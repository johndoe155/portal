import {
  Body, ConflictException, Controller, Get, Headers, HttpException, HttpStatus, Inject,
  NotFoundException, Param, Post, Req,
  ServiceUnavailableException, UnauthorizedException, UnprocessableEntityException,
} from "@nestjs/common";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { DB_TOKEN } from "../db/token";
import { withActor, SERVICE } from "../db/actor";
import { feeInvoices, feePayments, feeTemplates, guardians, schoolSettings, students, users } from "../db/schema";
import { Perm, ParentWrite } from "../common/guards";
import { insertAudit } from "../common/audit";
import { config } from "../config";
import { InvoiceCreateBody, PaymentRecordBody, FeeTemplateBody, TemplateGenerateBody } from "@portal/contracts";
import type { Request } from "express";

const LEDGER_ROLES = new Set(["super_admin", "school_admin"]);

/** Fees: invoices + payments (kobo). Paystack webhook is public + HMAC-verified. */
@Controller()
export class FeesController {
  constructor(@Inject(DB_TOKEN) private db: Db) {}

  /** admin ledger */
  @Get("fees/invoices")
  @Perm("fees:read")
  async listInvoices(@Req() req: Request) {
    const p = req.principal!;
    return withActor(this.db, { userId: p.userId, role: p.activeRole }, async (tx) => {
      const rows = await tx.select().from(feeInvoices).limit(200);
      return { data: rows };
    });
  }

  /** student's own ledger */
  @Get("fees/my")
  @Perm("self:read")
  async myFees(@Req() req: Request) {
    const p = req.principal!;
    return this.ledgerFor(p.userId, p);
  }

  /** guardian: child's ledger */
  @Get("parent/children/:id/fees")
  @Perm("family:read")
  async childFees(@Req() req: Request, @Param("id") id: string) {
    const p = req.principal!;
    return withActor(this.db, { userId: p.userId, role: p.activeRole }, async (tx) => {
      await this.assertGuardian(tx, p.userId, id);
    }).then(() => this.ledgerFor(id, p));
  }

  /**
   * Where a payer lands when they come back from Paystack.
   *
   * Initialize now sends callback_url=ORIGIN/fees/return, and that page needs
   * to answer one question: did the school get my money? It cannot ask
   * Paystack — the payer's browser holds no gateway credentials — and it must
   * not trust the query string Paystack appends, which the payer can edit.
   * So it asks us, and we answer from the row the signed webhook updated.
   *
   * "pending" is the honest answer while the webhook is in flight; the page
   * polls. Scoped to the payer: you can only look up a reference you started.
   */
  @Get("fees/payments/:reference/status")
  async paymentStatus(@Req() req: Request, @Param("reference") reference: string) {
    const p = req.principal!;
    return withActor(this.db, SERVICE, async (tx) => {
      const [pay] = await tx.select().from(feePayments)
        .where(eq(feePayments.gatewayRef, reference)).limit(1);
      if (!pay || pay.paidBy !== p.userId) throw new NotFoundException({ code: "not_found" });
      const [inv] = await tx.select({ status: feeInvoices.status, label: feeInvoices.label })
        .from(feeInvoices).where(eq(feeInvoices.id, pay.invoiceId)).limit(1);
      return {
        reference, status: pay.status, amount_kobo: Number(pay.amountKobo),
        currency: pay.currency, paid_at: pay.paidAt?.toISOString() ?? null,
        invoice_label: inv?.label ?? null, invoice_status: inv?.status ?? null,
      };
    });
  }

