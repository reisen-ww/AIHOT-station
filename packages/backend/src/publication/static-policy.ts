import type { ReportCitation, ReportDetail, SiteItemDetail } from "@aihot/contracts/site";
import type { PublicationRead } from "./read.ts";
import type { FeedIssue } from "./reports.ts";

/** Do not freeze an asynchronous source-licence transition into a long-lived public artifact. */
export async function assertStaticPublicationReady(read: PublicationRead) {
  const sql = read.db;
  const blocked = await sql<{ id: string }[]>`
    SELECT s.id FROM settings st JOIN sources s ON st.key = 'republish.source:' || s.id
    WHERE st.value->>'status' IS DISTINCT FROM 'done'
      AND EXISTS (SELECT 1 FROM publications p WHERE p.source_id = s.id)
    UNION ALL
    SELECT s.id FROM publications p JOIN sources s ON s.id = p.source_id JOIN articles a ON a.id = p.article_id
    WHERE p.visibility <> 'withdrawn' AND (
      s.participation_mode = 'isolated'
      OR (p.body_mode = 'full' AND (s.site_fulltext IS NOT TRUE OR a.body_status <> 'ok' OR coalesce(a.body_text, '') = ''))
      OR (p.syndicate AND (s.syndicate_fulltext IS NOT TRUE OR s.site_fulltext IS NOT TRUE OR p.body_mode <> 'full')))
    LIMIT 1`;
  if (blocked.length) throw new Error("public source projection is pending or its current licence disagrees; wait for republish before exporting");
}

/** Imported historical citations remain readable even when no local detail was imported with them. */
export function staticReportReferences(report: ReportDetail, itemIds: ReadonlySet<string>): ReportDetail {
  const cite = (c: ReportCitation): ReportCitation => ({ ...c,
    ...(c.available && c.itemId && !itemIds.has(c.itemId) ? { citationId: c.citationId ?? c.itemId } : {}),
    itemId: c.available && c.itemId && !itemIds.has(c.itemId) ? null : c.itemId,
    ...(c.related ? { related: c.related.map(cite) } : {}),
  });
  return { ...report, leadItemId: report.leadItemId && itemIds.has(report.leadItemId) ? report.leadItemId : null,
    highlights: report.highlights.map(cite), sections: report.sections.map((s) => ({ ...s, items: s.items.map(cite) })), flashes: report.flashes.map(cite) };
}

/** A legal composite membership does not necessarily have a readable event page of its own. */
export function staticItemStories(item: SiteItemDetail, stories: ReadonlySet<string>, aliases: Readonly<Record<string, string>>): SiteItemDetail {
  const readable = (id: string) => stories.has(aliases[id] ?? id);
  return { ...item, story: item.story && readable(item.story.publicId) ? item.story : null,
    relatedStories: item.relatedStories.filter((story) => readable(story.publicId)) };
}

/** Resolve historic feed links within this exact issue before XML escaping, never across other issues. */
export function staticFeedIssue(issue: FeedIssue, report: ReportDetail, itemIds: ReadonlySet<string>, siteUrl: string): FeedIssue {
  const historical = new Map<string, string>();
  const collect = (c: ReportCitation) => {
    if (c.available && c.itemId && !itemIds.has(c.itemId)) {
      if (c.sourceUrl || !historical.has(c.itemId)) historical.set(c.itemId, c.sourceUrl || `${siteUrl}/${report.kind}/${report.key}`);
    }
    c.related?.forEach(collect);
  };
  [...report.highlights, ...report.sections.flatMap((s) => s.items), ...report.flashes].forEach(collect);
  const prefix = `${siteUrl}/items/`;
  return { ...issue, sections: issue.sections.map((section) => ({ ...section, items: section.items.map((item) => {
    if (!item.link.startsWith(prefix)) return item;
    const id = item.link.slice(prefix.length);
    if (itemIds.has(id)) return item;
    const link = historical.get(id);
    if (!link) throw new Error("RSS references an unknown historical citation in this issue");
    return { ...item, link };
  }) })) };
}
