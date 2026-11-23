import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { createStaticFiles } from "../../../scripts/static-files.ts";
import { staticDocumentLinks, validateStaticData } from "../../../scripts/static-validate.ts";
import { publicFixture, writePublicFixture } from "./helpers/static-fixture.ts";

const temp = () => mkdtemp(path.join(process.env.LOCALAPPDATA!, "Temp", "opencode", "static-gate-"));
test("a complete snapshot passes byte and clickable-reference validation", async () => {
  const dir = path.join(await temp(), "data"), m = await writePublicFixture(dir, 3);
  assert.equal((await validateStaticData(dir, m)).items, 3);
  await writeFile(path.join(dir, m.files.catalog), "tampered");
  await assert.rejects(validateStaticData(dir, m), /checksum/);
});

test("rich fixtures cover nonempty events, groups, licensed media and historical citations", async () => {
  const dir = path.join(await temp(), "data"), m = await writePublicFixture(dir, 85, { rich: true, revision: "rich-check" });
  const result = await validateStaticData(dir, m);
  assert.equal(result.media, 1); assert.equal(m.stories.length, 4); assert.equal(Object.keys(m.aliases).length, 1);
});

test("dangling report references abort finish without leaving a manifest", async () => {
  const dir = path.join(await temp(), "data"), f = publicFixture(3), writer = await createStaticFiles(dir);
  (f.data.get("reports/daily/2026-09-01") as any).sections[0].items[0].itemId = "missing";
  for (const [key, value] of f.data) typeof value === "string" ? await writer.sink.text(key, value) : await writer.sink.json(key, value);
  const { files: _files, ...metadata } = f.manifest;
  await assert.rejects(writer.finish(metadata), /missing referenced item/);
  await assert.rejects(readFile(path.join(dir, "manifest.json")), /ENOENT/);
});

test("unlisted files and missing media cannot hide in otherwise complete public data", async () => {
  const root = await temp(), dir = path.join(root, "data"), m = await writePublicFixture(dir, 3);
  await writeFile(path.join(dir, "internal.json"), "{}");
  await assert.rejects(validateStaticData(dir, m), /unlisted/);
  await unlink(path.join(dir, "internal.json"));
  const file = m.files.contact;
  await unlink(path.join(dir, file));
  await assert.rejects(validateStaticData(dir, m), /ENOENT/);
});

test("rehashing cannot bless missing RSS, Markdown or rendered body links", async () => {
  const base = "https://reader.test/hot-pages/aihot";
  for (const kind of ["rss-link", "rss-description", "markdown", "body"] as const) {
    const f = publicFixture(1), dir = path.join(await temp(), "data"), writer = await createStaticFiles(dir, base);
    const missing = `${base}/items/old-not-online`;
    if (kind === "rss-link") f.data.set("feeds/all", `<rss><channel><item><link>${missing}</link></item></channel></rss>`);
    if (kind === "rss-description") f.data.set("feeds/all", `<rss><channel><item><description><![CDATA[<a href="${missing}">旧文</a>]]></description></item></channel></rss>`);
    if (kind === "markdown") f.data.set("markdown/fixture-0000", `# 正文\n\n[旧文][old]\n\n[old]: ${missing}`);
    if (kind === "body") (f.data.get("items/fixture-0000") as any).body.zh = `<a href="${missing}">旧文</a>`;
    for (const [key, value] of f.data) typeof value === "string" ? await writer.sink.text(key, value) : await writer.sink.json(key, value);
    const { files: _files, ...metadata } = f.manifest;
    await assert.rejects(writer.finish(metadata), /unresolved static link/, kind);
    await assert.rejects(readFile(path.join(dir, "manifest.json")), /ENOENT/);
  }
});

test("machine exits allow real originals, current issue fallbacks and live detail links", async () => {
  const f = publicFixture(1), base = "https://reader.test/hot-pages/aihot";
  f.data.set("feeds/all", `<rss><channel><item><link>${base}/daily/2026-09-01</link><description>&lt;a href=&quot;https://original.test/old?a=1&amp;amp;b=2&quot;&gt;原文&lt;/a&gt;</description></item></channel></rss>`);
  f.data.set("markdown/fixture-0000", `[本站](${base}/items/fixture-0000)\n\n[原文](https://original.test/a_(b))`);
  const dir = path.join(await temp(), "data"), writer = await createStaticFiles(dir, base);
  for (const [key, value] of f.data) typeof value === "string" ? await writer.sink.text(key, value) : await writer.sink.json(key, value);
  const { files: _files, ...metadata } = f.manifest;
  assert.equal((await writer.finish(metadata)).itemIds.length, 1);
  assert.deepEqual(staticDocumentLinks(`<rss><channel><description>&lt;a href=&quot;${base}/items/old&quot;&gt;x&lt;/a&gt;</description></channel></rss>`, "xml"), [`${base}/items/old`]);
});

test("bare prose URL heuristics cannot turn Chinese punctuation into a fatal external hostname", async () => {
  const prose = "文档链接：https://yr-lang.org，示例仓库：https://github.com/yr-lang/yrweb，npm 包：@yr-lang/yr";
  const base = "https://reader.test/hot-pages/aihot", own = base + "/items/fixture-0000";
  assert.deepEqual(staticDocumentLinks(prose + "\n\n" + own, "markdown"), [own]);
  const f = publicFixture(1), dir = path.join(await temp(), "data"), writer = await createStaticFiles(dir, base);
  f.data.set("markdown/fixture-0000", "# 原有正文\n\n" + prose + "\n\n[本站](" + own + ")");
  for (const [key, value] of f.data) typeof value === "string" ? await writer.sink.text(key, value) : await writer.sink.json(key, value);
  const { files: _files, ...metadata } = f.manifest;
  assert.equal((await writer.finish(metadata)).itemIds.length, 1);
});

test("explicit malformed links and real missing internal autolinks still abort the snapshot", async () => {
  const base = "https://reader.test/hot-pages/aihot";
  for (const copy of ["[显式坏链](https://bad%20host.test/path)", "<https://bad%20host.test/path>", base + "/items/not-online"]) {
    const f = publicFixture(1), dir = path.join(await temp(), "data"), writer = await createStaticFiles(dir, base);
    f.data.set("markdown/fixture-0000", copy);
    for (const [key, value] of f.data) typeof value === "string" ? await writer.sink.text(key, value) : await writer.sink.json(key, value);
    const { files: _files, ...metadata } = f.manifest;
    await assert.rejects(writer.finish(metadata), /Invalid URL|unresolved static link/);
    await assert.rejects(readFile(path.join(dir, "manifest.json")), /ENOENT/);
  }
});
