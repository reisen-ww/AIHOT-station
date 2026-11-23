import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { writeStaticSharing } from "../../../scripts/static-sharing.ts";
import { publicFixture } from "./helpers/static-fixture.ts";
import type { SiteItemDetail } from "@aihot/contracts/site";

test("bulk share rendering keeps the caller environment isolated and writes every PNG across batches", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "static-sharing-"));
  const previous = { SITE_URL: process.env.SITE_URL, AIHOT_DATA_DIR: process.env.AIHOT_DATA_DIR };
  try {
    const directory = path.join(temporary, "snapshot"), client = path.join(temporary, "build/client");
    await mkdir(path.join(directory, "json"), { recursive: true });
    const fixture = publicFixture(101);
    const manifest = { ...fixture.manifest, files: {} as Record<string, string>, reports: { daily: [], weekly: [], monthly: [] }, topicPages: {}, stories: [] };
    for (const id of manifest.itemIds) {
      const item = fixture.data.get(`items/${id}`) as SiteItemDetail;
      const body = JSON.stringify({ ...item, title: "隔离制图测试", summary: "所有输出复用同一真实渲染缓存。", category: null, score: null, selected: false, timelineAt: fixture.manifest.asOf });
      const file = `json/${createHash("sha256").update(body).digest("hex")}.json`;
      manifest.files[`items/${id}`] = file;
      await writeFile(path.join(directory, file), body);
    }
    await writeStaticSharing(client, directory, manifest, "https://reader.test/hot-pages/aihot");
    assert.equal(process.env.SITE_URL, previous.SITE_URL, "renderer must not change the caller site URL");
    assert.equal(process.env.AIHOT_DATA_DIR, previous.AIHOT_DATA_DIR, "renderer must not change the caller runtime directory");
    assert.equal((await readdir(path.join(client, "og/items"))).length, manifest.itemIds.length);
    const first = await readFile(path.join(client, `og/items/${manifest.itemIds[0]}.png`));
    const last = await readFile(path.join(client, `og/items/${manifest.itemIds.at(-1)}.png`));
    assert.deepEqual(first, last, "later batches must preserve the renderer and cache identity");
    assert.deepEqual([...first.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(first.readUInt32BE(16), 1200);
    assert.equal(first.readUInt32BE(20), 630);
  } finally {
    for (const key of ["SITE_URL", "AIHOT_DATA_DIR"] as const) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await rm(temporary, { recursive: true, force: true });
  }
});

test("a renderer failure rejects the whole share stage", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "static-sharing-failure-"));
  const previous = { SITE_URL: process.env.SITE_URL, AIHOT_DATA_DIR: process.env.AIHOT_DATA_DIR };
  try {
    const client = path.join(temporary, "not-a-directory");
    await writeFile(client, "preserved");
    await assert.rejects(writeStaticSharing(client, temporary, { ...publicFixture(1).manifest, itemIds: [], reports: { daily: [], weekly: [], monthly: [] }, topicPages: {}, stories: [] }, "https://reader.test/hot-pages/aihot"));
    assert.equal(await readFile(client, "utf8"), "preserved");
  } finally {
    for (const key of ["SITE_URL", "AIHOT_DATA_DIR"] as const) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await rm(temporary, { recursive: true, force: true });
  }
});
