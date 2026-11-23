// A snapshot is publishable only as a complete, byte-verified public reference closure.
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { StaticCatalog, StaticManifest, StaticSearchBody } from "@aihot/contracts/static";
import type { ItemAvailability, SiteItemDetail } from "@aihot/contracts/site";
import { staticFilePath } from "@aihot/contracts/static-manifest";
import { PUBLIC_API_CATEGORY_KEYS } from "@aihot/contracts/taxonomy";
import * as cheerio from "cheerio";
import { Marked, type Tokens } from "marked";

export const digest = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Symlinks and unexpected local files must never enter the public tree through recursive copying. */
export async function staticInventory(directory: string, prefix = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(path.join(directory, prefix), { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`static symlink refused: ${name}`);
    if (entry.isDirectory()) files.push(...await staticInventory(directory, name));
    else if (entry.isFile()) files.push(name);
    else throw new Error(`unsupported static entry: ${name}`);
  }
  return files.sort();
}

// GFM may heuristically join a bare URL to adjacent Chinese prose and produce an invalid host.
// That text is not an authored link. Keep explicit/angle/reference links and all valid autolinks
// strict; only stop inventing hrefs from bare text that cannot represent a URL at all.
const referenceMarkdown = new Marked({ renderer: {
  link(token: Tokens.Link) {
    if (token.autolink && /^(?:https?:\/\/|www\.)/i.test(token.raw)) {
      try { new URL(token.href); } catch { return this.parser.parseInline(token.tokens); }
    }
    return false;
  },
} });

/** Read rendered links, including escaped RSS descriptions and reference-style Markdown. */
export function staticDocumentLinks(text: string, kind: "html" | "markdown" | "xml"): string[] {
  const links: string[] = [];
  const html = (value: string) => {
    const $ = cheerio.load(value, null, false);
    $("[href]").each((_, element) => { const href = $(element).attr("href"); if (href) links.push(href); });
  };
  if (kind === "xml") {
    const $ = cheerio.load(text, { xml: true });
    $("link, loc").each((_, element) => { const value = $(element).text().trim(); if (value) links.push(value); });
    $("description, content\\:encoded").each((_, element) => html($(element).text()));
  } else html(kind === "markdown" ? referenceMarkdown.parse(text, { async: false, gfm: true }) : text);
  return links;
}

