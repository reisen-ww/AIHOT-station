import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { staticMediaSink, type StaticIconFallback } from "../../../scripts/static-media.ts";

const temp = (name: string) => mkdtemp(path.join(process.env.LOCALAPPDATA!, "Temp", "opencode", `static-media-${name}-`));
const proxy = (upstream: string, mode: string) => `/api/img-proxy?u=${encodeURIComponent(upstream)}&mode=${mode}&exp=1794441600&sig=57fdacac6e6ea8c7`;
const dns = (host = "protos-media.s3.eu-west-2.amazonaws.com") => Object.assign(new TypeError("fetch failed"), {
  cause: Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND", syscall: "getaddrinfo", hostname: host }),
});
const upstream = (status: number) => new Error(`static image upstream ${status}`);
const mediaFiles = (dir: string) => readdir(path.join(dir, "media")).catch((error: NodeJS.ErrnoException) => {
  if (error.code === "ENOENT") return [] as string[];
  throw error;
});
// The published shapes SourceAvatar renders: a report citation and a hot participant.
const citation = (sourceIconUrl: string | null, sourceIconSrcSet?: string) => ({ itemId: null, available: true, sourceIconUrl,
  ...(sourceIconSrcSet ? { sourceIconSrcSet } : {}) });
const srcSetOnly = (sourceIconSrcSet: string) => ({ itemId: null, available: true, sourceIconSrcSet });
const participant = (iconUrl: string, iconSrcSet?: string) => ({ name: "戊", kind: "editorial" as const, iconUrl,
  ...(iconSrcSet ? { iconSrcSet } : {}) });

test("media projection replaces HTML, srcset and signed URLs, sharing each rendition", async () => {
  const dir = await mkdtemp(path.join(process.env.LOCALAPPDATA!, "Temp", "opencode", "static-media-"));
  let value: any, calls = 0;
  const p = "/api/img-proxy?u=https%3A%2F%2Fexample.test%2Fa.png&mode=full&exp=1&sig=fake";
  const sink = staticMediaSink({ json: async (_k, v) => { value = v; }, text: async () => {} }, dir, "/hot-pages/aihot", async (url, mode) => {
    assert.equal(url, "https://example.test/a.png"); assert.equal(mode, "full"); calls++;
    return { body: Buffer.from("fixture-image"), type: "image/png" };
  });
  await sink.json("items/a", { image: p, srcSet: `${p} 720w, ${p} 1080w`, html: `<img src="${p.replaceAll("&", "&amp;")}">` });
  assert.equal(calls, 1);
  assert.match(value.image, /^\/hot-pages\/aihot\/data\/media\/[a-f0-9]{64}\.png$/);
  assert.equal(await readFile(path.join(dir, value.image.split("/data/")[1]), "utf8"), "fixture-image");
  assert.ok(!JSON.stringify(value).includes("img-proxy"));
  assert.ok(value.srcSet.includes("720w,"));
  assert.ok(value.html.includes(value.image));
});

test("prefixed absolute RSS media stays absolute and contact files are copied by content", async () => {
  const dir = await mkdtemp(path.join(process.env.LOCALAPPDATA!, "Temp", "opencode", "static-media-"));
  let xml = "", contact: any;
  const base = "https://reader.test/hot-pages/aihot";
  const sink = staticMediaSink({ json: async (_key, value) => { contact = value; }, text: async (_key, value) => { xml = value; } }, dir, "/hot-pages/aihot",
    async () => ({ body: Buffer.from("remote-image"), type: "image/png" }), base,
    async (url) => { assert.equal(url, "/contact/qr-wechat-abcd1234.png"); return { body: Buffer.from("contact-image"), type: "image/png" }; });
  await sink.text("feeds/full", `<img src="${base}/api/img-proxy?u=https%3A%2F%2Fexample.test%2Fa.png&amp;mode=full">`);
  assert.match(xml, /src="https:\/\/reader\.test\/hot-pages\/aihot\/data\/media\/[a-f0-9]{64}\.png"/);
  assert.ok(!xml.includes("img-proxy"));
  await sink.json("contact", { wechatQr: "/contact/qr-wechat-abcd1234.png" });
  assert.equal(await readFile(path.join(dir, contact.wechatQr.split("/data/")[1]), "utf8"), "contact-image");
});