  @Post("fees/invoices")
  @Perm("fees:write")
  async createInvoice(@Req() req: Request, @Body() body: unknown) {
    const parsed = InvoiceCreateBody.safeParse(body);
    if (!parsed.success) {
      throw new UnprocessableEntityException({ code: "validation", detail: parsed.error.message });
    }
    const p = req.principal!;
    const b = parsed.data;
    return withActor(this.db, { userId: p.userId, role: p.activeRole }, async (tx) => {
      const [student] = await tx.select({ userId: students.userId }).from(students)
        .where(eq(students.userId, b.student_user_id)).limit(1);
      if (!student) throw new UnprocessableEntityException({ code: "not_a_student" });
      const [dupe] = await tx.select({ id: feeInvoices.id }).from(feeInvoices)
        .where(and(eq(feeInvoices.studentUserId, b.student_user_id), eq(feeInvoices.termId, b.term_id),
          eq(feeInvoices.label, b.label))).limit(1);
      if (dupe) throw new ConflictException({ code: "invoice_exists" });
      const [inv] = await tx.insert(feeInvoices).values({
        id: randomUUID(), studentUserId: b.student_user_id, termId: b.term_id, label: b.label,
        amountKobo: b.amount_kobo, dueDate: b.due_date ?? null,
      }).returning();
      await insertAudit(tx, { actorUserId: p.userId, action: "invoice.created",
        entityType: "fee_invoice", entityId: inv.id, after: { kobo: b.amount_kobo }, ip: req.ip });
      return inv;
    });
  }

  /**
   * Create/reuse a pending payment, then call Paystack Initialize OUTSIDE the
   * DB transaction (review-5 #5: a slow gateway must never hold a pooled
   * connection). Per-invoice serialization: in-process queue (single node) +
   * pg_advisory_xact_lock in the prepare tx (cross-node row prep).
   */
  @Post("fees/invoices/:id/initiate")
  @Perm("fees:write")
  async initiate(@Req() req: Request, @Param("id") id: string) {
    const p = req.principal!;
    return this.serializedInitiate(id, () => this.initiateFlow(id, null, p, req.ip));
  }

  /**
   * review-2 #7: parent pays their own child's invoice. Deliberate exception
   * to the parent read-only rule — guarded by fees:pay + guardian link.
   * Paystack receives the PAYER's email (the parent), not the student's.
   */
  @Post("parent/children/:childId/fees/invoices/:invoiceId/initiate")
  @Perm("fees:pay")
  @ParentWrite()
  async parentInitiate(@Req() req: Request, @Param("childId") childId: string,
                       @Param("invoiceId") invoiceId: string) {
    const p = req.principal!;
    return this.serializedInitiate(invoiceId, () => this.initiateFlow(invoiceId, childId, p, req.ip));
  }

