// The browser receives only this public projection, never database rows or stored model output.
import type { FeedItemSummary, GroupReportsResponse, ReportIndexEntry, ReportKind, TimelineFilters } from "./site.ts";

export interface StaticSink {
  /** Must finish writing before it resolves; a rejected write aborts the snapshot. */
  json(key: string, value: unknown): Promise<void>;
  text(key: string, value: string): Promise<void>;
}

export interface StaticListItem {
  item: FeedItemSummary;
  /** Published time, otherwise discovery time: the site's /all and timeline ordering. */
  sortAt: string;
  inPool: boolean;
  inTimeline: boolean;
  firstParty: boolean;
  /** An opaque source identity: equal display names need not be the same publisher. */
  sourceKey: string;
  searchText: string;
  /** Every fact this listed report currently evidences, not just publications.fact_id. */
  poolFactIds: string[];
  /** Only current own-fact evidence folds; order is computed by the existing representative rule. */
  fact: { publicId: string; representativeOrder: number; sortKey?: string } | null;
}

export interface StaticEntityAlias {
  aliases: string[];
  /** Subject membership is projected here without exposing internal entity tags. */
  itemIds: string[];
}

export interface StaticCatalog {
  schemaVersion: 1;
  station: string;
  revision: string;
  asOf: string;
  items: StaticListItem[];
  entities: StaticEntityAlias[];
}

/** Only licensed, currently public original body text, matching the existing 12000-character limit. */
export interface StaticSearchBody {
  id: string;
  text: string;
}

export interface StaticPoolQuery extends TimelineFilters {
  q?: string | null;
  tab?: "time" | "relevance";
  page?: number;
}

export interface StaticTimelineQuery extends TimelineFilters {
  cursor?: string | null;
  limit?: number;
}

export interface StaticGroup {
  factId: string;
  reports: Array<GroupReportsResponse["reports"][number] & {
    channel: "news" | "x";
    category: string | null;
    tags: string[];
    firstParty: boolean;
  }>;
}

export interface StaticManifest {
  schemaVersion: 1;
  station: string;
  revision: string;
  asOf: string;
  /** Omitted by older, complete snapshots. All report issues remain available in either mode. */
  window?: {
    /** Latest articles retained. Explicit score retention adds qualifying historical articles. */
    maxItems: number; publicItems: number; onlineItems: number; oldestAt: string | null; newestAt: string | null; searchScope: "online-window";
    scoreRetention?: { minimumScore: number; additionalItems: number };
  };
  /** All paths are relative to the station's data directory, and content-addressed by the writer. */
  files: Record<string, string>;
  bodyShards: string[];
  reports: Record<ReportKind, ReportIndexEntry[]>;
  topicPages: Record<string, number>;
  itemIds: string[];
  stories: string[];
  aliases: Record<string, string>;
  routes: string[];
}
