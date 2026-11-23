import assert from "node:assert/strict";
import { after, test } from "node:test";
import { publicFixture } from "./helpers/static-fixture.ts";
import { staticModules } from "./helpers/static-browser.ts";
import type { PoolResponse, ReportDetail, ReportLatestPage, ReportNavigationResponse, SiteItemDetail, TimelineResponse } from "@aihot/contracts/site";
import { CATEGORY_KEYS } from "@aihot/contracts/taxonomy";

const fetchOriginal = globalThis.fetch;
const windowOriginal = Object.getOwnPropertyDescriptor(globalThis, "window");
const documentOriginal = Object.getOwnPropertyDescriptor(globalThis, "document");
after(() => {
  globalThis.fetch = fetchOriginal;
  for (const [name, descriptor] of [["window", windowOriginal], ["document", documentOriginal]] as const) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

function reader(options: { documentRevision?: string; pending?: string; tampered?: string } = {}) {
  const fixture = publicFixture(), requests: string[] = [];
  let release!: () => void, began!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { began = resolve; });
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: { location: { origin: "https://reader.test" } } },
    document: { configurable: true, value: { querySelector: () => ({ getAttribute: () => options.documentRevision ?? fixture.manifest.revision }) } },
  });
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://reader.test");
    assert.ok(url.pathname.startsWith("/hot-pages/aihot/data/"), "every read stays inside its station");
    const relative = url.pathname.slice("/hot-pages/aihot/data/".length);
    requests.push(relative);
    if (relative === fixture.manifest.files[options.pending ?? ""]) { began(); await gate; }
    if (relative === "manifest.json") return Response.json(fixture.manifest);
    const body = fixture.responses.get(relative);
    return body === undefined ? new Response("missing", { status: 404 }) : new Response(relative === fixture.manifest.files[options.tampered ?? ""] ? `${body} ` : body);
  };
  return { ...fixture, requests, started, release, api: staticModules().api() };
}

test("static route and interactive reads cover old pages, full-text search and report kinds", async () => {
  const r = reader(), api = await r.api;
  const pool = await api.apiGet<PoolResponse>("/api/site/pool?page=3");
  assert.equal(pool.total, 85);
  assert.equal(pool.items.length, 5);
  const summary = await api.apiGet<PoolResponse>("/api/site/pool?q=needle-body");
  assert.equal(summary.total, 0);
  const fulltext = await api.apiGet<PoolResponse>("/api/site/pool?q=needle-body&tab=relevance");
  assert.equal(fulltext.total, 85);
  const models = await api.apiGet<PoolResponse>(`/api/site/pool?category=${CATEGORY_KEYS[0]}&tag=模型发布&channel=firstParty`);
  assert.ok(models.total > 0);
  assert.ok(models.items.every((i) => i.category === CATEGORY_KEYS[0]));
  const first = await api.apiGet<TimelineResponse>("/api/site/timeline?limit=7");
  assert.equal(first.cards.length, 7);
  const next = await api.staticFetch(`/api/site/timeline?limit=7&cursor=${encodeURIComponent(first.nextCursor!)}`);
  assert.equal(next.status, 200);
  const nextData = await next.json() as TimelineResponse;
  assert.equal(nextData.cards.length, 7);
  assert.notEqual(nextData.cards[0].item.id, first.cards[0].item.id);
  const detail = await api.loadOr404<SiteItemDetail>(`/api/site/items/${pool.items.at(-1)!.id}`);
  assert.ok(detail.body?.zh?.includes("needle-body"));
  const original = await api.apiGet<SiteItemDetail>(`/api/site/items/${detail.id}/original`);
  assert.equal(original.bodyLanguage, "original");
  for (const [kind, key] of [["daily", "2026-09-01"], ["weekly", "2026-W45"], ["monthly", "2026-10"]]) {
    const report = await api.apiGet<ReportDetail>(`/api/site/reports/${kind}/${key}`);
    assert.equal(report.kind, kind);
    assert.equal(report.key, key);
    const latest = await api.apiGet<ReportLatestPage>(`/api/site/reports/${kind}/latest-page`);
    assert.equal(latest.report?.kind, kind);
  }
  const month = await api.apiGet<ReportNavigationResponse>("/api/site/reports/daily/months/2026-09");
  assert.equal(month.items[0].key, "2026-09-01");
  const md = await api.staticFetch(`/items/${detail.id}/markdown`);
  assert.match(md.headers.get("content-type")!, /text\/markdown/);
  assert.match(await md.text(), /needle-body/);
  assert.equal((await api.staticFetch("/api/site/items/missing")).status, 404);
  assert.equal((await api.staticFetch("/api/site/meta", { method: "POST" })).status, 405);
  assert.equal(r.requests.filter((p) => p === "manifest.json").length, 1);
  assert.equal(r.requests.filter((p) => p === r.manifest.files.catalog).length, 1);
});

test("a document from another revision cannot start reading a new snapshot", async () => {
  const r = reader({ documentRevision: "old-version" }), api = await r.api;
  await assert.rejects(api.apiGet("/api/site/pool"), api.StaticSnapshotChanged);
  assert.deepEqual(r.requests, ["manifest.json"]);
});

test("cancelled readers detach promptly without cancelling a shared immutable read", async () => {
  const r = reader({ pending: "catalog" }), api = await r.api, controller = new AbortController();
  let outcome: unknown;
  const cancelled = api.apiGet("/api/site/pool", { signal: controller.signal }).catch((error: unknown) => { outcome = error; });
  const other = api.apiGet<PoolResponse>("/api/site/pool?page=2");
  await r.started;
  controller.abort();
  await new Promise<void>((resolve) => setImmediate(resolve));
  try { assert.ok(outcome instanceof DOMException && outcome.name === "AbortError", "abort must not wait for the download to finish"); }
  finally { r.release(); await cancelled; await other; }
  assert.equal((await other).page, 2);
  assert.equal(r.requests.filter((p) => p === r.manifest.files.catalog).length, 1);
});

test("a content-addressed file with different bytes is refused rather than cached", async () => {
  const r = reader({ tampered: "catalog" }), api = await r.api;
  await assert.rejects(api.apiGet("/api/site/pool"), /integrity|checksum|hash/i);
  await assert.rejects(api.apiGet("/api/site/pool"), /integrity|checksum|hash/i);
  assert.equal(r.requests.filter((p) => p === r.manifest.files.catalog).length, 2);
});
