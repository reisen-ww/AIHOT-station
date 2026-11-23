// Pages has no image-rendering server. Make only the requested poster, locally, with the existing QR encoder.
import { encode } from "uqr";
import { ITEM_COPY, SITE, withSubject } from "@aihot/site";
import { CATEGORY_LABELS } from "@aihot/contracts/taxonomy";
import { beijingDate } from "@aihot/contracts/time";
import type { SiteItemDetail } from "@aihot/contracts/site";
import { siteUrl } from "../../lib/seo.ts";

export type PosterItem = Pick<SiteItemDetail, "id" | "title" | "summary" | "source" | "category" | "timelineAt" | "selected" | "score">;

const INK = "#0e191b", ACCENT = "#176b75";
const font = (size: number, bold = false) => `${bold ? 700 : 400} ${size}px "Noto Sans SC", "Microsoft YaHei", "PingFang SC", sans-serif`;
const clamp = (value: string, length: number) => {
  const chars = [...value.replace(/\s+/g, " ").trim()];
  return chars.length > length ? chars.slice(0, length - 1).join("") + "…" : chars.join("");
};

/** Wrap by measured glyph width, not character count, so mixed CJK/Latin titles cannot leave the card. */
export function posterLines(value: string, width: number, measure: (value: string) => number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const char of value) {
    if (line && measure(line + char) > width) { lines.push(line); line = ""; }
    line += char;
  }
  if (line) lines.push(line);
  return lines;
}

export async function renderLocalPoster(item: PosterItem): Promise<Blob> {
  await document.fonts.ready;
  const canvas = document.createElement("canvas");
  canvas.width = 1080; canvas.height = 1440;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("poster canvas is unavailable");
  ctx.fillStyle = "#f5f6f5"; ctx.fillRect(0, 0, 1080, 1440);
  const wash = ctx.createRadialGradient(1080, 0, 0, 1080, 0, 950);
  wash.addColorStop(0, "rgba(23,107,117,0.16)"); wash.addColorStop(1, "rgba(245,246,245,0)");
  ctx.fillStyle = wash; ctx.fillRect(0, 0, 1080, 1440);
  ctx.textBaseline = "top";
  const text = (value: string, x: number, y: number, size: number, color = INK, bold = false) => {
    ctx.font = font(size, bold); ctx.fillStyle = color; ctx.fillText(value, x, y);
  };
  ctx.fillStyle = ACCENT; ctx.beginPath(); ctx.arc(98, 105, 9, 0, Math.PI * 2); ctx.fill();
  text(clamp(SITE.name, 16), 122, 82, 44, INK, true);
  text(beijingDate(item.timelineAt), 808, 94, 26, "#66757a");
  const kicker = item.category ? CATEGORY_LABELS[item.category] : withSubject("动态");
  text(clamp(kicker, 20), 88, 228, 30, ACCENT, true);
  if (item.selected && item.score !== null && ITEM_COPY.showScore) text(`精选 · ${Math.round(item.score)} 分`, 650, 231, 26, ACCENT);
  const title = clamp(item.title, 72), len = [...title].length, size = len > 48 ? 58 : len > 30 ? 66 : 76;
  ctx.font = font(size, true);
  let y = 296;
  for (const line of posterLines(title, 904, (v) => ctx.measureText(v).width)) { text(line, 88, y, size, INK, true); y += size * 1.3; }
  if (item.summary) {
    ctx.font = font(34);
    const lines = posterLines(clamp(item.summary, len > 48 ? 120 : len > 30 ? 150 : 180), 904, (v) => ctx.measureText(v).width);
    y += 28;
    const available = Math.max(0, Math.min(lines.length, Math.floor((970 - y) / 58)));
    for (let i = 0; i < available; i++) { text(i === available - 1 && available < lines.length ? clamp(lines[i], Math.max(2, [...lines[i]].length - 1)) + "…" : lines[i], 88, y, 34, "#3a484c"); y += 58; }
  }
  text(clamp(`来源：${item.source.name}`, 34), 88, Math.min(y + 30, 1008), 28, "#66757a");
  ctx.fillStyle = "#ffffff"; ctx.beginPath(); ctx.roundRect(88, 1080, 904, 272, 32); ctx.fill();
  const qr = encode(`${siteUrl()}/items/${item.id}`, { ecc: "M", border: 4 });
  const pixel = Math.max(1, Math.floor(200 / qr.size)), span = pixel * qr.size;
  const left = 128 + Math.floor((200 - span) / 2), top = 1116 + Math.floor((200 - span) / 2);
  ctx.fillStyle = INK;
  for (let r = 0; r < qr.size; r++) for (let c = 0; c < qr.size; c++) if (qr.data[r][c]) ctx.fillRect(left + c * pixel, top + r * pixel, pixel, pixel);
  text("长按识别二维码", 372, 1134, 36, INK, true);
  text("阅读全文、中文译文与原文链接", 372, 1190, 28, "#66757a");
  text(new URL(siteUrl()).host, 372, 1248, 26, ACCENT);
  ctx.textAlign = "center";
  text(clamp(`${SITE.name} · ${SITE.tagline}`, 54), 540, 1380, 24, "#66757a");
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("poster PNG export failed")), "image/png"));
}