test("a media failure aborts the public write rather than publishing a broken signed URL", async () => {
  let written = false;
  const sink = staticMediaSink({ json: async () => { written = true; }, text: async () => {} }, "unused", "/hot-pages/aihot", async () => { throw new Error("unavailable image"); });
  await assert.rejects(sink.json("catalog", { src: "/api/img-proxy?u=https%3A%2F%2Fexample.test%2Fa.png" }), /unavailable/);
  assert.equal(written, false);
});

test("a dead source icon in a report citation falls back to the initial and is audited", async () => {
  const dir = await temp("icon-fallback");
  const audit: StaticIconFallback[] = [];
  let value: any;
  const url = proxy("https://protos-media.s3.eu-west-2.amazonaws.com/icon.png", "avatar");
  const srcSet = `${proxy("https://protos-media.s3.eu-west-2.amazonaws.com/icon.png", "avatar-48")} 48w, ${proxy("https://protos-media.s3.eu-west-2.amazonaws.com/icon.png", "avatar-96")} 96w`;
  const sink = staticMediaSink({ json: async (_key, v) => { value = v; }, text: async () => {} }, dir, "/hot-pages/cryptohot",
    async () => { throw dns(); }, undefined, undefined, (fallback) => audit.push(fallback));
  await sink.json("reports/daily/2026-11-06", { sections: [{ items: [{ title: "x", related: [citation(url, srcSet)] }] }] });
  const written = value.sections[0].items[0].related[0];
  assert.equal(written.sourceIconUrl, null, "the citation keeps a null icon so SourceAvatar shows the initial");
  assert.ok(!Object.hasOwn(written, "sourceIconSrcSet"), "a dropped icon must not keep a paired srcset");
  assert.deepEqual([...audit], [{ key: "reports/daily/2026-11-06", field: "sections[0].items[0].related[0].sourceIconUrl", kind: "dns" }]);
  assert.ok(!JSON.stringify(audit).includes("sig="), "the audit must not carry a signature");
  assert.ok(!JSON.stringify(audit).includes("protos-media"), "the audit must not carry the upstream address");
  assert.deepEqual(await mediaFiles(dir), []);
});

