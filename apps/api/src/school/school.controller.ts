import { Body, Controller, Get, Inject, Put, Req, UnprocessableEntityException } from "@nestjs/common";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { DB_TOKEN } from "../db/token";
import { withActor, SERVICE } from "../db/actor";
import { schoolSettings, gradingConfig } from "../db/schema";
import { Perm } from "../common/guards";
import { insertAudit } from "../common/audit";
import { SchoolSettingsBody, GradingConfigBody } from "@portal/contracts";
import type { Request } from "express";

/**
 * Phase 6: single-row school identity. GET is PUBLIC (login page, nav and
 * legal pages render the school's name/logo/contact before authentication);
 * the DB read still runs under RLS via the SERVICE actor. PUT is
 * settings:write (super_admin, school_admin).
 */
@Controller()
export class SchoolController {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  @Get("school")
  async get() {
    return withActor(this.db, SERVICE, async (tx) => {
      const [row] = await tx.select().from(schoolSettings).where(eq(schoolSettings.id, 1)).limit(1);
      if (!row) return { name: "School Portal" };
      return {
        name: row.name, logo_url: row.logoUrl,
        primary_color: row.primaryColor, accent_color: row.accentColor,
        contact_email: row.contactEmail, dpo_email: row.dpoEmail,
        address: row.address, phone: row.phone,
        timezone: row.timezone, currency: row.currency,
        mail_sender: row.mailSender,
        // Published on /legal/privacy §5 and /legal/retention. Null means the
        // pages say "no DPIA recorded" rather than claiming one exists.
        dpia_reference: row.dpiaReference, dpia_completed_at: row.dpiaCompletedAt,
      };
    });
  }

  @Put("school")
  @Perm("settings:write")
  async update(@Req() req: Request, @Body() body: unknown) {
    const parsed = SchoolSettingsBody.safeParse(body);
    if (!parsed.success) {
      throw new UnprocessableEntityException({ code: "validation", detail: parsed.error.message });
    }
    const b = parsed.data;
    const p = req.principal!;
    return withActor(this.db, SERVICE, async (tx) => {
      await tx.update(schoolSettings).set({
        name: b.name,
        logoUrl: b.logo_url ?? null,
        primaryColor: b.primary_color ?? "#1d4ed8",
        accentColor: b.accent_color ?? "#0ea5e9",
        contactEmail: b.contact_email ?? null,
        dpoEmail: b.dpo_email ?? null,
        address: b.address ?? null,
        phone: b.phone ?? null,
        timezone: b.timezone ?? "Africa/Lagos",
        currency: (b.currency ?? "NGN").toUpperCase(),
        mailSender: b.mail_sender ?? null,
        dpiaReference: b.dpia_reference?.trim() || null,
        dpiaCompletedAt: b.dpia_completed_at || null,
        updatedAt: new Date(), updatedBy: p.userId,
      }).where(eq(schoolSettings.id, 1));
      await insertAudit(tx, { actorUserId: p.userId, action: "school.updated",
        entityType: "school_settings", after: { name: b.name }, ip: req.ip });
      return { ok: true };
    });
  }

  /** phase 6: grading scale + default weights (any authenticated actor reads) */
  @Get("grading-config")
  async getGrading() {
    return withActor(this.db, SERVICE, async (tx) => {
      const [row] = await tx.select().from(gradingConfig).where(eq(gradingConfig.id, 1)).limit(1);
      return row?.config ?? { scale: [], weights: {} };
    });
  }

  @Put("grading-config")
  @Perm("academics:write")
  async putGrading(@Req() req: Request, @Body() body: unknown) {
    const parsed = GradingConfigBody.safeParse(body);
    if (!parsed.success) {
      throw new UnprocessableEntityException({ code: "validation", detail: parsed.error.message });
    }
    const p = req.principal!;
    const scale = [...parsed.data.scale].sort((a, b) => b.min_pct - a.min_pct);
    return withActor(this.db, SERVICE, async (tx) => {
      await tx.update(gradingConfig)
        .set({ config: { ...parsed.data, scale }, updatedAt: new Date(), updatedBy: p.userId })
        .where(eq(gradingConfig.id, 1));
      await insertAudit(tx, { actorUserId: p.userId, action: "grading.updated",
        entityType: "grading_config", ip: req.ip });
      return { ok: true, scale };
    });
  }
}
