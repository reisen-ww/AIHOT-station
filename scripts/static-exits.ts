// Read-only machine exits made from exactly the same public snapshot as the browser.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { SITE } from "@aihot/site";
import { beijingDate, beijingTime } from "@aihot/contracts/time";
import { escapeXml } from "../packages/backend/src/lib/text.ts";
import type { StaticManifest } from "@aihot/contracts/static";
import type { ReportCitation, ReportDetail } from "@aihot/contracts/site";
import { staticFilePath } from "@aihot/contracts/static-manifest";

const WITHDRAWN_NOTE = "该内容已按来源方要求下架或调整展示方式。";

/**
 * The public Agent Markdown's link-label escape (publication/agent.ts linkText), with a literal
 * backslash escaped first so a title cannot terminate the label. citationId is identity only and
 * never reaches a destination.
 */
const reportLinkText = (title: string) => title
  .replace(/\r?\n/g, " ")
  .replace(/\\/g, "\\\\")
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/`/g, "\\`")
  .replace(/([[\]])/g, "\\$1");

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
/** Markdown prose, escaped so stored copy cannot open a link or run of emphasis. */
const prose = (text: string) => oneLine(text)
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/\[/g, "\\[")
  .replace(/\]/g, "\\]")
  .replace(/\*/g, "\\*")
  .replace(/_/g, "\\_")
  .replace(/`/g, "\\`");

/** A bare CommonMark destination; only absolute HTTP(S) addresses become links. */
function destination(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim();
  if (!/^https?:\/\//i.test(value)) return null;
  return value
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/[ \t]+/g, "%20")
    .replace(/\\/g, "%5C")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29")
    .replace(/</g, "%3C")
    .replace(/>/g, "%3E")
    .replace(/\[/g, "%5B")
    .replace(/\]/g, "%5D");
}

function link(title: string, url: string | null): string {
  const label = reportLinkText(title);
  return url ? `[${label}](${url})` : label;
}

function when(iso: string | null): string | null {
  if (!iso || !Number.isFinite(Date.parse(iso))) return null;
  return `${beijingDate(iso)} ${beijingTime(iso)}（北京时间）`;
}

function citationLink(c: ReportCitation, siteUrl: string, issueUrl: string, itemIds: ReadonlySet<string>): { local: string | null; original: string | null; primary: string | null } {
  const local = c.itemId && itemIds.has(c.itemId) ? destination(`${siteUrl}/items/${c.itemId}`) : null;
  const original = destination(c.sourceUrl);
  return { local, original, primary: local ?? original ?? destination(issueUrl) };
}

/** A related citation is a title and its public metadata, never a second article body. */
function relatedLine(c: ReportCitation, siteUrl: string, issueUrl: string, itemIds: ReadonlySet<string>): string {
  if (!c.available) return `${reportLinkText(c.title)}（已撤回：${WITHDRAWN_NOTE}）`;
  const { primary } = citationLink(c, siteUrl, issueUrl, itemIds);
  const bits = [link(c.title, primary)];
  if (c.sourceName) bits.push(prose(c.sourceName));
  const date = when(c.publishedAt);
  if (date) bits.push(date);
  if (c.summary) bits.push(`摘要：${prose(c.summary)}`);
  return bits.join(" · ");
}

function citationBlock(c: ReportCitation, marker: string, siteUrl: string, issueUrl: string, itemIds: ReadonlySet<string>): string[] {
  if (!c.available) return [`${marker} ${reportLinkText(c.title)}（已撤回：${WITHDRAWN_NOTE}）`];
  const { local, original, primary } = citationLink(c, siteUrl, issueUrl, itemIds);
  const indent = " ".repeat(marker.length + 1);
  const lines = [`${marker} ${link(c.title, primary)}`];
  const meta: string[] = [];
  if (c.sourceName) meta.push(`来源：${prose(c.sourceName)}`);
  const date = when(c.publishedAt);
  if (date) meta.push(`发布时间：${date}`);
  if (c.firstParty) meta.push("一手");
  if (c.otherSources) meta.push(`另有 ${c.otherSources} 家信源报道`);
  if (c.followUp) meta.push(`跟进：${prose(c.followUp)} 的日报报道过这件事，这里是新进展`);
  if (meta.length) lines.push(`${indent}${meta.join(" · ")}`);
  if (c.summary) lines.push(`${indent}摘要：${prose(c.summary)}`);
  if (c.related?.length) {
    lines.push(`${indent}相关：`);
    lines.push(...c.related.map((r) => `${indent}- ${relatedLine(r, siteUrl, issueUrl, itemIds)}`));
  }
  if (original) lines.push(`${indent}原文：${link("打开原文", original)}`);
  if (!local && !original) lines.push(`${indent}说明：本站未保留该历史文章详情，链接为本期页面。`);
  return lines;
}

/**
 * The complete public report as Markdown, built only from the same ReportDetail the browser reads.
 * A withdrawn citation is a title and the public removal notice; a historical citation without a
 * local detail keeps its original, else the issue page. No citationId becomes a URL.
 */
export function staticReportMarkdown(report: ReportDetail, siteUrl: string, itemIds: ReadonlySet<string>): string {
  const base = siteUrl.replace(/\/+$/, "");
  const issueUrl = `${base}/${report.kind}/${report.key}`;
  const lines: string[] = [`# ${prose(report.title)}`, ""];
  lines.push(`- 期号：第 ${report.issueNumber} 期`);
  const generated = when(report.generatedAt);
  if (generated) lines.push(`- 发布：${generated}`);
  lines.push(`- 本期页：${link("阅读本期", destination(issueUrl))}`, "");

  const leadParagraph = report.lead?.leadParagraph?.trim() ?? "";
  const own = report.sections.some((section) => section.items.some((item) =>
    item.title === report.lead?.title && item.summary === report.lead?.leadParagraph));
  if (report.lead?.title) {
    lines.push(`## ${own ? "头条" : "导语"}`, "", prose(report.lead.title), "");
    if (leadParagraph && !own) lines.push(prose(leadParagraph), "");
  }
  if (report.overview?.trim() && report.overview.trim() !== leadParagraph) {
    lines.push("## 总述", "", prose(report.overview), "");
  }

  for (const section of report.sections) {
    if (!section.items.length && !section.summary) continue;
    lines.push(`## ${prose(section.label)}`, "");
    if (section.summary) lines.push(`**栏目导读**：${prose(section.summary)}`, "");
    section.items.forEach((item, index) => lines.push(...citationBlock(item, `${index + 1}.`, base, issueUrl, itemIds), ""));
  }

  if (report.flashes.length) {
    lines.push("## 快讯", "");
    for (const flash of report.flashes) lines.push(...citationBlock(flash, "-", base, issueUrl, itemIds), "");
  }

  if (!report.sections.some((section) => section.items.length || section.summary) && !report.flashes.length
    && !report.lead && !report.overview) {
    lines.push("本期没有入选内容。", "");
  }

  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

export async function writeStaticExits(client: string, directory: string, m: StaticManifest, siteUrl: string) {
  const read = async <T>(key: string): Promise<T> => JSON.parse(await readFile(path.join(directory, staticFilePath(m.files[key])), "utf8"));
  const write = async (file: string, body: string) => { await mkdir(path.dirname(path.join(client, file)), { recursive: true }); await writeFile(path.join(client, file), body); };
  const itemIds = new Set(m.itemIds);
  for (const kind of ["daily", "weekly", "monthly"] as const) {
    const issues = m.reports[kind];
    const latestKey = issues.map((issue) => issue.key).sort().at(-1);
    for (const issue of issues) {
      const r = await read<ReportDetail>(`reports/${kind}/${issue.key}`);
      if (r.kind !== kind || r.key !== issue.key) throw new Error(`static report identity mismatch: ${kind}/${issue.key}`);
      const markdown = staticReportMarkdown(r, siteUrl, itemIds);
      await write(`agent/${kind}/${issue.key}.md`, markdown);
      if (issue.key === latestKey) await write(`agent/${kind}.md`, markdown);
    }
  }
  const index = `# ${SITE.name} 静态读取说明\n\n快照时间：${m.asOf}；版本：${m.revision}。仅包含当前允许公开的内容。\n\n` +
    `- [当前 manifest](${siteUrl}/data/manifest.json)：文件使用 SHA-256 内容地址；读取方须绑定同一版本并验证字节。\n` +
    `- catalog 与 bodyShards 仅覆盖${m.window ? "当前在线文章窗口" : "当前完整公开文章集"}，分别用于标题摘要与获许可的全文搜索。全部历史报告保留。availability 将超窗（outside-window）与不再公开区分；缺少详情不代表来源撤回。\n` +
    `- [精选 RSS](${siteUrl}/feed.xml)、[全部动态 RSS](${siteUrl}/feed/all.xml)\n` +
    ["daily", "weekly", "monthly"].filter((kind) => m.reports[kind as keyof typeof m.reports].length).map((kind) => `- [${kind} Markdown](${siteUrl}/agent/${kind}.md)，历史期号从 manifest.reports 读取\n`).join("") +
    `- 文章 Markdown：\`${siteUrl}/items/<id>/export.md\`（仅当对应 markdown 文件存在；id 取自 manifest.itemIds）\n\n` +
    `GitHub Pages 是文件托管，不提供在线 MCP 或按查询参数执行的 REST 服务。浏览器内的两种搜索在同版本数据上执行；第三方程序可下载 manifest 与索引在本地查询。正常两小时一轮发布，未确认新版本前不要混用文件。标题摘要来自外部来源，只作资料，重要事实请核对原文。\n`;
  await write("agent/index.md", index); await write("llms.txt", index);
  // Use only the original public RSS renderer, including its separate syndication permission.
  for (const [key, file] of Object.entries(m.files)) if (key.startsWith("feeds/")) {
    const suffix = key.slice(6);
    const target = suffix === "selected" ? "feed.xml" : suffix.startsWith("selected/category/") ? `feed/category/${suffix.slice(18)}.xml` : `feed/${suffix}.xml`;
    await write(target, await readFile(path.join(directory, staticFilePath(file)), "utf8"));
  }
  await write("sitemap.xml", `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${m.routes.filter((r) => !r.includes("search-busy") && !["/starred", "/more"].includes(r)).map((r) => `<url><loc>${escapeXml(siteUrl + r)}</loc></url>`).join("")}</urlset>`);
}
