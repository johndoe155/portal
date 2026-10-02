import {
  Catch, ExceptionFilter, ArgumentsHost, HttpException, HttpStatus,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";

/** RFC 9457 problem+json for every error (Phase 3 §1.2). */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse();
    const req = ctx.getRequest();
    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = "internal";
    let title = "Internal error";
    let detail: string | undefined;
    let retryAfterMs: number | undefined;   // RFC 9457 extension member (lockout/rate limit)
    const pgCode = (exception as { code?: string })?.code;
    if (pgCode === "42501") { // RLS / privilege denied — gate 2 backstop
      status = 403; code = "rls_denied"; title = "Forbidden by data policy";
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse() as Record<string, unknown> | string;
      if (typeof body === "object") {
        code = (body.code as string) ?? codeFor(status);
        title = (body.title as string) ?? exception.message;
        detail = body.detail as string | undefined;
        if (typeof body.retryAfterMs === "number") retryAfterMs = body.retryAfterMs;
      } else { title = body; code = codeFor(status); }
    }
    const traceId = randomUUID();
    res.status(status).set("X-Trace-Id", traceId).json({
      type: `https://portal.school/errors/${code}`,
      title, status, code, detail, trace_id: traceId,
      path: req.url,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
  }
}

function codeFor(status: number): string {
  switch (status) {
    case 400: return "bad_request";
    case 401: return "unauthenticated";
    case 403: return "forbidden";
    case 404: return "not_found";
    case 409: return "conflict";
    case 422: return "validation";
    case 429: return "rate_limited";
    default: return "internal";
  }
}
