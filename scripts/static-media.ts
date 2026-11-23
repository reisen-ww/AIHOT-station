// Resolve only media referenced by the public projection. Source URLs and expiring signatures never ship.
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { StaticSink } from "@aihot/contracts/static";

export interface StaticMedia { body: Uint8Array; type: string }

/** A known source icon that could not be downloaded, so the reader shows the initial instead. */
export type StaticIconFallback = {
  /** The public data key whose projection lost an icon. */
  key: string;
  /** JSON field path inside that value, for example sections[0].items[4].related[1].sourceIconUrl. */
  field: string;
} & ({ kind: "dns" | "network" } | { kind: "http"; status: 403 | 404 | 410 | 429 });

// Only the renditions SourceAvatar actually requests may fall back; a new mode is a code change.
const ICON_MODES = new Set(["avatar", "avatar-48", "avatar-96"]);
const DNS_ERRORS = new Set(["ENOTFOUND", "EAI_AGAIN", "EAI_FAIL", "EAI_NONAME", "EAI_NODATA"]);
const UNDICI_ERRORS = new Set([
  "UND_ERR_ABORTED", "UND_ERR_BODY_TIMEOUT", "UND_ERR_CLOSED", "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_SOCKET",
]);
const CONNECT_ERRORS = new Set(["ECONNABORTED", "ECONNREFUSED", "EHOSTDOWN", "EHOSTUNREACH", "ENETDOWN", "ENETUNREACH", "ETIMEDOUT"]);
const SOCKET_ERRORS = new Set(["ECONNRESET", "EPIPE"]);

/** Image bytes are held until a published field references them, so a dropped srcset writes nothing. */
interface PreparedMedia { key: string; relative: string; committed: boolean; commit(): Promise<void>; discard(): void }

type IconFailure = { kind: "dns" | "network" } | { kind: "http"; status: 403 | 404 | 410 | 429 };

/** Only a real DNS, transport, upstream absence or rate limit may turn a known source icon into its initial. */
function failureKind(error: unknown, depth = 0, seen = new Set<unknown>()): IconFailure | null {
  if (!error || typeof error !== "object" || depth > 4 || seen.has(error)) return null;
  seen.add(error);
  const candidate = error as { code?: unknown; name?: unknown; message?: unknown; syscall?: unknown; hostname?: unknown; path?: unknown; cause?: unknown; errors?: unknown };
  // A filesystem error is never an upstream transport failure, even if a network share reports
  // a network-like code. Local writes are wrapped before this check; this also covers cache reads.
  if (typeof candidate.path === "string") return null;
  if (typeof candidate.code === "string") {
    // A DNS error is recognised by its lookup syscall or hostname, so a missing cache directory
    // that also reports ENOTFOUND is not mistaken for the icon's own host.
    if (DNS_ERRORS.has(candidate.code) && (candidate.syscall === "getaddrinfo" || String(candidate.syscall ?? "").startsWith("query")
      || typeof candidate.hostname === "string")) return { kind: "dns" };
    if (UNDICI_ERRORS.has(candidate.code)) return { kind: "network" };
    if (CONNECT_ERRORS.has(candidate.code) && candidate.syscall === "connect") return { kind: "network" };
    if (SOCKET_ERRORS.has(candidate.code) && (candidate.syscall === "read" || candidate.syscall === "write")) return { kind: "network" };
  }
  if (candidate.name === "TimeoutError") return { kind: "network" };
  if (typeof candidate.message === "string") {
    // Source icons may be absent or rate limited; readers can use their existing initial.
    // Every other status (400, 5xx), and every strict media consumer, stays fatal.
    const absent = /^static image upstream (403|404|410|429)$/.exec(candidate.message);
    if (absent) return { kind: "http", status: Number(absent[1]) as 403 | 404 | 410 | 429 };
    // The guarded egress resolver reports a name without an address as a plain Error.
    if (/^DNS lookup failed for /.test(candidate.message) || /^No address for /.test(candidate.message)) return { kind: "dns" };
    if (/^DNS upstream \d+$/.test(candidate.message)) return { kind: "network" };
  }
  const cause = failureKind(candidate.cause, depth + 1, seen);
  if (cause) return cause;
  if (Array.isArray(candidate.errors)) {
    for (const item of candidate.errors) {
      const kind = failureKind(item, depth + 1, seen);
      if (kind) return kind;
    }
  }
  return null;
}