test("a hot participant icon falls back, while a partially failed srcset leaves no unreferenced media", async () => {
  const dir = await temp("icon-partial");
  const audit: StaticIconFallback[] = [];
  let value: any;
  const avatar = proxy("https://protos-media.s3.eu-west-2.amazonaws.com/a.png", "avatar");
  const srcSet = `${proxy("https://protos-media.s3.eu-west-2.amazonaws.com/a.png", "avatar-48")} 48w, ${proxy("https://protos-media.s3.eu-west-2.amazonaws.com/b.png", "avatar-96")} 96w`;
  const sink = staticMediaSink({ json: async (_key, v) => { value = v; }, text: async () => {} }, dir, "/hot-pages/cryptohot",
    async (url, mode) => {
      if (url.endsWith("b.png")) throw dns();
      return { body: Buffer.from(`fixture-${mode}-${url}`), type: "image/png" };
    }, undefined, undefined, (fallback) => audit.push(fallback));
  await sink.json("hot", { entries: [{ story: { publicId: "s" } }, { story: { publicId: "t" } }, { story: { publicId: "u" },
    participants: [{ name: "甲", kind: "editorial" }, { name: "乙", kind: "editorial" }, { name: "丙", kind: "editorial" },
      { name: "丁", kind: "editorial" }, participant(avatar, srcSet)] }] });
  const face = value.entries[2].participants[4];
  assert.match(face.iconUrl, /^\/hot-pages\/cryptohot\/data\/media\/[a-f0-9]{64}\.png$/);
  assert.ok(!Object.hasOwn(face, "iconSrcSet"), "the whole srcset is dropped when one candidate cannot be fetched");
  assert.deepEqual([...audit], [{ key: "hot", field: "entries[2].participants[4].iconSrcSet", kind: "dns" }]);
  // Only the icon actually referenced by the published field may reach the media directory; a
  // candidate of the dropped srcset would be an unlisted file that validateStaticData rejects.
  assert.deepEqual(await mediaFiles(dir), [face.iconUrl.split("/data/media/")[1]]);
  // The home strip carries the same published field, so the same fallback applies there.
  let strip: any;
  const stripSink = staticMediaSink({ json: async (_key, v) => { strip = v; }, text: async () => {} }, dir, "/hot-pages/cryptohot",
    async (url, mode) => {
      if (url.endsWith("b.png")) throw dns();
      return { body: Buffer.from(`fixture-${mode}-${url}`), type: "image/png" };
    }, undefined, undefined, (fallback) => audit.push(fallback));
  await stripSink.json("hot-strip", [{ participants: [participant(avatar, srcSet)] }]);
  assert.match(strip[0].participants[0].iconUrl, /^\/hot-pages\/cryptohot\/data\/media\/[a-f0-9]{64}\.png$/);
  assert.ok(!Object.hasOwn(strip[0].participants[0], "iconSrcSet"));
  assert.deepEqual(audit.at(-1), { key: "hot-strip", field: "[0].participants[0].iconSrcSet", kind: "dns" });
  // Every published reference is either written or absent; nothing from the dropped srcset exists.
  const referenced = [face.iconUrl, strip[0].participants[0].iconUrl].map((url) => url.split("/data/media/")[1]);
  for (const file of await mediaFiles(dir)) assert.ok(referenced.includes(file), `unreferenced media ${file}`);
});

test("a candidate released by a failed srcset is fetched again when another citation needs it", async () => {
  const dir = await temp("icon-reuse");
  const audit: StaticIconFallback[] = [];
  const written: any[] = [];
  const first = `${proxy("https://example.test/a.png", "avatar-48")} 48w, ${proxy("https://example.test/gone.png", "avatar-96")} 96w`;
  const second = `${proxy("https://example.test/a.png", "avatar-48")} 48w, ${proxy("https://example.test/c.png", "avatar-96")} 96w`;
  let downloads = 0;
  const sink = staticMediaSink({ json: async (_key, value) => { written.push(value); }, text: async () => {} }, dir, "/hot-pages/cryptohot",
    async (upstream) => {
      downloads++;
      if (upstream.endsWith("gone.png")) throw dns();
      return { body: Buffer.from(`fixture-${upstream}`), type: "image/png" };
    }, undefined, undefined, (fallback) => audit.push(fallback));
  await sink.json("reports/daily/2026-11-06", { sections: [{ items: [citation(null, first)] }] });
  assert.equal(written[0].sections[0].items[0].sourceIconUrl, null);
  assert.ok(!Object.hasOwn(written[0].sections[0].items[0], "sourceIconSrcSet"));
  assert.deepEqual(await mediaFiles(dir), [], "no candidate of a dropped srcset is written");
  await sink.json("reports/weekly/2026-W45", { highlights: [citation(null, second)] });
  assert.match(written[1].highlights[0].sourceIconSrcSet, /48w, .*96w$/);
  assert.equal(downloads, 4, "the released candidate is downloaded again for the complete set");
  assert.equal((await mediaFiles(dir)).length, 2, "both candidates of the complete set are written once");
  assert.deepEqual([...audit].map((entry) => entry.key), ["reports/daily/2026-11-06"]);
});

