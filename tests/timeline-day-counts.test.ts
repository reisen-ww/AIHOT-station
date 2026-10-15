import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { beijingMidnight } from "@aihot/contracts/time";
import { loadTimeline } from "@aihot/backend/publication/timeline";

after(closeDb);

test("real grouped timeline pagination walks every group once across midnight", async () => {
  const T = tag();
  const source = `day-counts-${T}`;
  const facts: number[] = [];
  const groups: Array<{ anchor: number; key: string }> = [];
  const midnight = beijingMidnight("2024-02-29").getTime();
  const now = new Date("2024-03-02T00:00:00Z");
  await sql`INSERT INTO sources(id,name,kind,tier) VALUES(${source},'Day counts','rss','T1')`;
  const add = async (index: string, at: number, fact: number | null = null, story: number | null = null) => {
    const id = `${T}-${index}`;
    const date = new Date(at);
    await sql`INSERT INTO articles(id,source_id,identity_key,url,title,discovered_at,timeline_at)
      VALUES(${id},${source},${id},'https://example.test/days',${id},${date},${date})`;
    await sql`INSERT INTO publications(article_id,title,source_id,channel,url,discovered_at,timeline_at,sort_at,eligible,selected,visible_after,visibility,tags,fact_id,story_id)
      VALUES(${id},${id},${source},'news','https://example.test/days',${date},${date},${date},true,true,${date},'public',${[T]},${fact},${story})`;
    if (fact !== null) await sql`INSERT INTO fact_articles(fact_id,article_id,role) VALUES(${fact},${id},'report')`;
    return id;
  };
  for (let index = 0; index < 52; index++) {
    const anchor = midnight + 10_000 - Math.floor(index / 2) * 1000;
    const id = await add(String(index), anchor);
    groups.push({ anchor, key: `a${id}` });
  }
  const [story] = await sql<{ id: number }[]>`INSERT INTO stories(public_id,title,first_report_at,latest_at)
    VALUES(gen_random_uuid(),'Day story',${now},${now}) RETURNING id`;
  for (const storyId of [null, story!.id]) {
    const [fact] = await sql<{ id: number }[]>`INSERT INTO facts(public_id,story_id,title)
      VALUES(${`day-${T}-${facts.length}`},${storyId},'Day fact') RETURNING id`;
    facts.push(fact!.id);
    const anchor = storyId ? midnight : midnight - 86_400_000;
    await add(`group-${facts.length}-a`, anchor - 1, fact!.id, storyId);
    await add(`group-${facts.length}-b`, anchor, fact!.id, storyId);
    groups.push({ anchor: anchor - 1, key: `f${fact!.id}` });
  }
  groups.sort((a, b) => b.anchor - a.anchor || (a.key < b.key ? 1 : -1));
  const seen: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 20; page++) {
    const data = await loadTimeline({ channel: "all", category: null, tag: T, now, limit: 7, cursor });
    const pageGroups = groups.slice(seen.length, seen.length + 7);
    assert.deepEqual(data.cards.map(card => card.key), pageGroups.map(group => group.key));
    seen.push(...data.cards.map(card => card.key));
    cursor = data.nextCursor;
    if (!cursor) break;
  }
  assert.deepEqual(seen, groups.map(group => group.key));
  const empty = await loadTimeline({ channel: "all", category: null, tag: `${T}-empty`, now });
  assert.deepEqual([empty.cards, empty.nextCursor], [[], null]);
});