export function staticMediaSink(sink: StaticSink, directory: string, base: string,
  resolve: (url: string, mode: string) => Promise<StaticMedia>, siteUrl?: string,
  local?: (url: string) => Promise<StaticMedia>,
  onIconFallback?: (fallback: StaticIconFallback) => void) {
  const files = new Map<string, Promise<PreparedMedia>>();
  const prepare = ({ body, type }: StaticMedia, key: string): PreparedMedia => {
    const extension = ({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/svg+xml": "svg", "image/avif": "avif" } as Record<string, string>)[type];
    if (!extension || !body.byteLength) throw new Error("invalid static image bytes");
    const hash = createHash("sha256").update(body).digest("hex");
    let pending: Uint8Array | null = body;
    let written: Promise<void> | null = null;
    let done = false;
    return {
      key,
      relative: `${base}/data/media/${hash}.${extension}`,
      get committed() { return done; },
      commit() {
        if (written) return written;
        const bytes = pending;
        if (!bytes) return Promise.reject(new Error("static media bytes were already released"));
        pending = null;
        written = (async () => {
          try {
            await mkdir(path.join(directory, "media"), { recursive: true });
            await writeFile(path.join(directory, "media", `${hash}.${extension}`), bytes);
            done = true;
          } catch (error) {
            // A local write is never a reason to show an initial, even when a network share reports a
            // network-like code. A fresh error without a cause keeps that code out of the DNS test.
            const code = (error as NodeJS.ErrnoException)?.code;
            throw new Error(`static media write failed${code ? `: ${code}` : ""}`);
          }
        })();
        return written;
      },
      // Only bytes that were never written are released; a committed file stays referenced.
      discard() { if (!written) pending = null; },
    };
  };
  const proxy = (source: string) => {
    const url = new URL(source.replaceAll("&amp;", "&"), "https://static.invalid");
    if (!url.pathname.endsWith("/api/img-proxy")) throw new Error("not a public media projection");
    const upstream = url.searchParams.get("u"), mode = url.searchParams.get("mode") ?? "full";
    if (!upstream || !/^https?:\/\//i.test(upstream)) throw new Error("invalid public image");
    return { upstream, mode };
  };
  const prepared = async (source: string) => {
    const { upstream, mode } = proxy(source);
    const key = `${mode}|${upstream}`;
    let job = files.get(key);
    if (!job) {
      job = resolve(upstream, mode).then((media) => prepare(media, key));
      files.set(key, job);
    }
    return job;
  };
  const media = async (source: string, absolute: boolean) => {
    const item = await prepared(source);
    await item.commit();
    return absolute && siteUrl ? new URL(item.relative, siteUrl).href : item.relative;
  };
  const localMedia = async (value: string) => {
    if (!local) throw new Error("contact media requires an explicit local asset directory");
    const key = `local|${value}`;
    let job = files.get(key);
    if (!job) { job = local(value).then((media) => prepare(media, key)); files.set(key, job); }
    const item = await job;
    await item.commit();
    return item.relative;
  };
  async function text(value: string, absolute = false): Promise<string> {
    // Matches JSON string values, HTML src/poster and srcset candidates, including absolute proxy URLs.
    const matches = [...new Set(value.match(/(?:https?:\/\/[^\s"'<>]+)?\/(?:[a-zA-Z0-9_-]+\/)*api\/img-proxy\?[^\s"'<>]+/g) ?? [])];
    for (const source of matches) value = value.replaceAll(source, await media(source, absolute));
    // Local resources in page data, unlike React Router Links, do not receive basename automatically.
    if (/^\/contact\//.test(value)) {
      value = await localMedia(value);
    } else if (/^\/(?:logos|brands)\//.test(value)) value = `${base}${value}`;
    return value;
  }
  const field = (parent: string, key: string) => parent ? `${parent}.${key}` : key;
  const audited = (kind: IconFailure, publicKey: string, fieldPath: string) => onIconFallback?.(kind.kind === "http"
    ? { key: publicKey, field: fieldPath, kind: "http", status: kind.status }
    : { key: publicKey, field: fieldPath, kind: kind.kind });
  async function iconUrl(value: string, publicKey: string, fieldPath: string): Promise<string | null> {
    if (!value.includes("/api/img-proxy")) return text(value);
    const { mode } = proxy(value);
    // A rendition SourceAvatar never requests keeps the strict behaviour, including a DNS failure.
    if (!ICON_MODES.has(mode)) return media(value, false);
    try {
      return await media(value, false);
    } catch (error) {
      const kind = failureKind(error);
      if (!kind) throw error;
      audited(kind, publicKey, fieldPath);
      return null;
    }
  }
  const iconSrcSetCandidates = (value: string) => {
    if (!value.includes("/api/img-proxy")) return null;
    const candidates = value.split(/\s*,\s*/).filter(Boolean).map((part) => {
      const match = /^(\S+)(?:\s+(\d+w|[\d.]+x))?$/.exec(part);
      if (!match) throw new Error("invalid icon srcset");
      return { source: match[1]!, descriptor: match[2] ?? "" };
    });
    if (!candidates.length) throw new Error("invalid icon srcset");
    // Validate the whole set before any download: a malformed candidate must never be hidden by
    // an earlier network failure that would otherwise turn the whole srcset into a fallback.
    for (const candidate of candidates) {
      const { mode } = proxy(candidate.source);
      if (!ICON_MODES.has(mode)) throw new Error("icon srcset is not an avatar rendition");
    }
    return candidates;
  };
  async function iconSrcSet(candidates: Array<{ source: string; descriptor: string }>, publicKey: string, fieldPath: string): Promise<string | null> {
    const items: PreparedMedia[] = [];
    try {
      for (const candidate of candidates) items.push(await prepared(candidate.source));
    } catch (error) {
      const kind = failureKind(error);
      if (!kind) throw error;
      // Nothing was written yet: a candidate is committed only after its whole set resolves. Release
      // the bytes fetched before the failure and forget their cache entries, so a dropped srcset
      // leaves no media file that validateStaticData would call unlisted and does not hold image
      // bytes for the rest of a large export. A later citation of the same URL fetches again.
      for (const item of items) {
        if (item.committed) continue;
        item.discard();
        files.delete(item.key);
      }
      audited(kind, publicKey, fieldPath);
      return null;
    }
    // A write failure is not a network failure: it aborts the snapshot instead of hiding the icon.
    for (const item of items) await item.commit();
    return candidates.map((candidate, i) => candidate.descriptor ? `${items[i]!.relative} ${candidate.descriptor}` : items[i]!.relative).join(", ");
  }
  /** Only the published fields that SourceAvatar renders may fall back; same-named fields elsewhere stay strict. */
  const iconScope = (publicKey: string, parent: string, key: string) => {
    if (key === "sourceIconUrl" || key === "sourceIconSrcSet") return /^reports\/(?:daily|weekly|monthly)\/[^/]+$/.test(publicKey);
    if (key === "iconUrl" || key === "iconSrcSet") {
      if (publicKey === "hot") return /^entries\[\d+\]\.participants\[\d+\]$/.test(parent);
      if (publicKey === "hot-strip") return /^\[\d+\]\.participants\[\d+\]$/.test(parent);
    }
    return false;
  };
  const iconPair = (object: Record<string, unknown>, publicKey: string, parent: string) => {
    const citation = Object.hasOwn(object, "itemId") && Object.hasOwn(object, "available");
    const participant = typeof object.name === "string" && (object.kind === "editorial" || object.kind === "signal");
    if (citation && (Object.hasOwn(object, "sourceIconUrl") || Object.hasOwn(object, "sourceIconSrcSet")) && iconScope(publicKey, parent, "sourceIconUrl"))
      return { urlKey: "sourceIconUrl", srcSetKey: "sourceIconSrcSet" };
    if (participant && (Object.hasOwn(object, "iconUrl") || Object.hasOwn(object, "iconSrcSet")) && iconScope(publicKey, parent, "iconUrl"))
      return { urlKey: "iconUrl", srcSetKey: "iconSrcSet" };
    return null;
  };
  async function project(value: unknown, publicKey: string, parent = ""): Promise<unknown> {
    if (typeof value === "string") return text(value);
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      for (let i = 0; i < value.length; i++) result.push(await project(value[i], publicKey, `${parent}[${i}]`));
      return result;
    }
    if (value && typeof value === "object") {
      const object = value as Record<string, unknown>;
      const result: Record<string, unknown> = {};
      const pair = iconPair(object, publicKey, parent);
      const urlHandled = !!pair && Object.hasOwn(object, pair.urlKey);
      const srcSetHandled = !!pair && Object.hasOwn(object, pair.srcSetKey);
      const srcSetRaw = pair && srcSetHandled ? object[pair.srcSetKey] : undefined;
      // Validate a known source icon's srcset even when its URL field has already failed, so an
      // invalid proxy address is never hidden behind an unrelated DNS failure.
      const srcSetCandidates = typeof srcSetRaw === "string" ? iconSrcSetCandidates(srcSetRaw) : null;
      let iconFailed = false;
      if (pair && urlHandled) {
        const raw = object[pair.urlKey];
        if (typeof raw === "string") {
          const projected = await iconUrl(raw, publicKey, field(parent, pair.urlKey));
          if (projected === null) iconFailed = true;
          result[pair.urlKey] = projected;
        } else {
          result[pair.urlKey] = await project(raw, publicKey, field(parent, pair.urlKey));
        }
      }
      if (srcSetCandidates) {
        if (!iconFailed) {
          const projected = await iconSrcSet(srcSetCandidates, publicKey, field(parent, pair!.srcSetKey));
          if (projected !== null) result[pair!.srcSetKey] = projected;
        }
      } else if (pair && srcSetHandled) {
        result[pair.srcSetKey] = await project(srcSetRaw, publicKey, field(parent, pair.srcSetKey));
      }
      for (const [key, item] of Object.entries(object)) {
        if (pair && urlHandled && key === pair.urlKey) continue;
        if (pair && srcSetHandled && key === pair.srcSetKey) continue;
        result[key] = await project(item, publicKey, field(parent, key));
      }
      return result;
    }
    return value;
  }
  return {
    json: async (key, value) => sink.json(key, await project(value, key)),
    text: async (key, value) => sink.text(key, await text(value, key.startsWith("feeds/"))),
  } satisfies StaticSink;
}
