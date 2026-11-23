// Cheap per-URL share metadata, not a full-history React render. Hydration replaces these marked tags.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { SITE } from "@aihot/site";
import type { ReportDetail, SiteItemDetail, StoryDetail, TopicPage } from "@aihot/contracts/site";
import type { StaticManifest } from "@aihot/contracts/static";
import { staticFilePath } from "@aihot/contracts/static-manifest";

const escape = (v: string) => v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const TITLES: Record<string, string> = { all: `全部${SITE.subject}动态`, hot: "热点榜", topics: SITE.topicsTitle, daily: "日报", weekly: "周报", monthly: "月报", starred: "收藏", more: "我的", about: "关于", terms: "使用规则", privacy: "隐私说明", changelog: "更新日志", agent: "Agent 接入", "daily/archive": "日报 · 历史存档" };

export async function staticPage(route: string, manifest: StaticManifest, directory: string, siteUrl: string) {
  const read = async <T>(key: string): Promise<T> => JSON.parse(await readFile(path.join(directory, staticFilePath(manifest.files[key])), "utf8"));
  const parts = route.slice(1).split("/");
  let title = route === "/" ? SITE.homeTitle : TITLES[route.slice(1)] ?? SITE.name;
  let description: string = SITE.description, image = "/og/site.png", noindex = ["/starred", "/more", "/search-busy", "/all/search-busy"].includes(route);
  let article = false;
  if (parts[0] === "items") {
    const item = await read<SiteItemDetail>(`items/${parts[1]}`);
    title = item.title; description = item.summary ?? SITE.description; image = `/og/items/${item.id}.png`;
    noindex = !item.indexable || parts[2] === "original"; article = true;
  } else if (parts[0] === "story") {
    const id = manifest.aliases[parts[1]] ?? parts[1];
    const story = await read<StoryDetail>(`stories/${id}`);
    title = story.title; description = story.latest ?? story.digest ?? SITE.description; image = `/og/stories/${id}.png`;
  } else if (parts[0] === "topics" && parts[1]) {
    const { topic } = await read<TopicPage>(`topics/${parts[1]}/1`);
    title = `${topic.name} 最新动态`; description = topic.definition; image = `/og/topics/${topic.slug}.png`; noindex = !topic.indexable;
  } else if (["daily", "weekly", "monthly"].includes(parts[0]) && parts[1] && parts[1] !== "archive") {
    const report = await read<ReportDetail>(`reports/${parts[0]}/${parts[1]}`);
    title = report.title; description = report.lead?.leadParagraph ?? report.overview ?? SITE.description;
    image = `/og/reports/${report.kind}/${report.key}.png`; article = true;
  } else if (parts[0] && parts[0] !== "search-busy") image = `/og/pages/${parts[0]}.png`;
  const canonicalRoute = parts[0] === "story" && manifest.aliases[parts[1]] ? `/story/${manifest.aliases[parts[1]]}` : route;
  const url = siteUrl + canonicalRoute;
  const meta = (attribute: string, name: string, value: string) => `<meta data-static-meta="" ${attribute}="${escape(name)}" content="${escape(value)}"/>`;
  const documentTitle = route === "/" ? title : `${title} · ${SITE.name}`;
  const html = [`<title data-static-meta="">${escape(documentTitle)}</title>`, meta("name", "description", description),
    `<link data-static-meta="" rel="canonical" href="${escape(url)}"/>`,
    meta("property", "og:site_name", SITE.name), meta("property", "og:type", article ? "article" : "website"),
    meta("property", "og:title", title), meta("property", "og:description", description), meta("property", "og:url", url),
    meta("property", "og:image", siteUrl + image), meta("property", "og:image:width", "1200"), meta("property", "og:image:height", "630"),
    meta("name", "twitter:card", "summary_large_image"), meta("name", "twitter:title", title), meta("name", "twitter:description", description), meta("name", "twitter:image", siteUrl + image),
    ...(noindex ? [meta("name", "robots", "noindex, follow")] : [])].join("");
  return { html, title, description, image, url };
}
