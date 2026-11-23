import assert from "node:assert/strict";
import { test } from "node:test";
import { assertStaticPublicationReady, staticReportReferences, staticFeedIssue, staticItemStories } from "../../../packages/backend/src/publication/static-policy.ts";
import type { PublicationRead } from "../../../packages/backend/src/publication/read.ts";
import type { ReportCitation, ReportDetail } from "@aihot/contracts/site";
import { publicFixture } from "./helpers/static-fixture.ts";
import { citationKey } from "../app/features/report/format.ts";

test("pending or inconsistent source projections fail closed before any static export", async () => {
  const queries: string[] = [];
  const db = (async (strings: TemplateStringsArray) => { queries.push(strings.join("?")); return [{ id: "blocked" }]; }) as unknown as PublicationRead["db"];
  await assert.rejects(assertStaticPublicationReady({ db, now: new Date() }), /licence|republish/);
  assert.match(queries[0], /republish\.source:/);
  assert.match(queries[0], /syndicate_fulltext IS NOT TRUE/);
  assert.match(queries[0], /site_fulltext IS NOT TRUE/);
  assert.match(queries[0], /participation_mode = 'isolated'/);
});

test("historical citations retain prose and original links without inventing a local detail", () => {
  const fixture = publicFixture(1);
  const report = fixture.data.get("reports/daily/2026-09-01") as ReportDetail;
  const historical: ReportCitation = { ...report.sections[0].items[0], itemId: "not-imported", title: "保留历史引文", sourceUrl: "https://example.test/archive?a=1&b=2" };
  report.sections[0].items.push(historical);
  report.sections[0].items[0].related = [historical];
  report.leadItemId = historical.itemId;
  const projected = staticReportReferences(report, new Set(fixture.manifest.itemIds));
  assert.equal(projected.leadItemId, null);
  const c = projected.sections[0].items[1];
  assert.equal(c.itemId, null); assert.equal(c.available, true); assert.equal(c.title, historical.title);
  assert.equal(c.summary, historical.summary); assert.equal(c.sourceUrl, historical.sourceUrl);
  assert.equal(projected.sections[0].items[0].related![0].itemId, null);
  assert.equal(report.sections[0].items[1].itemId, "not-imported", "dynamic DTO is not mutated");
  const base = "https://reader.test/hot-pages/aihot";
  const rss = staticFeedIssue({ key: report.key, generatedAt: new Date(report.generatedAt), headline: "标题", leadParagraph: null,
    sections: [{ label: "栏目", items: [{ title: "历史", link: `${base}/items/not-imported` }, { title: "本站", link: `${base}/items/fixture-0000` }] }] }, report, new Set(fixture.manifest.itemIds), base);
  assert.equal(rss.sections[0].items[0].link, "https://example.test/archive?a=1&b=2", "escaping happens once in the RSS serializer");
  assert.equal(rss.sections[0].items[1].link, `${base}/items/fixture-0000`);
});

test("optional composite event memberships are removed only when no public event page exists", () => {
  const fixture = publicFixture(1), item = fixture.data.get("items/fixture-0000") as import("@aihot/contracts/site").SiteItemDetail;
  item.story = { publicId: "mention-only", title: "人工归属" };
  item.relatedStories = [item.story, { publicId: "readable", title: "可读事件" }, { publicId: "alias", title: "合并别名" }];
  const projected = staticItemStories(item, new Set(["readable"]), { alias: "readable" });
  assert.equal(projected.story, null);
  assert.deepEqual(projected.relatedStories.map((s) => s.publicId), ["readable", "alias"]);
  assert.equal(item.story.publicId, "mention-only", "does not mutate the dynamic projection");
  assert.equal(projected.body, item.body, "legal article content is retained");
});

test("same-title historical citations retain distinct identity without dead local links", () => {
  const f = publicFixture(1), report = f.data.get("reports/daily/2026-09-01") as ReportDetail;
  const cite = report.sections[0].items[0];
  report.sections[0].items = [{ ...cite, itemId: "old-a", title: "同一标题", sourceUrl: "https://a.test/item" },
    { ...cite, itemId: "old-b", title: "同一标题", sourceUrl: "https://b.test/item" },
    { ...cite, itemId: "old-c", title: "同一标题", sourceUrl: "", summary: "不同历史摘要" }];
  const projected = staticReportReferences(report, new Set(f.manifest.itemIds));
  assert.ok(projected.sections[0].items.every((c) => c.itemId === null));
  assert.equal(new Set(projected.sections[0].items.map(citationKey)).size, 3);
});

test("outside citations retain different original IDs even with identical prose and keep duplicate identity", () => {
  const f = publicFixture(1), report = f.data.get("reports/daily/2026-09-01") as ReportDetail;
  const base = { ...report.sections[0].items[0], title: "例行更新", sourceUrl: "", summary: null };
  const first = { ...base, itemId: "old-a", publishedAt: "2026-09-01T00:00:00Z" };
  const second = { ...base, itemId: "old-b", publishedAt: "2026-09-02T00:00:00Z" };
  report.sections[0].items = [first, second, { ...first }];
  const projected = staticReportReferences(report, new Set(f.manifest.itemIds));
  const citations = projected.sections[0].items;
  assert.ok(citations.every(c => c.itemId === null));
  assert.deepEqual(citations.map(c => c.citationId), ["old-a", "old-b", "old-a"]);
  assert.equal(new Set(citations.map(citationKey)).size, 2);
  assert.equal(citationKey(citations[0]), citationKey(citations[2]));
  assert.equal(report.sections[0].items[0].itemId, "old-a");
});

test("RSS historical fallbacks stay bound to the exact kind/key and prefer a real original", () => {
  const f = publicFixture(1), base = "https://reader.test/hot-pages/aihot";
  const daily = f.data.get("reports/daily/2026-09-01") as ReportDetail, weekly = f.data.get("reports/weekly/2026-W45") as ReportDetail;
  for (const r of [daily, weekly]) { r.highlights = []; r.sections[0].items = [{ ...r.sections[0].items[0], itemId: "old", sourceUrl: "" }]; }
  const issue = { key: "2026-09-01", generatedAt: new Date(), headline: "标题", leadParagraph: null,
    sections: [{ label: "栏目", items: [{ title: "历史", link: `${base}/items/old` }] }] };
  assert.equal(staticFeedIssue(issue, daily, new Set(), base).sections[0].items[0].link, `${base}/daily/2026-09-01`);
  assert.equal(staticFeedIssue({ ...issue, key: weekly.key }, weekly, new Set(), base).sections[0].items[0].link, `${base}/weekly/2026-W45`);
  daily.highlights.push({ ...daily.sections[0].items[0], sourceUrl: "https://original.test/a?x=1&y=2" });
  assert.equal(staticFeedIssue(issue, daily, new Set(), base).sections[0].items[0].link, "https://original.test/a?x=1&y=2");
  assert.equal(issue.sections[0].items[0].link, `${base}/items/old`);
});

test("full-text export uses only the existing white-listed UTF-16-truncated pool-search body", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../../../packages/backend/src/publication/static.ts", import.meta.url), "utf8");
  assert.match(source, /SELECT p\.article_id AS id, ps\.body AS text/);
  assert.doesNotMatch(source, /lower\(left\(coalesce\(a\.body_text/);
  assert.equal(("😀".repeat(6000) + "needle").slice(0, 12000).includes("needle"), false);
});
