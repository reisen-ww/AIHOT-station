import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import path from "node:path";
import { parseStaticManifest } from "@aihot/contracts/static-manifest";
import { createStaticFiles } from "../../../scripts/static-files.ts";
import { publicFixture } from "./helpers/static-fixture.ts";
import { staticModules } from "./helpers/static-browser.ts";

function windowFixture() {
  const f = publicFixture(3);
  f.manifest.window = { maxItems: 3, publicItems: 4, onlineItems: 3, oldestAt: f.catalog.items.at(-1)!.sortAt, newestAt: f.catalog.items[0].sortAt, searchScope: "online-window" };
  const availability = f.data.get("availability") as Record<string, unknown>;
  availability.old = { status: "outside-window", sourceName: "保留的来源", originalUrl: "https://example.test/archive" };
  const text = JSON.stringify(availability), name = `json/${createHash("sha256").update(text).digest("hex")}.json`;
  f.manifest.files.availability = name; f.responses.set(name, text);
  return f;
}

test("window metadata rejects incorrect online counts, ordering and limits", () => {
  const f = windowFixture();
  assert.doesNotThrow(() => parseStaticManifest(f.manifest, "aihot"));
  for (const patch of [{ maxItems: 0 }, { onlineItems: 4 }, { publicItems: 2 }, { oldestAt: null }, { newestAt: "2000-01-01T00:00:00.000Z" }, { searchScope: "all-history" }]) {
    assert.throws(() => parseStaticManifest({ ...f.manifest, window: { ...f.manifest.window, ...patch } }, "aihot"), /window/);
  }
});

test("score retention extends the recent window without allowing inconsistent limits", () => {
  const f = windowFixture();
  const window = { ...f.manifest.window!, maxItems: 1, scoreRetention: { minimumScore: 85, additionalItems: 2 } };
  assert.doesNotThrow(() => parseStaticManifest({ ...f.manifest, window }, "aihot"));
  for (const minimumScore of [0, 85.5, 100]) {
    assert.doesNotThrow(() => parseStaticManifest({ ...f.manifest, window: { ...window, scoreRetention: { minimumScore, additionalItems: 2 } } }, "aihot"));
  }
  for (const scoreRetention of [null, {}, { minimumScore: -1, additionalItems: 2 }, { minimumScore: 101, additionalItems: 2 },
    { minimumScore: NaN, additionalItems: 2 }, { minimumScore: "85", additionalItems: 2 },
    { minimumScore: 85, additionalItems: -1 }, { minimumScore: 85, additionalItems: 1 }, { minimumScore: 85, additionalItems: 2.5 }]) {
    assert.throws(() => parseStaticManifest({ ...f.manifest, window: { ...window, scoreRetention } }, "aihot"), /window/);
  }
  assert.throws(() => parseStaticManifest({ ...f.manifest, window: { ...window, scoreRetention: undefined } }, "aihot"), /window/);
  assert.throws(() => parseStaticManifest({ ...f.manifest, window: { ...window, maxItems: 5 } }, "aihot"), /window/);
  assert.doesNotThrow(() => parseStaticManifest({ ...f.manifest, window: { ...window, maxItems: 5, publicItems: 3, scoreRetention: { minimumScore: 85, additionalItems: 0 } } }, "aihot"));
});

test("window closure requires a distinct archived index and never publishes archived detail bytes", async () => {
  const f = windowFixture(), dir = await mkdtemp(path.join(process.env.LOCALAPPDATA!, "Temp", "static-window-"));
  const writer = await createStaticFiles(path.join(dir, "valid"));
  for (const [key, value] of f.data) typeof value === "string" ? await writer.sink.text(key, value) : await writer.sink.json(key, value);
  const { files: _, ...metadata } = f.manifest;
  const m = await writer.finish(metadata);
  assert.equal(m.window!.publicItems, 4);
  assert.ok(!m.files["items/old"]);
  const invalid = await createStaticFiles(path.join(dir, "invalid"));
  for (const [key, value] of f.data) typeof value === "string" ? await invalid.sink.text(key, value) : await invalid.sink.json(key, value);
  await invalid.sink.json("items/old", { id: "old" });
  await assert.rejects(invalid.finish(metadata), /out-of-window/);
  await assert.rejects(readFile(path.join(dir, "invalid", "manifest.json")), /ENOENT/);
});

const originalFetch = globalThis.fetch;
const descriptors = ["window", "document"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
after(() => { globalThis.fetch = originalFetch; for (const [name, descriptor] of descriptors) descriptor ? Object.defineProperty(globalThis, name, descriptor) : Reflect.deleteProperty(globalThis, name); });
test("old articles, old Markdown and bookmarks distinguish outside-window from withdrawn or unknown", async () => {
  const f = windowFixture();
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { origin: "https://reader.test" } } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: { querySelector: () => ({ getAttribute: () => f.manifest.revision }) } });
  globalThis.fetch = async (input) => {
    const key = new URL(String(input)).pathname.slice("/hot-pages/aihot/data/".length);
    return key === "manifest.json" ? Response.json(f.manifest) : new Response(f.responses.get(key) ?? "missing");
  };
  const api = await staticModules().api();
  for (const suffix of ["old", "old/original"]) await assert.rejects(api.apiGet(`/api/site/items/${suffix}`), (e: unknown) => e instanceof Response && e.status === 410);
  assert.equal((await api.staticFetch("/items/old/markdown")).status, 410);
  assert.equal((await api.staticFetch("/api/site/items/withdrawn")).status, 404);
  const states = await api.apiGet<Record<string, { status: string }>>("/api/site/items/availability?ids=old,withdrawn,fixture-0000");
  assert.equal(states.old.status, "outside-window");
  assert.equal(states.withdrawn.status, "unavailable");
  assert.equal(states["fixture-0000"].status, "public");
  const pool = await api.apiGet<{ total: number }>("/api/site/pool?q=保留的来源");
  assert.equal(pool.total, 0);
  const meta = await api.apiGet<{ articleWindow: unknown }>("/api/site/meta");
  assert.deepEqual(meta.articleWindow, f.manifest.window);
});

test("Pages 404 handoff restores the exact station path and refuses cross-station or external targets", async () => {
  let restored = "";
  const origin = "https://reader.test";
  const history = { state: { kept: true }, replaceState: (state: unknown, _title: string, value: string) => { assert.deepEqual(state, { kept: true }); restored = value; } };
  const location = { href: "" };
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location, history } });
  const module = await staticModules().location();
  for (const target of ["https://other.test/hot-pages/aihot/items/old", "/hot-pages/cryptohot/items/old", "/hot-pages/aihot/404.html"]) {
    location.href = origin + "/hot-pages/aihot/404.html?__hot_path=" + encodeURIComponent(target);
    module.restoreStaticLocation(); assert.equal(restored, "");
  }
  const target = "/hot-pages/aihot/items/old?view=original#sec-2";
  location.href = origin + "/hot-pages/aihot/404.html?__hot_path=" + encodeURIComponent(target);
  module.restoreStaticLocation(); assert.equal(restored, target);
});
