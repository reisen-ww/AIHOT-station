// Static-build HTTP adapter. Both prerender and the browser use the same content-addressed snapshot.
import { redirect } from "react-router";
import type { ItemAvailability, ReportDetail, ReportKind, ReportNavigationEntry } from "@aihot/contracts/site";
import type { StaticCatalog, StaticGroup, StaticManifest, StaticSearchBody } from "@aihot/contracts/static";
import { parseStaticManifest, staticFilePath } from "@aihot/contracts/static-manifest";
import { queryStaticGroup, queryStaticPool, queryStaticTimeline, StaticCursorError } from "@aihot/contracts/static-query";
import { readFilters } from "./seo";
import { STATIC_BASE, STATIC_STATION } from "./deployment";

export class StaticSnapshotChanged extends Error {}
const dataBase = () => `${window.location.origin}${STATIC_BASE}/data/`;
let manifestPromise: Promise<StaticManifest> | null = null;
const values = new Map<string, Promise<unknown>>();

/** Cancelling one caller must not abort the immutable download another caller is already sharing. */
function waitForRead<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

const missing = () => Response.json({ message: "not_found" }, { status: 404 });

async function manifest(): Promise<StaticManifest> {
  manifestPromise ??= fetch(`${dataBase()}manifest.json`, { cache: "no-cache", signal: AbortSignal.timeout(15_000) }).then(async (res) => {
    if (!res.ok) throw new Error("static snapshot unavailable");
    const m = parseStaticManifest(await res.json(), STATIC_STATION);
    const documentRevision = typeof document === "undefined" ? null : document.querySelector('meta[name="aihot-release"]')?.getAttribute("content");
    if (documentRevision && documentRevision !== m.revision) throw new StaticSnapshotChanged("站点已更新，请刷新后继续。");
    return m;
  }).catch((error) => { manifestPromise = null; throw error; });
  return manifestPromise;
}

async function file<T>(key: string, m: StaticManifest): Promise<T> {
  const relative = m.files[key];
  if (!relative) throw missing();
  let value = values.get(relative);
  if (!value) {
    value = fetch(new URL(staticFilePath(relative), dataBase()), { signal: AbortSignal.timeout(15_000) }).then(async (res) => {
      if (!res.ok) throw new Error(`snapshot file unavailable: ${key}`);
      const bytes = await res.arrayBuffer();
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
      if (relative.split("/")[1].split(".")[0] !== hash) throw new Error(`snapshot integrity check failed: ${key}`);
      const text = new TextDecoder().decode(bytes);
      return relative.endsWith(".md") ? text : JSON.parse(text);
    }).catch((error) => { values.delete(relative); throw error; });
    values.set(relative, value);
  }
  return await value as T;
}

function navigation(kind: ReportKind, m: StaticManifest, key: string): ReportNavigationEntry[] {
  const index = m.reports[kind];
  const at = index.findIndex((e) => e.key === key);
  return index.map((e, i) => ({ key: e.key, issueNumber: e.issueNumber,
    ...(kind !== "daily" || e.key.slice(0, 7) === key.slice(0, 7) || i < 3 || Math.abs(i - at) <= 1 ? { title: e.title } : {}) }));
}

export async function apiGet<T>(path: string, init?: { signal?: AbortSignal; headers?: Record<string, string>; responseHeaders?: Headers }): Promise<T> {
  init?.signal?.throwIfAborted();
  return waitForRead(readApi<T>(path, init?.signal), init?.signal);
}

