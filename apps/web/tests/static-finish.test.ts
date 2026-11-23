import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { writePublicFixture } from "./helpers/static-fixture.ts";

test("isolated finalization writes a complete fixture release and refuses a damaged snapshot", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "static-finish-"));
  try {
    const data = path.join(temporary, "data"), client = path.join(temporary, "build/client");
    const manifest = await writePublicFixture(data, 1);
    const base = "/hot-pages/aihot";
    await mkdir(path.join(client, "assets"), { recursive: true });
    await writeFile(path.join(client, "assets/poster-client-fixture.js"), "// isolated fixture only");
    await writeFile(path.join(client, "index.html"), '<!doctype html><html><head><meta name="fixture-revision" content="' + manifest.revision + '"/><script src="' + base + '/assets/poster-client-fixture.js"></script></head><body><script>window.__reactRouterContext={}</script></body></html>');
    const environment = { ...process.env, AIHOT_STATIC_BUILD: "1", AIHOT_STATIC_STATION: "aihot", AIHOT_STATIC_DATA: data,
      AIHOT_STATIC_URL: "https://reader.test" + base, MODEL_CALLS_ENABLED: "false", COLLECT_ENABLED: "false", FEISHU_INTERNAL_ENABLED: "false", FEISHU_CONTENT_PUSH_ENABLED: "false", INDEXNOW_SUBMIT_ENABLED: "false" };
    const entry = fileURLToPath(new URL("../../../scripts/static-finish.ts", import.meta.url));
    const run = () => spawnSync(process.execPath, ["--max-old-space-size=192", entry, client], { env: environment, encoding: "utf8", windowsHide: true });
    const success = run();
    assert.equal(success.status, 0, success.stderr);
    const release = JSON.parse(await readFile(path.join(client, "static-release.json"), "utf8"));
    assert.equal(release.station, "aihot");
    assert.equal(release.revision, manifest.revision);
    assert.ok(release.files["404.html"]);
    assert.ok(release.files["og/items/" + manifest.itemIds[0] + ".png"]);
    await unlink(path.join(client, "static-release.json"));
    await unlink(path.join(data, manifest.files.catalog));
    const failure = run();
    assert.notEqual(failure.status, 0);
    await assert.rejects(readFile(path.join(client, "static-release.json")), { code: "ENOENT" });
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