test("body, contact, unknown and X avatar media keep failing on the same network error", async () => {
  const dead = proxy("https://protos-media.s3.eu-west-2.amazonaws.com/icon.png", "avatar");
  const audit: StaticIconFallback[] = [];
  const sink = staticMediaSink({ json: async () => {}, text: async () => {} }, await temp("icon-strict"), "/hot-pages/cryptohot",
    async () => { throw dns(); }, undefined, async () => { throw new Error("contact asset unavailable"); }, (fallback) => audit.push(fallback));
  await assert.rejects(sink.json("items/a", { body: { zh: `<img src="${dead}">` } }), /ENOTFOUND|fetch failed/);
  await assert.rejects(sink.json("items/a", { x: { authorName: "甲", avatarUrl: dead, avatarSrcSet: `${dead} 96w` } }), /ENOTFOUND|fetch failed/);
  await assert.rejects(sink.json("contact", { wechatQr: "/contact/qr-wechat-deadbeef.png", feishuQr: null, makerAvatar: null }), /contact asset unavailable/);
  await assert.rejects(sink.json("contact", { wechatQr: null, feishuQr: null, makerAvatar: dead }), /ENOTFOUND|fetch failed/);
  await assert.rejects(sink.json("stories/abc", { sourceIconUrl: dead }), /ENOTFOUND|fetch failed/);
  await assert.rejects(sink.json("catalog", { items: [{ item: { sourceIconUrl: dead } }] }), /ENOTFOUND|fetch failed/);
  // A citation-shaped object outside a report key, and a report-shaped object missing the
  // citation markers, stay strict even though the field names match.
  await assert.rejects(sink.json("meta", citation(dead)), /ENOTFOUND|fetch failed/);
  await assert.rejects(sink.json("reports/daily/2026-11-06", { sections: [{ items: [{ sourceIconUrl: dead }] }] }), /ENOTFOUND|fetch failed/);
  // A cover picture is body media, not a source icon, even inside the same hot entry.
  await assert.rejects(sink.json("hot", { entries: [{ story: { publicId: "s" }, cover: { url: dead } }] }), /ENOTFOUND|fetch failed/);
  // A same-named field outside participants[].iconUrl stays strict.
  await assert.rejects(sink.json("hot-strip", [{ participants: [], title: dead }]), /ENOTFOUND|fetch failed/);
  assert.deepEqual([...audit], [], "only the two published icon fields may be audited as a fallback");
});

test("an unknown avatar rendition, an invalid proxy or bad bytes are never treated as a network failure", async () => {
  const audit: StaticIconFallback[] = [];
  const dir = await temp("icon-invalid");
  let calls = 0;
  const sink = staticMediaSink({ json: async () => {}, text: async () => {} }, dir, "/hot-pages/cryptohot",
    async () => { calls++; throw dns(); }, undefined, undefined, (fallback) => audit.push(fallback));
  const report = (sourceIconUrl: string, sourceIconSrcSet?: string) => ({ sections: [{ items: [citation(sourceIconUrl, sourceIconSrcSet)] }] });
  await assert.rejects(sink.json("reports/weekly/2026-W45", report(proxy("https://example.test/a.png", "avatar-123"))), /fetch failed/);
  await assert.rejects(sink.json("reports/weekly/2026-W45", report(proxy("https://example.test/a.png", "thumb"))), /fetch failed/);
  await assert.rejects(sink.json("reports/weekly/2026-W45", report("/api/img-proxy?u=javascript%3Aalert(1)&mode=avatar")), /invalid public image/);
  await assert.rejects(sink.json("reports/weekly/2026-W45", report("/api/img-proxy?mode=avatar")), /invalid public image/);
  // A srcset candidate outside the three SourceAvatar renditions is rejected before any download.
  await assert.rejects(sink.json("reports/weekly/2026-W45", { sections: [{ items: [srcSetOnly(
    `${proxy("https://example.test/a.png", "avatar-48")} 48w, ${proxy("https://example.test/a.png", "avatar-123")} 96w`)] }] }), /not an avatar rendition/);
  await assert.rejects(sink.json("reports/weekly/2026-W45", { sections: [{ items: [srcSetOnly(
    `${proxy("https://example.test/a.png", "avatar-48")} 48w, /api/img-proxy?u=javascript%3Aalert(1)&mode=avatar-96 96w`)] }] }), /invalid public image/);
  assert.equal(calls, 2, "only the two exact avatar URL modes may reach the network");
  assert.deepEqual([...audit], []);
  const bytes = staticMediaSink({ json: async () => {}, text: async () => {} }, dir, "/hot-pages/cryptohot",
    async () => ({ body: Buffer.alloc(0), type: "image/png" }), undefined, undefined, (fallback) => audit.push(fallback));
  await assert.rejects(bytes.json("reports/monthly/2026-10", report(proxy("https://example.test/b.png", "avatar"))), /invalid static image bytes/);
  assert.deepEqual([...audit], []);
});

