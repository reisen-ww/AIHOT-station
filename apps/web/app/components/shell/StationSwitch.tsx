// 报头右侧的站别切换：四个文字按钮，当前站高亮，点了直接换到那一站（本地端口）。
// 普通 <a>，不走 SPA 路由：目标是另一个站点，不是本站的一条路由。
import { CURRENT_STATION, STATIONS } from "../../lib/stations";

export function StationSwitch({ className = "" }: { className?: string }) {
  return (
    <nav aria-label="切换站点" className={`flex flex-wrap items-center gap-1 text-[12px] tracking-[0.08em] ${className}`}>
      {STATIONS.map((s) => {
        const on = s.key === CURRENT_STATION;
        return (
          <a
            key={s.key}
            href={`http://127.0.0.1:${s.port}`}
            aria-current={on ? "page" : undefined}
            className={`rounded-mark border px-2 py-0.5 transition-colors ${
              on ? "border-ink bg-ink font-semibold text-bg" : "border-line text-ink-4 hover:border-ink-4 hover:text-ink-2"
            }`}
          >
            {s.label}
          </a>
        );
      })}
    </nav>
  );
}
