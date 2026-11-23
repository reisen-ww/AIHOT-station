import {
  isRouteErrorResponse, Link, Links, Meta, Outlet, Scripts, ScrollRestoration, useLoaderData, useLocation, useNavigation, useRouteError, useRouteLoaderData,
  type ShouldRevalidateFunction,
} from "react-router";
import type { SiteMeta } from "@aihot/contracts/site";
import type { StaticManifest } from "@aihot/contracts/static";
import { SITE } from "@aihot/site";
import { RingMark } from "@aihot/site/brand/Logo.tsx";
import { useEffect, useState, type ReactNode } from "react";
import type { Route } from "./+types/root";
import "./app.css";
import { Sidebar } from "./components/shell/Sidebar";
import { TabBar } from "./components/shell/TabBar";
import { PullToRefresh } from "./components/shell/PullToRefresh";
import { usePageTransition } from "./components/shell/transitions";
import { SearchOverlay } from "./features/search/SearchOverlay";
import { BackToTop, NavigationProgress } from "./components/shell/Chrome";
import { buttonClass } from "./components/ui/Controls";
import { rememberPage, THEME_BOOT_SCRIPT, useThemeSync } from "./lib/local-state";
import { apiGet } from "./lib/api";
import { STATIC_SITE, sitePath } from "./lib/deployment";
import { useHydratedFlag } from "./lib/hydration";
import { titled } from "./lib/seo";
import { webModules } from "./site-modules";

declare const __STATIC_META__: { changelogVersion: string | null; release: string; articleWindow?: StaticManifest["window"] | null } | null;

export const links: Route.LinksFunction = () => [
  { rel: "icon", href: sitePath("/favicon.ico"), sizes: "any" },
  { rel: "icon", type: "image/png", href: sitePath("/icon.png") },
  { rel: "apple-touch-icon", href: sitePath("/apple-icon.png") },
  { rel: "manifest", href: sitePath("/manifest.webmanifest") },
  { rel: "alternate", type: "application/rss+xml", title: `${SITE.name} — 精选`, href: sitePath("/feed.xml") },
];

/** The release rendering this document: once a newer one is deployed, a render error reloads the page (entry.client). */
export async function loader({ request }: Route.LoaderArgs) {
  if (STATIC_SITE && __STATIC_META__) return __STATIC_META__;
  const release = process.env.AIHOT_RELEASE ?? null;
  try {
    const meta = await apiGet<SiteMeta>("/api/site/meta", {
      headers: Object.assign({}, ...webModules().map((m) => m.root?.documentHeaders?.(request) ?? {})),
      signal: request.signal,
    });
    return { ...meta, release, articleWindow: null };
  } catch {
    return { changelogVersion: null, release, articleWindow: null };
  }
}

export const shouldRevalidate: ShouldRevalidateFunction = () => false;

export async function clientLoader({ request, serverLoader }: Route.ClientLoaderArgs) {
  if (!STATIC_SITE) return serverLoader();
  const meta = await (await import("./lib/static-api")).apiGet<SiteMeta & { articleWindow?: StaticManifest["window"] | null }>("/api/site/meta", { signal: request.signal });
  return { ...meta, release: __STATIC_META__?.release ?? null };
}
clientLoader.hydrate = STATIC_SITE;

export function HydrateFallback() {
  return <main className="grid min-h-dvh place-items-center bg-bg text-ink-3"><p role="status">正在打开{SITE.name}…</p></main>;
}

export function Layout({ children }: { children: React.ReactNode }) {
  const site = useRouteLoaderData<typeof loader>("root");
  const [documentRelease] = useState(site?.release ?? (STATIC_SITE ? __STATIC_META__?.release : null) ?? null);
  return (
    <html lang={SITE.locale} suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        {documentRelease && <meta name="aihot-release" content={documentRelease} />}
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="theme-color" media="(prefers-color-scheme: light)" content="#efe4cc" />
        <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#101419" />
        <meta name="apple-mobile-web-app-title" content={SITE.name} />
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
        {webModules().map((m) => m.root?.bootScript && <script key={m.name} dangerouslySetInnerHTML={{ __html: m.root.bootScript }} />)}
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration getKey={(location) => location.key} />
        <Scripts />
      </body>
    </html>
  );
}

/** Only a page nobody matched falls back to this; every page names itself. */
export function meta({ error }: Route.MetaArgs) {
  if (!error) return [];
  const status = isRouteErrorResponse(error) ? error.status : 500;
  return [{ title: titled(status === 410 ? "已超出在线窗口" : status === 404 ? "页面不存在" : "暂时无法加载") }, { name: "robots", content: "noindex" }];
}