test("a media write failure is never published as an initial", async () => {
  const dir = await temp("icon-write");
  await writeFile(path.join(dir, "media"), "not a directory");
  const audit: StaticIconFallback[] = [];
  let written = false;
  const sink = staticMediaSink({ json: async () => { written = true; }, text: async () => {} }, dir, "/hot-pages/cryptohot",
    async () => ({ body: Buffer.from("fixture"), type: "image/png" }), undefined, undefined, (fallback) => audit.push(fallback));
  await assert.rejects(sink.json("reports/daily/2026-11-06", { sections: [{ items: [citation(proxy("https://example.test/a.png", "avatar"))] }] }), /static media write failed/);
  assert.equal(written, false);
  assert.deepEqual([...audit], []);
});

test("an icon fallback for one URL does not soften a strict consumer of the same URL", async () => {
  const dead = proxy("https://protos-media.s3.eu-west-2.amazonaws.com/icon.png", "avatar");
  const audit: StaticIconFallback[] = [];
  const sink = staticMediaSink({ json: async () => {}, text: async () => {} }, await temp("icon-shared"), "/hot-pages/cryptohot",
    async () => { throw dns(); }, undefined, undefined, (fallback) => audit.push(fallback));
  await sink.json("reports/daily/2026-11-06", { flashes: [citation(dead)] });
  assert.equal(audit.length, 1);
  await assert.rejects(sink.json("items/b", { body: { zh: `<img src="${dead}">` } }), /ENOTFOUND|fetch failed/);
});