// Export/build callers retain their own industry vocabulary. The cross-station runner supplies
// the snapshot's declared category feeds instead of importing the AI station's taxonomy.
export async function validateStaticData(directory: string, m: StaticManifest, siteUrl?: string, publicCategoryKeys: readonly string[] = PUBLIC_API_CATEGORY_KEYS) {
  if (!Array.isArray(publicCategoryKeys) || !publicCategoryKeys.length || new Set(publicCategoryKeys).size !== publicCategoryKeys.length
    || publicCategoryKeys.some(key => typeof key !== "string" || !/^[a-zA-Z0-9_-]+$/.test(key))) throw new Error("invalid public category feeds");
  const knownFiles = new Set(Object.values(m.files));
  const items = new Set(m.itemIds), stories = new Set(m.stories), routes = new Set(m.routes);
  const requiredFeeds = ["selected", "full", "all", "daily", "weekly", "monthly",
    ...["selected", "full"].flatMap((name) => publicCategoryKeys.map((category) => `${name}/category/${category}`))];
  const site = new URL(siteUrl ?? `https://static.invalid/hot-pages/${m.station}`);
  const base = site.pathname.replace(/\/+$/, "");
  const linkedPaths = new Set([...m.routes, "/data/manifest.json", "/agent/index.md", "/llms.txt", "/feed.xml",
    ...requiredFeeds.filter(name => name !== "selected").map(name => `/feed/${name}.xml`),
    ...publicCategoryKeys.map(category => `/feed/category/${category}.xml`),
    ...Object.entries(m.files).filter(([key]) => key.startsWith("markdown/")).map(([key]) => `/items/${key.slice(9)}/export.md`),
    ...Object.values(m.files).map(file => `/data/${file}`),
    ...["daily", "weekly", "monthly"].flatMap(kind => m.reports[kind as keyof typeof m.reports].length
      ? [`/agent/${kind}.md`, ...m.reports[kind as keyof typeof m.reports].map(issue => `/agent/${kind}/${issue.key}.md`)] : [])]);
  const link = (raw: string) => {
    if (raw.startsWith("#")) return;
    const target = new URL(raw, site.href.replace(/\/$/, "") + "/");
    if (target.origin !== site.origin) return;
    if (target.pathname !== base && !target.pathname.startsWith(base + "/")) throw new Error(`static link escapes station: ${raw}`);
    const relative = decodeURIComponent(target.pathname.slice(base.length)).replace(/\/+$/, "") || "/";
    if (!linkedPaths.has(relative)) throw new Error(`unresolved static link: ${raw}`);
  };
  for (const name of requiredFeeds) if (!m.files[`feeds/${name}`]) throw new Error(`missing public feed: ${name}`);
  const media = new Set<string>();
  for (const relative of knownFiles) {
    const bytes = await readFile(path.join(directory, staticFilePath(relative)));
    if (digest(bytes) !== relative.split("/")[1].split(".")[0]) throw new Error(`static checksum mismatch: ${relative}`);
    const text = bytes.toString("utf8");
    if (/\/api\/img-proxy\?/.test(text)) throw new Error(`unprepared media in ${relative}`);
    for (const match of text.matchAll(/\/data\/(media\/[a-f0-9]{64}\.(?:png|jpg|webp|gif|svg|avif))/g)) media.add(match[1]);
  }
  for (const file of media) {
    const bytes = await readFile(path.join(directory, file));
    if (!bytes.length || digest(bytes) !== path.basename(file).split(".")[0]) throw new Error(`static media checksum mismatch: ${file}`);
  }
  for (const file of await staticInventory(directory)) {
    if (file !== "manifest.json" && !knownFiles.has(file) && !media.has(file)) throw new Error(`unlisted static data file: ${file}`);
  }
  const get = async <T>(key: string): Promise<T> => {
    if (!m.files[key]) throw new Error(`missing public data: ${key}`);
    const bytes = await readFile(path.join(directory, staticFilePath(m.files[key])));
    if (digest(bytes) !== path.basename(m.files[key]).split(".")[0]) throw new Error(`static checksum mismatch: ${key}`);
    return (m.files[key].endsWith(".json") ? JSON.parse(bytes.toString("utf8")) : bytes.toString("utf8")) as T;
  };
  const item = (id: unknown) => { if (typeof id !== "string" || !items.has(id)) throw new Error(`missing referenced item: ${String(id)}`); };
  const story = (id: unknown) => { if (typeof id !== "string" || !stories.has(m.aliases[String(id)] ?? id)) throw new Error(`missing referenced story: ${String(id)}`); };
  const checkRefs = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(checkRefs); return; }
    if (typeof value === "string") { if (/\bhref\s*=/i.test(value)) staticDocumentLinks(value, "html").forEach(link); return; }
    if (!value || typeof value !== "object") return;
    const r = value as Record<string, any>;
    // Withdrawn citations retain a title only, never prose or a clickable original address.
    if (r.available === false) {
      if (r.summary || r.sourceUrl || r.sourceIconUrl || r.related?.length) throw new Error("withdrawn citation still exposes content");
      return;
    }
    for (const field of ["itemId", "leadItemId"]) if (r[field]) item(r[field]);
    if (r.sameEvent) item(r.sameEvent.id);
    if (r.latestReport) item(r.latestReport.id);
    if (r.representative) item(r.representative.id);
    if (r.story) story(r.story.publicId);
    if (r.storyPublicId) story(r.storyPublicId);
    if (Array.isArray(r.relatedStories)) r.relatedStories.forEach((s: any) => story(s.publicId));
    Object.values(r).forEach(checkRefs);
  };
  const catalog = await get<StaticCatalog>("catalog");
  if (catalog.schemaVersion !== 1 || catalog.station !== m.station || catalog.revision !== m.revision || catalog.asOf !== m.asOf) throw new Error("catalog is bound to a different snapshot");
  const catalogIds = new Set<string>();
  for (const row of catalog.items) {
    item(row.item.id);
    if (catalogIds.has(row.item.id)) throw new Error("duplicate catalog item");
    catalogIds.add(row.item.id);
    if (!Number.isFinite(Date.parse(row.sortAt))) throw new Error("invalid public ordering time");
    if (row.fact && !m.files[`groups/${row.fact.publicId}`]) throw new Error("missing fact reports");
    checkRefs(row.item);
  }
  for (const entity of catalog.entities) entity.itemIds.forEach(item);
  const availability = await get<Record<string, ItemAvailability>>("availability");
  let outside = 0;
  for (const [id, value] of Object.entries(availability)) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id) || !["public", "summary-only", "outside-window"].includes(value.status)) throw new Error("invalid static availability");
    if (value.status === "outside-window") {
      if (!m.window || items.has(id) || m.files[`items/${id}`] || m.files[`markdown/${id}`]) throw new Error("out-of-window item exposes online content");
      if (value.originalUrl && !/^https?:\/\//i.test(value.originalUrl)) throw new Error("invalid out-of-window original");
      outside++;
    } else if (!items.has(id)) throw new Error("availability exposes a missing public detail");
  }
  if (m.window && outside + items.size !== m.window.publicItems) throw new Error("window public count disagrees with availability");
  const fullItems = new Set<string>();
  for (const id of items) {
    const detail = await get<SiteItemDetail>(`items/${id}`);
    if (detail.id !== id || !["public", "summary-only"].includes(availability[id]?.status)) throw new Error("invalid public detail identity or availability");
    if (detail.readingMode === "summary-only" && detail.body) throw new Error("summary-only item exposes a body");
    if (detail.markdownAvailable !== !!m.files[`markdown/${id}`]) throw new Error("Markdown availability does not match its file");
    if (detail.readingMode === "full") fullItems.add(id);
  }
  const bodyIds = new Set<string>();
  for (const shard of m.bodyShards) for (const row of await get<StaticSearchBody[]>(shard)) {
    item(row.id);
    if (bodyIds.has(row.id) || typeof row.text !== "string" || !fullItems.has(row.id)) throw new Error("invalid licensed search body");
    bodyIds.add(row.id);
  }
  for (const [key, relative] of Object.entries(m.files)) {
    const value = await get<any>(key);
    if (key.startsWith("feeds/")) {
      if (typeof value !== "string" || !value.includes("<rss") || !value.includes("</rss>")) throw new Error(`invalid RSS: ${key}`);
      staticDocumentLinks(value, "xml").forEach(link);
    } else if (key.startsWith("markdown/")) { item(key.slice(9)); staticDocumentLinks(value, "markdown").forEach(link); }
    else if (key.startsWith("items/")) {
      item(key.split("/")[1]);
      if (value.id !== key.split("/")[1]) throw new Error("mismatched item file");
    } else if (key.startsWith("groups/")) {
      if (value.factId !== key.slice(7)) throw new Error("mismatched fact file");
      value.reports.forEach((r: any) => item(r.id));
    } else if (key.startsWith("stories/")) {
      story(key.split("/")[1]);
      if (!key.endsWith("/followups") && value.publicId !== key.split("/")[1]) throw new Error("mismatched story file");
      for (const r of [...value.timeline ?? [], ...value.officialReports ?? []]) item(r.id);
      for (const related of value.related ?? []) story(related.publicId);
    } else if (key.startsWith("topics/")) value.items.forEach((i: any) => item(i.id));
    else if (key === "hot") value.entries.forEach((entry: any) => story(entry.story.publicId));
    else if (key === "stats") value.latest.forEach((entry: any) => item(entry.id));
    else if (key === "media-fallbacks") {
      if (!Array.isArray(value)) throw new Error("invalid media fallback audit");
      for (const entry of value) if (!entry || !["dns", "network", "http"].includes(entry.kind)
        || (entry.kind === "http" ? ![403, 404, 410, 429].includes(entry.status) : Object.hasOwn(entry, "status")) || typeof entry.key !== "string"
        || !m.files[entry.key] || typeof entry.field !== "string" || !/(?:sourceIcon|icon)(?:Url|SrcSet)$/.test(entry.field)
        || Object.keys(entry).some((key) => !["key", "field", "kind", "status"].includes(key))) throw new Error("invalid media fallback audit entry");
    }
    else if (!["catalog", "availability", "topics", "hot-strip", "meta", "changelog", "contact", "stats"].includes(key)
      && !key.startsWith("reports/") && !m.bodyShards.includes(key)) throw new Error(`unknown public data key: ${key}`);
    checkRefs(value);
  }
  for (const topic of (await get<any>("topics")).topics) if (!m.topicPages[topic.slug]) throw new Error("topic index points to a missing topic");
  for (const route of routes) {
    const [, kind, id] = route.split("/");
    if (kind === "items") item(id);
    else if (kind === "story") story(id);
    else if (kind === "topics" && id && !m.topicPages[id]) throw new Error("route points to a missing topic");
    else if (["daily", "weekly", "monthly"].includes(kind) && id && id !== "archive" && !m.files[`reports/${kind}/${id}`]) throw new Error("route points to a missing report");
  }
  return { files: knownFiles.size, media: media.size, items: items.size, routes: routes.size };
}
