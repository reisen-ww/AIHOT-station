import assert from "node:assert/strict";
import { test } from "node:test";
import type { StaticCatalog, StaticListItem } from "@aihot/contracts/static";
import { queryStaticGroup, queryStaticPool, queryStaticTimeline, StaticCursorError } from "@aihot/contracts/static-query";
import { CATEGORY_KEYS } from "@aihot/contracts/taxonomy";

const filters = { channel: "all" as const, category: null, tag: null };
const at = "2026-01-01T00:00:00.000Z";
function row(id: string, options: Partial<StaticListItem> = {}): StaticListItem {
  return {
    item: { id, title: id, summary: "公开摘要", reason: "重要", source: { name: "公开来源" }, publishedAt: at, timelineAt: at,
      category: null, tags: [], score: 80, selected: true, channel: "news", x: null },
    sortAt: at, inPool: true, inTimeline: true, firstParty: false, sourceKey: id, searchText: id.toLowerCase(), fact: null,
    poolFactIds: options.fact ? [options.fact.publicId] : [],
    ...options,
  };
}
function catalog(items: StaticListItem[], overrides: Partial<StaticCatalog> = {}): StaticCatalog {
  return { schemaVersion: 1, station: "aihot", revision: "fixture-v1", asOf: at, items, entities: [], ...overrides };
}

test("all public history is pageable and searchable beyond 2000 results", () => {
  const items = Array.from({ length: 2041 }, (_, i) => row(`article-${String(i).padStart(4, "0")}`));
  const c = catalog(items);
  const result = queryStaticPool(c, { ...filters, page: 52 });
  assert.equal(result.total, 2041);
  assert.equal(result.pageCount, 52);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].id, "article-0000");
  assert.equal(queryStaticPool(c, { ...filters, q: "article-0000" }).items[0].id, "article-0000");
  assert.equal(queryStaticPool(c, { ...filters, q: "impossible" }).total, 0);
  assert.throws(() => queryStaticPool(c, { ...filters, page: Infinity }), /invalid page/);
});

test("latest and full-text relevance retain cross-field AND, boosts, literal characters and ties", () => {
  const title = row("title", { searchText: "zx qy" });
  title.item.title = "ZX QY";
  const crossA = row("cross-a", { searchText: "zx" });
  const crossZ = row("cross-z", { searchText: "zx" });
  const bodyOnly = row("body", { searchText: "", sortAt: "2026-01-02T00:00:00.000Z" });
  const c = catalog([title, crossA, crossZ, bodyOnly, row("partial", { searchText: "zx" })]);
  const bodies = new Map([["title", "zx qy"], ["cross-a", "qy"], ["cross-z", "qy"], ["body", "zx qy"]]);
  assert.deepEqual(queryStaticPool(c, { ...filters, q: "zx qy", tab: "relevance" }, bodies).items.map((i) => i.id), ["title", "cross-z", "cross-a", "body"]);
  assert.deepEqual(queryStaticPool(c, { ...filters, q: "zx qy" }).items.map((i) => i.id), ["title"]);
  assert.throws(() => queryStaticPool(c, { ...filters, q: "zx", tab: "relevance" }), /not loaded/);
  const literal = catalog([row("literal", { searchText: "qx%_\\z" }), row("lookalike", { searchText: "qx-anything-z" })]);
  assert.deepEqual(queryStaticPool(literal, { ...filters, q: "qx%_\\z" }).items.map((i) => i.id), ["literal"]);
});

test("only a whole entity alias expands subject matches, without duplicates", () => {
  const c = catalog([row("subject", { searchText: "" }), row("text", { searchText: "openai" }), row("both", { searchText: "openai" })],
    { entities: [{ aliases: ["OpenAI", "ChatGPT"], itemIds: ["subject", "both"] }] });
  assert.deepEqual(queryStaticPool(c, { ...filters, q: "  CHATGPT " }).items.map((i) => i.id), ["subject", "both"]);
  assert.equal(queryStaticPool(c, { ...filters, q: "openai", tab: "relevance" }, new Map()).total, 3);
  assert.equal(queryStaticPool(c, { ...filters, q: "openai extra" }).total, 0);
});

