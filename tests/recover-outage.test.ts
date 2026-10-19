// Outage fallback: when every recent call of the main model failed, the steps are demoted to the
// relay's auto route (settings models.* in the admin's own format), failing sources are due again and
// failed articles requeue. While down the steps call `auto`, so the restore verdict watches the models
// in use (auto), not the main model the steps no longer call; two consecutive ok rounds restore the
// snapshot; without traffic nothing changes.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { capabilities } from "@aihot/backend/editorial/models";
import { requeueFailed } from "@aihot/backend/jobs/content";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { recoverAfterOutage } from "@aihot/backend/operations/recover";

// The demotion verdict filters on the main model (env LLM_MODEL); while down the steps call auto.
process.env.LLM_MODEL ??= "longcat-2.5";
const MODEL = process.env.LLM_MODEL!;
const AUTO = "auto";
const STATE_KEY = "recovery.outage";

after(async () => {
  await stopBoss();
  await closeDb();
});

/** One live attempt of a model as receipts.ts would record it (the main model, or the demoted auto). */
async function attempt(status: "received" | "failed", model = MODEL) {
  const [r] = await sql<{ id: number }[]>`
    INSERT INTO receipts (logical_key, service, model, purpose, status) VALUES (${`outage-${tag()}`}, 'llm', ${model}, 'invariant_test', ${status}) RETURNING id`;
  await sql`INSERT INTO receipt_attempts (receipt_id, attempt, service, model, status, origin) VALUES (${r!.id}, 1, 'llm', ${model}, ${status}, 'live')`;
}

