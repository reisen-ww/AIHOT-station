// Selected news timeline: one card per story, or per fact, or per standalone article. Only duplicate
// reports fold together. A card stays at its first appearance; later reports never move it.
import type { GroupInfo, TimelineCard, TimelineFilters, TimelineResponse } from "@aihot/contracts/site";
import { sql } from "../db.ts";
import { cachedByKey } from "../lib/cache.ts";
import { pickRepresentative, REPRESENTATIVE_COLUMNS, type RepresentativeRow } from "./representative.ts";
import { decodeCursor, encodeCursor, InvalidCursorError, queryBinding } from "../lib/cursor.ts";
import {
  ITEM_COLUMNS, ITEM_FROM, categoryCondition, channelCondition, tagCondition, toFeedItemSummary,
  type ItemRow,
} from "./items.ts";
import { evidenceCondition, listedCondition, ownFactEvidenceCondition, selectedCondition } from "./scope.ts";

export interface TimelineQuery extends TimelineFilters {
  cursor?: string | null;
  limit?: number;
  now?: Date;
}

interface GroupRow {
  gk: string;
  anchor_at: Date;
}

function filterSql(q: TimelineQuery) {
  return sql`${channelCondition(q.channel)} ${categoryCondition(q.category)} ${tagCondition(q.tag)}`;
}

function binding(q: TimelineQuery): string {
  return queryBinding({ c: q.channel, k: q.category, t: q.tag });
}

/**
 * Public pool reports linked to the given facts, under the same
 * filters (non-selected included): the sets "另有 N 家信源报道" expands and the group counts come from.
 */
async function groupPool(q: TimelineQuery, now: Date, factIds: number[]) {
  if (!factIds.length) return [];
  return sql<{ fact_id: number; story_id: number | null; article_id: string; source_id: string }[]>`
    SELECT DISTINCT f.id AS fact_id, f.story_id, p.article_id, p.source_id
    FROM facts f JOIN fact_articles fa ON fa.fact_id = f.id JOIN publications p ON p.article_id = fa.article_id
    WHERE f.id IN ${sql(factIds)}
      AND ${evidenceCondition()} AND ${listedCondition(now)} ${filterSql(q)}`;
}

/**
 * The selected set grouped into cards (story, fact or standalone item) with their anchor times,
 * newest first. Every timeline page and its day counts read this list; it is kept for five seconds
 * per filter scope (a newly selected report appears at most that much later).
 */
const groupedAnchors = cachedByKey(binding, (q: TimelineQuery) => queryGroupedAnchors(q, new Date()), { freshMs: 5000, maxStaleMs: 5000, maxKeys: 50 });

async function queryGroupedAnchors(q: TimelineQuery, now: Date) {
  const rows = (
    await sql<{ gk: string; anchor_at: Date }[]>`
      WITH base AS MATERIALIZED (
        SELECT coalesce(p.published_at, p.discovered_at) AS sort_at, CASE
          WHEN p.story_id IS NOT NULL THEN 's' || p.story_id::text
          WHEN p.fact_id IS NOT NULL AND ${ownFactEvidenceCondition()} THEN 'f' || p.fact_id::text
          ELSE 'a' || p.article_id END AS gk
        FROM publications p
        WHERE ${selectedCondition(now)} ${filterSql(q)}
      )
      SELECT gk, min(sort_at) AS anchor_at FROM base GROUP BY gk ORDER BY anchor_at DESC, gk COLLATE "C" DESC`
  ).map((r) => ({ gk: r.gk, anchor: r.anchor_at.getTime() }));
  return rows;
}

