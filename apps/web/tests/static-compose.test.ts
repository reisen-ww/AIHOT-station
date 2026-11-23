import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { composeStaticSites } from "../../../scripts/static-compose.ts";

async function candidates() {
  const root = await mkdtemp(path.join(tmpdir(), "hot-compose-"));
  const inputs: Record<string, string> = {};
  for (const station of ["aihot", "cryptohot", "acadhot", "openhot"]) {
    const directory = inputs[station] = path.join(root, station);
    await mkdir(path.join(directory, "data"), { recursive: true });
    const files = {
      "index.html": `<script src="/hot-pages/${station}/assets/main.js"></script>`,
      "404.html": "station missing address shell",
      "data/manifest.json": JSON.stringify({ station, revision: `revision-${station}`, itemIds: [],
        reports: { daily: [{ key: "2026-11-06", title: `${station} verified report`, issueNumber: 1, count: 1 }], weekly: [], monthly: [] },
        routes: ["/", "/daily/2026-11-06"] }),
    };
    for (const [file, body] of Object.entries(files)) await writeFile(path.join(directory, file), body);
    await writeFile(path.join(directory, "static-release.json"), JSON.stringify({ schemaVersion: 1, station, revision: `revision-${station}`,
      files: Object.fromEntries(Object.entries(files).map(([file, body]) => [file, createHash("sha256").update(body).digest("hex")])) }));
  }
  return { root, inputs };
}

test("four station composition preserves release bytes, accounts for every file and restores old station addresses", async () => {
  const { root, inputs } = await candidates(), out = path.join(root, "combined");
  const result = await composeStaticSites(inputs, out, "https://reader.test/hot-pages", 1_000_000);
  const release = JSON.parse(await readFile(path.join(out, "static-site-release.json"), "utf8"));
  let bytes = Buffer.byteLength(await readFile(path.join(out, "static-site-release.json")));
  for (const [file, digest] of Object.entries(release.files)) {
    const body = await readFile(path.join(out, file));
    assert.equal(createHash("sha256").update(body).digest("hex"), digest); bytes += body.length;
  }
  assert.equal(result.bytes, bytes);
  assert.equal(result.stations.length, 4);
  const html = await readFile(path.join(out, "404.html"), "utf8");
  const script = html.split("<script>")[1].split("</script>")[0];
  let redirected = "";
  vm.runInNewContext(script, { location: { pathname: "/hot-pages/cryptohot/items/old", search: "?view=original", hash: "#sec-2",
    replace: (value: string) => { redirected = value; } } });
  assert.equal(redirected, "/hot-pages/cryptohot/404.html?__hot_path=" + encodeURIComponent("/hot-pages/cryptohot/items/old?view=original#sec-2"));
  await assert.rejects(composeStaticSites(inputs, out, "https://reader.test/hot-pages", 1_000_000), /EEXIST/);
});

test("a changed station or an over-budget candidate never obtains a combined release marker", async () => {
  const { root, inputs } = await candidates();
  const small = path.join(root, "too-large");
  await assert.rejects(composeStaticSites(inputs, small, "https://reader.test/hot-pages", 100), /exceeds budget/);
  await assert.rejects(readFile(path.join(small, "static-site-release.json")), /ENOENT/);
  await writeFile(path.join(inputs.cryptohot, "index.html"), "tampered");
  const altered = path.join(root, "changed");
  await assert.rejects(composeStaticSites(inputs, altered, "https://reader.test/hot-pages", 1_000_000), /bytes changed/);
  await assert.rejects(readFile(path.join(altered, "static-site-release.json")), /ENOENT/);
  await assert.rejects(composeStaticSites({ aihot: inputs.aihot }, path.join(root, "missing"), "https://reader.test/hot-pages", 1_000_000), /four station/);
});

test("portal report metadata stays bound to the manifest bytes verified against the release", async (context) => {
  const { root, inputs } = await candidates(), out = path.join(root, "portal-read-race");
  const manifestPath = path.resolve(inputs.aihot, "data/manifest.json");
  const originalRead = fsPromises.readFile;
  const altered = JSON.parse(await originalRead(manifestPath, "utf8"));
  altered.reports.daily[0].title = "unverified transient report";
  let sourceReads = 0;
  // Simulate a temporary replacement during a second source read, restored before copyFile.
  const intercepted = context.mock.method(fsPromises, "readFile", async (file: Parameters<typeof readFile>[0], options?: Parameters<typeof readFile>[1]) => {
    if (path.resolve(String(file)) === manifestPath && ++sourceReads === 2) {
      const body = Buffer.from(JSON.stringify(altered));
      return options === "utf8" ? body.toString("utf8") : body;
    }
    return options === undefined ? originalRead(file) : originalRead(file, options);
  });
  syncBuiltinESMExports();
  try {
    await composeStaticSites(inputs, out, "https://reader.test/hot-pages", 1_000_000);
  } finally {
    intercepted.mock.restore();
    syncBuiltinESMExports();
  }
  const html = await readFile(path.join(out, "index.html"), "utf8");
  const copied = JSON.parse(await readFile(path.join(out, "aihot/data/manifest.json"), "utf8"));
  assert.equal(copied.reports.daily[0].title, "aihot verified report");
  assert.ok(html.includes("aihot verified report"));
  assert.ok(!html.includes("unverified transient report"));
});
