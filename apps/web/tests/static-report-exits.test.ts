import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ReportCitation, ReportDetail } from "@aihot/contracts/site";
import { createStaticFiles } from "../../../scripts/static-files.ts";
import { writeStaticExits } from "../../../scripts/static-exits.ts";
import { staticDocumentLinks } from "../../../scripts/static-validate.ts";
import { publicFixture } from "./helpers/static-fixture.ts";

const base = "https://reader.test/hot-pages/aihot";

/** Materialise the existing public fixture in a fresh temp directory, then write the machine exits. */
async function publish(mutate: (data: Map<string, unknown>) => void) {
  const root = await mkdtemp(path.join(tmpdir(), "hot-report-markdown-"));
  const dataDirectory = path.join(root, "data"), client = path.join(root, "client");
  const fixture = publicFixture(3);
  mutate(fixture.data);
  const writer = await createStaticFiles(dataDirectory);
  for (const [key, value] of fixture.data) {
    if (typeof value === "string") await writer.sink.text(key, value);
    else await writer.sink.json(key, value);
  }
  const { files: _files, ...metadata } = fixture.manifest;
  const manifest = writer.snapshot(metadata);
  await writeStaticExits(client, dataDirectory, manifest, base);
  return { root, manifest, read: (file: string) => readFile(path.join(client, file), "utf8") };
}

function cite(report: ReportDetail, patch: Partial<ReportCitation>): ReportCitation {
  return { ...report.sections[0].items[0], ...patch };
}

