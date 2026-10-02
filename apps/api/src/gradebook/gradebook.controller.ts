import {
  Body, ConflictException, Controller, ForbiddenException, Get, Inject, Param, Post, Req, UnprocessableEntityException,
} from "@nestjs/common";
import { eq, and, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import { DB_TOKEN } from "../db/token";
import { withActor } from "../db/actor";
import { grades, gradeRevisions, sectionStaff } from "../db/schema";
import { Perm } from "../common/guards";
import { enqueueGradeReleased } from "../notify/notify.service";
import { requireIdempotencyKey, claimIdempotency, completeIdempotency, releaseIdempotency } from "../common/idempotency";
import { insertAudit } from "../common/audit";
import { GradesBulkBody } from "@portal/contracts";
import type { Request } from "express";

@Controller()
export class GradebookController {
  constructor(@Inject(DB_TOKEN) private db: Db) {}

  @Get("sections/:id/gradebook")
  @Perm("gradebook:read")
  async gradebook(@Req() req: Request, @Param("id") sectionId: string) {
    const p = req.principal!;
    return withActor(this.db, { userId: p.userId, role: p.activeRole }, async (tx) => {
      const rows = await tx.select().from(grades).where(eq(grades.sectionId, sectionId));
      return { data: rows };
    });
  }

  @Post("sections/:id/grades/bulk")
  @Perm("gradebook:write")
  async bulk(@Req() req: Request, @Param("id") sectionId: string, @Body() body: unknown) {
    const key = requireIdempotencyKey(req);
    const p = req.principal!;
    const claim = await claimIdempotency(this.db, key, p.userId, req);
    if (claim.status === "replay") return claim.body;
    if (claim.status === "conflict") {
      throw new ConflictException({ code: "idempotency_in_progress",
        detail: "A request with this Idempotency-Key is still processing" });
    }
    try {
    const parsed = GradesBulkBody.safeParse(body);
    if (!parsed.success) throw new UnprocessableEntityException({ code: "validation", detail: parsed.error.message });
    const out = await withActor(this.db, { userId: p.userId, role: p.activeRole }, async (tx) => {
      await this.assertStaffOn(tx, p.userId, sectionId);
      let written = 0, revisions = 0;
      for (const item of parsed.data.items) {
        const points = item.points, max = item.max_points;
        if (Number(points) > Number(max)) {
          throw new UnprocessableEntityException({ code: "grade_exceeds_max",
            detail: `points (${points}) exceeds max_points (${max})` });
        }
        const [existing] = await tx.select().from(grades).where(and(
          eq(grades.studentUserId, item.student_user_id),
          eq(grades.sectionId, sectionId),
          eq(grades.label, item.label),
          eq(grades.sourceType, item.source_type),
          isNull(grades.sourceId))).limit(1);
        if (existing) {
          if (existing.points !== points || existing.feedbackText !== (item.feedback_text ?? null)) {
            await tx.update(grades).set({
              points, maxPoints: max, weightPct: item.weight_pct ?? null,
              feedbackText: item.feedback_text ?? null, gradedBy: p.userId, gradedAt: new Date(),
            }).where(eq(grades.id, existing.id));
            await tx.insert(gradeRevisions).values({
              gradeId: existing.id, prevPoints: existing.points, newPoints: points,
              changedBy: p.userId, reason: "correction",
            });
            revisions++;
          }
        } else {
          const [g] = await tx.insert(grades).values({
            studentUserId: item.student_user_id, sectionId,
            sourceType: item.source_type, sourceId: item.source_id ?? null,
            label: item.label, points, maxPoints: max,
            weightPct: item.weight_pct ?? null, gradedBy: p.userId,
            feedbackText: item.feedback_text ?? null,
          }).returning();
          await tx.insert(gradeRevisions).values({
            gradeId: g.id, prevPoints: null, newPoints: points, changedBy: p.userId, reason: "initial",
          });
          revisions++;
        }
        written++;
      }
      await insertAudit(tx, { actorUserId: p.userId, action: "gradebook.bulk_upsert",
        entityType: "course_section", entityId: sectionId,
        after: { written, revisions }, ip: req.ip });
      return { written, revisions };
    });
    await completeIdempotency(this.db, key, p.userId, req, 201, out);
    return out;
    } catch (e) {
      // review-3 #4: a FAILED save must not strand the key — release the
      // claim so the client can retry with the same Idempotency-Key.
      await releaseIdempotency(this.db, key, p.userId, req);
      throw e;
    }
  }

  @Post("sections/:id/grades/release")
  @Perm("gradebook:write")
  async release(@Req() req: Request, @Param("id") sectionId: string) {
    const p = req.principal!;
    return withActor(this.db, { userId: p.userId, role: p.activeRole }, async (tx) => {
      await this.assertStaffOn(tx, p.userId, sectionId);
      const rows = await tx.select({ id: grades.id, studentUserId: grades.studentUserId }).from(grades)
        .where(and(eq(grades.sectionId, sectionId), isNull(grades.releasedAt)));
      for (const r of rows) {
        await tx.update(grades).set({ releasedAt: new Date() }).where(eq(grades.id, r.id));
      }
      if (rows.length) {
        // 5.3: tell students + guardians inside the SAME transaction (outbox pattern)
        await enqueueGradeReleased(tx, sectionId, [...new Set(rows.map((r) => r.studentUserId))]);
      }
      await insertAudit(tx, { actorUserId: p.userId, action: "grades.released",
        entityType: "course_section", entityId: sectionId, after: { count: rows.length } });
      return { released: rows.length };
    });
  }

  /** Gate 1 object check; RLS (gate 2) still backstops. */
  private async assertStaffOn(tx: Db, userId: string, sectionId: string) {
    const [row] = await tx.select().from(sectionStaff)
      .where(and(eq(sectionStaff.sectionId, sectionId), eq(sectionStaff.userId, userId))).limit(1);
    if (!row) throw new ForbiddenException({ code: "outside_section_scope",
      detail: "user is not staff on this section" });
  }
}
