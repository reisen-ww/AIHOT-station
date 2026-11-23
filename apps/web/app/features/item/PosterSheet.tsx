// The dynamic server renders posters; Pages makes a PNG locally when opened, not for every historic item.
import { useEffect, useState } from "react";
import { SITE } from "@aihot/site";
import { Sheet } from "../../components/ui/Sheet";
import { IconDownload, IconShare } from "../../components/icons";
import { STATIC_SITE, sitePath } from "../../lib/deployment";
import type { PosterItem } from "./poster-client";

export default function PosterSheet({ item, open, onClose }: { item: PosterItem; open: boolean; onClose: () => void }) {
  const { id, title } = item;
  const [localSrc, setLocalSrc] = useState<string | null>(null);
  const src = STATIC_SITE ? localSrc : sitePath(`/og/posters/${id}.png`);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [canShareFile, setCanShareFile] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!open || !STATIC_SITE) return;
    let active = true;
    setLoaded(false); setFailed(false); setLocalSrc(null);
    import("./poster-client").then(({ renderLocalPoster }) => renderLocalPoster(item)).then((blob) => {
      if (!active) return;
      setLocalSrc(URL.createObjectURL(blob));
    }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [open, item, attempt]);

  // Presence keeps the closing image mounted for its exit animation. Revoke only after its src
  // has actually changed or the whole poster unmounts, not while that retained image still reads it.
  useEffect(() => () => { if (localSrc) URL.revokeObjectURL(localSrc); }, [localSrc]);

  useEffect(() => {
    if (!open) return;
    try {
      setCanShareFile(!!navigator.canShare?.({ files: [new File([], "p.png", { type: "image/png" })] }));
    } catch {
      setCanShareFile(false);
    }
  }, [open]);

  async function share() {
    if (!src) return;
    try {
      const response = await fetch(src);
      if (!response.ok) throw new Error(String(response.status));
      const blob = await response.blob();
      await navigator.share({ files: [new File([blob], `${SITE.mcpPrefix}-${id}.png`, { type: "image/png" })], title });
    } catch {
      // cancelled or unsupported: saving stays available
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title="分享海报" centered>
      <div className="flex flex-col items-center px-5 sm:px-7">
        <div className="relative aspect-[3/4] w-full max-w-[min(360px,calc((88dvh-200px)*0.75))] overflow-hidden rounded-card border border-line bg-bg-sunk">
          {!loaded && !failed && <div className="absolute inset-0 animate-pulse bg-[linear-gradient(110deg,transparent_30%,rgba(255,255,255,0.35)_50%,transparent_70%)] bg-[length:200%_100%]" />}
          {failed ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-6 text-center text-[13px] text-ink-3">
              <p>海报生成失败，请稍后再试。</p>
              {STATIC_SITE && <button type="button" className="rounded-full border border-line-strong px-4 py-2" onClick={() => setAttempt((v) => v + 1)}>重新生成</button>}
            </div>
          ) : src ? (
            <img
              src={src}
              alt={`${title} · 分享海报`}
              className={`size-full object-contain transition-[opacity,transform] duration-[250ms] ${loaded ? "scale-100 opacity-100" : "scale-[0.985] opacity-0"}`}
              onLoad={() => setLoaded(true)}
              onError={() => setFailed(true)}
            />
          ) : null}
        </div>
        <p className="mt-3 text-[12.5px] text-ink-3">长按图片可保存或发送给朋友</p>
        <div className="mt-3 flex w-full max-w-[360px] gap-2">
          {src && loaded && <a
            href={src}
            download={`${SITE.mcpPrefix}-${id}.png`}
            className="inline-flex h-11 flex-1 items-center justify-center gap-1.5 rounded-full bg-accent text-[14px] font-medium text-accent-contrast transition-colors hover:bg-accent-ink lg:h-10 sm:text-[13.5px]"
          >
            <IconDownload size={15} /> 保存图片
          </a>}
          {canShareFile && src && loaded && (
            <button type="button" onClick={share} className="inline-flex h-11 flex-1 items-center justify-center gap-1.5 rounded-full border border-line-strong bg-surface text-[14px] font-medium text-ink transition-colors hover:border-ink-4 lg:h-10 sm:text-[13.5px]">
              <IconShare size={15} /> 分享
            </button>
          )}
        </div>
      </div>
    </Sheet>
  );
}
