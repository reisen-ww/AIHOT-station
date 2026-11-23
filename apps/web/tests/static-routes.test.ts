import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { staticRouteSource } from "../../../scripts/static-routes.ts";

test("static wrapper uses the original public loader and retains phone preview behavior", () => {
  const source = staticRouteSource(`export async function loader() {}\nexport async function clientLoader() {}\nexport function headers() {}\nexport function meta() {}\nexport const handle = {};\nexport default function ItemPage() {}`, "./original.tsx", "./deployment.ts");
  assert.match(source, /loader as read, clientLoader as preview/);
  assert.match(source, /localLoaderRequest\(args.request\)/);
  assert.match(source, /return preview\(\{ \.\.\.args, request, serverLoader \}\)/);
  assert.doesNotMatch(source, /headers/);
  assert.match(source, /export \{ meta, handle, default \}/);
});

test("re-exported original-language page exports stay available without server headers", () => {
  const source = staticRouteSource(`export { default, handle, headers, meta } from './item'; export async function loader() {}`, "./original.tsx", "./deployment.ts");
  assert.match(source, /export \{ default, handle, meta \}/);
  assert.doesNotMatch(source, /headers/);
});

test("a write-capable page is refused instead of shipping a dead static form", () => {
  assert.throws(() => staticRouteSource("export async function action() {}", "./original", "./deployment"), /unsupported write/);
});

test("static all-history UI does not advertise the dynamic 2000-result and 50-page caps", async () => {
  const source = await readFile(new URL("../app/routes/all.tsx", import.meta.url), "utf8");
  assert.match(source, /!STATIC_SITE && data\.total >= 2000/);
  assert.match(source, /!STATIC_SITE && data\.page >= 50/);
});

test("static tools summary describes only the file exits actually served by Pages", async () => {
  const source = await readFile(new URL("../app/routes/more.tsx", import.meta.url), "utf8");
  assert.match(source, /STATIC_SITE \? \["公开快照", "RSS", "Markdown"\]/);
});
