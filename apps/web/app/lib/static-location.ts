import { STATIC_BASE, STATIC_SITE } from "./deployment.ts";

/** The Pages project root's custom 404 hands the untouched URL to a station document. */
export function restoreStaticLocation() {
  if (!STATIC_SITE) return;
  const location = new URL(window.location.href);
  const original = location.searchParams.get("__hot_path");
  if (!original || location.pathname !== `${STATIC_BASE}/404.html`) return;
  let target: URL;
  try { target = new URL(original, location.origin); } catch { return; }
  if (target.origin !== location.origin || !target.pathname.startsWith(`${STATIC_BASE}/`)
    || target.pathname === `${STATIC_BASE}/404.html`) return;
  window.history.replaceState(window.history.state, "", target.pathname + target.search + target.hash);
}
