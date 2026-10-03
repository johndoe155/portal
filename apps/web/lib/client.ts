"use client";
/** Browser API helper: same-origin via BFF rewrite; CSRF double-submit from cookie. */

function csrfToken(): string {
  const m = document.cookie.match(/(?:^|;\s*)csrf=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : "";
}

export class ApiError extends Error {
  status: number; code: string;
  /** The server's longer explanation, when it sent one — worth showing. */
  detail?: string;
  constructor(status: number, code: string, message: string, detail?: string) {
    super(message); this.status = status; this.code = code; this.detail = detail;
  }
}

export async function api<T = unknown>(path: string, init?: RequestInit & { idempotencyKey?: string }): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json");
  headers.set("x-csrf", csrfToken());
  if (init?.idempotencyKey) headers.set("idempotency-key", init.idempotencyKey);
  const res = await fetch(`/api/v1${path}`, { ...init, headers, credentials: "same-origin" });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(res.status, body?.code ?? "error",
      body?.title ?? body?.detail ?? res.statusText, body?.detail);
  }
  return body as T;
}
