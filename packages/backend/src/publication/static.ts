// Static is another public outlet. Read one repeatable-read transaction, using the same page projections.
import { createHash } from "node:crypto";
import type { StaticCatalog, StaticGroup, StaticListItem, StaticManifest, StaticSearchBody, StaticSink } from "@aihot/contracts/static";
import type { ItemAvailability, ReportKind } from "@aihot/contracts/site";
import { sql as connection } from "../db.ts";
import { siteMeta, loadChangelog } from "../site/meta.ts";
import { loadContact, loadMakerAvatar } from "../site/contact.ts";
import { loadSiteStats } from "../site/stats.ts";
import { ITEM_COLUMNS, ITEM_FROM, seatHolders, toFeedItemSummary, type ItemRow } from "./items.ts";
import { evidenceCondition, listedCondition, ownFactEvidenceCondition, releasedCondition, selectedCondition } from "./scope.ts";
import { publicSourceName } from "./rules.ts";
import { loadItemDetail, exportMarkdown } from "./detail.ts";
import { loadHot, loadStoryDetail, resolveStory } from "./stories.ts";
import { loadStoryFollowups } from "./followups.ts";
import { loadHotStrip } from "./hot.ts";
import { loadGroupReports } from "./groups.ts";
import { pickRepresentative } from "./representative.ts";
import { listReports, loadReport } from "./reports.ts";
import { listTopicSummaries, loadTopicPage, TOPICS } from "./topics.ts";
import { itemWindow, type PublicationRead } from "./read.ts";
import { itemFeed, reportFeed } from "./feeds.ts";
import { PUBLIC_API_CATEGORY_KEYS } from "@aihot/contracts/taxonomy";
import { config } from "../config.ts";
import { assertStaticPublicationReady, staticReportReferences, staticFeedIssue, staticItemStories } from "./static-policy.ts";

type CatalogRow = ItemRow & {
  in_pool: boolean; in_timeline: boolean; first_party: boolean; source_id: string; search_text: string;
  fact_public_id: string | null; own_evidence: boolean;
};
interface RankRow {
  id: string; fact_id: number; body_mode: "full" | "summary"; score: number | null; timeline_at: Date;
  source_tier: string; publisher_role: string | null; owner_entity_id: string | null; fact_subject: string | null;
}
const opaque = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 20);

