// The existing OG/poster renderers consume only the exported public projection, never a live DB.
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { SITE, ITEM_COPY, CARDS, REPORTS, withSubject } from "@aihot/site";
import { CATEGORY_LABELS } from "@aihot/contracts/taxonomy";
import { beijingDate } from "@aihot/contracts/time";
import type { StaticManifest } from "@aihot/contracts/static";
import type { SiteItemDetail, ReportDetail, StoryDetail, TopicPage } from "@aihot/contracts/site";
import type { OgCard } from "../packages/backend/src/media/og.ts";
import { staticFilePath } from "@aihot/contracts/static-manifest";

export async function writeStaticSharing(client: string, directory: string, m: StaticManifest, siteUrl: string) {
  // Font/layout caches must leave memory before the web gate runs. Each serial batch owns
  // its renderer process; the existing disk cache still reuses identical cards across builds.
  let batch: Array<{ file: string; card: OgCard }> = [];
  const flush = async () => {
    if (!batch.length) return;
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.env.AIHOT_STATIC_RENDER_COMMAND || process.execPath, ["--max-old-space-size=192", path.join(import.meta.dirname, "static-sharing-worker.ts"), client], {
        env: { ...process.env, SITE_URL: siteUrl, AIHOT_DATA_DIR: path.join(path.dirname(client), ".static-render-cache") },
        stdio: ["pipe", "inherit", "inherit"], windowsHide: true,
      });
      child.once("error", reject);
      child.once("close", (code, signal) => code === 0 ? resolve() : reject(new Error(`static share renderer failed (${signal ?? code})`)));
      child.stdin.on("error", reject);
      child.stdin.end(JSON.stringify(batch));
    });
    batch = [];
  };
  const read = async <T>(key: string): Promise<T> => JSON.parse(await readFile(path.join(directory, staticFilePath(m.files[key])), "utf8"));
  const og = async (file: string, card: OgCard) => {
    batch.push({ file, card });
    if (batch.length === 100) await flush();
  };
  await og("og/site.png", CARDS.site);
  for (const name of ["all", "hot", "topics", "daily", "weekly", "monthly", "starred", "more", "about", "terms", "privacy", "changelog", "agent"])
    await og(`og/pages/${name}.png`, (CARDS as Record<string, OgCard>)[name] ?? { kicker: SITE.name, title: name === "topics" ? SITE.topicsTitle : SITE.homeTitle, subtitle: SITE.description });
  for (const id of m.itemIds) {
    const item = await read<SiteItemDetail>(`items/${id}`);
    const kicker = item.category ? CATEGORY_LABELS[item.category] : withSubject("动态");
    await og(`og/items/${id}.png`, { kicker, title: item.title, subtitle: item.summary, meta: `${item.source.name} · ${beijingDate(item.timelineAt)}`,
      badge: item.selected && item.score !== null && ITEM_COPY.showScore ? { value: String(Math.round(item.score)), label: "精选评分" } : null });
  }
  for (const kind of ["daily", "weekly", "monthly"] as const) for (const { key } of m.reports[kind]) {
    const r = await read<ReportDetail>(`reports/${kind}/${key}`);
    await og(`og/reports/${kind}/${key}.png`, { kicker: `${withSubject(kind === "daily" ? "日报" : kind === "weekly" ? "周报" : "月报")} · ${key}`,
      title: r.lead?.title ?? r.title, subtitle: r.lead?.leadParagraph ?? r.overview,
      meta: `${r.sections.reduce((n, s) => n + s.items.length, 0)} ${REPORTS.shareUnit} · 约 ${r.readingMinutes} 分钟读完` });
  }
  for (const slug of Object.keys(m.topicPages)) {
    const { topic } = await read<TopicPage>(`topics/${slug}/1`);
    await og(`og/topics/${slug}.png`, { kicker: `主题 · ${topic.groupName}`, title: `${topic.name} 最新动态`, subtitle: topic.definition });
  }
  for (const id of m.stories) {
    const s = await read<StoryDetail>(`stories/${id}`);
    await og(`og/stories/${id}.png`, { kicker: s.whyHot.rank ? `热点第 ${s.whyHot.rank} · 事件` : "事件", title: s.title, subtitle: s.latest ?? s.digest,
      meta: `${s.sourceCount} 个来源 · ${s.reportCount} 篇报道`, accent: s.whyHot.rank ? "hot" : "teal" });
  }
  await flush();
}