test("filters recompute the fact anchor, representative and counts before pagination", () => {
  const a = row("original", { firstParty: true, sortAt: at, fact: { publicId: "fact", representativeOrder: 0 } });
  const b = row("later-x", { sortAt: "2026-01-02T00:00:00.000Z", fact: { publicId: "fact", representativeOrder: 1 } });
  b.item.channel = "x";
  const extra = row("other-x", { inTimeline: false, fact: { publicId: "fact", representativeOrder: 2 } });
  extra.item.channel = "x";
  const composite = row("composite");
  const c = catalog([a, b, extra, composite]);
  const full = queryStaticTimeline(c, filters);
  const card = full.cards.find((i) => i.group);
  assert.equal(card?.anchorAt, at);
  assert.equal(card?.item.id, "original");
  assert.equal(card?.group?.reportCount, 3);
  const x = queryStaticTimeline(c, { ...filters, channel: "x" });
  assert.equal(x.cards.length, 1);
  assert.equal(x.cards[0].item.id, "later-x");
  assert.equal(x.cards[0].anchorAt, b.sortAt);
  assert.equal(x.cards[0].group?.reportCount, 2);
  assert.equal(queryStaticTimeline(c, { ...filters, channel: "firstParty" }).cards.length, 1);
});

test("timeline cursor covers old history exactly once and rejects other versions and filters", () => {
  const c = catalog(Array.from({ length: 73 }, (_, i) => row(String(i).padStart(3, "0"))));
  const first = queryStaticTimeline(c, { ...filters, limit: 7 });
  assert.ok(first.nextCursor);
  assert.throws(() => queryStaticTimeline(c, { ...filters, tag: "different", cursor: first.nextCursor }), StaticCursorError);
  assert.throws(() => queryStaticTimeline({ ...c, revision: "new" }, { ...filters, cursor: first.nextCursor }), StaticCursorError);
  assert.throws(() => queryStaticTimeline(c, { ...filters, cursor: "bad" }), StaticCursorError);
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const result = queryStaticTimeline(c, { ...filters, cursor, limit: 7 });
    ids.push(...result.cards.map((r) => r.item.id));
    cursor = result.nextCursor;
  } while (cursor);
  assert.equal(ids.length, 73);
  assert.equal(new Set(ids).size, 73);
  assert.deepEqual(ids, [...c.items.map((r) => r.item.id)].sort().reverse());
});

test("timeline counts all current evidence memberships, without folding a different fact", () => {
  const own = row("own", { fact: { publicId: "one", representativeOrder: 0 } });
  const other = row("other", { fact: { publicId: "two", representativeOrder: 0 }, poolFactIds: ["one", "two"] });
  const standalone = row("standalone", { inTimeline: false, poolFactIds: ["one"] });
  const c = catalog([own, other, standalone]);
  const cards = queryStaticTimeline(c, filters).cards;
  assert.equal(cards.length, 2, "a report's evidence membership does not merge two facts");
  assert.equal(cards.find((r) => r.item.id === "own")?.group?.reportCount, 3);
  assert.equal(cards.find((r) => r.item.id === "own")?.group?.additionalSourceCount, 2);
});

test("pool hides the yielding report's reason but a filtered timeline representative retains it", () => {
  const yielding = row("yielding", { fact: { publicId: "one", representativeOrder: 0 } });
  yielding.item.sameEvent = { id: "holder", title: "Holder" };
  const c = catalog([yielding]);
  assert.equal(queryStaticPool(c, filters).items[0].reason, null);
  assert.equal(queryStaticTimeline(c, filters).cards[0].item.reason, "重要");
  assert.equal(queryStaticTimeline(c, filters).cards[0].item.sameEvent, undefined);
});

test("an entity subject only receives direct/body boosts when the whole text query matches", () => {
  const subject = row("subject", { searchText: "first", sortAt: "2026-01-03T00:00:00.000Z" });
  subject.item.title = "first";
  const text = row("text", { searchText: "first second" });
  text.item.title = "first second";
  const c = catalog([subject, text], { entities: [{ aliases: ["first second"], itemIds: ["subject"] }] });
  assert.deepEqual(queryStaticPool(c, { ...filters, q: "first second", tab: "relevance" }, new Map()).items.map((i) => i.id), ["text", "subject"]);
});

test("group filters are applied before the original 100-report display limit", () => {
  const reports = Array.from({ length: 103 }, (_, i) => ({
    id: `report-${i}`, title: "Report", source: { name: "Source" }, timelineAt: at, originalUrl: "https://example.test/",
    channel: "news" as const, category: CATEGORY_KEYS[i < 100 ? 1 : 0] ?? CATEGORY_KEYS[0], tags: [], firstParty: false,
  }));
  assert.equal(queryStaticGroup({ factId: "fact", reports }, { ...filters, category: CATEGORY_KEYS[0] })?.reports.length, 3);
});
