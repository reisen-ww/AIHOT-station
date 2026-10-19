import { data as withHeaders, redirect, useLoaderData } from "react-router";
import type { Route } from "./+types/home";
import type { TimelineResponse } from "@aihot/contracts/site";
import { apiDeadlineCache, loadOr404 } from "../lib/api.server";
import { filterParams, itemListLd, listPath, pageMeta, readFilters, siteLd } from "../lib/seo";
import type { Screen } from "../components/shell/screens";
import { Timeline } from "../features/feed/Timeline";
import { ActiveFilters, CategoryTabs, FeedBar, SearchField } from "../features/feed/Filters";

export const handle: Screen = { tab: "featured", name: "精选" };

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const q = url.searchParams.get("q");
  // Search lives on /all; keep the parameters so old links still land on results.
  if (q && q.trim()) throw redirect(`/all${url.search}`);
  const filters = readFilters(url.searchParams);
  const upstream = new Headers();
  const data = await loadOr404<TimelineResponse>(listPath("/api/site/timeline", filterParams(filters)), { responseHeaders: upstream, signal: request.signal });
  return withHeaders({ data, filters }, { headers: apiDeadlineCache(60, Date.now(), upstream) });
}

export function meta({ loaderData }: Route.MetaArgs) {
  const path = listPath("/", loaderData ? filterParams(loaderData.filters) : {});
  const titles = loaderData?.data.cards.map((c) => c.item.title) ?? [];
  return pageMeta({ path, jsonLd: path === "/" ? [...siteLd(), itemListLd("/", "精选", titles)] : undefined });
}

export function headers({ loaderHeaders }: Route.HeadersArgs) {
  return loaderHeaders;
}

export default function Home() {
  const { data, filters } = useLoaderData<typeof loader>();
  // 有筛选时按筛选结果读；没有筛选时首页就是「今天这一页」（报纸版式）。
  const filtered = !!filters.tag || !!filters.category || filters.channel !== "all";
  return (
    <div className="pb-6">
      {/* Phones: the bar (精选 | 全部, filter, search) and the filter in use. The 报头 lives in the feed. */}
      <FeedBar base="/" category={filters.category} channel={filters.channel} />
      <ActiveFilters base="/" category={filters.category} channel={filters.channel} tag={filters.tag} />

      {/* Desktop 的筛选行：报头之下不再有第二个标题，所以它留在最上面当顶栏用。 */}
      <div className="hidden items-center justify-between gap-4 pb-1 lg:flex">
        <CategoryTabs base="/" category={filters.category} channel={filters.channel} layoutId="home-cat-desk" className="min-w-0" />
        <SearchField keep={{ category: filters.category }} />
      </div>

      {filtered ? (
        <>
          <h1 className="hidden text-[24px] font-semibold leading-[1.3] text-ink lg:block lg:pt-4">{filters.tag ? `#${filters.tag}` : "精选"}</h1>
          <Timeline initial={data} filters={data.filters} />
        </>
      ) : (
        <Timeline initial={data} filters={data.filters} layout="today" />
      )}
    </div>
  );
}
