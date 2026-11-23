// Explicit fake public content for adapter, build and browser checks; never connects to a station DB.
import { createHash } from "node:crypto";
import type { HotEntryView, ReportDetail, ReportKind, SiteItemDetail, StoryDetail, TopicPage } from "@aihot/contracts/site";
import type { StaticCatalog, StaticListItem, StaticManifest } from "@aihot/contracts/static";
import { createStaticFiles } from "../../../../scripts/static-files.ts";
import { CATEGORY_KEYS, CATEGORY_LABELS, PUBLIC_API_CATEGORY_KEYS } from "@aihot/contracts/taxonomy";

export function publicFixture(count = 85, options: { rich?: boolean; revision?: string } = {}) {
  const asOf = "2026-11-08T04:00:00.000Z", station = "aihot", revision = options.revision ?? "fixture-v1";
  const data = new Map<string, unknown>();
  const media = new Map<string, string>();
  const rows: StaticListItem[] = Array.from({ length: count }, (_, i) => {
    const id = `fixture-${String(i).padStart(4, "0")}`, at = new Date(Date.parse(asOf) - i * 12 * 3600_000).toISOString();
    const category = CATEGORY_KEYS[i % 2 ? 1 : 0] ?? CATEGORY_KEYS[0];
    const item: StaticListItem["item"] = { id, title: `隔离样例 ${i}：${i % 2 ? "产品" : "模型"}更新`, summary: "这是一条测试摘要，不是真实新闻。",
      reason: "用于验证完整阅读链路。", source: { name: "夹具来源" }, publishedAt: at, timelineAt: at,
      category, tags: [i % 2 ? "产品更新" : "模型发布"], score: 80 + i % 10, selected: true, channel: "news", x: null };
    const detail: SiteItemDetail = { ...item, originalTitle: "Fixture original", links: { original: `https://example.test/${id}` },
      discoveredAt: at, story: null, author: "Fixture", readingMode: "full", x: null,
      body: { zh: "<h2 id=\"fixture-heading\">隔离正文</h2><p>只有正文出现的 needle-body 供全文搜索验证。</p>", original: null, zhKind: "translation", complete: true },
      outline: [{ id: "fixture-heading", text: "隔离正文", level: 2 }], relatedStories: [], topics: [],
      indexable: true, markdownAvailable: true, group: null, hasTranslation: true, bodyLanguage: "zh" };
    data.set(`items/${id}`, detail);
    data.set(`items/${id}/original`, { ...detail, bodyLanguage: "original", body: { ...detail.body, zh: null, original: "<h2>Original fixture body</h2>", zhKind: null } });
    data.set(`markdown/${id}`, `# ${item.title}\n\n隔离正文 needle-body\n`);
    return { item, sortAt: at, inPool: true, inTimeline: true, firstParty: i % 3 === 0, sourceKey: `source-${i % 4}`,
      searchText: item.title.toLowerCase(), poolFactIds: [], fact: null };
  });
  const catalog: StaticCatalog = { schemaVersion: 1, station, revision, asOf, items: rows, entities: [] };
  data.set("catalog", catalog);
  data.set("availability", Object.fromEntries(rows.map(({ item }) => [item.id, { status: "public", sourceName: item.source.name }])));
  data.set("search/body-0", rows.map(({ item }) => ({ id: item.id, text: "needle-body" })));
  const topic: TopicPage["topic"] = { slug: "fixture-topic", name: "隔离主题", definition: "用于静态阅读验收的测试主题。", group: "field", groupName: "方向",
    brand: null, total: rows.length, recent: rows.length, poolTotal: rows.length, indexable: true, latest: { title: rows[0].item.title, at: asOf } };
  data.set("topics", { groups: [{ key: "field", name: "方向", blurb: "隔离夹具" }], topics: [topic] });
  const topicCount = Math.max(1, Math.ceil(rows.length / 40));
  for (let page = 1; page <= topicCount; page++) data.set(`topics/${topic.slug}/${page}`, {
    topic, modules: {}, items: rows.slice((page - 1) * 40, page * 40).map((r) => r.item), page, pageCount: topicCount, pageSize: 40,
  } satisfies TopicPage);
  data.set("hot", { computedAt: asOf, windowHours: 24, entries: [] });
  data.set("hot-strip", []);
  data.set("meta", { changelogVersion: "2026-11-08T12:00" });
  data.set("changelog", { latestVersion: "2026-11-08T12:00", releases: [{ date: "2026-11-08", time: "12:00", kind: "更新", title: "隔离验证", body: ["仅用于测试。"] }] });
  data.set("contact", { wechatQr: null, feishuQr: null, makerAvatar: null });
  data.set("stats", { sources: 4, sourceKinds: { rss: 4 }, items: rows.length, selected: rows.length, dailies: 2,
    day: { collected: 2, selected: 2 }, sampleSources: [], latest: rows.slice(0, 8).map(({ item }) => ({ id: item.id, title: item.title, source: item.source.name })) });
  const reports: StaticManifest["reports"] = { daily: [], weekly: [], monthly: [] };
  const routes = ["/", "/all", "/hot", "/topics", "/daily", "/daily/archive", "/weekly", "/monthly", "/starred", "/more", "/about", "/terms", "/privacy", "/changelog", "/agent", "/search-busy", "/all/search-busy",
    ...rows.flatMap(({ item }) => [`/items/${item.id}`, `/items/${item.id}/original`]),
    ...Array.from({ length: topicCount }, (_, i) => i ? `/topics/${topic.slug}/page/${i + 1}` : `/topics/${topic.slug}`)];
  for (const kind of ["daily", "weekly", "monthly"] as ReportKind[]) {
    const keys = kind === "daily" ? ["2026-11-08", "2026-09-01"] : kind === "weekly" ? ["2026-W45"] : ["2026-10"];
    reports[kind] = keys.map((key, i) => ({ key, issueNumber: keys.length - i, title: `隔离${kind} ${key}`, count: 1 }));
    for (const issue of reports[kind]) {
      const citation = { itemId: rows[0].item.id, title: rows[0].item.title, summary: rows[0].item.summary, sourceName: "夹具来源",
        sourceUrl: "https://example.test/fixture", sourceIconUrl: null, firstParty: true, publishedAt: asOf, available: true };
      data.set(`reports/${kind}/${issue.key}`, { kind, key: issue.key, issueNumber: issue.issueNumber, title: issue.title!, generatedAt: asOf,
        lead: { title: rows[0].item.title, leadParagraph: "隔离报告导语。" }, leadItemId: rows[0].item.id, overview: "隔离报告总述。",
      highlights: [citation], sections: [{ label: CATEGORY_LABELS[CATEGORY_KEYS[0]], summary: null, items: [citation] }], flashes: [], cover: null,
        metrics: { items: 1, sources: 1 }, readingMinutes: 1, prev: keys[keys.indexOf(issue.key) + 1] ?? null, next: keys[keys.indexOf(issue.key) - 1] ?? null } satisfies ReportDetail);
      routes.push(`/${kind}/${issue.key}`);
    }
  }
  const feed = '<?xml version="1.0"?><rss version="2.0"><channel><title>隔离测试订阅</title></channel></rss>';
  for (const name of ["selected", "full", "all", "daily", "weekly", "monthly"]) data.set(`feeds/${name}`, feed);
  for (const name of ["selected", "full"]) for (const category of PUBLIC_API_CATEGORY_KEYS) data.set(`feeds/${name}/category/${category}`, feed);
  const stories: string[] = [], aliases: Record<string, string> = {};
  if (options.rich) {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540"><rect width="960" height="540" fill="#efe4cc"/><rect x="60" y="60" width="840" height="420" rx="12" fill="#176b75"/><text x="100" y="240" font-family="sans-serif" font-size="48" fill="white">OFFLINE TEST IMAGE</text><text x="100" y="315" font-family="sans-serif" font-size="28" fill="white">Fixture only - no real news</text></svg>';
    const hash = createHash("sha256").update(svg).digest("hex"), file = `media/${hash}.svg`, src = `/hot-pages/aihot/data/${file}`;
    media.set(file, svg);
    for (const [i, row] of rows.entries()) {
      if (i % 5 !== 0) continue;
      row.item.channel = "x";
      row.item.x = { authorName: "隔离作者", handle: "fixture", avatarUrl: src, media: [{ kind: "image", url: src, fullUrl: src, srcSet: `${src} 960w`, width: 960, height: 540, alt: "隔离媒体样例", poster: null }], quoted: null };
      for (const key of [`items/${row.item.id}`, `items/${row.item.id}/original`]) {
        const detail = data.get(key) as SiteItemDetail;
        detail.channel = "x"; detail.x = { ...row.item.x, quoted: null };
      }
    }
    const first = data.get(`items/${rows[2].item.id}`) as SiteItemDetail;
    first.body!.zh += `<figure><img src="${src}" srcset="${src} 960w" width="960" height="540" alt="隔离正文图片"/></figure>`;
    first.outline = ["隔离正文", "代码示例", "阅读与返回", "结语"].map((text, i) => ({ id: i ? `fixture-heading-${i}` : "fixture-heading", text, level: 2 }));
    first.body!.zh += `<h2 id="fixture-heading-1">代码示例</h2><pre><code class="language-javascript">const fixture = "needle-body";\nconsole.log(fixture);</code></pre>`
      + `<h2 id="fixture-heading-2">阅读与返回</h2>${"<p>这是一段长正文，用来验证目录跳转、阅读进度、滚动返回和手机阅读工具，所有文字均为测试内容。</p>".repeat(20)}`
      + '<h2 id="fixture-heading-3">结语</h2><p>隔离长正文结束。</p>';
    data.set("contact", { wechatQr: src, feishuQr: null, makerAvatar: src });
    const entries: HotEntryView[] = [];
    const factId = "10000000-0000-4000-8000-000000000001";
    for (const i of [0, 1]) { rows[i].fact = { publicId: factId, representativeOrder: i }; rows[i].poolFactIds = [factId]; }
    const group = { factId, reportCount: 2, additionalSourceCount: 1 };
    for (const i of [0, 1]) for (const key of [`items/${rows[i].item.id}`, `items/${rows[i].item.id}/original`]) (data.get(key) as SiteItemDetail).group = group;
    data.set(`groups/${factId}`, { factId, reports: rows.slice(0, 2).map((row) => ({ id: row.item.id, title: row.item.title, source: row.item.source,
      timelineAt: row.sortAt, originalUrl: `https://example.test/${row.item.id}`, channel: row.item.channel, category: row.item.category, tags: row.item.tags, firstParty: row.firstParty })) });
    for (let i = 0; i < 4; i++) {
      const id = `20000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`, title = `隔离事件 ${i + 1}：持续进展`;
      const members = rows.slice(i * 3, i * 3 + 3), timeline = members.map((r, index) => ({ id: r.item.id, title: r.item.title, summary: `${"这是一段用于展开和阅读验证的公开摘要。".repeat(12)}序号${index}`,
        source: { name: r.item.source.name, firstParty: index === 0 }, publishedAt: r.sortAt, selected: index !== 2 }));
      const detail: StoryDetail = { publicId: id, title, status: "active", reportCount: timeline.length, sourceCount: timeline.length,
        firstReportAt: timeline.at(-1)!.publishedAt, latestAt: timeline[0].publishedAt, digest: "这是一段隔离事件综述，用于确认事件详情而非真实新闻。", digestUpdatedAt: asOf,
        summary: "隔离事件摘要", excerpt: null, latest: timeline[0].title, latestReport: { id: timeline[0].id },
        whyHot: { participants48h: 8 + i, newParticipants6h: 3, recentReports24h: 3, observationComplete: true, rank: i + 1 },
        developments: timeline.map((r, index) => ({ factId: index === 0 && i === 0 ? factId : `fact-fixture-${i}-${index}`, title: r.title, firstReportAt: r.publishedAt, reportCount: 1, representative: r })),
        officialReports: timeline.filter((r) => r.source.firstParty), timeline, heat: Array.from({ length: 169 }, (_, hour) => ({ hour: new Date(Date.parse(asOf) - (168 - hour) * 3600000).toISOString(), heat: 10 + hour * (i + 1), participants: hour + 1 })),
        related: [], topics: [{ slug: topic.slug, name: topic.name }] };
      for (const row of members) for (const key of [`items/${row.item.id}`, `items/${row.item.id}/original`]) {
        const item = data.get(key) as SiteItemDetail; item.story = { publicId: id, title }; item.relatedStories = [{ publicId: id, title }]; item.topics = detail.topics;
      }
      data.set(`stories/${id}`, detail);
      data.set(`stories/${id}/followups`, { items: timeline.map((r, index) => ({ factId: `fixture-followup-${index}`, representative: { id: r.id, title: r.title, source: r.source, timelineAt: r.publishedAt } })), more: false });
      stories.push(id); routes.push(`/story/${id}`);
      entries.push({ rank: i + 1, story: { publicId: id, title }, heat: 100 - i * 10, trend: i === 0 ? "up" : "new", trendPct: i === 0 ? 25 : null,
        badges: [i === 0 ? "rising" : "new"], participantCount: 8 + i, sourceCount: 3, sourceNames: ["夹具来源", "另一来源"], participants: [], spark: Array.from({ length: 25 }, (_, h) => 5 + h * (i + 1)),
        summary: detail.digest, latest: detail.latest, cover: i === 0 ? { url: src, width: 960, height: 540 } : null });
    }
    data.set("hot", { computedAt: asOf, windowHours: 48, entries });
    data.set("hot-strip", entries.map((e) => ({ rank: e.rank, title: e.story.title, heat: e.heat, trend: e.trend, storyPublicId: e.story.publicId, itemId: null, participants: [], participantCount: e.participantCount })));
    const alias = "30000000-0000-4000-8000-000000000001"; aliases[alias] = stories[0]; routes.push(`/story/${alias}`);
    const historical = data.get("reports/daily/2026-09-01") as ReportDetail;
    historical.sections[0].items.push({ ...historical.sections[0].items[0], itemId: null, title: "保留的历史原文引文", sourceUrl: "https://example.test/archive", related: [] },
      { ...historical.sections[0].items[0], itemId: "withdrawn-fixture", title: "已撤回的历史标题", summary: null, sourceName: "", sourceUrl: "", sourceIconUrl: null, available: false });
    historical.sections[0].items.push(
      { ...historical.sections[0].items[0], itemId: null, title: "同标题历史引文", summary: "历史来源甲的独立摘要。", sourceName: "历史来源甲", sourceUrl: "https://example.test/archive-a" },
      { ...historical.sections[0].items[0], itemId: null, title: "同标题历史引文", summary: "历史来源乙的独立摘要。", sourceName: "历史来源乙", sourceUrl: "https://example.test/archive-b" },
    );
    const base = "https://reisen-ww.github.io/hot-pages/aihot";
    const rss = `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>隔离测试订阅</title><item><title>隔离订阅文章</title><link>${base}/items/${rows[0].item.id}</link><description>测试摘要</description></item></channel></rss>`;
    for (const name of ["selected", "full", "all", "daily", "weekly", "monthly"]) data.set(`feeds/${name}`, rss);
    data.set("feeds/full", rss.replace("</item>", `<content:encoded><![CDATA[<p>明确许可的隔离正文</p><img src="${base}/data/${file}"/>]]></content:encoded></item>`));
  }
  const files: Record<string, string> = {}, responses = new Map<string, string>();
  for (const [key, value] of data) {
    const extension = typeof value === "string" ? "md" : "json", contents = typeof value === "string" ? value : JSON.stringify(value);
    const hash = createHash("sha256").update(contents).digest("hex"), relative = `${extension}/${hash}.${extension}`;
    files[key] = relative;
    responses.set(relative, contents);
  }
  const manifest: StaticManifest = { schemaVersion: 1, station, revision, asOf, files, bodyShards: ["search/body-0"], reports,
    topicPages: { [topic.slug]: topicCount }, itemIds: rows.map((r) => r.item.id), stories, aliases, routes };
  return { manifest, data, responses, catalog, media };
}

export async function writePublicFixture(directory: string, count = 85, options: { rich?: boolean; revision?: string } = {}) {
  const fixture = publicFixture(count, options), writer = await createStaticFiles(directory);
  if (fixture.media.size) {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const path = await import("node:path");
    await mkdir(path.join(directory, "media"));
    for (const [file, body] of fixture.media) await writeFile(path.join(directory, file), body);
  }
  for (const [key, value] of fixture.data) {
    if (typeof value === "string") await writer.sink.text(key, value);
    else await writer.sink.json(key, value);
  }
  const { files: _files, ...metadata } = fixture.manifest;
  return writer.finish(metadata);
}
