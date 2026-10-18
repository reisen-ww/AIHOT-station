// In-doubt work. A stopped process leaves "pending" receipts and deliveries: they become
// "unknown" and are never re-sent on their own. An unknown receipt is released once automatically after
// half an hour without checking the provider's bill, so a lost answer costs at most one repeat; one that
// turns unknown again waits for the admin, who checks the bill and releases it with a note. A released
// receipt lets its request call again, and an article that stopped on it goes back to processing.
import { audit, Conflict } from "../audit.ts";
import { sql } from "../db.ts";
import { capabilities, invalidateModelCache } from "../editorial/models.ts";
import { requeueFailed, resumeAfterRelease } from "../jobs/content.ts";
import { sweepUngrouped } from "../jobs/events.ts";
import { retryReleasedReceiptJobs } from "../jobs/queue.ts";
import { markStaleDeliveries } from "../notify/deliver.ts";
import { formatAlert, formatRecovery, sendAlert, type Finding } from "../notify/feishu.ts";
import { markStalePendingReceipts, releaseUnknownReceipt } from "../providers/receipts.ts";

const AUTO_RELEASE_AFTER_MS = 30 * 60_000;
export const AUTO_RELEASE_NOTE = "自动放行：结果未知超过 30 分钟，未核对是否计费";

// 故障自动回退：主模型（default）连续全失败时把各步骤切到 auto 路由，连续两轮恢复后切回。
// 判定只看主模型自己的 attempts，auto 的成功不算主模型的恢复。状态存 settings（watchdog.worker 同款）。
const OUTAGE_STATE_KEY = "recovery.outage";
const OUTAGE_CONFIRM_OK = 2;

interface OutageState {
  state: "idle" | "down";
  since?: string;
  confirmOkStreak?: number;
  demotedFrom?: Record<string, { model?: string }>;
}

const OUTAGE_DOWN: Finding = {
  key: "models.outage",
  level: "now",
  title: "主模型连续失败，各步骤已自动回退到 auto 路由",
  impact: "处理不停但走了中转站的路由选择；主模型恢复后两轮内自动切回",
  heals: "连续两轮看到主模型成功后自动恢复",
  action: "转给 AI 处理",
};

async function release(id: number, error: string, actor: string, note: string, billed: boolean | null) {
  return sql.begin(async (tx) => {
    const receipt = await releaseUnknownReceipt(tx, id, error);
    if (!receipt) return null;
    const requeued = await resumeAfterRelease(receipt, tx);
    await audit(actor, "receipt.release", `receipt:${id}`, note, { status: "unknown" }, { status: "failed", billed, requeued }, { db: tx });
    return { id, status: "failed", subject: receipt.subject, purpose: receipt.purpose, requeued };
  });
}

/** Admin, after checking the provider's console: records whether it was billed and releases it. */
export async function releaseReceipt(id: number, input: { billed: boolean; note: string }, actor: string) {
  if (!input.note?.trim()) throw new Error("note is required");
  const [row] = await sql<{ status: string }[]>`SELECT status FROM receipts WHERE id = ${id}`;
  if (!row) return null;
  if (row.status !== "unknown") throw new Conflict("只有结果未知的回执需要人工核对");
  const error = `人工核对：${input.billed ? "供应商已计费但结果未取回" : "供应商未计费"}。${input.note}`;
  return release(id, error, actor, input.note, input.billed);
}

/**
 * Unknown receipts older than half an hour, released without checking the provider's bill. A request
 * released this way once and unknown again stays for the admin (the daily ops digest lists it).
 */
export async function autoReleaseUnknownReceipts(now = Date.now()) {
  const rows = await sql<{ id: number }[]>`
    SELECT r.id FROM receipts r
    WHERE r.status = 'unknown' AND r.updated_at < ${new Date(now - AUTO_RELEASE_AFTER_MS)}
      AND NOT EXISTS (SELECT 1 FROM receipt_attempts a WHERE a.receipt_id = r.id AND a.error LIKE ${AUTO_RELEASE_NOTE + "%"})
    ORDER BY r.id LIMIT 200`;
  let released = 0;
  let requeued = 0;
  for (const r of rows) {
    const done = await release(r.id, AUTO_RELEASE_NOTE, "ops.recover", "结果未知，自动放行一次", null);
    if (done) released += 1;
    if (done?.requeued) requeued += 1;
  }
  return { released, requeued };
}