  /** In-process per-invoice queue so double-clicks can't double-Initialize. */
  private initiateLocks = new Map<string, Promise<unknown>>();
  private serializedInitiate<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.initiateLocks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const stored = run.then(() => {}, () => {});
    this.initiateLocks.set(key, stored);
    stored.then(() => {
      if (this.initiateLocks.get(key) === stored) this.initiateLocks.delete(key);
    });
    return run;
  }

  /** tx1: validate + prepare pending row → HTTP (no tx) → tx2: persist checkout. */
  private async initiateFlow(invoiceId: string, childId: string | null, p: any, ip?: string) {
    const actor = childId ? SERVICE : { userId: p.userId, role: p.activeRole };
    const prepared = await withActor(this.db, actor, async (tx: any) => {
      // cross-node serialization of the prepare step for this invoice
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${invoiceId}))`);
      if (childId) await this.assertGuardian(tx, p.userId, childId);
      const [inv] = await tx.select().from(feeInvoices)
        .where(childId
          ? and(eq(feeInvoices.id, invoiceId), eq(feeInvoices.studentUserId, childId))
          : eq(feeInvoices.id, invoiceId))
        .limit(1);
      if (!inv) throw new NotFoundException({ code: "not_found" });
      if (inv.status === "paid" || inv.status === "void") {
        throw new ConflictException({ code: "invoice_not_payable" });
      }
      return this.preparePayment(tx, inv, p, ip);
    });
    if (prepared.reused) {
      return { reference: prepared.reference, amount_kobo: prepared.amountKobo,
        checkout_url: prepared.checkoutUrl ?? null, access_code: prepared.accessCode ?? null };
    }
    const { checkoutUrl, accessCode } = await this.paystackInitialize(
      p, prepared.reference, prepared.amountKobo, prepared.currency);
    await withActor(this.db, actor, async (tx: any) => {
      // review-4 #2: persist the checkout so retries reuse it (never re-init)
      await tx.update(feePayments).set({ checkoutUrl, accessCode })
        .where(eq(feePayments.id, prepared.payId));
      await insertAudit(tx, { actorUserId: p.userId, action: "payment.initiated",
        entityType: "fee_payment", entityId: prepared.payId,
        after: { reference: prepared.reference, reused: false, amount_kobo: prepared.amountKobo }, ip });
    });
    return { reference: prepared.reference, amount_kobo: prepared.amountKobo,
      checkout_url: checkoutUrl, access_code: accessCode };
  }

  /**
   * Prepare the pending payment row inside tx1 and decide reuse vs refresh.
   * review-4 #3: charge the REMAINING balance, not the invoice total.
   * review-3 #7 / review-4 #2: ONE payable reference per invoice; a pending
   * row's STORED checkout is returned as-is — re-Initializing the same
   * reference is rejected by the real gateway. review-5 #4: reuse only while
   * the stored checkout is fresh (PAYSTACK_CHECKOUT_TTL_MS, default 30 min);
   * stale sessions are refreshed with a new reference. A payment that still
   * lands on a superseded reference surfaces as webhook `unknown_reference`.
   */
  private async preparePayment(tx: any, inv: any, p: any, ip?: string) {
    // The school's configured currency, not a hardcoded "NGN". It is read
    // here, inside the prepare transaction, and stored on the row so the
    // webhook compares against the currency we actually charged in.
    const [settings] = await tx.select({ currency: schoolSettings.currency })
      .from(schoolSettings).where(eq(schoolSettings.id, 1)).limit(1);
    const currency = (settings?.currency || "NGN").toUpperCase();
    const [sumRow] = await tx.select({ total: sql<number>`COALESCE(SUM(amount_kobo),0)::bigint` })
      .from(feePayments)
      .where(and(eq(feePayments.invoiceId, inv.id), eq(feePayments.status, "success")));
    const remaining = Number(inv.amountKobo) - Number(sumRow?.total ?? 0);
    if (remaining <= 0) {
      throw new ConflictException({ code: "invoice_not_payable",
        detail: "invoice balance is already covered" });
    }

    const [openPending] = await tx.select().from(feePayments)
      .where(and(eq(feePayments.invoiceId, inv.id), eq(feePayments.channel, "paystack"),
        eq(feePayments.status, "pending"), eq(feePayments.amountKobo, remaining)))
      .orderBy(feePayments.createdAt)
      .limit(1);
    const checkoutFresh = !!openPending?.checkoutUrl &&
      Date.now() - openPending.createdAt.getTime() <= config.paystackCheckoutTtlMs;
    if (openPending?.checkoutUrl && checkoutFresh) {
      await tx.update(feePayments).set({ paidBy: p.userId }).where(eq(feePayments.id, openPending.id));
      await insertAudit(tx, { actorUserId: p.userId, action: "payment.initiated",
        entityType: "fee_payment", entityId: openPending.id,
        after: { reference: openPending.gatewayRef, reused: true }, ip });
      return { reused: true as const, payId: openPending.id, reference: openPending.gatewayRef,
        amountKobo: remaining, currency: openPending.currency as string,
        checkoutUrl: openPending.checkoutUrl as string | null,
        accessCode: openPending.accessCode as string | null };
    }
    // No reusable pending row (none, pre-0006 legacy without a stored
    // checkout, or a STALE one): issue a fresh reference; any legacy/stale
    // pending row for this invoice is repurposed so exactly one remains.
    const reference = `psk_${randomUUID()}`;
    let payId: string;
    if (openPending) {
      // review-5 #4: reset created_at — it timestamps the CURRENT checkout
      // session for the TTL check; without this a refreshed row would read as
      // stale forever and every retry would burn a new reference
      await tx.update(feePayments)
        .set({ gatewayRef: reference, amountKobo: remaining, paidBy: p.userId, currency,
          checkoutUrl: null, accessCode: null, createdAt: new Date() })
        .where(eq(feePayments.id, openPending.id));
      payId = openPending.id;
    } else {
      const [pay] = await tx.insert(feePayments).values({
        id: randomUUID(), invoiceId: inv.id, amountKobo: remaining, currency,
        channel: "paystack", gatewayRef: reference, paidBy: p.userId,
      }).returning();
      payId = pay.id;
    }
    return { reused: false as const, payId, reference, amountKobo: remaining, currency,
      checkoutUrl: null, accessCode: null };
  }

  /** Paystack Initialize Transaction — pure HTTP, no DB transaction held. */
  private async paystackInitialize(
    p: any, reference: string, amountKobo: number, currency: string,
  ) {
    const secret = config.paystackSecret;
    if (!secret) {
      throw new HttpException({ code: "paystack_not_configured", status: 503,
        title: "Payments not configured", detail: "PAYSTACK_SECRET is not set" },
        HttpStatus.SERVICE_UNAVAILABLE);
    }
    // review-2 #7: Paystack receives the PAYER's email (whoever is paying),
    // not the student's — receipts go to the person who charged their card.
    const base = process.env.PAYSTACK_API_BASE ?? config.paystackApiBase;
    let init: { status?: boolean; message?: string;
      data?: { authorization_url?: string; access_code?: string } };
    try {
      const res = await fetch(`${base}/transaction/initialize`, {
        method: "POST",
        headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
        body: JSON.stringify({
          email: p.email ?? "noreply@school.example",
          amount: amountKobo,
          reference,
          currency,
          // Without a callback_url Paystack drops the payer on its own
          // generic "payment complete" page and they are simply stranded —
          // no way back to the portal, no confirmation that the school knows.
          // This page waits for the webhook and tells them what happened.
          callback_url: `${config.publicWebOrigin}/fees/return`,
        }),
      });
      init = await res.json() as typeof init;
      if (!res.ok || !init?.status) {
        throw new Error(init?.message ?? `HTTP ${res.status}`);
      }
    } catch (e: any) {
      throw new HttpException({ code: "paystack_initialize_failed", status: 502,
        title: "Payment gateway unreachable",
        detail: String(e?.message ?? e).slice(0, 160) }, HttpStatus.BAD_GATEWAY);
    }
    return { checkoutUrl: init.data?.authorization_url ?? null,
      accessCode: init.data?.access_code ?? null };
  }

  /** record an offline payment (cash/transfer) — completes immediately */
  @Post("fees/invoices/:id/payments")
  @Perm("fees:write")
  async recordPayment(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const parsed = PaymentRecordBody.safeParse(body);
    if (!parsed.success) {
      throw new UnprocessableEntityException({ code: "validation", detail: parsed.error.message });
    }
    const p = req.principal!;
    const b = parsed.data;
    return withActor(this.db, { userId: p.userId, role: p.activeRole }, async (tx) => {
      const [inv] = await tx.select().from(feeInvoices).where(eq(feeInvoices.id, id)).limit(1);
      if (!inv) throw new NotFoundException({ code: "not_found" });
      if (inv.status === "paid" || inv.status === "void") {
        throw new ConflictException({ code: "invoice_not_payable" });
      }
      const [pay] = await tx.insert(feePayments).values({
        id: randomUUID(), invoiceId: id, amountKobo: b.amount_kobo, channel: b.channel,
        status: "success", paidBy: p.userId, paidAt: new Date(),
      }).returning();
      await this.recomputeInvoice(tx, id, p.userId, "payment.recorded", req.ip);
      return pay;
    });
  }

  /* ── phase 6: fee templates → bulk invoice generation ── */

  @Get("fees/templates")
  @Perm("fees:read")
  async listTemplates(@Req() req: Request) {
    const p = req.principal!;
    return withActor(this.db, { userId: p.userId, role: p.activeRole }, async (tx) => {
      return { data: await tx.select().from(feeTemplates) };
    });
  }

  @Post("fees/templates")
  @Perm("fees:write")
  async createTemplate(@Req() req: Request, @Body() body: unknown) {
    const parsed = FeeTemplateBody.safeParse(body);
    if (!parsed.success) {
      throw new UnprocessableEntityException({ code: "validation", detail: parsed.error.message });
    }
    const b = parsed.data;
    const p = req.principal!;
    return withActor(this.db, SERVICE, async (tx) => {
      const [row] = await tx.insert(feeTemplates).values({
        name: b.name, amountKobo: b.amount_kobo,
        gradeLevel: b.grade_level ?? null, dueDays: b.due_days ?? 14,
        active: b.active ?? true, createdBy: p.userId,
      }).returning();
      await insertAudit(tx, { actorUserId: p.userId, action: "fee_template.created",
        entityType: "fee_template", entityId: row.id, after: { name: b.name }, ip: req.ip });
      return row;
    });
  }

  @Post("fees/templates/:id/generate")
  @Perm("fees:write")
  async generateFromTemplate(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const parsed = TemplateGenerateBody.safeParse(body);
    if (!parsed.success) {
      throw new UnprocessableEntityException({ code: "validation", detail: parsed.error.message });
    }
    const p = req.principal!;
    return withActor(this.db, SERVICE, async (tx) => {
      const [tpl] = await tx.select().from(feeTemplates).where(eq(feeTemplates.id, id)).limit(1);
      if (!tpl) throw new NotFoundException({ code: "not_found" });
      // every ACTIVE student in the template's grade scope
      const targets = await tx.select({ userId: students.userId }).from(students)
        .where(tpl.gradeLevel
          ? and(eq(students.status, "active"), eq(students.gradeLevel, tpl.gradeLevel))
          : eq(students.status, "active"));
      const dueDate = new Date(Date.now() + tpl.dueDays * 86400_000).toISOString().slice(0, 10);
      let created = 0, skipped = 0;
      for (const t of targets) {
        // dedupe: one invoice per (student, term, template name)
        const [exists] = await tx.select({ id: feeInvoices.id }).from(feeInvoices)
          .where(and(eq(feeInvoices.studentUserId, t.userId),
            eq(feeInvoices.termId, parsed.data.term_id),
            eq(feeInvoices.label, tpl.name))).limit(1);
        if (exists) { skipped++; continue; }
        await tx.insert(feeInvoices).values({
          id: randomUUID(), studentUserId: t.userId, termId: parsed.data.term_id,
          label: tpl.name, amountKobo: tpl.amountKobo, dueDate,
        });
        created++;
      }
      await insertAudit(tx, { actorUserId: p.userId, action: "fee_template.generated",
        entityType: "fee_template", entityId: id,
        after: { termId: parsed.data.term_id, created, skipped }, ip: req.ip });
      return { created, skipped, amount_kobo: tpl.amountKobo, due_date: dueDate };
    });
  }

  /**
   * Paystack webhook — public route, HMAC SHA-512 over the RAW body
   * (x-paystack-signature). Idempotent via the unique gateway_ref.
   */
  @Post("webhooks/paystack")
  async paystackWebhook(@Req() req: Request,
                        @Headers("x-paystack-signature") signature?: string) {
    const secret = config.paystackSecret;
    if (!secret) {
      throw new ServiceUnavailableException({ code: "webhook_not_configured",
        detail: "PAYSTACK_SECRET is not set" });
    }
    const raw = (req as any).rawBody as Buffer | undefined;
    if (!raw || !signature) {
      throw new UnauthorizedException({ code: "webhook_unverified" });
    }
    const expect = createHmac("sha512", secret).update(raw).digest("hex");
    const got = Buffer.from(signature);
    const want = Buffer.from(expect);
    if (got.length !== want.length || !timingSafeEqual(got, want)) {
      throw new UnauthorizedException({ code: "webhook_unverified" });
    }
    let event: any;
    try { event = JSON.parse(raw.toString()); } catch { event = null; }
    if (!event || event.event !== "charge.success") return { ignored: true };

    const reference = event?.data?.reference as string | undefined;
    if (!reference) return { ignored: true };
    const payloadAmount = Number(event?.data?.amount ?? 0);
    const payloadCurrency = String(event?.data?.currency ?? "");

    return withActor(this.db, SERVICE, async (tx) => {
      const [pay] = await tx.select().from(feePayments)
        .where(eq(feePayments.gatewayRef, reference)).limit(1);
      if (!pay) {
        await insertAudit(tx, { actorUserId: null, action: "webhook.orphan",
          entityType: "fee_payment", after: { reference } });
        return { ignored: true, reason: "unknown_reference" };
      }
      if (pay.status === "success") return { duplicate: true };
      // review-3 #7: the payload is UNTRUSTED input (a valid signature proves
      // origin, not correctness). We initiated the charge with OUR amount in
      // OUR currency — anything else is anomalous: fail the row, audit,
      // never post it. The comparison is against the currency stored on the
      // payment row, not the live school setting: a bursar who switches
      // currency mid-term must not fail every in-flight payment.
      const expectedCurrency = (pay.currency || "NGN").toUpperCase();
      if (payloadCurrency.toUpperCase() !== expectedCurrency) {
        await tx.update(feePayments).set({ status: "failed" }).where(eq(feePayments.id, pay.id));
        await insertAudit(tx, { actorUserId: null, action: "webhook.currency_mismatch",
          entityType: "fee_payment", entityId: pay.id,
          after: { reference, currency: payloadCurrency.slice(0, 8), expected: expectedCurrency } });
        return { rejected: true, reason: "currency_mismatch" };
      }
      if (payloadAmount !== Number(pay.amountKobo)) {
        await tx.update(feePayments).set({ status: "failed" }).where(eq(feePayments.id, pay.id));
        await insertAudit(tx, { actorUserId: null, action: "webhook.amount_mismatch",
          entityType: "fee_payment", entityId: pay.id,
          after: { reference, payload_kobo: payloadAmount, expected_kobo: Number(pay.amountKobo) } });
        return { rejected: true, reason: "amount_mismatch" };
      }
      // Stored amount is authoritative — the success update never touches it.
      await tx.update(feePayments).set({ status: "success", paidAt: new Date() })
        .where(eq(feePayments.id, pay.id));
      const [invNow] = await tx.select({ status: feeInvoices.status }).from(feeInvoices)
        .where(eq(feeInvoices.id, pay.invoiceId)).limit(1);
      if (invNow?.status === "paid") {
        // Overpayment (legacy stacked references or gateway double-collect):
        // money really moved, so record it — but flag it for the bursar
        // instead of silently folding it into the invoice total.
        await insertAudit(tx, { actorUserId: null, action: "webhook.overpaid",
          entityType: "fee_payment", entityId: pay.id, after: { reference } });
        return { applied: true, payment_id: pay.id, review: "overpayment" };
      }
      await this.recomputeInvoice(tx, pay.invoiceId, null, "webhook.charge_success");
      return { applied: true, payment_id: pay.id };
    });
  }

  private async ledgerFor(studentUserId: string, p: { userId: string; activeRole: string }) {
    return withActor(this.db, { userId: p.userId, role: p.activeRole }, async (tx) => {
      const invoices = await tx.select().from(feeInvoices)
        .where(eq(feeInvoices.studentUserId, studentUserId));
      const ids = invoices.map((i) => i.id);
      const payments = ids.length
        ? await tx.select().from(feePayments)
            .where(sql`${feePayments.invoiceId} IN (${sql.join(ids, sql`, `)})`)
        : [];
      return { data: { invoices, payments: payments.filter((x) => x.status !== "failed") } };
    });
  }

  /** sum successful payments → invoice status; audit every transition */
  private async recomputeInvoice(tx: Db, invoiceId: string, actorId: string | null,
                                 action: string, ip?: string) {
    const [inv] = await tx.select().from(feeInvoices).where(eq(feeInvoices.id, invoiceId)).limit(1);
    if (!inv) return;
    const rows = await tx.select({ total: sql<number>`COALESCE(SUM(amount_kobo),0)::bigint` })
      .from(feePayments)
      .where(and(eq(feePayments.invoiceId, invoiceId), eq(feePayments.status, "success")));
    const paid = Number(rows[0]?.total ?? 0);
    const status = paid >= Number(inv.amountKobo) ? "paid" : paid > 0 ? "partial" : "due";
    if (status !== inv.status) {
      await tx.update(feeInvoices).set({ status }).where(eq(feeInvoices.id, invoiceId));
    }
    await insertAudit(tx, { actorUserId: actorId, action, entityType: "fee_invoice",
      entityId: invoiceId, after: { paid_kobo: paid, status }, ip });
  }

  private async assertGuardian(tx: Db, userId: string, studentId: string) {
    const [g] = await tx.select({ id: guardians.id }).from(guardians)
      .where(and(eq(guardians.userId, userId), eq(guardians.studentUserId, studentId),
        sql`${guardians.verifiedAt} IS NOT NULL`, isNull(guardians.endedAt))).limit(1);
    if (!g) throw new NotFoundException({ code: "not_found" });
  }
}
