// Explicitly bind public reads to one connection and clock. Normal callers retain their live defaults.
import { sql, type Db } from "../db.ts";

export interface PublicationRead {
  db: Db;
  now: Date;
  /** Offline article selection; reports and source licences retain their complete history. */
  itemIds?: readonly string[];
}

/** Public queries name their publication p. Live readers keep the original unbounded scope. */
export const itemWindow = (read?: PublicationRead) => read?.itemIds
  ? sql`AND p.article_id = ANY(${[...read.itemIds]}::text[])` : sql``;

export const livePublicationRead = (): PublicationRead => ({ db: sql, now: new Date() });
