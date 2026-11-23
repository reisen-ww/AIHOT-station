import type { StaticManifest } from "./static.ts";

/** Data files never select another origin or escape their station's data directory. */
export function staticFilePath(value: string): string {
  if (typeof value !== "string" || !/^(json|md)\/[a-f0-9]{64}\.\1$/.test(value)) throw new Error("unsafe static data path");
  return value;
}

export function parseStaticManifest(value: unknown, station: string): StaticManifest {
  if (!value || typeof value !== "object") throw new Error("missing static manifest");
  const m = value as StaticManifest;
  const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  if (m.schemaVersion !== 1 || m.station !== station || typeof m.revision !== "string" || !/^[a-zA-Z0-9_-]+$/.test(m.revision)
    || typeof m.asOf !== "string" || !Number.isFinite(Date.parse(m.asOf)) || !record(m.files)
    || !Array.isArray(m.bodyShards) || !Array.isArray(m.itemIds) || !Array.isArray(m.routes)
    || !Array.isArray(m.stories) || !record(m.reports) || !record(m.topicPages) || !record(m.aliases)) throw new Error("invalid static manifest");
  const uniqueStrings = (values: unknown[], pattern: RegExp) => values.every((v) => typeof v === "string" && pattern.test(v)) && new Set(values).size === values.length;
  if (!uniqueStrings(m.itemIds, /^[a-zA-Z0-9_-]{1,80}$/) || !uniqueStrings(m.stories, /^[a-f0-9-]{36}$/i)
    || !uniqueStrings(m.routes, /^\/(?:[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*)?$/)
    || !uniqueStrings(m.bodyShards, /^search\/body-\d+$/)) throw new Error("invalid or duplicate static identity");
  for (const [key, file] of Object.entries(m.files)) {
    if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(key)) throw new Error("unsafe static key");
    staticFilePath(file);
  }
  const routes = new Set(m.routes);
  if (m.window) {
    const w = m.window;
    const date = (v: unknown) => v === null || (typeof v === "string" && Number.isFinite(Date.parse(v)));
    const extra = w.scoreRetention;
    if (extra !== undefined && (!record(extra) || !Number.isFinite(extra.minimumScore) || extra.minimumScore < 0 || extra.minimumScore > 100
      || !Number.isSafeInteger(extra.additionalItems) || extra.additionalItems < 0
      || w.onlineItems !== Math.min(w.maxItems, w.publicItems) + extra.additionalItems)) throw new Error("invalid static score retention window");
    if (!Number.isSafeInteger(w.maxItems) || w.maxItems < 1 || !Number.isSafeInteger(w.publicItems) || w.publicItems < 0
      || w.onlineItems !== m.itemIds.length || (extra === undefined && w.onlineItems > w.maxItems) || w.onlineItems > w.publicItems
      || w.searchScope !== "online-window" || !date(w.oldestAt) || !date(w.newestAt)
      || (w.onlineItems > 0 && (!w.oldestAt || !w.newestAt || w.oldestAt > w.newestAt))
      || (w.onlineItems === 0 && (w.oldestAt !== null || w.newestAt !== null))) throw new Error("invalid static article window");
  }
  for (const route of ["/", "/all", "/hot", "/topics", "/daily", "/daily/archive", "/weekly", "/monthly", "/starred", "/more", "/about", "/terms", "/privacy", "/changelog", "/agent"]) {
    if (!routes.has(route)) throw new Error(`missing static route: ${route}`);
  }
  for (const required of ["catalog", "availability", "topics", "hot", "hot-strip", "meta", "changelog", "contact", "stats", ...m.bodyShards]) {
    if (!Object.hasOwn(m.files, required)) throw new Error(`missing static file: ${required}`);
  }
  for (const id of m.itemIds) {
    if (!Object.hasOwn(m.files, `items/${id}`) || !routes.has(`/items/${id}`)) throw new Error("missing public detail");
    if (m.files[`items/${id}/original`] && !routes.has(`/items/${id}/original`)) throw new Error("missing original route");
  }
  for (const id of m.stories) {
    if (!m.files[`stories/${id}`] || !m.files[`stories/${id}/followups`] || !routes.has(`/story/${id}`)) throw new Error("missing public story");
  }
  for (const [alias, target] of Object.entries(m.aliases)) {
    if (!/^[a-f0-9-]{36}$/i.test(alias) || !m.stories.includes(target) || !routes.has(`/story/${alias}`)) throw new Error("invalid story alias");
  }
  for (const [slug, count] of Object.entries(m.topicPages)) {
    if (!/^[a-zA-Z0-9_-]+$/.test(slug) || !Number.isSafeInteger(count) || count < 1) throw new Error("invalid topic pages");
    for (let page = 1; page <= count; page++) {
      if (!m.files[`topics/${slug}/${page}`] || !routes.has(page === 1 ? `/topics/${slug}` : `/topics/${slug}/page/${page}`)) throw new Error("missing topic page");
    }
  }
  for (const kind of ["daily", "weekly", "monthly"] as const) {
    if (!Array.isArray(m.reports[kind])) throw new Error("invalid report index");
    const pattern = kind === "daily" ? /^\d{4}-\d{2}-\d{2}$/ : kind === "weekly" ? /^\d{4}-W\d{2}$/ : /^\d{4}-\d{2}$/;
    const keys = new Set<string>();
    for (const issue of m.reports[kind]) {
      if (!issue || !pattern.test(issue.key) || keys.has(issue.key) || !Number.isSafeInteger(issue.issueNumber) || issue.issueNumber < 1
        || !Number.isSafeInteger(issue.count) || issue.count < 0 || !(issue.title === null || typeof issue.title === "string")
        || !m.files[`reports/${kind}/${issue.key}`] || !routes.has(`/${kind}/${issue.key}`)) throw new Error("invalid or missing report detail");
      keys.add(issue.key);
    }
  }
  return m;
}
