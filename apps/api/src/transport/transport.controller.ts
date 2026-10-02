import {
  Body, ConflictException, Controller, Delete, Get, Inject, NotFoundException, Param, Post, Req,
  UnprocessableEntityException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { DB_TOKEN } from "../db/token";
import { withActor } from "../db/actor";
import { busRoutes, busStops, transportAssignments, students } from "../db/schema";
import { Perm } from "../common/guards";
import { insertAudit } from "../common/audit";
import { RouteCreateBody, StopCreateBody, TransportAssignBody } from "@portal/contracts";
import type { Request } from "express";

const OPS_ROLES = new Set(["super_admin", "school_admin"]);

/** Transport: routes, stops, per-term student assignments. */
@Controller()
export class TransportController {
  constructor(@Inject(DB_TOKEN) private db: Db) {}

  @Get("transport/routes")
  async routes(@Req() req: Request) {
    const p = req.principal!;
    return withActor(this.db, { userId: p.userId, role: p.activeRole }, async (tx) => {
      const routes = await tx.select().from(busRoutes);
      const stops = await tx.select().from(busStops);
      return { data: { routes, stops } };
    });
  }

  @Post("transport/routes")
  @Perm("transport:write")
  async createRoute(@Req() req: Request, @Body() body: unknown) {
    const parsed = RouteCreateBody.safeParse(body);
    if (!parsed.success) {
      throw new UnprocessableEntityException({ code: "validation", detail: parsed.error.message });
    }
    const p = req.principal!;
    const b = parsed.data;
    return withActor(this.db, { userId: p.userId, role: p.activeRole }, async (tx) => {
      const [route] = await tx.insert(busRoutes).values({
        id: randomUUID(), name: b.name, driverName: b.driver_name ?? null,
        driverPhone: b.driver_phone ?? null, capacity: b.capacity ?? null,
      }).returning();
      await insertAudit(tx, { actorUserId: p.userId, action: "route.created",
        entityType: "bus_route", entityId: route.id, ip: req.ip });
      return route;
    });
  }

  @Post("transport/routes/:id/stops")
  @Perm("transport:write")
  async createStop(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const parsed = StopCreateBody.safeParse(body);
    if (!parsed.success) {
      throw new UnprocessableEntityException({ code: "validation", detail: parsed.error.message });
    }
    const p = req.principal!;
    const b = parsed.data;
    return withActor(this.db, { userId: p.userId, role: p.activeRole }, async (tx) => {
      const [route] = await tx.select({ id: busRoutes.id }).from(busRoutes)
        .where(eq(busRoutes.id, id)).limit(1);
      if (!route) throw new NotFoundException({ code: "not_found" });
      const [stop] = await tx.insert(busStops).values({
        id: randomUUID(), routeId: id, name: b.name,
        pickupTime: b.pickup_time ?? null, seq: b.seq ?? 0,
      }).returning();
      await insertAudit(tx, { actorUserId: p.userId, action: "stop.created",
        entityType: "bus_stop", entityId: stop.id });
      return stop;
    });
  }

  @Post("transport/assignments")
  @Perm("transport:write")
  async assign(@Req() req: Request, @Body() body: unknown) {
    const parsed = TransportAssignBody.safeParse(body);
    if (!parsed.success) {
      throw new UnprocessableEntityException({ code: "validation", detail: parsed.error.message });
    }
    const p = req.principal!;
    const b = parsed.data;
    return withActor(this.db, { userId: p.userId, role: p.activeRole }, async (tx) => {
      const [student] = await tx.select({ userId: students.userId }).from(students)
        .where(eq(students.userId, b.student_user_id)).limit(1);
      if (!student) throw new UnprocessableEntityException({ code: "not_a_student" });
      const [route] = await tx.select({ id: busRoutes.id, capacity: busRoutes.capacity })
        .from(busRoutes).where(eq(busRoutes.id, b.route_id)).limit(1);
      if (!route) throw new UnprocessableEntityException({ code: "route_not_found" });
      const [dupe] = await tx.select({ id: transportAssignments.id }).from(transportAssignments)
        .where(and(eq(transportAssignments.studentUserId, b.student_user_id),
          eq(transportAssignments.termId, b.term_id), eq(transportAssignments.status, "active")))
        .limit(1);
      if (dupe) throw new ConflictException({ code: "already_assigned" });
      // capacity enforcement (was recorded-but-unenforced): active seats per route+term
      if (route.capacity != null && route.capacity > 0) {
        const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(transportAssignments)
          .where(and(eq(transportAssignments.routeId, b.route_id),
            eq(transportAssignments.termId, b.term_id),
            eq(transportAssignments.status, "active")));
        if (n >= route.capacity) {
          throw new ConflictException({ code: "capacity_reached",
            detail: `route is full (${n}/${route.capacity} seats)` });
        }
      }
      const [row] = await tx.insert(transportAssignments).values({
        id: randomUUID(), studentUserId: b.student_user_id, routeId: b.route_id,
        stopId: b.stop_id ?? null, termId: b.term_id,
      }).returning();
      await insertAudit(tx, { actorUserId: p.userId, action: "transport.assigned",
        entityType: "transport_assignment", entityId: row.id, ip: req.ip });
      return row;
    });
  }

  @Delete("transport/assignments/:id")
  @Perm("transport:write")
  async unassign(@Req() req: Request, @Param("id") id: string) {
    const p = req.principal!;
    return withActor(this.db, { userId: p.userId, role: p.activeRole }, async (tx) => {
      const rows = await tx.update(transportAssignments)
        .set({ status: "ended", endedAt: new Date() })
        .where(and(eq(transportAssignments.id, id), eq(transportAssignments.status, "active")))
        .returning();
      if (rows.length === 0) throw new NotFoundException({ code: "not_found" });
      await insertAudit(tx, { actorUserId: p.userId, action: "transport.unassigned",
        entityType: "transport_assignment", entityId: id });
      return { ended: rows.length };
    });
  }

  /** student's own active assignment */
  @Get("student/transport")
  @Perm("self:read")
  async myTransport(@Req() req: Request) {
    const p = req.principal!;
    return withActor(this.db, { userId: p.userId, role: p.activeRole }, async (tx) => {
      const [row] = await tx.select().from(transportAssignments)
        .where(and(eq(transportAssignments.studentUserId, p.userId),
          eq(transportAssignments.status, "active"))).limit(1);
      if (!row) return { data: null };
      const [route] = await tx.select().from(busRoutes).where(eq(busRoutes.id, row.routeId)).limit(1);
      const [stop] = row.stopId
        ? await tx.select().from(busStops).where(eq(busStops.id, row.stopId)).limit(1)
        : [null];
      return { data: { assignment: row, route, stop } };
    });
  }

  /** guardian: child's active assignment */
  @Get("parent/children/:id/transport")
  @Perm("family:read")
  async childTransport(@Req() req: Request, @Param("id") id: string) {
    const p = req.principal!;
    return withActor(this.db, { userId: p.userId, role: p.activeRole }, async (tx) => {
      const [row] = await tx.select().from(transportAssignments)
        .where(and(eq(transportAssignments.studentUserId, id),
          eq(transportAssignments.status, "active"))).limit(1);
      if (!row) return { data: null };
      const [route] = await tx.select().from(busRoutes).where(eq(busRoutes.id, row.routeId)).limit(1);
      const [stop] = row.stopId
        ? await tx.select().from(busStops).where(eq(busStops.id, row.stopId)).limit(1)
        : [null];
      return { data: { assignment: row, route, stop } };
    });
  }
}
