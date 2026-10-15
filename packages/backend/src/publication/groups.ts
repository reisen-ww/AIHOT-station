// Duplicate reports of one news fact ("另有 N 家信源报道"). Members must pass the same visibility, pool
// eligibility and parent-page filters as the card they open under. A fact inside a story is read over
// that whole story: the card counts the event as a whole, and its list and counts follow.
import type { CategoryKey, ChannelKey } from "@aihot/contracts/taxonomy";
import type { GroupReportsResponse } from "@aihot/contracts/site";
import { sql } from "../db.ts";
import { categoryCondition, channelCondition, tagCondition } from "./items.ts";
import { evidenceCondition, listedCondition } from "./scope.ts";
import { publicSourceName } from "./rules.ts";

export interface GroupReportsQuery {
  factPublicId: string;
  channel: ChannelKey;
  category: CategoryKey | null;
  tag: string | null;
}

/** The filters a card carries from its list page into its report list and its counts; the detail page has none. */
export interface GroupFilters {
  channel?: ChannelKey | null;
  category?: CategoryKey | null;
  tag?: string | null;
}

/** A fact has a few dozen reports at most; the cap only bounds an odd one. */
const MAX_REPORTS = 100;

/** The fact itself and every fact of the story it belongs to; nothing extra when it has no story. */
function storyScope(factId: number) {
  return sql`(f.id = ${factId} OR f.story_id = (SELECT story_id FROM facts WHERE id = ${factId}))`;
}

/**
 * Report and source counts of a fact's scope under the filters, with the fact's own public id for the
 * link back to it; null when the fact is unknown or has no public report. The detail page reads its
 * numbers from here, so they stay the ones the timeline card shows.
 */
export async function countGroupReports(factId: number, filters: GroupFilters, now = new Date()) {
  const [c] = await sql<{ public_id: string | null; reports: number; sources: number }[]>`
    SELECT (SELECT public_id FROM facts WHERE id = ${factId}) AS public_id,
      count(DISTINCT p.article_id) AS reports, count(DISTINCT p.source_id) AS sources
    FROM facts f JOIN fact_articles fa ON fa.fact_id = f.id JOIN publications p ON p.article_id = fa.article_id
    WHERE ${storyScope(factId)} AND ${evidenceCondition()} AND ${listedCondition(now)}
      ${channelCondition(filters.channel)} ${categoryCondition(filters.category)} ${tagCondition(filters.tag)}`;
  if (!c || !c.public_id || Number(c.reports) === 0) return null;
  return {
    factPublicId: c.public_id,
    reportCount: Number(c.reports),
    additionalSourceCount: Math.max(0, Number(c.sources) - 1),
  };
}

/** The fact's public reports under the filters, newest first; null when it has none. */
export async function loadGroupReports(q: GroupReportsQuery, now = new Date()): Promise<GroupReportsResponse | null> {
  const [fact] = await sql<{ id: number }[]>`SELECT id FROM facts WHERE public_id = ${q.factPublicId}`;
  if (!fact) return null;
  const members = await sql<{ id: string; title: string; timeline_at: Date; url: string; source_name: string }[]>`
    SELECT DISTINCT p.article_id AS id, p.title, p.timeline_at, p.url, s.name AS source_name
    FROM facts f JOIN fact_articles fa ON fa.fact_id = f.id JOIN publications p ON p.article_id = fa.article_id
    JOIN sources s ON s.id = p.source_id
    WHERE ${storyScope(fact.id)} AND ${evidenceCondition()} AND ${listedCondition(now)}
      ${channelCondition(q.channel)} ${categoryCondition(q.category)} ${tagCondition(q.tag)}
    ORDER BY p.timeline_at DESC, p.article_id ASC
    LIMIT ${MAX_REPORTS}`;
  if (members.length === 0) return null;
  return {
    factId: q.factPublicId,
    reports: members.map((m) => ({
      id: m.id,
      title: m.title,
      source: { name: publicSourceName(m.source_name) },
      timelineAt: m.timeline_at.toISOString(),
      originalUrl: m.url,
    })),
  };
}
