// 首页的「报纸版式」：一天一页。报头（巨大「今日」+ 日期 + 站别切换）、三件大事、其余一行一条。
// 版面大小就是重要程度：三件大事按 score 排，不显示分数本身。
// 数据全来自 /api/site/timeline 的分页结果，翻页逻辑仍在 Timeline 里。
import { useMemo } from "react";
import { Link } from "react-router";
import type { TimelineCard, TimelineFilters } from "@aihot/contracts/site";
import { CATEGORY_LABELS } from "@aihot/contracts/taxonomy";
import { beijingDate, beijingStamp, beijingTime, beijingWeekday } from "@aihot/contracts/time";
import { IntentLink } from "../../components/ui/IntentLink";
import { StationSwitch } from "../../components/shell/StationSwitch";
import { markRead, useReadSet } from "../../lib/local-state";

const BIG_N = 3;

/** Higher score first; items without one keep their place at the end. */
function byScore(a: TimelineCard, b: TimelineCard): number {
  return (b.item.score ?? -1) - (a.item.score ?? -1);
}

/** 报头：巨大「今日」+ 日期，右侧站别切换。 */
function Masthead({ day }: { day: string }) {
  const [y, m, d] = [day.slice(0, 4), Number(day.slice(5, 7)), Number(day.slice(8, 10))];
  return (
    <>
      <header className="flex flex-wrap items-baseline gap-x-5 gap-y-2 pt-2 lg:pt-4">
        <h1 className="text-[40px] font-bold leading-[0.9] tracking-[-0.05em] text-ink lg:text-[58px]">今日</h1>
        <div className="mono flex items-baseline gap-1.5 text-[12.5px] uppercase tracking-[0.14em] text-ink-4">
          <b className="font-bold text-ink">
            {y} · {String(m).padStart(2, "0")} · {String(d).padStart(2, "0")}
          </b>
          <span>{beijingWeekday(day)}</span>
        </div>
        <StationSwitch className="w-full lg:ml-auto lg:w-auto" />
      </header>
      <div aria-hidden="true" className="mt-3 h-[3px] bg-ink" />
    </>
  );
}

/** 栏目标题：左边一个标签，一条线拉到右边，末尾一个计数。 */
function Section({ label, count }: { label: string; count: string }) {
  return (
    <div className="mt-9 mb-4 flex items-baseline gap-3 lg:mt-10 lg:mb-[18px]">
      <span className="whitespace-nowrap text-[11.5px] font-bold uppercase tracking-[0.18em] text-ink">{label}</span>
      <span aria-hidden="true" className="h-px flex-1 self-center bg-line" />
      <span className="num whitespace-nowrap text-[11.5px] text-ink-4">{count}</span>
    </div>
  );
}

/** 三件大事里的一条：序号 + 信源·时间·N家交叉 + 大标题 + 摘要 + 为什么重要。 */
function BigStory({ card, rank, read }: { card: TimelineCard; rank: number; read: boolean }) {
  const { item, group } = card;
  const at = item.publishedAt ?? card.anchorAt;
  const cross = group && group.additionalSourceCount > 0 ? group.additionalSourceCount + 1 : null;
  return (
    <article className="group relative grid grid-cols-[minmax(0,1fr)] gap-y-2 border-b border-line py-5 transition-colors hover:bg-surface-2 lg:grid-cols-[64px_minmax(0,1fr)] lg:gap-x-6 lg:py-[22px] lg:pb-6">
      <div className="mono hidden text-[13px] font-semibold tracking-[0.04em] text-ink-4 lg:block lg:pt-1">
        {String(rank).padStart(2, "0")}
        <span aria-hidden="true" className="mt-2.5 block h-px w-7 bg-ink-4 opacity-50" />
      </div>
      <div className="min-w-0">
        <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] uppercase tracking-[0.06em] text-ink-4">
          <span className="font-bold text-accent">{item.source.name}</span>
          <span aria-hidden="true">·</span>
          <time dateTime={at} className="num">
            {beijingTime(at)}
          </time>
          {cross !== null && (
            <span className="inline-flex items-center gap-1 rounded-mark bg-accent-soft px-1.5 py-px text-[10.5px] tracking-[0.04em] text-accent">{cross} 家交叉</span>
          )}
        </div>
        <h2
          className={`text-balance font-bold leading-[1.3] tracking-[-0.025em] ${
            rank === 1 ? "text-[22px] leading-[1.24] lg:text-[31px]" : "text-[22px] lg:text-[26px]"
          } ${read ? "text-ink-4" : "text-ink"} group-hover:underline group-hover:decoration-1 group-hover:underline-offset-[3px]`}
        >
          <IntentLink viewTransition to={`/items/${item.id}`} onClick={() => markRead(item.id)} className="after:absolute after:inset-0 after:content-['']">
            {item.title}
          </IntentLink>
        </h2>
        {item.summary && (
          <p className={`mt-2.5 line-clamp-2 text-[15px] leading-[1.72] text-ink-2 lg:max-w-[46em] ${rank === 1 ? "lg:line-clamp-3 lg:text-[15.5px]" : ""}`}>{item.summary}</p>
        )}
        {item.reason && (
          <div className="mt-3 border-l-2 border-note pl-3 text-[13px] leading-[1.6] text-note">
            <b className="font-bold">为什么重要</b> · {item.reason}
          </div>
        )}
      </div>
    </article>
  );
}

