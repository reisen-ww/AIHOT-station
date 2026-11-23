import assert from "node:assert/strict";
import { after, test } from "node:test";
import { staticModules } from "./helpers/static-browser.ts";

const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const oldDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
after(() => {
  for (const [name, descriptor] of [["window", oldWindow], ["document", oldDocument]] as const) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

function browser() {
  const local = new Map<string, string>(), session = new Map<string, string>();
  const storage = (values: Map<string, string>) => ({
    get length() { return values.size; }, key: (i: number) => [...values.keys()][i] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); },
  });
  const window = Object.assign(new EventTarget(), { localStorage: storage(local), sessionStorage: storage(session) });
  const document = Object.assign(new EventTarget(), { visibilityState: "visible", cookie: "" });
  Object.defineProperties(globalThis, { window: { configurable: true, value: window }, document: { configurable: true, value: document } });
  return { local, session };
}
const star = { id: "same-id", title: "本站文章", summary: null, sourceName: "来源", publishedAt: null, score: null, aiSelected: true };

test("Pages isolates reader records on a shared origin while keeping the theme shared", async () => {
  const { local, session } = browser();
  const aiModules = staticModules(), cryptoModules = staticModules("cryptohot");
  const ai = await aiModules.state(), crypto = await cryptoModules.state();
  assert.equal(ai.toggleStar(star), true);
  ai.markRead(star.id);
  ai.addRecentSearch("AI查询");
  ai.setChangelogSeen("2026-11-08T12:00");
  ai.rememberPage("/all?page=2");
  assert.deepEqual(crypto.getStarred(), []);
  assert.deepEqual(crypto.getReadIds(), []);
  assert.equal(crypto.lastPage(), null);
  assert.equal(local.has(crypto.KEYS.recentSearches), false);
  assert.equal(local.has(crypto.KEYS.changelogSeen), false);
  crypto.toggleStar({ ...star, title: "另一站文章" });
  assert.equal(ai.getStarred()[0].title, "本站文章");
  ai.setThemePreference("ink");
  assert.equal(crypto.getThemePreference(), "ink");
  crypto.setThemePreference("sepia");
  assert.equal(ai.getThemePreference(), "sepia");
  const a = (await aiModules.cache()).sessionCache<{ savedAt: number; value: string }>("list:", 10000);
  const b = (await cryptoModules.cache()).sessionCache<{ savedAt: number; value: string }>("list:", 10000);
  a.set("same-history-key", { savedAt: Date.now(), value: "AI" });
  a.flush();
  assert.equal(b.read("same-history-key"), null);
  assert.ok(session.has("list:aihot:same-history-key"));
});

test("v2 rejects cross-station import and v1 requires confirmation without changing old records", async () => {
  const { local } = browser();
  const ai = await staticModules().state(), crypto = await staticModules("cryptohot").state();
  ai.toggleStar(star);
  const bundle = ai.exportBundle();
  assert.equal(bundle.version, 2);
  assert.equal(bundle.station, "aihot");
  assert.throws(() => crypto.importBundle(JSON.stringify(bundle)), /另一个站点/);
  assert.equal(local.has(crypto.KEYS.starred), false);
  const old = JSON.stringify([{ ...star, savedAt: "2026-01-01T00:00:00.000Z" }]);
  local.set("aihot-starred-items", old);
  local.set("aihot-read-items", JSON.stringify(["old-id"]));
  const legacy = crypto.legacyReaderBackup()!;
  assert.ok(legacy);
  assert.throws(() => crypto.importBundle(legacy), /确认/);
  assert.deepEqual(crypto.getStarred(), []);
  assert.equal(crypto.importBundle(legacy, true).starredAdded, 1);
  assert.deepEqual(crypto.getReadIds(), ["old-id"]);
  assert.equal(local.get("aihot-starred-items"), old);
  assert.equal(local.get("aihot-read-items"), '["old-id"]');
});

test("station base is applied once and reused loaders retain query, headers and cancellation", async () => {
  const deployment = await staticModules().deployment();
  assert.equal(deployment.sitePath("/feed.xml"), "/hot-pages/aihot/feed.xml");
  assert.equal(deployment.sitePath("/hot-pages/aihot/feed.xml"), "/hot-pages/aihot/feed.xml");
  assert.equal(deployment.sitePath("https://example.test/image.png"), "https://example.test/image.png");
  assert.equal(deployment.markdownPath("one"), "/hot-pages/aihot/items/one/export.md");
  const controller = new AbortController();
  const request = deployment.localLoaderRequest(new Request("https://reader.test/hot-pages/aihot/weekly/2026-W44?from=test", {
    signal: controller.signal, headers: { "X-Fixture": "one" },
  }));
  assert.equal(request.url, "https://reader.test/weekly/2026-W44?from=test");
  assert.equal(request.headers.get("X-Fixture"), "one");
  controller.abort();
  assert.equal(request.signal.aborted, true);
});
