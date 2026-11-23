import assert from "node:assert/strict";
import { after, test } from "node:test";
import { staticModules } from "./helpers/static-browser.ts";

const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
after(() => {
  if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
  else Reflect.deleteProperty(globalThis, "window");
});

test("static copied URLs, canonical, OG and structured data use the public station even in a local preview", async () => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { origin: "http://127.0.0.1:43817" } } });
  const seo = await staticModules().seo(), base = "https://reader.test/hot-pages/aihot";
  assert.equal(seo.siteUrl(), base);
  const tags = seo.pageMeta({ title: "隔离文章", path: "/items/one", image: "/og/items/one.png" });
  assert.ok(tags.some((tag) => "rel" in tag && tag.rel === "canonical" && tag.href === `${base}/items/one`));
  assert.ok(tags.some((tag) => "property" in tag && tag.property === "og:url" && tag.content === `${base}/items/one`));
  assert.ok(tags.some((tag) => "property" in tag && tag.property === "og:image" && tag.content === `${base}/og/items/one.png`));
  assert.equal(seo.breadcrumbLd([{ name: "正文", path: "/items/one" }]).itemListElement[0].item, `${base}/items/one`);
  assert.ok(!JSON.stringify(tags).includes("127.0.0.1"));
  assert.equal((await staticModules("cryptohot").seo()).siteUrl(), "https://reader.test/hot-pages/cryptohot");
});