async function readApi<T>(path: string, signal?: AbortSignal): Promise<T> {
  const m = await manifest();
  signal?.throwIfAborted();
  const url = new URL(path, "https://static.invalid");
  const pathname = url.pathname;
  const filters = readFilters(url.searchParams);
  let result: unknown;
  if (pathname === "/api/health") {
    result = { ok: true, release: m.revision, asOf: m.asOf };
  } else if (pathname === "/api/site/timeline") {
    const catalog = await file<StaticCatalog>("catalog", m);
    if (catalog.revision !== m.revision || catalog.station !== m.station) throw new StaticSnapshotChanged("snapshot data does not match its manifest");
    try {
      const timeline = queryStaticTimeline(catalog, { ...filters, cursor: url.searchParams.get("cursor"), limit: Number(url.searchParams.get("limit")) || 20 });
      const unfiltered = filters.channel === "all" && !filters.category && !filters.tag && !url.searchParams.has("cursor");
      result = { ...timeline, hot: unfiltered ? await file("hot-strip", m) : null };
    } catch (error) {
      if (error instanceof StaticCursorError) throw Response.json({ message: "invalid_cursor" }, { status: 400 });
      throw error;
    }
  } else if (pathname === "/api/site/pool") {
    const catalog = await file<StaticCatalog>("catalog", m);
    if (catalog.revision !== m.revision || catalog.station !== m.station) throw new StaticSnapshotChanged("snapshot data does not match its manifest");
    const q = url.searchParams.get("q");
    const tab = url.searchParams.get("tab") === "relevance" ? "relevance" : "time";
    let bodies: Map<string, string> | undefined;
    if (q && tab === "relevance") {
      bodies = new Map();
      for (const shard of m.bodyShards) {
        signal?.throwIfAborted();
        for (const row of await file<StaticSearchBody[]>(shard, m)) bodies.set(row.id, row.text);
      }
    }
    result = queryStaticPool(catalog, { ...filters, q, tab, page: Number(url.searchParams.get("page")) || 1 }, bodies);
  } else if (pathname === "/api/site/items/availability") {
    const available = await file<Record<string, ItemAvailability>>("availability", m);
    result = Object.fromEntries((url.searchParams.get("ids") ?? "").split(",").filter(Boolean).slice(0, 500)
      .map((id) => [id, available[id] ?? { status: "unavailable" }]));
  } else if (/^\/api\/site\/items\/[a-zA-Z0-9_-]+(?:\/original)?$/.test(pathname)) {
    let key = pathname.replace("/api/site/", "");
    if (!m.files[key] && !m.files[key.replace(/\/original$/, "")]) {
      const id = pathname.split("/")[4];
      const available = await file<Record<string, ItemAvailability>>("availability", m);
      if (available[id]?.status === "outside-window") throw Response.json({ message: "outside_window", ...available[id] }, { status: 410 });
    }
    if (key.endsWith("/original") && !m.files[key]) key = key.slice(0, -9);
    result = await file(key, m);
  } else if (/^\/api\/site\/groups\/[^/]+\/reports$/.test(pathname)) {
    const factId = decodeURIComponent(pathname.split("/")[4]);
    result = queryStaticGroup(await file<StaticGroup>(`groups/${factId}`, m), filters);
    if (!result) throw missing();
  } else if (/^\/api\/site\/stories\/[^/]+(?:\/followups)?$/.test(pathname)) {
    const id = pathname.split("/")[4];
    if (m.aliases[id]) throw redirect(`/story/${m.aliases[id]}`, 308);
    result = await file(pathname.replace("/api/site/", ""), m);
  } else if (pathname.startsWith("/api/site/reports/")) {
    const [, , , , kind, ...rest] = pathname.split("/");
    if (!["daily", "weekly", "monthly"].includes(kind)) throw missing();
    const k = kind as ReportKind;
    if (!rest.length) result = { kind, items: m.reports[k] };
    else if (rest[0] === "latest-page") {
      const key = m.reports[k][0]?.key;
      result = { index: navigation(k, m, key ?? ""), report: key ? await file<ReportDetail>(`reports/${kind}/${key}`, m) : null };
    } else if (rest[0] === "navigation") result = { items: navigation(k, m, rest[1]) };
    else if (rest[0] === "months") result = { items: m.reports[k].filter((e) => e.key.startsWith(rest[1])).map(({ key, issueNumber, title }) => ({ key, issueNumber, title })) };
    else result = await file(`reports/${kind}/${rest[0]}`, m);
  } else if (/^\/api\/site\/topics\/[^/]+$/.test(pathname)) {
    result = await file(`topics/${decodeURIComponent(pathname.split("/")[4])}/${Number(url.searchParams.get("page")) || 1}`, m);
  } else if (["meta", "topics", "hot", "changelog", "contact", "stats"].some((key) => pathname === `/api/site/${key}`)) {
    const key = pathname.split("/").at(-1)!;
    result = await file(key, m);
    if (key === "meta") result = { ...result as object, release: m.revision, articleWindow: m.window ?? null };
  } else throw missing();
  signal?.throwIfAborted();
  return result as T;
}

export function loadOr404<T>(path: string, opts: { busyRedirect?: string; merged?: (id: string) => string; responseHeaders?: Headers; signal?: AbortSignal } = {}): Promise<T> {
  return apiGet<T>(path, opts);
}
export const edgeTtl = (_seconds: number): Record<string, string> => ({});
export const apiDeadlineCache = (_seconds: number, _now?: number, _upstream?: Headers): Record<string, string> => ({});

export async function staticFetch(path: string, init?: RequestInit): Promise<Response> {
  if (init?.method && init.method !== "GET") return new Response("Static site is read-only", { status: 405 });
  const url = new URL(path, "https://static.invalid");
  try {
    const signal = init?.signal ?? undefined;
    signal?.throwIfAborted();
    if (/^\/items\/[^/]+\/markdown$/.test(url.pathname)) {
      const m = await waitForRead(manifest(), signal);
      const id = url.pathname.split("/")[2];
      if (!m.files[`markdown/${id}`]) {
        const available = await waitForRead(file<Record<string, ItemAvailability>>("availability", m), signal);
        if (available[id]?.status === "outside-window") return Response.json({ message: "outside_window" }, { status: 410 });
      }
      const text = await waitForRead(file<string>(`markdown/${id}`, m), signal);
      return new Response(text, { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
    }
    return Response.json(await apiGet(path, { signal: init?.signal ?? undefined }));
  } catch (error) {
    if (error && typeof error === "object" && "status" in error && typeof error.status === "number") {
      return Response.json({ detail: "Static data unavailable" }, { status: error.status });
    }
    throw error;
  }
}
