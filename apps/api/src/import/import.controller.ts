import {
  BadRequestException, Body, Controller, ForbiddenException, Get, Header, Inject,
  NotFoundException, Param, Post, Query, Req, Res, UnprocessableEntityException,
  UploadedFile, UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { diskStorage } from "multer";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { desc, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import { DB_TOKEN } from "../db/token";
import { withActor, SERVICE } from "../db/actor";
import { importJobs } from "../db/schema";
import { Perm } from "../common/guards";
import { insertAudit } from "../common/audit";
import { mailConfigured } from "../notify/mailer";
import {
  parseImportCsv, planPasswords, processRows, toCsvRow, ImportShapeError,
  IMPORT_KINDS, KIND_HEADERS, type ImportKind, type RowResult,
} from "./import.engine";
import { runJob, toJobView } from "./import.jobs";
import { ImportBody } from "@portal/contracts";
import type { Request, Response } from "express";

export { parseCsv } from "./import.engine";

const TMP_DIR = () => process.env.IMPORT_TMP_DIR ?? "./data/imports";
const MAX_UPLOAD_BYTES = () => Math.max(1, Number(process.env.IMPORT_MAX_UPLOAD_MB ?? 25)) * 1024 * 1024;

/** Kinds that create accounts, and therefore pay ~100 ms of scrypt per row. */
const ACCOUNT_KINDS = new Set<ImportKind>(["students", "staff", "guardians"]);

/**
 * Rows above which the synchronous path refuses and insists on a background
 * job. The cap is cost-based, not a flat number, because the costs differ by
 * two orders of magnitude:
 *
 *   - committing accounts  → scrypt dominates (~100 ms/row): 200 rows ≈ 20 s,
 *     already close to the Next proxy's ~30 s timeout;
 *   - committing sections/enrolments → a few indexed queries per row;
 *   - dry runs → no hashing at all, just validation reads.
 *
 * A flat limit would needlessly push a harmless 600-row dry run into a job.
 */
function syncRowLimit(kind: ImportKind, dryRun: boolean): number {
  if (dryRun) return Number(process.env.IMPORT_SYNC_DRYRUN_LIMIT ?? 5000);
  return ACCOUNT_KINDS.has(kind)
    ? Number(process.env.IMPORT_SYNC_ROW_LIMIT ?? 200)
    : Number(process.env.IMPORT_SYNC_ROW_LIMIT_CHEAP ?? 1000);
}

function assertKind(kind: string): ImportKind {
  if (!(IMPORT_KINDS as readonly string[]).includes(kind)) {
    throw new NotFoundException({
      code: "unknown_import_kind",
      detail: IMPORT_KINDS.join(" | "),
    });
  }
  return kind as ImportKind;
}

/**
 * Phase 6: bulk CSV import — the bridge from spreadsheets/SIS exports.
 *
 * Two entry points, one engine:
 *   POST /import/:kind         JSON body, synchronous — small pastes, dry runs
 *   POST /import/:kind/upload  multipart, asynchronous — real school files
 *
 * Every kind supports dry_run (validate everything, write nothing) and dedupes
 * on the natural key (admission number / email / composite), so re-running a
 * corrected file is always safe.
 */
@Controller()
export class ImportController {
  constructor(@Inject(DB_TOKEN) private db: Db) {}

  /** The expected header for each kind — drives the admin UI and the docs. */
  @Get("import/templates")
  @Perm("directory:read")
  templates() {
    return {
      data: IMPORT_KINDS.map((kind) => ({
        kind,
        header: KIND_HEADERS[kind],
        sample: toCsvRow(KIND_HEADERS[kind]).trim(),
      })),
      maxUploadMb: MAX_UPLOAD_BYTES() / 1024 / 1024,
      syncRowLimit: syncRowLimit("students", false),
      syncDryRunLimit: syncRowLimit("students", true),
    };
  }

  /** Blank CSV with the correct header — removes "what columns?" guesswork. */
  @Get("import/:kind/template.csv")
  @Perm("directory:read")
  @Header("content-type", "text/csv; charset=utf-8")
  templateCsv(@Param("kind") kind: string, @Res({ passthrough: true }) res: Response) {
    const k = assertKind(kind);
    res.setHeader("content-disposition", `attachment; filename="${k}-template.csv"`);
    return toCsvRow(KIND_HEADERS[k]);
  }

  /**
   * Synchronous import (JSON body). Kept for small pastes and dry runs; a file
   * larger than SYNC_ROW_LIMIT is rejected with a pointer at the upload route
   * rather than being allowed to time out halfway through.
   */
  @Post("import/:kind")
  async import(@Req() req: Request, @Param("kind") kind: string, @Body() body: unknown) {
    const parsed = ImportBody.safeParse(body);
    if (!parsed.success) {
      throw new UnprocessableEntityException({ code: "validation", detail: parsed.error.message });
    }
    const k = assertKind(kind);
    const p = req.principal!;
    this.assertKindPermission(k, p.perms);
    const dryRun = parsed.data.dry_run ?? false;

    let records;
    try {
      ({ records } = parseImportCsv(k, parsed.data.csv));
    } catch (e) {
      if (e instanceof ImportShapeError) {
        throw new UnprocessableEntityException({ code: e.code, detail: e.message });
      }
      throw e;
    }

    const limit = syncRowLimit(k, dryRun);
    if (records.length > limit) {
      throw new UnprocessableEntityException({
        code: "file_too_large_for_sync",
        title: "Use the file upload for a roster this size",
        detail: `${records.length} rows exceeds the ${limit}-row synchronous limit. ` +
          `POST the file to /api/v1/import/${k}/upload instead — it runs as a background ` +
          `job with progress, and is the path designed for whole-school files.`,
      });
    }

    // scrypt happens before the transaction opens (~100 ms/row).
    const plans = await planPasswords(k, records, dryRun);
    const ctx = {
      kind: k, dryRun, actorUserId: p.userId, actorRole: p.activeRole,
      smtpConfigured: mailConfigured(),
    };

    let outcome;
    if (dryRun) {
      // dry run must not persist — run on a transaction we always roll back by
      // throwing a sentinel; commits run the same code path and persist.
      try {
        await withActor(this.db, SERVICE, async (tx) => {
          const o = await processRows(tx, records, plans, ctx);
          throw Object.assign(new Error("__dry_run__"), { outcome: o });
        });
        outcome = { results: [] as RowResult[], created: 0, duplicates: 0, errors: 0 };
      } catch (e: any) {
        if (e?.message !== "__dry_run__") throw e;
        outcome = e.outcome;
      }
      // A dry run reports what WOULD be created. Some branches (a guardian
      // whose account does not exist yet) legitimately never reach the
      // `created++` line because the write is skipped, so recount from the
      // row verdicts instead of trusting the write counter.
      outcome = {
        ...outcome,
        created: outcome.results.filter((r: RowResult) => r.status === "ok").length,
        duplicates: outcome.results.filter((r: RowResult) => r.status === "duplicate").length,
      };
    } else {
      outcome = await withActor(this.db, SERVICE, async (tx) => {
        const o = await processRows(tx, records, plans, ctx);
        await insertAudit(tx, {
          actorUserId: p.userId, action: "import.completed", entityType: "import",
          after: { kind: k, rows: records.length, created: o.created,
            duplicates: o.duplicates, errors: o.errors }, ip: req.ip,
        });
        return o;
      });
    }

    return {
      kind: k, dry_run: dryRun, total: records.length,
      valid: outcome.results.filter((r: RowResult) => r.status === "ok").length,
      duplicates: outcome.duplicates, errors: outcome.errors,
      ...(dryRun ? { would_create: outcome.created } : { created: outcome.created }),
      // review-6 #5: every problem row is listed (no 500 cap). Ok rows are
      // omitted to keep the payload small — EXCEPT ones carrying a set-password
      // link, which the admin must see once. Counts above cover the full file.
      rows: outcome.results.filter((r: RowResult) => r.status !== "ok" || r.set_password_url),
    };
  }

  /**
   * Asynchronous import: stream the file to disk, create a job, return 202.
   *
   * This is the path that makes a whole-school roster possible. The old JSON
   * body hit the 1 MB express cap and the ~30 s proxy timeout long before a
   * real enrolments file finished.
   */
  @Post("import/:kind/upload")
  @UseInterceptors(FileInterceptor("file", {
    storage: diskStorage({
      destination: (_req, _file, cb) => {
        const dir = TMP_DIR();
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (_req, _file, cb) => cb(null, `upload-${randomUUID()}.csv`),
    }),
    // Applies to THIS route only — the global express.json limit stays 1 MB.
    limits: { fileSize: MAX_UPLOAD_BYTES(), files: 1 },
    fileFilter: (_req, file, cb) => {
      const ok = /\.csv$/i.test(file.originalname) ||
        ["text/csv", "application/csv", "text/plain", "application/vnd.ms-excel"]
          .includes(file.mimetype);
      cb(ok ? null : new BadRequestException({
        code: "not_a_csv",
        detail: `Expected a .csv file, got "${file.originalname}" (${file.mimetype}). ` +
          `In Excel use File → Save As → CSV UTF-8.`,
      }), ok);
    },
  }))
  async upload(@Req() req: Request, @Param("kind") kind: string,
               @UploadedFile() file: Express.Multer.File,
               @Query("dry_run") dryRunQuery?: string,
               @Body("dry_run") dryRunBody?: string) {
    const k = assertKind(kind);
    const p = req.principal!;
    try {
      this.assertKindPermission(k, p.perms);
    } catch (e) {
      if (file?.path) fs.rmSync(file.path, { force: true });
      throw e;
    }
    if (!file) {
      throw new UnprocessableEntityException({
        code: "no_file", detail: "Attach the CSV as the 'file' field of a multipart form.",
      });
    }
    const dryRun = String(dryRunQuery ?? dryRunBody ?? "false") === "true";

    // Validate the header NOW so a wrong file fails in a second rather than
    // after a background job has churned through it.
    try {
      const head = fs.readFileSync(file.path, "utf8").slice(0, 64 * 1024);
      parseImportCsv(k, head.includes("\n") ? head.slice(0, head.lastIndexOf("\n")) : head);
    } catch (e) {
      fs.rmSync(file.path, { force: true });
      if (e instanceof ImportShapeError) {
        throw new UnprocessableEntityException({ code: e.code, detail: e.message });
      }
      throw e;
    }

    const [job] = await withActor(this.db, { userId: p.userId, role: p.activeRole }, async (tx) => {
      const rows = await tx.insert(importJobs).values({
        kind: k, dryRun, state: "pending", requestedBy: p.userId, actorRole: p.activeRole,
        filename: path.basename(file.originalname).slice(0, 200),
        sourcePath: path.resolve(file.path),
        byteSize: file.size,
      }).returning();
      await insertAudit(tx, {
        actorUserId: p.userId, action: "import.queued", entityType: "import_job",
        entityId: rows[0].id,
        after: { kind: k, dryRun, filename: file.originalname, bytes: file.size }, ip: req.ip,
      });
      return rows;
    });

    // In-process worker (dev/single node) runs jobs itself; when the worker is
    // a separate process it will pick this up on its next poll.
    if (process.env.WORKER_INPROC !== "false") {
      void runJob(this.db, job.id, "api-inproc").catch((err) =>
        console.error("[import] inline job failed", err));
    }

    return {
      job_id: job.id, state: "pending", kind: k, dry_run: dryRun,
      filename: job.filename, bytes: file.size,
      poll: `/api/v1/import/jobs/${job.id}`,
    };
  }

  /** Progress + results for one job (the admin page polls this). */
  @Get("import/jobs/:id")
  @Perm("directory:read")
  async job(@Req() req: Request, @Param("id") id: string) {
    const p = req.principal!;
    return withActor(this.db, { userId: p.userId, role: p.activeRole }, async (tx) => {
      const [row] = await tx.select().from(importJobs).where(eq(importJobs.id, id)).limit(1);
      if (!row) throw new NotFoundException({ code: "not_found" });
      return toJobView(row);
    });
  }

  /** Recent jobs, so an admin can see what has been imported and by whom. */
  @Get("import/jobs")
  @Perm("directory:read")
  async jobs(@Req() req: Request, @Query("limit") limit?: string) {
    const p = req.principal!;
    const n = Math.min(Math.max(Number(limit) || 20, 1), 100);
    return withActor(this.db, { userId: p.userId, role: p.activeRole }, async (tx) => {
      const rows = await tx.select().from(importJobs)
        .orderBy(desc(importJobs.createdAt)).limit(n);
      return { data: rows.map(toJobView) };
    });
  }

  /**
   * Problem rows as a CSV the registrar can open in Excel, fix, and re-upload.
   * A 6,000-row file with 400 bad rows is unusable as an HTML table.
   */
  @Get("import/jobs/:id/errors.csv")
  @Perm("directory:read")
  @Header("content-type", "text/csv; charset=utf-8")
  async errorsCsv(@Req() req: Request, @Param("id") id: string,
                  @Res({ passthrough: true }) res: Response) {
    const p = req.principal!;
    const row = await withActor(this.db, { userId: p.userId, role: p.activeRole }, async (tx) => {
      const [r] = await tx.select().from(importJobs).where(eq(importJobs.id, id)).limit(1);
      return r;
    });
    if (!row) throw new NotFoundException({ code: "not_found" });
    res.setHeader("content-disposition", `attachment; filename="import-${row.kind}-problems.csv"`);
    let out = toCsvRow(["row", "status", "problems"]);
    for (const pr of (row.problems ?? []) as RowResult[]) {
      out += toCsvRow([pr.row, pr.status, (pr.errors ?? []).join("; ")]);
    }
    return out;
  }

  /**
   * One-time download of generated set-password links (only produced when SMTP
   * is unconfigured). Reading them clears them: they are credentials, and a job
   * row is not the right place to keep them.
   */
  @Get("import/jobs/:id/credentials.csv")
  @Perm("directory:write")
  @Header("content-type", "text/csv; charset=utf-8")
  async credentialsCsv(@Req() req: Request, @Param("id") id: string,
                       @Res({ passthrough: true }) res: Response) {
    const p = req.principal!;
    return withActor(this.db, SERVICE, async (tx) => {
      const [row] = await tx.select().from(importJobs).where(eq(importJobs.id, id)).limit(1);
      if (!row) throw new NotFoundException({ code: "not_found" });
      const secrets = (row.secrets ?? []) as { row: number; url: string }[];
      res.setHeader("content-disposition", `attachment; filename="set-password-links.csv"`);
      let out = toCsvRow(["row", "set_password_url"]);
      for (const s of secrets) out += toCsvRow([s.row, s.url]);
      // Shown once, then wiped.
      await tx.update(importJobs).set({ secrets: [] as any }).where(eq(importJobs.id, id));
      await insertAudit(tx, {
        actorUserId: p.userId, action: "import.credentials_downloaded",
        entityType: "import_job", entityId: id, after: { count: secrets.length }, ip: req.ip,
      });
      return out;
    });
  }

  /** Cancel a job that has not started (or stop one that is running). */
  @Post("import/jobs/:id/cancel")
  @Perm("directory:write")
  async cancel(@Req() req: Request, @Param("id") id: string) {
    const p = req.principal!;
    return withActor(this.db, SERVICE, async (tx) => {
      const [row] = await tx.select().from(importJobs).where(eq(importJobs.id, id)).limit(1);
      if (!row) throw new NotFoundException({ code: "not_found" });
      if (!["pending", "running"].includes(row.state)) {
        throw new UnprocessableEntityException({
          code: "not_cancellable", detail: `job is already ${row.state}`,
        });
      }
      await tx.update(importJobs)
        .set({ state: "cancelled", finishedAt: new Date(), lockedBy: null, lockedAt: null,
               sourcePath: null })
        .where(eq(importJobs.id, id));
      // The parked upload is a roster: names, emails, admission numbers. A
      // cancelled job used to leave it on disk forever.
      if (row.sourcePath) { try { fs.rmSync(row.sourcePath, { force: true }); } catch { /* gone */ } }
      await insertAudit(tx, {
        actorUserId: p.userId, action: "import.cancelled", entityType: "import_job",
        entityId: id, before: { state: row.state }, ip: req.ip,
      });
      // Rows already committed stay committed — re-running the corrected file
      // is safe because every kind dedupes on its natural key.
      return { ok: true, id, state: "cancelled", processed_rows: row.processedRows };
    });
  }

  /** per-kind capability, the same rule the @Perm decorator enforces */
  private assertKindPermission(kind: ImportKind, perms: string[]) {
    const perm = (kind === "sections" || kind === "enrollments") ? "academics:write" : "directory:write";
    if (!perms.includes(perm)) {
      throw new ForbiddenException({ code: "missing_capability", detail: `requires ${perm}` });
    }
  }
}
