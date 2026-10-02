import { BadRequestException, Body, Controller, Get, Param, Post, Query, Req, Res } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import { config } from "../config";
import { AuthService } from "./auth.service";
import {
  authorizeUrl, claimsOf, createSsoFlow, exchangeCode, getProvider, signLinkToken,
  verifyFlowCookie, verifyIdToken, verifyState,
} from "./sso.service";
import { STAFF_ROLES } from "../common/principal";
import { rateLimitCheck, rateLimitReset } from "../common/rate-limit";
import { SsoLinkBody } from "@portal/contracts";

/**
 * OIDC authorization-code flow (Entra ID + Google Workspace, Phase-1 §4).
 * Public routes — the session middleware whitelists /api/v1/auth/sso/*.
 * The callback sets the session cookie on the WEB origin because the browser
 * arrives via the BFF rewrite (ADR-012); redirect_uri points there too.
 *
 * review-3 #2: the PKCE code_verifier and OIDC nonce live ONLY in the
 * short-lived httpOnly `sso_flow` cookie. The URL `state` param is a signed
 * correlation id with no secrets — URLs leak (history, IdP logs, Referer),
 * and a verifier in the URL would reduce PKCE to decoration. The callback
 * requires cookie.sid === state.sid, which doubles as the login-CSRF
 * binding (round-2 fix): an attacker's code+state cannot complete in a
 * browser that never ran /start.
 *
 * sameSite=lax (NOT strict): the callback is a cross-site top-level
 * navigation from the IdP — strict cookies would not be sent on it.
 */
export const SSO_FLOW_COOKIE = "sso_flow";

@Controller("auth/sso")
export class SsoController {
  constructor(private auth: AuthService) {}

  @Get(":provider/start")
  start(@Param("provider") provider: string, @Res() res: Response) {
    let p;
    try { p = getProvider(provider); }
    catch (e: any) {
      if (e?.code === "sso_not_configured") {
        throw new BadRequestException({ code: "sso_not_configured", detail: e.message });
      }
      throw e;
    }
    const flow = createSsoFlow(provider);
    res.cookie(SSO_FLOW_COOKIE, flow.cookie, {
      httpOnly: true, sameSite: "lax", secure: config.cookieSecure,
      path: "/api/v1/auth/sso", maxAge: config.ssoStateTtlMs,
    });
    res.redirect(302, authorizeUrl(p, flow.state, flow.nonce, flow.verifier));
  }

  @Get(":provider/callback")
  async callback(@Param("provider") provider: string,
                 @Query("code") code: string, @Query("state") state: string,
                 @Req() req: Request, @Res() res: Response) {
    const fail = (detail: string) => {
      clearFlowCookie(res);
      return res.redirect(302, `${config.publicWebOrigin}/login?sso_error=${encodeURIComponent(detail)}`);
    };
    let p;
    try { p = getProvider(provider); } catch { return fail("provider not configured"); }
    if (!code || !state) return fail("missing code or state");
    // Bind the callback to the browser that started the flow (login CSRF).
    const flowCookie = req.cookies?.[SSO_FLOW_COOKIE];
    if (!flowCookie) return fail("sso flow cookie missing — restart the login");
    let sid: string;
    try { sid = verifyState(state, provider).sid; } catch (e: any) { return fail(`state: ${e.message}`); }
    let nonce: string, verifier: string;
    try {
      ({ nonce, verifier } = verifyFlowCookie(flowCookie, provider, sid));
    } catch (e: any) { return fail(String(e.message)); }
    try {
      const idToken = await exchangeCode(p, code, verifier);
      const payload = await verifyIdToken(p, idToken, { nonce });
      const claims = claimsOf(payload as any);
      // review-3 #3 (nOAuth): email linking is only as trustworthy as the
      // IdP's email verification. Providers exempt from email_verified
      // (Entra) may ONLY sign in pre-linked identities (oid:tid) or JIT
      // provisioning — never claim an existing directory account by email.
      const out = await this.auth.ssoLogin(provider, claims, p.jitRole,
        { ip: req.ip, ua: req.headers["user-agent"] },
        { allowEmailLink: p.requireEmailVerified !== false });
      clearFlowCookie(res);
      res.cookie(config.sidCookie, out.token, {
        httpOnly: true, sameSite: "strict", secure: config.cookieSecure,
        path: "/", maxAge: 12 * 60 * 60 * 1000,
      });
      if (!req.cookies?.[config.csrfCookie]) {
        res.cookie(config.csrfCookie, randomBytes(16).toString("base64url"), {
          httpOnly: false, sameSite: "strict", secure: config.cookieSecure, path: "/",
        });
      }
      // staff still face the MFA gate after SSO (web redirects on session.mfaRequired)
      const needsMfa = out.roles.some((r) => STAFF_ROLES.has(r));
      res.redirect(302, `${config.publicWebOrigin}${needsMfa ? "/mfa" : "/"}`);
    } catch (e: any) {
      const code = e?.response?.code ?? e?.message ?? "sso_failed";
      // review-4 #4: existing account + unverified-email provider → send the
      // user to the password-proven linking form instead of a dead end.
      if (e?.ssoLink) {
        clearFlowCookie(res);
        const linkToken = signLinkToken(e.ssoLink.provider, e.ssoLink.sub, e.ssoLink.email);
        return res.redirect(302, `${config.publicWebOrigin}/login?sso_error=sso_link_required` +
          `&link_token=${encodeURIComponent(linkToken)}`);
      }
      if (e?.status === 403 || code === "sso_user_not_provisioned") {
        clearFlowCookie(res);
        return res.status(403).json({ code: "sso_user_not_provisioned",
          title: "No portal account is linked to this identity" });
      }
      return fail(String(code).slice(0, 120)); // fail() clears the cookie
    }
  }

  /**
   * review-4 #4: complete account linking. The link_token (issued by the
   * callback above) binds provider+sub+email; the user proves ownership of
   * the portal account with their password. Public route (auth/sso/* prefix)
   * — rate limited per email AND per IP; wrong passwords count against the
   * account lockout via the shared login limiter key.
   */
  @Post("link")
  async link(@Body() body: unknown, @Req() req: Request,
             @Res({ passthrough: true }) res: Response) {
    const parsed = SsoLinkBody.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({ code: "validation", detail: parsed.error.message });
    }
    const email = parsed.data.email;
    rateLimitCheck(`login:${email.toLowerCase()}`, config.rateLimit.loginMax, config.rateLimit.windowMs);
    rateLimitCheck(`login-ip:${req.ip}`, config.rateLimit.loginIpMax, config.rateLimit.windowMs);
    const out = await this.auth.ssoLink(parsed.data.link_token, email, parsed.data.password,
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
    const needsMfa = out.roles.some((r) => STAFF_ROLES.has(r));
    return { userId: out.userId, email: out.email, roles: out.roles,
      activeRole: out.activeRole, mfaRequired: needsMfa, mfaVerified: false };
  }
}

function clearFlowCookie(res: Response) {
  res.clearCookie(SSO_FLOW_COOKIE, { path: "/api/v1/auth/sso", httpOnly: true, sameSite: "lax" });
}