test("a source icon the publisher refuses or no longer serves (403/404/410) falls back, while other statuses stay fatal", async () => {
  const dir = await temp("icon-http");
  const audit: StaticIconFallback[] = [];
  const written: any[] = [];
  const statuses = new Map<string, number>([
    ["gone-403.png", 403], ["gone-404.png", 404], ["gone-410.png", 410],
    ["gone-429.png", 429], ["gone-400.png", 400], ["gone-503.png", 503],
    ["body-403.png", 403], ["body-404.png", 404], ["x-404.png", 404], ["contact-404.png", 404],
    ["story-404.png", 404], ["cover-404.png", 404], ["nested-404.png", 404],
  ]);
  const icon = (name: string) => proxy(`https://protos-media.s3.eu-west-2.amazonaws.com/${name}`, "avatar");
  const gone = icon("gone-404.png");
  const sink = staticMediaSink({ json: async (_key, value) => { written.push(value); }, text: async () => {} }, dir, "/hot-pages/cryptohot",
    async (url) => { throw upstream(statuses.get(url.split("/").at(-1)!)!); }, undefined, undefined, (fallback) => audit.push(fallback));
  const report = { sections: [{ items: [citation(gone)] }] };
  await sink.json("reports/daily/2026-11-06", report);
  assert.equal(written[0].sections[0].items[0].sourceIconUrl, null);
  await sink.json("reports/weekly/2026-W45", { sections: [{ items: [citation(icon("gone-403.png"))] }] });
  assert.equal(written[1].sections[0].items[0].sourceIconUrl, null);
  await sink.json("reports/monthly/2026-10", { highlights: [citation(icon("gone-410.png"))] });
  assert.equal(written[2].highlights[0].sourceIconUrl, null);
  assert.deepEqual([...audit], [
    { key: "reports/daily/2026-11-06", field: "sections[0].items[0].sourceIconUrl", kind: "http", status: 404 },
    { key: "reports/weekly/2026-W45", field: "sections[0].items[0].sourceIconUrl", kind: "http", status: 403 },
    { key: "reports/monthly/2026-10", field: "highlights[0].sourceIconUrl", kind: "http", status: 410 },
  ]);
  // The same statuses stay fatal for body media, contact images, X avatars, unknown keys and
  // non-icon fields. Each uses its own upstream so the failure is fetched, not replayed from a
  // cached rejection.
  await assert.rejects(sink.json("items/a", { body: { zh: `<img src="${icon("body-404.png")}">` } }), /static image upstream 404/);
  await assert.rejects(sink.json("items/a", { body: { zh: `<img src="${icon("body-403.png")}">` } }), /static image upstream 403/);
  await assert.rejects(sink.json("items/a", { x: { authorName: "甲", avatarUrl: icon("x-404.png") } }), /static image upstream 404/);
  await assert.rejects(sink.json("contact", { wechatQr: null, feishuQr: null, makerAvatar: icon("contact-404.png") }), /static image upstream 404/);
  await assert.rejects(sink.json("stories/abc", { sourceIconUrl: icon("story-404.png") }), /static image upstream 404/);
  await assert.rejects(sink.json("hot", { entries: [{ story: { publicId: "s" }, cover: { url: icon("cover-404.png") } }] }), /static image upstream 404/);
  await assert.rejects(sink.json("reports/monthly/2026-10", { sections: [{ items: [{ sourceIconUrl: icon("nested-404.png") }] }] }), /static image upstream 404/);
  await assert.rejects(sink.json("reports/daily/2026-11-06", { sections: [{ items: [citation(icon("gone-503.png"))] }] }), /static image upstream 503/);
  await assert.rejects(sink.json("reports/daily/2026-11-06", { sections: [{ items: [citation(icon("gone-429.png"))] }] }), /static image upstream 429/);
  await assert.rejects(sink.json("reports/daily/2026-11-06", { sections: [{ items: [citation(icon("gone-400.png"))] }] }), /static image upstream 400/);
  assert.equal(audit.length, 3, "only 403, 404 and 410 on the two published icon fields are audited");
});

test("a 404 in one srcset candidate drops the set without writing the candidate that succeeded", async () => {
  const dir = await temp("icon-http-srcset");
  const audit: StaticIconFallback[] = [];
  let value: any;
  const avatar = proxy("https://example.test/icon.png", "avatar");
  const srcSet = `${proxy("https://example.test/a.png", "avatar-48")} 48w, ${proxy("https://example.test/gone.png", "avatar-96")} 96w`;
  const sink = staticMediaSink({ json: async (_key, v) => { value = v; }, text: async () => {} }, dir, "/hot-pages/cryptohot",
    async (url, mode) => {
      if (url.endsWith("gone.png")) throw upstream(404);
      return { body: Buffer.from(`fixture-${mode}-${url}`), type: "image/png" };
    }, undefined, undefined, (fallback) => audit.push(fallback));
  await sink.json("reports/daily/2026-11-06", { flashes: [citation(avatar, srcSet)] });
  assert.ok(!Object.hasOwn(value.flashes[0], "sourceIconSrcSet"));
  assert.deepEqual([...audit], [{ key: "reports/daily/2026-11-06", field: "flashes[0].sourceIconSrcSet", kind: "http", status: 404 }]);
  assert.equal((await mediaFiles(dir)).length, 1, "only the URL icon is referenced and written");
});
