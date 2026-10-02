/** Isomorphic helpers (no "use client", no server-only imports). */
export const todayIso = () => new Date().toISOString().slice(0, 10);