/** Sidebar, main column and phone tab bar around a page (or an error). */
function SiteShell({ changelogVersion, children }: { changelogVersion: string | null; children: ReactNode }) {
  const navigation = useNavigation();
  // The phone search and pull-to-refresh are client-side, mounted once the page is interactive.
  const [interactive, setInteractive] = useState(false);
  useEffect(() => setInteractive(true), []);
  return (
    <div className="flex min-h-dvh">
      <NavigationProgress active={navigation.state === "loading"} />
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[70] focus:rounded-control focus:bg-surface focus:px-3 focus:py-2">
        跳到正文
      </a>
      <Sidebar changelogVersion={changelogVersion} />
      {/* Phone shell (≤ 960px): each page's top bar (PhoneBar), one centred column, the tab bar below.
          Desktop: the page fills the main area up to the list width (--page-max-wide), centred beyond it. */}
      <main id="main" className="min-w-0 flex-1 pb-[calc(72px+env(safe-area-inset-bottom))] lg:px-7 lg:pb-[72px] lg:pt-6">
        <div className="mx-auto w-full max-w-[640px] pl-[var(--gutter-l)] pr-[var(--gutter-r)] lg:max-w-[var(--page-max-wide)] lg:px-0">
          {webModules().map((m) => m.root?.Top && <m.root.Top key={m.name} />)}
          {children}
        </div>
      </main>
      <TabBar changelogVersion={changelogVersion} />
      {interactive && <SearchOverlay />}
      {interactive && <PullToRefresh />}
      <BackToTop />
    </div>
  );
}

export default function App() {
  const meta = useLoaderData<typeof loader>();
  useHydratedFlag();
  useThemeSync();
  const { pathname, search } = useLocation();
  useEffect(() => rememberPage(pathname + search), [pathname, search]);
  usePageTransition();
  // iOS Safari only shows :active (pressed) styles once the document listens for touches.
  useEffect(() => {
    const noop = () => {};
    document.addEventListener("touchstart", noop, { passive: true });
    return () => document.removeEventListener("touchstart", noop);
  }, []);
  // The admin has its own chrome.
  if (pathname === "/admin" || pathname.startsWith("/admin/")) return <Outlet />;
  return (
    <>
      <SiteShell changelogVersion={meta.changelogVersion}>
        <Outlet />
      </SiteShell>
      {webModules().map((m) => m.root?.Bottom && <m.root.Bottom key={m.name} />)}
    </>
  );
}

export function ErrorBoundary() {
  useThemeSync();
  const error = useRouteError();
  const site = useRouteLoaderData<typeof loader>("root");
  const { pathname, search, hash } = useLocation();
  const status = isRouteErrorResponse(error) ? error.status : 500;
  const notFound = status === 404;
  const outside = status === 410 && isRouteErrorResponse(error) && error.data?.message === "outside_window";
  const original = outside && typeof error.data.originalUrl === "string" && /^https?:\/\//i.test(error.data.originalUrl) ? error.data.originalUrl : null;
  const body = (
    <div className="flex min-h-[70vh] items-center justify-center px-2 py-16">
      <div className="max-w-sm text-center">
        <RingMark className="mx-auto mb-5 size-10 text-accent" />
        <div className="mono text-[12px] text-ink-4">{status}</div>
        <h1 className="mt-1.5 text-[20px] font-bold text-ink">{outside ? "已超出当前在线窗口" : notFound ? "这里没有内容" : "暂时无法加载"}</h1>
        <p className="mt-2 text-[13.5px] leading-relaxed text-ink-3">
          {outside ? "这篇历史文章暂未包含在本版在线窗口中，并非来源撤回。已有收藏仍然保留；历史日报、周报和月报可继续阅读。" : notFound ? STATIC_SITE ? "此地址未收录在当前在线窗口，也可能不存在或已不再公开；历史报告仍可浏览。" : "你访问的页面不存在，或内容已不再公开。" : "页面暂时无法显示，请重新加载后再试。"}
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2.5">
          {!notFound && !outside && <Link reloadDocument to={pathname + search + hash} className={buttonClass("primary")}>
            重新加载
          </Link>}
          {original && <a href={original} target="_blank" rel="noopener noreferrer" className={buttonClass("primary")}>阅读原文</a>}
          <Link reloadDocument to="/" className={buttonClass(notFound ? "primary" : "secondary")}>
            回到精选
          </Link>
          <Link reloadDocument to="/all" className={buttonClass("secondary")}>
            浏览全部动态
          </Link>
        </div>
      </div>
    </div>
  );
  // Admin errors stay inside the admin's own chrome.
  if (pathname === "/admin" || pathname.startsWith("/admin/")) return body;
  return <SiteShell changelogVersion={site?.changelogVersion ?? null}>{body}</SiteShell>;
}