async function article(state: string) {
  const source = `outage-src-${tag()}`;
  await sql`INSERT INTO sources (id, name, kind, health) VALUES (${source}, ${source}, 'rss', 'unknown')`;
  const id = `outage-${tag()}`;
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, discovered_at, timeline_at, processing_state)
            VALUES (${id}, ${source}, ${id}, 'https://example.com/a', 't', now(), now(), ${state})`;
  return id;
}

const modelSettings = () => sql<{ key: string; value: { model?: string } }[]>`SELECT key, value FROM settings WHERE key LIKE 'models.%' ORDER BY key`;
const state = () => sql<{ value: { state: string; confirmOkStreak?: number; demotedFrom?: Record<string, unknown> } }[]>`SELECT value FROM settings WHERE key = ${STATE_KEY}`;
// The tests share the 10-minute verdict window: each one removes the previous ones' attempts too.
const clear = () => sql`DELETE FROM receipts WHERE logical_key LIKE 'outage-%'`;
const clearState = () => sql`DELETE FROM settings WHERE key LIKE 'models.%' OR key = ${STATE_KEY}`;

test("every recent main-model call failed: steps are demoted to auto, sources and articles requeue", async () => {
  await clear();
  await clearState();
  process.env.LLM_MODEL = "longcat-2.5";
  const failed = await article("failed");
  const fresh = await article("new");
  await sql`UPDATE sources SET health = 'failing' WHERE id = (SELECT source_id FROM articles WHERE id = ${failed})`;
  await sql`UPDATE sources SET health = 'ok' WHERE id = (SELECT source_id FROM articles WHERE id = ${fresh})`;
  await sql`INSERT INTO settings (key, value, updated_by) VALUES ('models.score', ${sql.json({ model: "deepseek-flash" } as never)}, 'admin')`;
  await attempt("failed");

  const out = await recoverAfterOutage();
  assert.equal(out.state, "down");
  assert.equal(out.sourcesReset, 1);
  assert.equal(out.requeued, 1);
  assert.equal((await requeueFailed(null)).requeued, 0); // the failed article is back to processing

  const settings = await modelSettings();
  const caps = Object.keys(capabilities());
  assert.equal(settings.length, caps.length);
  for (const row of settings) assert.equal(row.value.model, "auto");
  const st = (await state())[0]!.value!;
  assert.equal(st.state, "down");
  assert.deepEqual(st.demotedFrom!["models.score"], { model: "deepseek-flash" }); // the snapshot this demotion restores from
  assert.equal((await sql`SELECT processing_state FROM articles WHERE id = ${failed}`)[0]!.processing_state, "new");
  assert.equal((await sql`SELECT health FROM sources WHERE id = (SELECT source_id FROM articles WHERE id = ${failed})`).length, 1);
  assert.ok((await sql`SELECT 1 FROM audit_log WHERE action = 'recovery.demote'`).length > 0);
});

test("while down the demoted model's calls count: two ok rounds restore, a failure resets the streak", async () => {
  await clear();
  await clearState();
  process.env.LLM_MODEL = "longcat-2.5";
  await sql`INSERT INTO settings (key, value, updated_by) VALUES ('models.score', ${sql.json({ model: "deepseek-flash" } as never)}, 'admin')`;
  await attempt("failed");
  await recoverAfterOutage(); // demote
  assert.equal((await state())[0]!.value!.state, "down");

  // The steps now call auto, and the main model is not called at all: auto's success is the live signal.
  await attempt("received", AUTO);
  assert.equal((await recoverAfterOutage()).state, "down");
  assert.equal((await state())[0]!.value!.confirmOkStreak, 1);
  assert.equal((await modelSettings())[0]!.value.model, "auto"); // not restored yet

  await clear(); // the earlier ok attempt still sits in the 10-minute window: drop it for a failed-only round
  await attempt("failed", AUTO);
  await recoverAfterOutage(); // the streak resets
  assert.equal((await state())[0]!.value!.confirmOkStreak, 0);

  await attempt("received", AUTO);
  await recoverAfterOutage(); // first ok round
  assert.equal((await state())[0]!.value!.state, "down");
  await recoverAfterOutage(); // second consecutive ok round restores
  assert.equal((await sql`SELECT value FROM settings WHERE key = ${STATE_KEY}`)[0]!.value.state, "idle");
  const settings = await modelSettings();
  assert.equal(settings.length, 1);
  assert.equal(settings[0]!.key, "models.score");
  assert.equal(settings[0]!.value.model, "deepseek-flash");
  assert.ok((await sql`SELECT 1 FROM audit_log WHERE action = 'recovery.restore'`).length > 0);
});

test("an empty snapshot removes the demotion on restore", async () => {
  await clear();
  await clearState();
  process.env.LLM_MODEL = "longcat-2.5";
  await attempt("failed");
  await recoverAfterOutage();
  assert.equal((await modelSettings()).length, Object.keys(capabilities()).length);
  await attempt("received", AUTO);
  await recoverAfterOutage(); // first ok round only counts the streak
  await recoverAfterOutage(); // second round restores
  assert.equal((await modelSettings()).length, 0); // nothing was there before: the overrides are gone
});

test("an empty snapshot does not delete the settings an admin set while down", async () => {
  await clear();
  await clearState();
  process.env.LLM_MODEL = "longcat-2.5";
  await attempt("failed");
  await recoverAfterOutage(); // demote with an empty snapshot (no models.* existed)
  assert.equal((await state())[0]!.value!.demotedFrom && Object.keys((await state())[0]!.value!.demotedFrom!).length, 0);

  // An admin sets a step while the site is down; the snapshot cannot know about it.
  await sql`UPDATE settings SET value = ${sql.json({ model: "deepseek-flash" } as never)}, updated_by = 'admin' WHERE key = 'models.summarize'`;
  await attempt("received", AUTO);
  await recoverAfterOutage();
  await recoverAfterOutage(); // restore

  const settings = await modelSettings();
  assert.deepEqual(settings.map((row) => row.key), ["models.summarize"]);
  assert.equal(settings[0]!.value.model, "deepseek-flash"); // kept, not deleted with the auto overrides
  assert.equal((await state())[0]!.value!.state, "idle");
});

test("a snapshot key the admin changed while down keeps the newer value on restore", async () => {
  await clear();
  await clearState();
  process.env.LLM_MODEL = "longcat-2.5";
  await sql`INSERT INTO settings (key, value, updated_by) VALUES ('models.score', ${sql.json({ model: "deepseek-flash" } as never)}, 'admin')`;
  await attempt("failed");
  await recoverAfterOutage(); // demote, snapshot models.score = deepseek-flash
  await sql`UPDATE settings SET value = ${sql.json({ model: "qwen3.8-flash" } as never)}, updated_by = 'admin' WHERE key = 'models.score'`;
  await attempt("received", AUTO);
  await recoverAfterOutage();
  await recoverAfterOutage(); // restore

  const settings = await modelSettings();
  assert.equal(settings.length, 1);
  assert.equal(settings[0]!.key, "models.score");
  assert.equal(settings[0]!.value.model, "qwen3.8-flash"); // the admin's newer choice wins over the snapshot
});

test("no recent main-model traffic: nothing changes, whatever the state is", async () => {
  await clear();
  await clearState();
  process.env.LLM_MODEL = "longcat-2.5";
  await sql`INSERT INTO settings (key, value, updated_by) VALUES ('models.score', ${sql.json({ model: "deepseek-flash" } as never)}, 'admin')`;
  // Another model's attempts do not count for the main model's verdict.
  const [r] = await sql<{ id: number }[]>`
    INSERT INTO receipts (logical_key, service, model, purpose, status) VALUES (${`outage-other-${tag()}`}, 'llm', 'some-other-model', 'invariant_test', 'failed') RETURNING id`;
  await sql`INSERT INTO receipt_attempts (receipt_id, attempt, service, model, status) VALUES (${r!.id}, 1, 'llm', 'some-other-model', 'failed')`;

  assert.equal((await recoverAfterOutage()).state, "idle");
  assert.equal((await state()).length, 0);
  assert.equal((await modelSettings())[0]!.value.model, "deepseek-flash");
  assert.equal((await sql`SELECT processing_state FROM articles WHERE processing_state = 'failed'`).length, 0);
});
