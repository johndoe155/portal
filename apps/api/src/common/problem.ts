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
    } else if (pgCode === "LIMIT_FILE_SIZE") {
      // multer: the roster upload exceeded IMPORT_MAX_UPLOAD_MB.
      const mb = process.env.IMPORT_MAX_UPLOAD_MB ?? "25";
      status = 413; code = "file_too_large";
      title = "That file is too large to upload";
      detail = `The limit is ${mb} MB. Split the roster into smaller files (for example by ` +
        `year group) and import them one after another, or raise IMPORT_MAX_UPLOAD_MB.`;
    } else if (pgCode === "LIMIT_UNEXPECTED_FILE" || pgCode === "LIMIT_FILE_COUNT") {
      status = 400; code = "unexpected_file";
      title = "Attach exactly one CSV as the 'file' field";
    } else if ((exception as { type?: string })?.type === "entity.too.large") {
      // body-parser on the 1 MB JSON cap. This used to surface as a bare 500
      // "Internal error", which told an admin pasting a whole-school roster
      // nothing at all about what to do instead.
      status = 413; code = "payload_too_large";
      title = "That request body is too large";
      detail = "The API accepts at most 1 MB of JSON. For roster files use the file upload " +
        "(POST /api/v1/import/<kind>/upload), which streams the file and runs as a " +
        "background job — it is the path designed for whole-school data.";
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse() as Record<string, unknown> | string;
      if (typeof body === "object") {
        code = (body.code as string) ?? codeFor(status);
        title = (body.title as string) ?? exception.message;
        detail = body.detail as string | undefined;
        if (typeof body.retryAfterMs === "number") retryAfterMs = body.retryAfterMs;
      } else { title = body; code = codeFor(status); }
      if (status === 413 && !detail) {
        // Nest's FileInterceptor turns multer's LIMIT_FILE_SIZE into a bare
        // PayloadTooLargeException ("File too large"). Give the admin the fix.
        const mb = process.env.IMPORT_MAX_UPLOAD_MB ?? "25";
        title = "That file is too large to upload";
        detail = `The limit is ${mb} MB. Split the roster into smaller files (for example ` +
          `by year group) and import them one after another, or raise IMPORT_MAX_UPLOAD_MB.`;
      }
    }
    const traceId = randomUUID();
    // A 500 with no explanation anywhere is the hardest thing to debug in this
    // codebase; log the real cause server-side, keep the response opaque.
    if (status >= 500) {
      console.error(`[error] ${traceId} ${req.method} ${req.url}`,
        (exception as any)?.message ?? exception,
        (exception as any)?.cause?.message ?? "",
        (exception as any)?.stack ?? "");
    }
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
    case 413: return "payload_too_large";
    case 429: return "rate_limited";
    default: return "internal";
  }
}
