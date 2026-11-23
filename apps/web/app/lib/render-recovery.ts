// A public render error can outlive its deployment: replace an outdated document once per tab.
import { isRouteErrorResponse } from "react-router";
import type { HydrationOptions } from "react-dom/client";
import { STATIC_BASE, STATIC_SITE, STATIC_STATION } from "./deployment.ts";

const RECOVERY_RELEASE_KEY = `aihot-render-recovery-release${STATIC_SITE ? `:${STATIC_STATION}` : ""}`;

export function createRenderErrorHandler(documentRelease: string | null) {
  let checking = false;
  return async (error: unknown, info: Parameters<NonNullable<HydrationOptions["onCaughtError"]>>[1]) => {
    console.error(error, info);
    const failedUrl = window.location.href;
    if (isRouteErrorResponse(error) || /^\/admin(?:\/|$)/.test(new URL(failedUrl).pathname)
      || !documentRelease || documentRelease === "dev" || checking) return;
    checking = true;
    try {
      // If storage is blocked, manual reload stays available without risking a reload loop.
      const storage = window.sessionStorage;
      if (storage.getItem(RECOVERY_RELEASE_KEY) === documentRelease) return;
      const response = await fetch(STATIC_SITE ? `${STATIC_BASE}/data/manifest.json` : "/api/health", { cache: "no-store", signal: AbortSignal.timeout(5_000) });
      if (!response.ok) return;
      const value = await response.json() as { ok?: unknown; release?: unknown; revision?: unknown; station?: unknown };
      const health = STATIC_SITE ? { ok: value.station === STATIC_STATION, release: value.revision } : value;
      if (health.ok !== true || typeof health.release !== "string" || !health.release
        || health.release === "dev" || health.release === documentRelease) return;
      if (window.location.href !== failedUrl) return;
      storage.setItem(RECOVERY_RELEASE_KEY, documentRelease);
      window.location.reload();
    } catch {
      // An unavailable health check or storage must leave the original error and retry visible.
    } finally {
      checking = false;
    }
  };
}