test("report Markdown keeps lead, overview, section introduction, summaries, sources, dates, follow-ups and related citations", async () => {
  const { read } = await publish((data) => {
    const report = data.get("reports/daily/2026-09-01") as ReportDetail;
    const local = report.sections[0].items[0];
    const outside = cite(report, {
      itemId: null, citationId: "old-outside", title: "窗外[标题](x)", summary: "窗外摘要标记",
      sourceName: "窗外来源", sourceUrl: "https://example.test/out (1)",
      publishedAt: "2026-08-01T01:02:00.000Z", available: true,
      related: [cite(report, {
        itemId: null, citationId: "related-outside", title: "相关引用标记", summary: "相关摘要标记",
        sourceName: "相关来源", sourceUrl: "https://example.test/related",
        publishedAt: "2026-08-02T03:04:00.000Z", available: true,
      })],
    });
    const fallback = cite(report, {
      itemId: null, citationId: "old-fallback", title: "无原文历史引文", summary: "回退摘要标记",
      sourceName: "历史来源", sourceUrl: "", publishedAt: null, available: true,
    });
    const withdrawn = cite(report, {
      itemId: "withdrawn-id", title: "撤回标题标记", summary: "不应出现的撤回摘要",
      sourceName: "不应出现的来源", sourceUrl: "https://example.test/withdrawn",
      sourceIconUrl: null, publishedAt: "2026-08-04T05:06:00.000Z", available: false,
      related: [cite(report, {
        itemId: null, title: "不应出现的撤回相关", summary: "不应出现的撤回相关摘要",
        sourceName: "不应出现的撤回来源", sourceUrl: "https://example.test/withdrawn-related", available: false,
      })],
    });
    report.lead = { title: "导语标题标记", leadParagraph: "导语正文标记" };
    report.overview = "总述标记";
    report.highlights = [outside];
    report.sections = [{ label: "栏目[甲]", summary: "栏目导读标记", items: [local, outside, fallback, withdrawn] }];
    report.flashes = [cite(report, {
      itemId: null, citationId: "flash-outside", title: "快讯标题标记", summary: "快讯摘要标记",
      sourceName: "快讯来源", sourceUrl: "https://example.test/flash",
      publishedAt: "2026-08-03T05:06:00.000Z", available: true,
      followUp: "2026-07-01", otherSources: 2,
    })];
  });
  const markdown = await read("agent/daily/2026-09-01.md");
  const rendered = staticDocumentLinks(markdown, "markdown");
  for (const marker of ["导语正文标记", "总述标记", "栏目导读标记", "窗外摘要标记", "相关引用标记",
    "相关摘要标记", "快讯标题标记", "快讯摘要标记", "回退摘要标记"]) assert.ok(markdown.includes(marker), marker);
  assert.match(markdown, /来源：窗外来源/);
  assert.match(markdown, /发布时间：2026-08-01 09:02（北京时间）/);
  assert.match(markdown, /跟进：2026-07-01 的日报报道过这件事，这里是新进展/);
  assert.match(markdown, /另有 2 家信源报道/);
  assert.match(markdown, /摘要：快讯摘要标记/);
  assert.ok(markdown.includes(`[隔离样例 0：模型更新](${base}/items/fixture-0000)`), "window detail link");
  assert.ok(markdown.includes("https://example.test/out%20%281%29"), "outside original link, escaped once");
  assert.ok(markdown.includes("[打开原文](https://example.test/out%20%281%29)"), "original is an auditable Markdown link");
  assert.ok(markdown.includes("https://example.test/related"), "related original link");
    assert.ok(markdown.includes("窗外\\[标题\\](x)"), "brackets in link labels are escaped");
  assert.ok(!markdown.includes("/items/old-outside"));
  assert.ok(!markdown.includes("/items/old-fallback"));
  assert.ok(!markdown.includes("old-outside"));
  assert.ok(!markdown.includes("old-fallback"));
  assert.ok(!/\/items\/(?![a-zA-Z0-9_-])/.test(markdown), "no empty local article id");
  assert.ok(!rendered.some((url) => /\/items\/(?:$|[?#])/.test(url)), "no rendered link with an empty article id");
  assert.ok(rendered.includes(`${base}/items/fixture-0000`), "the window detail is the only local article link");
  assert.ok(rendered.includes("https://example.test/out%20%281%29"), "the original stays an explicit link");
  assert.ok(markdown.includes(`${base}/daily/2026-09-01`), "issue-page fallback");
  assert.ok(markdown.includes("说明：本站未保留该历史文章详情，链接为本期页面。"));
  assert.ok(markdown.includes("撤回标题标记"));
  assert.ok(markdown.includes("已撤回"));
  for (const leaked of ["不应出现的撤回摘要", "不应出现的来源", "https://example.test/withdrawn",
    "不应出现的撤回相关", "不应出现的撤回相关摘要", "不应出现的撤回来源", "https://example.test/withdrawn-related"]) {
    assert.ok(!markdown.includes(leaked), leaked);
  }
});

test("a flashes-only issue keeps its flashes and the latest alias matches its dated issue", async () => {
  const { read } = await publish((data) => {
    const report = data.get("reports/daily/2026-11-08") as ReportDetail;
    const local = report.sections[0].items[0];
    report.lead = null;
    report.overview = null;
    report.highlights = [];
    report.sections = [];
    report.flashes = [{
      ...local, itemId: null, citationId: "flash-only", title: "仅快讯标记", summary: "仅快讯摘要",
      sourceName: "仅快讯来源", sourceUrl: "https://example.test/only-flash",
      publishedAt: "2026-11-08T04:05:00.000Z", available: true,
    }];
  });
  const latest = await read("agent/daily/2026-11-08.md");
  const alias = await read("agent/daily.md");
  assert.equal(alias, latest);
  assert.match(latest, /## 快讯/);
  assert.ok(latest.includes("仅快讯标记"));
  assert.ok(latest.includes("仅快讯摘要"));
  assert.ok(!latest.includes("本期没有入选内容"));
  const historical = await read("agent/daily/2026-09-01.md");
  assert.notEqual(historical, alias);
  assert.ok(historical.includes("2026-09-01"));
});

test("a period issue keeps its own lead paragraph when it differs from the overview", async () => {
  const { read } = await publish((data) => {
    const report = data.get("reports/weekly/2026-W45") as ReportDetail;
    report.lead = { title: "周报导语标题标记", leadParagraph: "周报导语段落标记" };
    report.overview = "周报总述标记";
    report.sections[0].summary = "周报栏目导读标记";
  });
  const markdown = await read("agent/weekly/2026-W45.md");
  for (const marker of ["周报导语标题标记", "周报导语段落标记", "周报总述标记", "周报栏目导读标记"]) {
    assert.ok(markdown.includes(marker), marker);
  }
  assert.ok(markdown.indexOf("周报导语段落标记") < markdown.indexOf("周报总述标记"), "lead paragraph precedes the overview");
});

test("the static reading guide keeps its article Markdown address in a code span", async () => {
  const { read } = await publish(() => {});
  const guide = await read("agent/index.md");
  assert.ok(guide.includes(`\`${base}/items/<id>/export.md\``), "template address is not a link");
  assert.ok(!staticDocumentLinks(guide, "markdown").some((url) => /\/items\/(?:$|[?#])/.test(url)), "no rendered link with an empty article id");
  assert.equal(guide, await read("llms.txt"));
});