/** 其余里的一条：时间 + 标题 + 信源·分类。 */
function Brief({ card, read }: { card: TimelineCard; read: boolean }) {
  const { item } = card;
  const at = item.publishedAt ?? card.anchorAt;
  const cat = item.category ? CATEGORY_LABELS[item.category] : null;
  return (
    <Link
      viewTransition
      to={`/items/${item.id}`}
      onClick={() => markRead(item.id)}
      className="group grid grid-cols-[46px_minmax(0,1fr)] items-baseline gap-x-3 border-b border-line py-2.5 opacity-90 transition-colors hover:bg-surface-2 hover:opacity-100 lg:grid-cols-[54px_minmax(0,1fr)_auto] lg:gap-x-4 lg:py-[11px]"
    >
      <span className="mono num text-[11.5px] text-ink-4">{beijingTime(at)}</span>
      <span
        className={`text-[15.5px] font-semibold leading-[1.45] tracking-[-0.02em] group-hover:underline group-hover:decoration-1 group-hover:underline-offset-[3px] lg:text-[16px] ${
          read ? "text-ink-4" : "text-ink"
        }`}
      >
        {item.title}
      </span>
      <span className="col-start-2 mt-0.5 whitespace-nowrap text-[12px] text-ink-4 lg:col-start-3 lg:mt-0">
        <span className="font-semibold text-ink-3">{item.source.name}</span>
        {cat && <span> · {cat}</span>}
      </span>
    </Link>
  );
}

/**
 * The day's page. 报头 + 三件大事 + 其余。三件大事只从首批里选（翻页加载进来的旧闻不会挤掉头条，
 * 否则读者一边往下翻，版面一边重排）。其余按时间倒序。
 */
export function TodayFeed({ initial, cards, filters }: { initial: TimelineCard[]; cards: TimelineCard[]; filters: TimelineFilters }) {
  const readSet = useReadSet();
  const day = beijingDate(Date.now());
  void filters;

  const topKeys = useMemo(() => new Set([...initial].sort(byScore).slice(0, BIG_N).map((c) => c.key)), [initial]);
  const byKey = useMemo(() => new Map(cards.map((c) => [c.key, c])), [cards]);

  const bigs: TimelineCard[] = [];
  for (const c of [...initial].sort(byScore)) {
    if (bigs.length >= BIG_N) break;
    const live = byKey.get(c.key);
    if (live) bigs.push(live);
  }
  const briefs = cards.filter((c) => !topKeys.has(c.key));

  return (
    <div>
      <Masthead day={day} />

      {bigs.length > 0 && (
        <>
          <Section label="三件大事" count={`按重要程度 · 其余 ${briefs.length} 条在下面`} />
          <section aria-label="三件大事" className="border-t-[3px] border-ink">
            {bigs.map((c, i) => (
              <BigStory key={c.key} card={c} rank={i + 1} read={readSet.has(c.item.id)} />
            ))}
          </section>
        </>
      )}

      {briefs.length > 0 && (
        <>
          <Section label="其余" count={`${briefs.length} 条 · 按时间倒序`} />
          <div className="border-t border-line" aria-label="其余">
            {briefs.map((c) => (
              <Brief key={c.key} card={c} read={readSet.has(c.item.id)} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** 报纸版式里没有「今天还没有精选」那种整页空态，但空数据时要跟原来一样说一句。 */
export function TodayEmpty({ message, linkLabel }: { message: string; linkLabel: string }) {
  return (
    <p className="flex flex-wrap items-baseline gap-x-1.5 py-6 text-[13px] leading-relaxed text-ink-4">
      <span>{message}</span>
      <Link to="/all" className="shrink-0 font-medium text-accent hover:underline">
        {linkLabel}
      </Link>
    </p>
  );
}
