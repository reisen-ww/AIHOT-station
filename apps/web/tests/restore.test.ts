import assert from "node:assert/strict";
import { after, test } from "node:test";
import { staticModules } from "./helpers/static-browser.ts";

const descriptors = new Map(["window", "document"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
after(() => {
  for (const [name, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

test("position-only and feed snapshots do not collide across documents, filters or history entries", async () => {
  const values = new Map<string, string>();
  const sessionStorage = {
    get length() { return values.size; }, key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); },
  };
  Object.defineProperty(globalThis, "window", { configurable: true, value: Object.assign(new EventTarget(), { sessionStorage, scrollY: 120 }) });
  Object.defineProperty(globalThis, "document", { configurable: true, value: Object.assign(new EventTarget(), { visibilityState: "visible", querySelectorAll: () => [] }) });
  const restore = await staticModules().restore();
  const location = { key: "default", pathname: "/", search: "" };
  const home = restore.snapshotKey(location), starred = restore.snapshotKey({ ...location, pathname: "/starred" });
  const models = restore.snapshotKey({ ...location, search: "?category=ai-models" });
  const products = restore.snapshotKey({ ...location, search: "?category=ai-products" });
  restore.saveSnapshot(starred, null, true);
  assert.equal(restore.readSnapshot<null>(starred)?.data, null, "position-only snapshots remain valid");
  assert.equal(restore.readSnapshot(home), null, "a newly opened feed does not read the starred document");
  const state = { version: 2, cards: ["model-card"], nextCursor: "next", collapsed: [], batches: 2 };
  restore.saveSnapshot(models, state, true);
  assert.equal(restore.readSnapshot(products), null, "another filter does not inherit the previous list or cursor");
  assert.equal(restore.readSnapshot(restore.snapshotKey({ ...location, key: "another-entry", search: "?category=ai-models" })), null);
  assert.deepEqual(restore.readSnapshot(models)?.data, state, "returning to the same entry retains its list");
  assert.equal(restore.readSnapshot(models)?.scrollY, 120);
  const anchored = { ...location, hash: "#section" };
  assert.equal(restore.snapshotKey(anchored), home, "an outline anchor does not create a different list");
});