/** No ledger initialisation, writes, worker import, model call or HTTP side effect. */
export async function exportStaticSnapshot(station: string, revision: string, sink: StaticSink, options: { maxItems?: number; retainScoreAtLeast?: number } = {}): Promise<Omit<StaticManifest, "files">> {
  if (!/^[a-z][a-z0-9-]*$/.test(station) || !/^[a-zA-Z0-9_-]+$/.test(revision)) throw new Error("invalid snapshot identity");
  if (options.maxItems !== undefined && (!Number.isSafeInteger(options.maxItems) || options.maxItems < 1)) throw new Error("maxItems must be a positive integer");
  if (options.retainScoreAtLeast !== undefined && (options.maxItems === undefined || !Number.isFinite(options.retainScoreAtLeast) || options.retainScoreAtLeast < 0 || options.retainScoreAtLeast > 100)) throw new Error("retainScoreAtLeast requires maxItems and a score between 0 and 100");
  return connection.begin("isolation level repeatable read read only", async (tx) => {
    await tx`SET LOCAL statement_timeout = '30s'`;
    await tx`SET LOCAL idle_in_transaction_session_timeout = '120s'`;
    const [clock] = await tx<{ at: Date }[]>`SELECT transaction_timestamp() AS at`;
    const read: PublicationRead = { db: tx, now: clock.at };
    // A small public index supports old bookmarks without loading historical bodies or generating OG.
    const publicRows = await tx<{ id: string; visibility: string; source_name: string; url: string; at: Date; score: number | null }[]>`
      SELECT p.article_id AS id, p.visibility, s.name AS source_name, p.url, coalesce(p.published_at, p.discovered_at) AS at, p.score
      FROM publications p JOIN sources s ON s.id = p.source_id
      WHERE ${releasedCondition(clock.at)} AND p.visibility <> 'withdrawn' AND s.participation_mode = 'editorial'
      ORDER BY coalesce(p.published_at, p.discovered_at) DESC, p.article_id DESC`;
    const selected = options.maxItems === undefined ? publicRows : publicRows.filter((row, index) => index < options.maxItems!
      || (options.retainScoreAtLeast !== undefined && row.score !== null && row.score >= options.retainScoreAtLeast));
    if (options.maxItems !== undefined) read.itemIds = selected.map((row) => row.id);
    const window: StaticManifest["window"] = options.maxItems === undefined ? undefined : {
      maxItems: options.maxItems, publicItems: publicRows.length, onlineItems: selected.length,
      oldestAt: selected.at(-1)?.at.toISOString() ?? null, newestAt: selected[0]?.at.toISOString() ?? null, searchScope: "online-window",
      ...(options.retainScoreAtLeast !== undefined ? { scoreRetention: { minimumScore: options.retainScoreAtLeast, additionalItems: selected.length - Math.min(options.maxItems, publicRows.length) } } : {}),
    };
    const outside: Record<string, ItemAvailability> = {};
    if (window) {
      const online = new Set(selected.map((row) => row.id));
      for (const row of publicRows) if (!online.has(row.id)) outside[row.id] = { status: "outside-window", sourceName: publicSourceName(row.source_name),
        ...(/^https?:\/\//i.test(row.url) ? { originalUrl: row.url } : {}) };
    }
    return exportPublicRead(station, revision, read, sink, window, outside);
  });
}

async function exportPublicRead(station: string, revision: string, read: PublicationRead, sink: StaticSink, window: StaticManifest["window"], outside: Record<string, ItemAvailability>): Promise<Omit<StaticManifest, "files">> {
  const sql = read.db;
  const now = read.now;
  await assertStaticPublicationReady(read);
  const rows = (await sql<CatalogRow[]>`
    SELECT ${ITEM_COLUMNS}, ${listedCondition(now)} AS in_pool, ${selectedCondition(now)} AS in_timeline,
      s.tier = 'T1' AS first_party, p.source_id, p.search_text, f.public_id AS fact_public_id,
      ${ownFactEvidenceCondition()} AS own_evidence
    ${ITEM_FROM} LEFT JOIN facts f ON f.id = p.fact_id
    WHERE ${releasedCondition(now)} AND p.visibility <> 'withdrawn' AND s.participation_mode = 'editorial' ${itemWindow(read)}
    ORDER BY coalesce(p.published_at, p.discovered_at) DESC, p.article_id DESC`);
  // Rank using the existing comparator, without publishing its internal source/analysis inputs.
  const ids = rows.filter((r) => r.in_timeline && r.own_evidence && r.fact_id !== null).map((r) => r.id);
  const ranking: RankRow[] = ids.length ? await sql<RankRow[]>`SELECT p.article_id AS id, p.fact_id, p.body_mode, p.score, p.timeline_at, s.tier AS source_tier,
      s.config->>'publisherRole' AS publisher_role, s.owner_entity_id, f.subject AS fact_subject
    FROM publications p JOIN sources s ON s.id = p.source_id LEFT JOIN facts f ON f.id = p.fact_id
    WHERE p.article_id = ANY(${ids}::text[])` : [];
  const byFact = new Map<number, RankRow[]>();
  for (const row of ranking) {
    const group: RankRow[] = byFact.get(Number(row.fact_id)) ?? [];
    group.push(row);
    byFact.set(Number(row.fact_id), group);
  }
  const order = new Map<string, number>();
  for (const group of byFact.values()) {
    // Use pickRepresentative, including its tie rules; groups are normally small.
    const remaining = [...group];
    for (let i = 0; remaining.length; i++) {
      const next = pickRepresentative(remaining);
      order.set(next.id, i);
      remaining.splice(remaining.indexOf(next), 1);
    }
  }
  const holders = await seatHolders(rows, now, sql, read.itemIds);
  const evidence = await sql<{ id: string; public_id: string }[]>`
    SELECT DISTINCT p.article_id AS id, f.public_id FROM facts f
    JOIN fact_articles fa ON fa.fact_id = f.id JOIN publications p ON p.article_id = fa.article_id
    WHERE ${listedCondition(now)} AND ${evidenceCondition()} ${itemWindow(read)}`;
  const poolFacts = new Map<string, string[]>();
  for (const row of evidence) {
    const facts = poolFacts.get(row.id) ?? [];
    facts.push(row.public_id);
    poolFacts.set(row.id, facts);
  }
  const items: StaticListItem[] = rows.filter((r) => r.in_pool || r.in_timeline).map((row) => {
    const item = toFeedItemSummary(row);
    const holder = holders.get(row.id);
    return {
      item: holder ? { ...item, sameEvent: holder } : item,
      sortAt: (row.published_at ?? row.discovered_at).toISOString(),
      inPool: row.in_pool, inTimeline: row.in_timeline, firstParty: row.first_party,
      sourceKey: opaque(row.source_id), searchText: row.search_text, poolFactIds: poolFacts.get(row.id) ?? [],
      fact: row.fact_public_id && row.own_evidence ? {
        publicId: row.fact_public_id, sortKey: `f${row.fact_id}`, representativeOrder: order.get(row.id) ?? Number.MAX_SAFE_INTEGER,
      } : null,
    };
  });
  const entityRows = await sql<{ id: string; tags: string[] }[]>`
    SELECT p.article_id AS id, p.tags FROM publications p WHERE ${listedCondition(now)} ${itemWindow(read)}`;
  const entities = TOPICS.filter((t) => t.entityId).map((topic) => ({
    aliases: topic.aliases,
    itemIds: entityRows.filter((r) => r.tags.includes(`entity:${topic.entityId}`)).map((r) => r.id),
  }));
  const catalog: StaticCatalog = { schemaVersion: 1, station, revision, asOf: now.toISOString(), items, entities };
  await sink.json("catalog", catalog);

  const bodyShards: string[] = [];
  // Read only body text licensed for the current public pool; never copy the whole pool_search row.
  let after = "";
  for (let n = 0; ; n++) {
    const batch = await sql<StaticSearchBody[]>`
      SELECT p.article_id AS id, ps.body AS text
      FROM publications p JOIN pool_search ps ON ps.article_id = p.article_id JOIN sources s ON s.id = p.source_id
      WHERE ${listedCondition(now)} AND s.participation_mode = 'editorial' AND s.site_fulltext
        ${itemWindow(read)}
        AND p.body_mode = 'full' AND p.article_id > ${after}
      ORDER BY p.article_id LIMIT 500`;
    if (!batch.length) break;
    const key = `search/body-${n}`;
    await sink.json(key, batch);
    bodyShards.push(key);
    after = batch.at(-1)!.id;
  }

  const availability: Record<string, ItemAvailability> = { ...outside };
  const routes = new Set(["/", "/all", "/hot", "/topics", "/daily", "/daily/archive", "/weekly", "/monthly", "/starred", "/more", "/about", "/terms", "/privacy", "/changelog", "/agent", "/search-busy", "/all/search-busy"]);
  const rowById = new Map(rows.map((r) => [r.id, r]));
  const itemIds = new Set(rowById.keys());
  const factIds = new Set<string>();
  const storyRows = await sql<{ id: number; public_id: string }[]>`
    SELECT st.id, st.public_id::text FROM stories st WHERE st.merged_into IS NULL AND EXISTS (
      SELECT 1 FROM facts f JOIN fact_articles fa ON fa.fact_id = f.id JOIN publications p ON p.article_id = fa.article_id
      WHERE f.story_id = st.id ${itemWindow(read)}
    ) ORDER BY st.id`;
  const storyDetails = new Map<string, import("@aihot/contracts/site").StoryDetail>();
  const stories: string[] = [];
  for (const story of storyRows) {
    const detail = await loadStoryDetail(story.id, now, read);
    if (!detail) continue;
    storyDetails.set(story.public_id, detail);
    const followups = await loadStoryFollowups(story.public_id, now, read);
    await sink.json(`stories/${story.public_id}/followups`, followups ?? { items: [], more: false });
    stories.push(story.public_id);
    routes.add(`/story/${story.public_id}`);
  }
  const readableStories = new Set(stories);
  for (const [id, detail] of storyDetails) await sink.json(`stories/${id}`, { ...detail, related: detail.related.filter((story) => readableStories.has(story.publicId)) });
  const aliasRows = await sql<{ public_id: string }[]>`
    SELECT public_id::text FROM stories WHERE merged_into IS NOT NULL UNION SELECT public_id::text FROM story_aliases`;
  const aliases: Record<string, string> = {};
  for (const alias of aliasRows) {
    const found = await resolveStory(alias.public_id, read);
    if (found.kind === "merged" && readableStories.has(found.target)) {
      aliases[alias.public_id] = found.target;
      routes.add(`/story/${alias.public_id}`);
    }
  }
  for (const row of rows) {
    // DetailResult also includes an internal row. Only the explicitly public .item is written.
    const detail = await loadItemDetail(row.id, "zh", now, read);
    if (detail.kind !== "found") throw new Error(`detail disappeared within snapshot: ${row.id}`);
    const boundedItem = (item: import("@aihot/contracts/site").SiteItemDetail) => ({ ...staticItemStories(item, readableStories, aliases),
      ...(item.sameEvent && !itemIds.has(item.sameEvent.id) ? { sameEvent: null } : {}) });
    await sink.json(`items/${row.id}`, boundedItem(detail.item));
    routes.add(`/items/${row.id}`);
    if (detail.item.hasTranslation) {
      const original = await loadItemDetail(row.id, "original", now, read);
      if (original.kind !== "found") throw new Error(`original disappeared: ${row.id}`);
      await sink.json(`items/${row.id}/original`, boundedItem(original.item));
      routes.add(`/items/${row.id}/original`);
    }
    const markdown = await exportMarkdown(row.id, read);
    if (markdown) await sink.text(`markdown/${row.id}`, markdown.body);
    availability[row.id] = { status: row.visibility === "summary-only" ? "summary-only" : "public", sourceName: detail.item.source.name };
    if (detail.item.group) factIds.add(detail.item.group.factId);
  }
  await sink.json("availability", availability);
  for (const factId of factIds) {
    const group = await loadGroupReports({ factPublicId: factId, channel: "all", category: null, tag: null }, now, read, null);
    if (!group) continue;
    const projected: StaticGroup = { factId, reports: group.reports.map((report) => {
      const row = rowById.get(report.id);
      if (!row) throw new Error(`reading group has no public detail: ${report.id}`);
      const item = toFeedItemSummary(row);
      return { ...report, channel: item.channel, category: item.category, tags: item.tags, firstParty: row.first_party };
    }) };
    await sink.json(`groups/${factId}`, projected);
  }

  const reports = {} as StaticManifest["reports"];
  const reportDetails = new Map<string, import("@aihot/contracts/site").ReportDetail>();
  for (const kind of ["daily", "weekly", "monthly"] as ReportKind[]) {
    // No historical 400-issue navigation cap in this complete archive outlet.
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM reports WHERE kind = ${kind}`;
    reports[kind] = await listReports(kind, n, read);
    for (const issue of reports[kind]) {
      const detail = await loadReport(kind, issue.key, read);
      if (!detail) throw new Error(`report disappeared within snapshot: ${kind}/${issue.key}`);
      reportDetails.set(`${kind}/${issue.key}`, detail);
      await sink.json(`reports/${kind}/${issue.key}`, staticReportReferences(detail, itemIds));
      routes.add(`/${kind}/${issue.key}`);
    }
  }
  const topics = await listTopicSummaries(read);
  const topicPages: Record<string, number> = {};
  for (const topic of topics.topics) {
    const first = await loadTopicPage(topic.slug, 1, now, read);
    if (!first) throw new Error(`topic disappeared: ${topic.slug}`);
    topicPages[topic.slug] = first.pageCount;
    for (let page = 1; page <= first.pageCount; page++) {
      const result = page === 1 ? first : await loadTopicPage(topic.slug, page, now, read);
      if (!result) throw new Error(`topic page missing: ${topic.slug}/${page}`);
      await sink.json(`topics/${topic.slug}/${page}`, result);
      routes.add(page === 1 ? `/topics/${topic.slug}` : `/topics/${topic.slug}/page/${page}`);
    }
  }
  await sink.json("topics", topics);
  const hot = await loadHot(read), strip = await loadHotStrip(read);
  await sink.json("hot", { ...hot, entries: hot.entries.filter((entry) => readableStories.has(entry.story.publicId)) });
  await sink.json("hot-strip", strip?.filter((entry) => (!entry.storyPublicId || readableStories.has(entry.storyPublicId)) && (!entry.itemId || itemIds.has(entry.itemId))) ?? null);
  await sink.json("meta", siteMeta());
  await sink.json("changelog", loadChangelog());
  await sink.json("contact", { ...await loadContact(read), makerAvatar: await loadMakerAvatar(read) });
  await sink.json("stats", await loadSiteStats(read));
  for (const [kind, name] of [["selected", "selected"], ["selected-full", "full"], ["all", "all"]] as const) {
    await sink.text(`feeds/${name}`, await itemFeed(kind, null, { now }, read));
    if (kind !== "all") for (const category of PUBLIC_API_CATEGORY_KEYS)
      await sink.text(`feeds/${name}/category/${category}`, await itemFeed(kind, category, { now }, read));
  }
  for (const kind of ["daily", "weekly", "monthly"] as const)
    await sink.text(`feeds/${kind}`, await reportFeed(kind, undefined, read, (issue) => {
      const report = reportDetails.get(`${kind}/${issue.key}`);
      if (!report) throw new Error("RSS issue missing from this public snapshot");
      return staticFeedIssue(issue, report, itemIds, config.siteUrl);
    }));
  return { schemaVersion: 1, station, revision, asOf: now.toISOString(), ...(window ? { window } : {}), bodyShards, reports, topicPages,
    itemIds: rows.map((r) => r.id), stories, aliases, routes: [...routes].sort() };
}
