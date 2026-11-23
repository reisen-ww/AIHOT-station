import assert from "node:assert/strict";
import { test } from "node:test";
import { parseStaticManifest, staticFilePath } from "@aihot/contracts/static-manifest";
import type { StaticManifest } from "@aihot/contracts/static";

export function emptyManifest(): StaticManifest {
  const file = `json/${"a".repeat(64)}.json`;
  return { schemaVersion: 1, station: "aihot", revision: "fixture-v1", asOf: "2026-01-01T00:00:00.000Z",
    files: Object.fromEntries(["catalog", "availability", "topics", "hot", "hot-strip", "meta", "changelog", "contact", "stats"].map((key) => [key, file])),
    routes: ["/", "/all", "/hot", "/topics", "/daily", "/daily/archive", "/weekly", "/monthly", "/starred", "/more", "/about", "/terms", "/privacy", "/changelog", "/agent"],
    itemIds: [], stories: [], bodyShards: [], reports: { daily: [], weekly: [], monthly: [] }, topicPages: {}, aliases: {} };
}

test("manifest paths cannot escape a station or select another origin", () => {
  for (const path of ["../manifest.json", "/api/secret", "https://example.test/a", `md/${"a".repeat(64)}.json`, `json/${"a".repeat(64)}.json?url=evil`]) {
    assert.throws(() => staticFilePath(path), /unsafe/);
  }
  assert.doesNotThrow(() => parseStaticManifest(emptyManifest(), "aihot"));
  assert.throws(() => parseStaticManifest(emptyManifest(), "cryptohot"), /invalid/);
});

test("missing details, topic pages, route entries and alias targets prevent a valid manifest", () => {
  const item = emptyManifest();
  item.itemIds.push("missing");
  assert.throws(() => parseStaticManifest(item, "aihot"), /missing public detail/);
  const topic = emptyManifest();
  topic.topicPages.example = 2;
  assert.throws(() => parseStaticManifest(topic, "aihot"), /missing topic/);
  const route = emptyManifest();
  route.routes.splice(route.routes.indexOf("/all"), 1);
  assert.throws(() => parseStaticManifest(route, "aihot"), /missing static route/);
  const alias = emptyManifest();
  alias.aliases["00000000-0000-0000-0000-000000000001"] = "00000000-0000-0000-0000-000000000002";
  assert.throws(() => parseStaticManifest(alias, "aihot"), /alias/);
});
