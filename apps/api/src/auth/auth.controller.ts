import { Body, Controller, Get, Post, Req, Res, HttpException, HttpStatus } from "@nestjs/common";
import type { Request, Response } from "express";
import { randomBytes } from "node:crypto";
import {
  LoginBody, TotpVerifyBody, RecoveryVerifyBody, RoleSwitchBody, TotpEnrollBody,
  ForgotPasswordBody, ResetPasswordBody, ChangePasswordBody, InviteAcceptBody,
} from "@portal/contracts";
import { config } from "../config";
import { rateLimitCheck, rateLimitReset } from "../common/rate-limit";
import { AuthService } from "./auth.service";

const badRequest = (detail: string) => new HttpException(
  { code: "validation", title: "Validation failed", status: 400, detail },
  HttpStatus.BAD_REQUEST);

@Controller("auth")
export class AuthController {
  constructor(private auth: AuthService) {}

  @Get("providers")
  providers() {
    // SSO connections (Entra + Google) are configured per Phase-1 §4; local login always on.
    return { providers: ["local", "entra", "google"], parentEmailLogin: true };
  }

  @Post("login")
  async login(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const parsed = LoginBody.safeParse(body);
    if (!parsed.success) throw badRequest(parsed.error.message);
    const email = parsed.data.email;
    // review-2 #3: tight per-account limit (brute-force) + generous per-IP cap
    // (a whole school shares one public IP; the DB lockout is the durable defence)
    rateLimitCheck(`login:${email.toLowerCase()}`, config.rateLimit.loginMax, config.rateLimit.windowMs);
    rateLimitCheck(`login-ip:${req.ip}`, config.rateLimit.loginIpMax, config.rateLimit.windowMs);
    const out = await this.auth.login(email, parsed.data.password,
      { ip: req.ip, ua: req.headers["user-agent"] });
    rateLimitReset(`login:${email.toLowerCase()}`);
    res.cookie(config.sidCookie, out.token, {
      httpOnly: true, sameSite: "strict", secure: config.cookieSecure,
      path: "/", maxAge: 12 * 60 * 60 * 1000,
    });
    if (!req.cookies?.[config.csrfCookie]) {
      res.cookie(config.csrfCookie, randomBytes(16).toString("base64url"), {
        httpOnly: false, sameSite: "strict", secure: config.cookieSecure, path: "/",
      });
    }
    return { userId: out.userId, roles: out.roles, activeRole: out.activeRole,
      mfaRequired: out.mfaRequired, mfaVerified: out.mfaVerified,
      mustChangePassword: (out as { mustChangePassword?: boolean }).mustChangePassword === true };
  }

  @Get("session")
  session(@Req() req: Request) {
    const p = req.principal!;
    return { userId: p.userId, email: p.email, displayName: p.displayName, roles: p.roles,
      activeRole: p.activeRole, permissions: p.perms,
      mfaVerified: p.mfaVerified, mfaRequired: p.mfaRequired,
      mustChangePassword: p.mustChangePassword === true };
  }

  @Post("logout")
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const out = await this.auth.logout(req.principal!);
    res.clearCookie(config.sidCookie);
    return out;
  }

  /** Enrollment requires an admin-issued single-use token (controlled flow). */
  @Post("mfa/totp/enroll")
  enroll(@Body() body: unknown, @Req() req: Request) {
    const parsed = TotpEnrollBody.safeParse(body ?? {});
    if (!parsed.success) throw badRequest(parsed.error.message);
    return this.auth.totpEnroll(req.principal!, parsed.data.token);
  }

  @Post("mfa/totp/verify")
  async verify(@Body() body: unknown, @Req() req: Request) {
    const parsed = TotpVerifyBody.safeParse(body);
    if (!parsed.success) throw badRequest(parsed.error.message);
    const p = req.principal!;
    rateLimitCheck(`totp:${p.userId}`, config.rateLimit.totpMax, config.rateLimit.windowMs);
    const out = await this.auth.totpVerify(p, parsed.data.code,
      { ip: req.ip, ua: req.headers["user-agent"] });
    rateLimitReset(`totp:${p.userId}`);
    return out;
  }

  /** Recovery-code step-up (review-2 #5): single-use codes from enrollment. */
  @Post("mfa/recovery")
  async recovery(@Body() body: unknown, @Req() req: Request) {
    const parsed = RecoveryVerifyBody.safeParse(body);
    if (!parsed.success) throw badRequest(parsed.error.message);
    const p = req.principal!;
    rateLimitCheck(`recovery:${p.userId}`, config.rateLimit.totpMax, config.rateLimit.windowMs);
    const out = await this.auth.recoveryVerify(p, parsed.data.code,
      { ip: req.ip, ua: req.headers["user-agent"] });
    rateLimitReset(`recovery:${p.userId}`);
    return out;
  }

  @Post("role/switch")
  switchRole(@Body() body: unknown, @Req() req: Request) {
    const parsed = RoleSwitchBody.safeParse(body);
    if (!parsed.success) throw badRequest(parsed.error.message);
    return this.auth.switchRole(req.principal!, parsed.data.role);
  }

  /* ── account lifecycle ── */

  /** Always 202 — never reveals whether the account exists. */
  @Post("password/forgot")
  async forgot(@Body() body: unknown, @Req() req: Request) {
    const parsed = ForgotPasswordBody.safeParse(body);
    if (!parsed.success) throw badRequest(parsed.error.message);
    // review-2 #3: tight per-email (mail-bombing) + generous per-IP (school NAT)
    rateLimitCheck(`forgot:${parsed.data.email.toLowerCase()}`,
      config.rateLimit.forgotEmailMax, config.rateLimit.windowMs);
    rateLimitCheck(`forgot-ip:${req.ip}`, config.rateLimit.accountOpsIpMax, config.rateLimit.windowMs);
    await this.auth.forgotPassword(parsed.data.email, { ip: req.ip, ua: req.headers["user-agent"] });
    return { ok: true };
  }

  @Post("password/reset")
  async reset(@Body() body: unknown, @Req() req: Request) {
    const parsed = ResetPasswordBody.safeParse(body);
    if (!parsed.success) throw badRequest(parsed.error.message);
    rateLimitCheck(`reset-ip:${req.ip}`, config.rateLimit.accountOpsIpMax, config.rateLimit.windowMs);
    return this.auth.resetPassword(parsed.data.token, parsed.data.password,
      { ip: req.ip, ua: req.headers["user-agent"] });
  }

  @Post("password/change")
  change(@Body() body: unknown, @Req() req: Request) {
    const parsed = ChangePasswordBody.safeParse(body);
    if (!parsed.success) throw badRequest(parsed.error.message);
    return this.auth.changePassword(req.principal!, parsed.data.current_password,
      parsed.data.new_password);
  }

  /** Invitee self-onboarding: sets their own password from the emailed link. */
  @Post("invite/accept")
  acceptInvite(@Body() body: unknown, @Req() req: Request) {
    const parsed = InviteAcceptBody.safeParse(body);
    if (!parsed.success) throw badRequest(parsed.error.message);
    rateLimitCheck(`invite-ip:${req.ip}`, config.rateLimit.accountOpsIpMax, config.rateLimit.windowMs);
    return this.auth.acceptInvite(parsed.data.token, parsed.data.password,
      { ip: req.ip, ua: req.headers["user-agent"] });
  }
}