const saveOutageState = (value: OutageState) =>
  sql`INSERT INTO settings (key, value, updated_by) VALUES (${OUTAGE_STATE_KEY}, ${sql.json(value as never)}, 'worker')
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;

/**
 * The outage state machine, run from ops.recover every 10 minutes. Only the main model's own attempts
 * (the `llm` service, env LLM_MODEL) count: with every recent one failed the steps are demoted to the
 * relay's `auto` route (settings models.*, the admin's own format), failing sources are due again and
 * failed articles requeue; two consecutive rounds with a success restore the snapshot.
 * Never throws: an outage bookkeeping problem must not take down the rest of recovery.
 */
export async function recoverAfterOutage(): Promise<{ state: "idle" | "down"; requeued?: number; sourcesReset?: number; streak?: number }> {
  try {
    const model = process.env.LLM_MODEL ?? "";
    const [counts] = await sql<{ total: number; ok: number; failed: number }[]>`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE a.status = 'received')::int AS ok,
             count(*) FILTER (WHERE a.status = 'failed')::int AS failed
      FROM receipt_attempts a JOIN receipts r ON r.id = a.receipt_id
      WHERE a.started_at > now() - interval '10 minutes' AND a.origin = 'live' AND r.service = 'llm' AND r.model = ${model}`;
    if (!counts || counts.total === 0) return { state: (await loadOutageState())?.state ?? "idle" }; // no traffic: no verdict
    const [current] = await sql<{ value: OutageState | null }[]>`SELECT value FROM settings WHERE key = ${OUTAGE_STATE_KEY}`;
    const state = current?.value?.state === "down" ? current.value : { state: "idle" as const };

    if (state.state !== "down" && counts.failed > 0 && counts.ok === 0) {
      const snapshot: Record<string, { model?: string }> = {};
      for (const row of await sql<{ key: string; value: { model?: string } }[]>`SELECT key, value FROM settings WHERE key LIKE 'models.%'`)
        snapshot[row.key] = row.value;
      let demoted = 0;
      for (const cap of Object.keys(capabilities())) {
        await sql`INSERT INTO settings (key, value, updated_by) VALUES (${`models.${cap}`}, ${sql.json({ model: "auto" } as never)}, 'worker')
                  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
        demoted += 1;
      }
      invalidateModelCache();
      const sourcesReset = (await sql`UPDATE sources SET next_fetch_at = now() WHERE health IN ('failing', 'degraded') AND enabled RETURNING 1`).length;
      const { requeued } = await requeueFailed(null);
      const since = new Date();
      await saveOutageState({ state: "down", since: since.toISOString(), confirmOkStreak: 0, demotedFrom: snapshot });
      const detail = `主模型 ${model} 近 10 分钟 ${counts.failed} 次调用全部失败：${demoted} 个步骤切到 auto，重置 ${sourcesReset} 个不健康信源，重排 ${requeued} 篇失败文章`;
      await audit("worker", "recovery.demote", `capability:all`, detail, { models: snapshot }, { model: "auto" });
      const alert = formatAlert(OUTAGE_DOWN, since, Date.now());
      await sendAlert(alert.title, [...alert.lines, detail]);
      return { state: "down", requeued, sourcesReset };
    }

    if (state.state === "down") {
      if (counts.ok === 0) {
        await saveOutageState({ ...state, confirmOkStreak: 0 });
        return { state: "down", streak: 0 };
      }
      const streak = (state.confirmOkStreak ?? 0) + 1;
      if (streak < OUTAGE_CONFIRM_OK) {
        await saveOutageState({ ...state, confirmOkStreak: streak });
        return { state: "down", streak };
      }
      // Restore exactly the snapshot: the demotion's own writes (keys it does not name) are removed,
      // so an empty snapshot leaves no overrides at all.
      await sql`DELETE FROM settings WHERE key LIKE 'models.%'`;
      for (const [key, value] of Object.entries(state.demotedFrom ?? {})) {
        await sql`INSERT INTO settings (key, value, updated_by) VALUES (${key}, ${sql.json(value as never)}, 'worker')
                  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
      }
      invalidateModelCache();
      await saveOutageState({ state: "idle" });
      await audit("worker", "recovery.restore", `capability:all`, `主模型 ${model} 连续 ${streak} 轮有成功调用，按快照恢复各步骤`, { model: "auto" }, { models: state.demotedFrom ?? {} });
      const since = state.since ? new Date(state.since) : new Date();
      const alert = formatRecovery(OUTAGE_DOWN.title, since, Date.now());
      await sendAlert(alert.title, alert.lines);
      return { state: "idle" };
    }
    return { state: "idle" };
  } catch (error) {
    console.error("recoverAfterOutage failed:", error);
    await audit("worker", "recovery.error", "capability:all", "故障回退状态机自身出错", null, { error: String(error).slice(0, 500) }).catch(() => {});
    return { state: "idle" };
  }
}

async function loadOutageState(): Promise<OutageState | null> {
  const [row] = await sql<{ value: OutageState | null }[]>`SELECT value FROM settings WHERE key = ${OUTAGE_STATE_KEY}`;
  return row?.value ?? null;
}

/** ops.recover, every 10 minutes. */
export async function recoverStaleWork() {
  return { receipts: await markStalePendingReceipts(), released: await autoReleaseUnknownReceipts(), jobs: await retryReleasedReceiptJobs(), grouping: await sweepUngrouped(), deliveries: await markStaleDeliveries(), outage: await recoverAfterOutage() };
}
