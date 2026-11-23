// Query the immutable public projection in both the browser and export checks. No network or storage.
import type { GroupReportsResponse, PoolResponse, TimelineFilters, TimelineResponse } from "./site.ts";
import type { StaticCatalog, StaticGroup, StaticListItem, StaticPoolQuery, StaticTimelineQuery } from "./static.ts";

const PAGE_SIZE = 40;
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const normalizedAlias = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

export class StaticCursorError extends Error {}

function matches(row: { firstParty: boolean; item: { channel: string; category: string | null; tags: string[] } }, filters: TimelineFilters): boolean {
  return (filters.channel === "all" || (filters.channel === "firstParty" ? row.firstParty : row.item.channel === filters.channel))
    && (!filters.category || row.item.category === filters.category)
    && (!filters.tag || row.item.tags.includes(filters.tag));
}

function newest(a: StaticListItem, b: StaticListItem): number {
  return compare(b.sortAt, a.sortAt) || compare(b.item.id, a.item.id);
}

function queryTerms(q: string): string[] {
  // Unlike SQL LIKE, String.includes treats %, _ and backslashes literally without escaping.
  return q.toLowerCase().split(/\s+/).map((s) => s.trim()).filter(Boolean).slice(0, 6);
}

export function queryStaticPool(catalog: StaticCatalog, query: StaticPoolQuery, bodies?: ReadonlyMap<string, string>): PoolResponse {
  const page = query.page ?? 1;
  if (!Number.isSafeInteger(page) || page < 1) throw new RangeError("invalid page");
  const q = query.q?.trim().slice(0, 200) || null;
  const tab = q && query.tab === "relevance" ? "relevance" : "time";
  if (q && tab === "relevance" && !bodies) throw new Error("full-text search data was not loaded");
  const terms = q ? queryTerms(q) : [];
  const entity = q ? catalog.entities.find((e) => e.aliases.some((a) => normalizedAlias(a) === normalizedAlias(q))) : null;
  const subjectIds = new Set(entity?.itemIds ?? []);
  const ranked: Array<{ row: StaticListItem; score: number }> = [];
  for (const row of catalog.items) {
    if (!row.inPool || !matches(row, query)) continue;
    const subject = subjectIds.has(row.item.id);
    const direct = row.searchText;
    const body = tab === "relevance" ? bodies!.get(row.item.id) ?? "" : "";
    const textMatch = terms.every((t) => direct.includes(t) || (tab === "relevance" && body.includes(t)));
    if (!subject && !textMatch) continue;
    const title = row.item.title.toLowerCase();
    const score = tab === "relevance" ? (subject ? 10 : 0) + terms.reduce((sum, t) => sum
      + (textMatch && direct.includes(t) ? 3 : 0) + (textMatch && body.includes(t) ? 1 : 0) + (title.includes(t) ? 6 : 0), 0) : 0;
    ranked.push({ row, score });
  }
  ranked.sort((a, b) => b.score - a.score || newest(a.row, b.row));
  const offset = (page - 1) * PAGE_SIZE;
  return {
    filters: { channel: query.channel, category: query.category, tag: query.tag, q, tab },
    items: Number.isSafeInteger(offset) ? ranked.slice(offset, offset + PAGE_SIZE).map(({ row }) => row.item.sameEvent ? { ...row.item, reason: null } : row.item) : [],
    page,
    pageCount: Math.max(1, Math.ceil(ranked.length / PAGE_SIZE)),
    total: ranked.length,
    freshness: catalog.asOf,
  };
}

function cursorBinding(catalog: StaticCatalog, q: TimelineFilters): string {
  return JSON.stringify([catalog.station, catalog.revision, q.channel, q.category, q.tag]);
}

export function queryStaticTimeline(catalog: StaticCatalog, query: StaticTimelineQuery): Omit<TimelineResponse, "hot"> {
  const limit = Math.min(Math.max(query.limit ?? 20, 1), 40);
  if (!Number.isInteger(limit)) throw new RangeError("invalid limit");
  const binding = cursorBinding(catalog, query);
  let offset = 0;
  if (query.cursor) {
    try {
      if (!query.cursor.startsWith("st1:")) throw new Error();
      const value: unknown = JSON.parse(decodeURIComponent(query.cursor.slice(4)));
      if (!Array.isArray(value) || value.length !== 2 || value[0] !== binding || !Number.isSafeInteger(value[1]) || value[1] < 0) throw new Error();
      offset = value[1];
    } catch {
      throw new StaticCursorError("cursor belongs to another snapshot or filter");
    }
  }
  const filtered = catalog.items.filter((r) => matches(r, query));
  const groups = new Map<string, StaticListItem[]>();
  const pool = new Map<string, StaticListItem[]>();
  for (const row of filtered) {
    if (row.inPool) {
      for (const key of row.poolFactIds) {
        const reports = pool.get(key) ?? [];
        reports.push(row);
        pool.set(key, reports);
      }
    }
    if (!row.inTimeline) continue;
    const key = row.fact ? row.fact.sortKey ?? `f:${row.fact.publicId}` : `a${row.item.id}`;
    const members = groups.get(key) ?? [];
    members.push(row);
    groups.set(key, members);
  }
  const ordered = [...groups].map(([key, members]) => {
    const anchorAt = members.reduce((earliest, r) => r.sortAt < earliest ? r.sortAt : earliest, members[0].sortAt);
    return { key, members, anchorAt };
  }).sort((a, b) => compare(b.anchorAt, a.anchorAt) || compare(b.key, a.key));
  const cards = ordered.slice(offset, offset + limit).map(({ key, members, anchorAt }) => {
    const representative = members.reduce((best, row) => (row.fact?.representativeOrder ?? 0) < (best.fact?.representativeOrder ?? 0) ? row : best);
    const reports = representative.fact ? pool.get(representative.fact.publicId) ?? [] : [];
    const sources = new Set(reports.filter((r) => r.sourceKey !== representative.sourceKey).map((r) => r.sourceKey));
    const group = reports.length > 1 && representative.fact ? {
      factId: representative.fact.publicId, additionalSourceCount: sources.size, reportCount: reports.length,
    } : null;
    // The timeline representative owns its displayed reason even when another item holds the machine seat.
    const { sameEvent: _sameEvent, ...item } = representative.item;
    return { key, anchorAt, item: group ? { ...item, publishedAt: anchorAt } : item, group };
  });
  const nextOffset = offset + limit;
  return {
    filters: { channel: query.channel, category: query.category, tag: query.tag },
    cards,
    nextCursor: nextOffset < ordered.length ? `st1:${encodeURIComponent(JSON.stringify([binding, nextOffset]))}` : null,
  };
}

export function queryStaticGroup(group: StaticGroup, filters: TimelineFilters): GroupReportsResponse | null {
  const reports = group.reports.filter((r) => matches({ firstParty: r.firstParty, item: r }, filters))
    .sort((a, b) => compare(b.timelineAt, a.timelineAt) || compare(a.id, b.id)).slice(0, 100)
    .map(({ id, title, source, timelineAt, originalUrl }) => ({ id, title, source, timelineAt, originalUrl }));
  return reports.length ? { factId: group.factId, reports } : null;
}