export async function loadTimeline(q: TimelineQuery): Promise<Omit<TimelineResponse, "hot">> {
  const now = q.now ?? new Date();
  const limit = Math.min(Math.max(q.limit ?? 20, 1), 40);
  const bind = binding(q);
  let after: { a: number; g: string } | null = null;
  if (q.cursor) {
    const c = decodeCursor<{ a: number; g: string; b: string }>("tl4", q.cursor);
    if (c.b !== bind || typeof c.a !== "number" || typeof c.g !== "string") throw new InvalidCursorError("cursor does not match this query");
    after = { a: c.a, g: c.g };
  }

  // A given clock (tests, replays) reads afresh.
  const grouped = q.now ? await queryGroupedAnchors(q, now) : await groupedAnchors(q);
  const start = after ? grouped.findIndex((g) => g.anchor < after!.a || (g.anchor === after!.a && g.gk < after!.g)) : 0;
  const groups: GroupRow[] = (start < 0 ? [] : grouped.slice(start, start + limit + 1)).map((g) => ({ gk: g.gk, anchor_at: new Date(g.anchor) }));

  const page = groups.slice(0, limit);
  const hasMore = groups.length > limit;

  const factIds = page.filter((g) => g.gk.startsWith("f")).map((g) => Number(g.gk.slice(1)));
  const storyIds = page.filter((g) => g.gk.startsWith("s")).map((g) => Number(g.gk.slice(1)));
  // A story card is chosen among every fact the story holds, so those facts are read with the page's.
  const storyFactIds = storyIds.length
    ? (await sql<{ id: number }[]>`SELECT id FROM facts WHERE story_id IN ${sql(storyIds)}`).map((f) => f.id)
    : [];
  const memberFactIds = [...new Set([...factIds, ...storyFactIds])];
  const factById = new Map(
    memberFactIds.length
      ? (await sql<{ id: number; public_id: string; story_id: number | null }[]>`
        SELECT id, public_id, story_id FROM facts WHERE id IN ${sql(memberFactIds)}`).map((f) => [f.id, f])
      : [],
  );

  // Read only ranking fields for the whole group; bodies, media and translations are hydrated for this page's representatives.
  type Member = RepresentativeRow & Pick<ItemRow, "id"> & { fact_id: number };
  const [members, pool] = await Promise.all([
    memberFactIds.length
      ? sql<Member[]>`
        SELECT p.fact_id, p.article_id AS id, p.body_mode, p.score, p.timeline_at, ${REPRESENTATIVE_COLUMNS}
        FROM publications p JOIN sources s ON s.id = p.source_id LEFT JOIN facts f ON f.id = p.fact_id
        WHERE p.fact_id IN ${sql(memberFactIds)}
          AND ${selectedCondition(now)} AND ${ownFactEvidenceCondition()} ${filterSql(q)}`
      : Promise.resolve([] as Member[]),
    groupPool(q, now, memberFactIds),
  ]);

  const planned: Array<{ key: string; anchorAt: string; id: string; group: GroupInfo | null }> = [];
  for (const g of page) {
    if (g.gk.startsWith("a")) {
      planned.push({ key: g.gk, anchorAt: g.anchor_at.toISOString(), id: g.gk.slice(1), group: null });
      continue;
    }
    // 's': the event counts as a whole, so the card comes from every fact of the story; 'f': from the one fact.
    const anchorId = Number(g.gk.slice(1));
    const own = g.gk.startsWith("s")
      ? new Set([...factById.values()].filter((f) => f.story_id === anchorId).map((f) => f.id))
      : new Set([anchorId]);
    const candidates = members.filter((m) => own.has(m.fact_id));
    if (!candidates.length) continue;
    const rep = pickRepresentative(candidates);
    const reports = pool.filter((r) => own.has(r.fact_id));
    const repSource = reports.find((r) => r.article_id === rep.id)?.source_id;
    const group: GroupInfo = {
      factId: factById.get(rep.fact_id)?.public_id ?? String(rep.fact_id),
      additionalSourceCount: new Set(reports.filter((r) => r.source_id !== repSource).map((r) => r.source_id)).size,
      reportCount: new Set(reports.map((r) => r.article_id)).size,
    };
    const showGroup = group.reportCount > 1;
    planned.push({ key: g.gk, anchorAt: g.anchor_at.toISOString(), id: rep.id, group: showGroup ? group : null });
  }

  // Recheck scope when hydrating: a withdrawal may commit after the narrow representative read.
  const rows = new Map(planned.length ? (await sql<ItemRow[]>`
    SELECT ${ITEM_COLUMNS} ${ITEM_FROM} WHERE p.article_id IN ${sql(planned.map((p) => p.id))}
      AND ${selectedCondition(now)} ${filterSql(q)}`).map((row) => [row.id, row]) : []);
  const cards: TimelineCard[] = planned.flatMap(({ id, key, anchorAt, group }) => {
    const row = rows.get(id);
    if (!row) return [];
    const item = toFeedItemSummary(row);
    // A folded group's card carries the group's anchor as its time: that is the value the list is
    // ordered by (the earliest report of the event). The representative's own publication time can be
    // later, and showing it made the card read out of order against its neighbours.
    return [{ key, anchorAt, item: group ? { ...item, publishedAt: anchorAt } : item, group }];
  });

  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeCursor("tl4", { a: last.anchor_at.getTime(), g: last.gk, b: bind }) : null;
  return { filters: { channel: q.channel, category: q.category, tag: q.tag }, cards, nextCursor };
}
