/// <reference types="vite/client" />
// Also imported by Node-only SEO tests: keep Vite's ImportMeta types available at this shared boundary.
// React Router handles Link/Form destinations; plain resources and loader request paths need the same base.
export const STATIC_SITE = import.meta.env?.VITE_STATION_STATIC === "1";
export const STATIC_BASE = (import.meta.env?.VITE_STATIC_BASE ?? "").replace(/\/+$/, "");
export const STATIC_STATION = import.meta.env?.VITE_STATIC_STATION ?? "";

export function sitePath(path: string): string {
  if (!STATIC_SITE || !path.startsWith("/") || path.startsWith("//") || path === STATIC_BASE || path.startsWith(`${STATIC_BASE}/`)) return path;
  return `${STATIC_BASE}${path}`;
}

export function localPath(path: string): string {
  if (!STATIC_SITE || !STATIC_BASE) return path;
  if (path === STATIC_BASE) return "/";
  return path.startsWith(`${STATIC_BASE}/`) ? path.slice(STATIC_BASE.length) : path;
}

export function markdownPath(id: string): string {
  return sitePath(STATIC_SITE ? `/items/${id}/export.md` : `/items/${id}/markdown`);
}

/** Reused server loaders inspect /weekly, /all, etc., not the deployment's /hot-pages/<station> prefix. */
export function localLoaderRequest(request: Request): Request {
  const url = new URL(request.url);
  url.pathname = localPath(url.pathname);
  return new Request(url, { method: "GET", signal: request.signal, headers: request.headers });
}
