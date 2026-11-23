// The single local generation/publication entry. Importing this module never starts a cycle.
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { appendFile, lstat, mkdir, readFile, readdir, rename, rm, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { composeStaticSites } from "./static-compose.ts";
import { digest, staticInventory } from "./static-validate.ts";
import { STATIONS, PUBLIC_SITE_URL, acquireLock, atomicWriteState, fingerprintSnapshot, fingerprintSources, readState, slotFor, validateCombinedRelease } from "./static-runner-core.mjs";
import { confirmPublication, publishCandidate } from "./static-publish.mjs";

const OWNER = "hot-pages-static-cycle";
// Scheduled runs may retry a slot once; a crash loop must never hold the phone for hours.
const MAX_SLOT_ATTEMPTS = 2;
const RETRY_COOLDOWN_MS = 10 * 60 * 1000;
const SLOT_MS = 2 * 60 * 60 * 1000;
const SLOT_START_MARGIN_MS = 20 * 60 * 1000;
// A build produced by another Node runtime is not interchangeable with this one, even when the
// snapshot and the sources are byte-identical. Bump this key whenever the runtime changes.
const BUILD_TOOL = digest([process.version, process.platform, process.arch].join("\n"));
const exists = async (file) => { try { return await lstat(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; } };
function inside(root, file) {
  const relative = path.relative(root, path.resolve(file));
  if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw new Error("runner path escapes its owned directory");
  return path.resolve(file);
}

export function validateCycleConfiguration(value) {
  if (!value || value.schemaVersion !== 1 || !path.isAbsolute(value.workDirectory ?? "") || !Number.isSafeInteger(value.budgetBytes) || value.budgetBytes < 1 || value.budgetBytes >= 1_000_000_000) throw new Error("explicit workDirectory and combined budget required");
  if (Object.keys(value.stations ?? {}).sort().join(",") !== [...STATIONS].sort().join(",")) throw new Error("exactly four explicit stations required");
  const roots = new Set();
  for (const slug of STATIONS) {
    const station = value.stations[slug];
    if (!station || !path.isAbsolute(station.root ?? "") || !/^[A-Z][A-Z0-9_]*$/.test(station.databaseEnv ?? "") || !Number.isSafeInteger(station.maxItems) || station.maxItems < 1 || (station.assetsDirectory && !path.isAbsolute(station.assetsDirectory))) throw new Error("invalid explicit station configuration: " + slug);
    if (station.retainScoreAtLeast !== undefined && (!Number.isFinite(station.retainScoreAtLeast) || station.retainScoreAtLeast < 0 || station.retainScoreAtLeast > 100)) throw new Error("invalid score retention configuration: " + slug);
    const root = path.resolve(station.root), key = process.platform === "win32" ? root.toLowerCase() : root;
    if (roots.has(key)) throw new Error("station source roots must be distinct");
    roots.add(key);
    const relative = path.relative(root, value.workDirectory);
    if (!relative || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative))) throw new Error("workDirectory must be outside station source roots");
  }
  const allRoots = [path.resolve(value.workDirectory), ...STATIONS.map((slug) => path.resolve(value.stations[slug].root))];
  for (const [index, root] of allRoots.entries()) for (const other of allRoots.slice(index + 1)) {
    for (const [parent, child] of [[root, other], [other, root]]) {
      const relative = path.relative(parent, child);
      if (!relative || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative))) throw new Error("source and work directories must not overlap");
    }
  }
  if (value.keepSuccessfulRuns !== undefined && (!Number.isSafeInteger(value.keepSuccessfulRuns) || value.keepSuccessfulRuns < 2)) throw new Error("keepSuccessfulRuns must be at least two");
  return value;
}

async function ownedWorkspace(root) {
  await physicalDirectory(root, true);
  const marker = path.join(root, "runner-owner.json"), stat = await exists(marker);
  if (!stat) {
    if ((await readdir(root)).some((name) => name !== "runner-owner.json")) throw new Error("refusing an unowned nonempty workDirectory");
    try { await writeFile(marker, JSON.stringify({ schemaVersion: 1, owner: OWNER }), { flag: "wx" }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  const current = await lstat(marker);
  if (current.isSymbolicLink() || !current.isFile()) throw new Error("invalid workspace owner");
  const owner = JSON.parse(await readFile(marker, "utf8"));
  if (owner.schemaVersion !== 1 || owner.owner !== OWNER) throw new Error("workspace belongs to another task");
}

async function physicalDirectory(directory, create = false) {
  const root = path.resolve(directory), anchor = path.parse(root).root;
  let current = anchor;
  for (const part of ["", ...root.slice(anchor.length).split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part);
    let info = await exists(current);
    if (!info && create) {
      try { await mkdir(current); } catch (error) { if (error.code !== "EEXIST") throw error; }
      info = await lstat(current);
    }
    if (!info || info.isSymbolicLink() || !info.isDirectory()) throw new Error("physical directory required: " + current);
  }
  return root;
}

function candidateRun(work, candidate) {
  const runs = path.join(work, "runs"), directory = inside(runs, candidate?.directory ?? "");
  const run = path.dirname(directory);
  if (path.basename(directory) !== "combined" || path.dirname(run) !== runs) throw new Error("invalid generated candidate path");
  return run;
}

async function ownedRun(directory) {
  await physicalDirectory(directory);
  const file = path.join(directory, "run-owner.json"), info = await lstat(file);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("invalid run owner");
  const owner = JSON.parse(await readFile(file, "utf8"));
  if (owner.owner !== OWNER || owner.runId !== path.basename(directory)) throw new Error("unknown run owner");
}

function cleanError(error, secrets) {
  let text = String(error?.stack ?? error);
  for (const secret of secrets.filter(Boolean)) text = text.split(secret).join("<REDACTED>");
  return text;
}

export async function runLoggedCommand(command, args, { cwd, env, logFile, secrets = [] }) {
  const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let outputError, spawnError;
  const output = async (stream) => {
    try {
      for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
        // Keep draining after a log failure. The owning build process must finish its own children
        // before this function can return and the cycle can release its lock.
        if (!outputError) try { await appendFile(logFile, cleanError(line, secrets) + "\n"); } catch (error) { outputError = error; }
      }
    } catch (error) { outputError ??= error; }
  };
  const closed = new Promise((resolve) => {
    child.once("error", (error) => { spawnError = error; });
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const [, , status] = await Promise.all([output(child.stdout), output(child.stderr), closed]);
  if (spawnError) throw spawnError;
  if (outputError) throw outputError;
  if (status.code !== 0) throw new Error("stage command failed (" + (status.signal ?? status.code) + "); see " + path.basename(logFile));
}

function defaultAdapters(configuration, context) {
  const safeEnvironment = { ...process.env, AIHOT_STATIC_BUILD: "0", AIHOT_CREDENTIALS_DIR: path.join(configuration.workDirectory, "no-credentials"), MODEL_CALLS_ENABLED: "false", COLLECT_ENABLED: "false", FEISHU_INTERNAL_ENABLED: "false", FEISHU_CONTENT_PUSH_ENABLED: "false", INDEXNOW_SUBMIT_ENABLED: "false", ALLOW_PRIVATE_NETWORK_FETCH: "false" };
  return {
    async exportStation(slug, snapshot, logFile) {
      const station = configuration.stations[slug], database = process.env[station.databaseEnv];
      if (!database || !/^postgres(?:ql)?:$/.test(new URL(database).protocol)) throw new Error("missing explicit database environment: " + station.databaseEnv);
      context.secrets.push(database);
      const args = ["--max-old-space-size=192", "scripts/export-static.ts", "--station", slug, "--out", snapshot, "--database-url", database, "--site-url", PUBLIC_SITE_URL + "/" + slug, "--max-items", String(station.maxItems), "--cache-dir", path.join(configuration.workDirectory, "cache", slug)];
      if (station.retainScoreAtLeast !== undefined) args.push("--retain-score-at-least", String(station.retainScoreAtLeast));
      if (station.assetsDirectory) args.push("--assets-dir", station.assetsDirectory);
      await runLoggedCommand(process.execPath, args, { cwd: station.root, env: safeEnvironment, logFile, secrets: context.secrets });
    },
    async buildStation(slug, snapshot, destination, logFile) {
      const station = configuration.stations[slug], web = path.join(station.root, "apps/web"), client = path.join(web, "build-static/client");
      await physicalDirectory(path.dirname(client), true);
      if (await exists(client)) {
        const preserved = path.join(configuration.workDirectory, "preserved-builds");
        await physicalDirectory(client);
        await physicalDirectory(preserved, true);
        await rename(client, path.join(preserved, context.runId + "-" + slug));
      }
      const env = { ...safeEnvironment, AIHOT_STATIC_BUILD: "1", AIHOT_STATIC_STATION: slug, AIHOT_STATIC_DATA: snapshot, AIHOT_STATIC_URL: PUBLIC_SITE_URL + "/" + slug };
      await runLoggedCommand(process.execPath, ["--max-old-space-size=192", "../../scripts/build-static.ts"], { cwd: web, env, logFile, secrets: context.secrets });
      await rename(client, destination);
    },
    compose: composeStaticSites,
    publish: (candidate, transport, onPrepared) => publishCandidate(candidate, configuration.publisher, configuration.workDirectory, { transport, onPrepared }),
    confirm: (candidate) => confirmPublication(candidate, configuration.publisher),
  };
}

async function pruneSuccessfulRuns(configuration, state) {
  const runs = path.join(configuration.workDirectory, "runs"), protectedRuns = new Set();
  await physicalDirectory(runs);
  for (const candidate of [state.lastGenerated, state.lastConfirmed, state.pending?.candidate]) if (candidate?.directory) protectedRuns.add(candidateRun(configuration.workDirectory, candidate));
  // Reused station artifacts live inside older runs; deleting those runs would silently discard the
  // only copy of a station the next round is allowed to reuse.
  for (const entry of Object.values(state.stationBuilds ?? {})) {
    if (typeof entry?.directory !== "string") continue;
    const directory = path.resolve(entry.directory), relative = path.relative(runs, directory);
    if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) continue;
    const parts = relative.split(path.sep);
    if (parts.length !== 3 || parts[1] !== "combined") continue;
    protectedRuns.add(path.join(runs, parts[0]));
  }
  const generated = [], unchanged = [];
  for (const entry of await readdir(runs, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const directory = inside(runs, path.join(runs, entry.name));
    try {
      await ownedRun(directory);
      if (await exists(path.join(directory, "failure.json"))) continue;
      const resultInfo = await lstat(path.join(directory, "result.json"));
      if (resultInfo.isSymbolicLink() || !resultInfo.isFile()) continue;
      const result = JSON.parse(await readFile(path.join(directory, "result.json"), "utf8"));
      if (!["ready", "unchanged", "confirmed", "pending"].includes(result.status) || !Number.isFinite(Date.parse(result.finishedAt))) continue;
      if (result.changed === true && result.directory === path.join(directory, "combined")) generated.push({ directory, finishedAt: result.finishedAt });
      else if (result.changed === false && !(await exists(path.join(directory, "combined")))) unchanged.push({ directory, finishedAt: result.finishedAt });
    } catch { /* Unknown and failed runs are preserved. */ }
  }
  for (const successes of [generated, unchanged]) {
    successes.sort((a, b) => String(b.finishedAt).localeCompare(String(a.finishedAt)));
    for (const item of successes.slice(configuration.keepSuccessfulRuns ?? 2)) {
      if (protectedRuns.has(item.directory)) continue;
      if (path.dirname(item.directory) !== runs) throw new Error("unsafe derived-run cleanup target");
      await ownedRun(item.directory);
      if (await exists(path.join(item.directory, "failure.json"))) continue;
      await staticInventory(item.directory); // Refuse any newly inserted link before recursive cleanup.
      await rm(item.directory, { recursive: true });
    }
  }
}

async function publicationDirectory(work, transport) {
  const root = path.join(work, "publications"), directory = inside(root, transport.directory);
  if (path.dirname(directory) !== root) throw new Error("invalid publication directory");
  await physicalDirectory(directory);
  const ownerFile = path.join(directory, "publication-owner.json"), ownerInfo = await lstat(ownerFile);
  if (ownerInfo.isSymbolicLink() || !ownerInfo.isFile()) throw new Error("invalid publication owner");
  const owner = JSON.parse(await readFile(ownerFile, "utf8"));
  if (owner.schemaVersion !== 1 || owner.owner !== OWNER || owner.publicationId !== path.basename(directory)) throw new Error("unknown publication owner");
  return directory;
}

async function recordConfirmation(work, transport, confirmedAt) {
  if (!transport) return;
  const directory = await publicationDirectory(work, transport), file = path.join(directory, "confirmation.json");
  const receipt = { schemaVersion: 1, markerHash: transport.markerHash, commit: transport.commit, confirmedAt };
  const info = await exists(file);
  if (info) {
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("invalid publication receipt");
    const previous = JSON.parse(await readFile(file, "utf8"));
    if (previous.schemaVersion !== 1 || previous.markerHash !== receipt.markerHash || previous.commit !== receipt.commit) throw new Error("publication receipt changed");
  } else await writeFile(file, JSON.stringify(receipt), { flag: "wx" });
}

async function pruneConfirmedPublications(configuration, state) {
  const root = path.join(configuration.workDirectory, "publications");
  if (!await exists(root)) return;
  await physicalDirectory(root);
  const successes = [], protectedDirectories = new Set([state.pending?.transport?.directory, state.lastConfirmed?.publicationDirectory].filter(Boolean).map((file) => inside(root, file)));
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const directory = inside(root, path.join(root, entry.name));
    try {
      await publicationDirectory(configuration.workDirectory, { directory });
      if (await exists(path.join(directory, "failure.json"))) continue;
      for (const name of ["confirmation.json", "transport.json"]) {
        const info = await lstat(path.join(directory, name));
        if (info.isSymbolicLink() || !info.isFile()) throw new Error("unknown publication record");
      }
      const confirmed = JSON.parse(await readFile(path.join(directory, "confirmation.json"), "utf8"));
      const transport = JSON.parse(await readFile(path.join(directory, "transport.json"), "utf8"));
      if (confirmed.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(confirmed.markerHash ?? "") || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(confirmed.commit ?? "") || !Number.isFinite(Date.parse(confirmed.confirmedAt))
        || transport.directory !== directory || transport.markerHash !== confirmed.markerHash || transport.commit !== confirmed.commit) continue;
      successes.push({ directory, finishedAt: confirmed.confirmedAt });
    } catch { /* Unconfirmed, failed and unknown transports must survive. */ }
  }
  successes.sort((a, b) => String(b.finishedAt).localeCompare(String(a.finishedAt)));
  for (const item of successes.slice(configuration.keepSuccessfulRuns ?? 2)) {
    if (protectedDirectories.has(item.directory)) continue;
    await publicationDirectory(configuration.workDirectory, { directory: item.directory });
    if (await exists(path.join(item.directory, "failure.json"))) continue;
    await staticInventory(item.directory);
    await rm(item.directory, { recursive: true });
  }
}

export async function runStaticCycle(input, options = {}) {
  const configuration = validateCycleConfiguration(input), work = path.resolve(configuration.workDirectory);
  if (options.publishOnly && !options.publish) throw new Error("publish-only requires explicit publish mode");
  await ownedWorkspace(work);
  const lock = await acquireLock(work);
  if (!lock) return { status: "busy", exitCode: 75 };
  const now = options.now ?? (() => new Date());
  let runDirectory, result;
  const context = { runId: randomUUID(), secrets: [] };
  try {
    const slot = slotFor(now());
    const state = await readState(work), adapters = { ...defaultAdapters(configuration, context), ...options.adapters };
    const checkedCandidate = async (candidate) => {
      await ownedRun(candidateRun(work, candidate));
      const verified = await validateCombinedRelease(candidate.directory);
      if (verified.markerHash !== candidate.markerHash) throw new Error("stored candidate changed");
      if (verified.totalBytes > configuration.budgetBytes) throw new Error("stored candidate exceeds the configured combined budget");
      return { ...candidate, ...verified };
    };
    const maintain = async () => {
      await pruneSuccessfulRuns(configuration, state);
      await pruneConfirmedPublications(configuration, state);
    };
    const acceptConfirmation = async (candidate, commit) => {
      const transport = state.pending?.transport, confirmedAt = now().toISOString();
      await recordConfirmation(work, transport, confirmedAt);
      state.lastConfirmed = { ...candidate, ...(commit ? { commit } : {}), ...(transport ? { publicationDirectory: transport.directory } : {}), confirmedAt };
      delete state.pending;
      await atomicWriteState(work, state);
    };
    const publish = async (candidate) => {
      const verified = await checkedCandidate(candidate);
      if (state.lastConfirmed?.markerHash === verified.markerHash) return "confirmed";
      if (state.pending && state.pending.candidate.markerHash !== verified.markerHash) throw new Error("another publication is pending");
      if (state.pending && await adapters.confirm(verified)) {
        await acceptConfirmation(candidate, state.pending.transport?.commit ?? state.pending.commit);
        return "confirmed";
      }
      state.pending ??= { status: "preparing", candidate };
      await atomicWriteState(work, state);
      const sent = await adapters.publish(verified, state.pending.transport ?? null, async (transport) => {
        if (transport.markerHash !== candidate.markerHash || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(transport.commit ?? "")) throw new Error("invalid prepared transport");
        await publicationDirectory(work, transport);
        state.pending = { status: "prepared", candidate, transport }; await atomicWriteState(work, state);
      });
      if (!state.pending.transport || sent.commit !== state.pending.transport.commit) throw new Error("publication completed without a durable matching transport");
      state.pending.status = "pushed"; state.pending.commit = sent.commit;
      await atomicWriteState(work, state);
      if (!await adapters.confirm(verified)) return "pending";
      await acceptConfirmation(candidate, sent.commit);
      return "confirmed";
    };
    // A pending publication of an older candidate can be confirmed first; only then may the
    // current candidate be pushed. Generation is never blocked by an unconfirmed receipt.
    const publishWithPending = async (candidate) => {
      if (state.pending && state.pending.candidate.markerHash !== candidate.markerHash) {
        const prior = await publish(state.pending.candidate);
        if (prior !== "confirmed") return "publication-pending";
      }
      return publish(candidate);
    };
    if (state.pending && options.publishOnly) {
      const status = await publish(state.pending.candidate);
      if (status === "confirmed") await maintain();
      return { status, exitCode: status === "pending" ? 2 : 0 };
    }
    if (state.pending && !options.publish) return { status: "publication-pending", exitCode: 2, markerHash: state.pending.candidate.markerHash };
    // A previous publication still waiting for its remote receipt must not block today's content:
    // generation proceeds, and only an exactly matching candidate is published afterwards.
    let pendingPublication = state.pending ? state.pending.candidate.markerHash : null;
    if (options.publishOnly) {
      if (!state.lastGenerated) throw new Error("no complete generated candidate exists");
      const status = await publish(state.lastGenerated);
      if (status === "confirmed") await maintain();
      return { status, exitCode: status === "pending" ? 2 : 0 };
    }
    if (options.scheduled && state.lastCheckedSlot === slot) {
      if (options.publish && state.lastGenerated && state.lastConfirmed?.markerHash !== state.lastGenerated.markerHash) {
        const status = await publishWithPending(state.lastGenerated);
        if (status === "confirmed") await maintain();
        return { status, slot, exitCode: status === "pending" ? 2 : 0 };
      }
      return { status: "already-checked", slot, exitCode: 0 };
    }
    // A failed attempt still belongs to this slot. Without it a ten-minute cron retries the same
    // slot forever and one broken round can occupy the phone for hours.
    if (options.scheduled && state.lastAttemptSlot === slot) {
      const attempts = state.slotAttempts ?? 0;
      const age = now().getTime() - Date.parse(state.lastAttemptAt ?? 0);
      if (attempts >= MAX_SLOT_ATTEMPTS) return { status: "slot-attempts-exhausted", slot, exitCode: 0 };
      if (Number.isFinite(age) && age >= 0 && age < RETRY_COOLDOWN_MS) return { status: "retry-cooldown", slot, exitCode: 0 };
    }
    // Starting a four-station round with a few minutes left in the slot only guarantees an
    // overrun into the next one; wait for the boundary instead.
    if (options.scheduled && state.lastAttemptSlot !== slot && now().getTime() % SLOT_MS > SLOT_MS - SLOT_START_MARGIN_MS) {
      return { status: "slot-too-late-to-start", slot, exitCode: 0 };
    }
    const attemptCount = options.scheduled && state.lastAttemptSlot === slot ? (state.slotAttempts ?? 0) : 0;
    if (options.scheduled) {
      state.lastAttemptSlot = slot; state.slotAttempts = attemptCount + 1; state.lastAttemptAt = now().toISOString();
      await atomicWriteState(work, state);
    }
    const disk = await statfs(work);
    if (Number(disk.bavail) * Number(disk.bsize) < configuration.budgetBytes * 3) throw new Error("insufficient staging disk space; existing versions preserved");
    runDirectory = inside(path.join(work, "runs"), path.join(work, "runs", context.runId));
    await physicalDirectory(path.dirname(runDirectory), true);
    await mkdir(path.join(runDirectory, "snapshots"), { recursive: true });
    await mkdir(path.join(runDirectory, "sites"));
    await writeFile(path.join(runDirectory, "run-owner.json"), JSON.stringify({ owner: OWNER, runId: context.runId }), { flag: "wx" });
    const sources = {}, snapshots = {}, fingerprints = {};
    const phases = {};
    let phaseStart = now().getTime();
    for (const slug of STATIONS) {
      sources[slug] = await fingerprintSources(configuration.stations[slug].root);
      snapshots[slug] = path.join(runDirectory, "snapshots", slug);
      await adapters.exportStation(slug, snapshots[slug], path.join(runDirectory, "export-" + slug + ".log"));
      fingerprints[slug] = await fingerprintSnapshot(snapshots[slug], slug);
      phases["export-" + slug] = Math.round((now().getTime() - phaseStart) / 1000); phaseStart = now().getTime();
    }
    // buildTool is part of the round fingerprint: a runtime upgrade must not be mistaken for
    // "nothing changed" just because every snapshot and source tree is byte-identical.
    const fingerprint = digest(JSON.stringify({ sources, fingerprints, buildTool: BUILD_TOOL, siteUrl: PUBLIC_SITE_URL, budgetBytes: configuration.budgetBytes, limits: STATIONS.map((slug) => ({ maxItems: configuration.stations[slug].maxItems, retainScoreAtLeast: configuration.stations[slug].retainScoreAtLeast ?? null })) }));
    // A station whose exported snapshot is byte-identical to the one already published keeps its
    // existing build. Compose re-verifies every reused file against its own release marker, so a
    // stale or tampered artifact fails the round instead of shipping.
    const reusableStation = async (slug) => {
      const record = state.stationBuilds?.[slug];
      // Both halves matter: the snapshot decides the content, the source tree decides the code that
      // renders it. Reusing a build across a source change would ship stale templates.
      if (!record || record.fingerprint !== fingerprints[slug] || record.sourceFingerprint !== sources[slug]
        || record.buildTool !== BUILD_TOOL || typeof record.directory !== "string") return null;
      const directory = path.resolve(record.directory), runs = path.join(work, "runs");
      const relative = path.relative(runs, directory);
      if (!relative || relative.startsWith(".." + path.sep) || relative === ".." || path.isAbsolute(relative)) return null;
      if (path.basename(directory) !== slug || path.basename(path.dirname(directory)) !== "combined") return null;
      // Resolve one level up as well: a reused artifact must stay a plain directory inside this run
      // tree, never a link that compose would happily hash from somewhere else.
      try {
        const info = await lstat(directory);
        if (info.isSymbolicLink() || !info.isDirectory()) return null;
      } catch { return null; }
      if (!await exists(path.join(directory, "static-release.json"))) return null;
      // The stored fingerprint is only a hint: recompute it from the artifact itself so a swapped-in
      // older build, or a self-consistent forgery, cannot satisfy the current snapshot. Hashing the
      // data directory costs seconds; rebuilding the station costs tens of minutes.
      try {
        if (await fingerprintSnapshot(path.join(directory, "data"), slug) !== fingerprints[slug]) return null;
      } catch { return null; }
      return directory;
    };
    let candidate, changed = state.lastGenerated?.fingerprint !== fingerprint;
    let reusedStations = [];
    if (!changed) { await checkedCandidate(state.lastGenerated); candidate = state.lastGenerated; }
    else {
      const sites = {};
      const reused = [];
      for (const slug of STATIONS) {
        const reusable = await reusableStation(slug);
        if (reusable) { sites[slug] = reusable; reused.push(slug); phases["build-" + slug] = 0; }
        else {
          sites[slug] = path.join(runDirectory, "sites", slug);
          await adapters.buildStation(slug, snapshots[slug], sites[slug], path.join(runDirectory, "build-" + slug + ".log"));
          phases["build-" + slug] = Math.round((now().getTime() - phaseStart) / 1000); phaseStart = now().getTime();
        }
        // Fail on a source change as soon as the affected station is built instead of hours later.
        if (await fingerprintSources(configuration.stations[slug].root) !== sources[slug]) throw new Error("source changed during cycle: " + slug);
      }
      const directory = path.join(runDirectory, "combined");
      await adapters.compose(sites, directory, PUBLIC_SITE_URL, configuration.budgetBytes);
      phases.compose = Math.round((now().getTime() - phaseStart) / 1000); phaseStart = now().getTime();
      const verified = await validateCombinedRelease(directory);
      phases.validate = Math.round((now().getTime() - phaseStart) / 1000);
      reusedStations = [...reused];
      state.stationBuilds = Object.fromEntries(STATIONS.map((slug) => [slug, { fingerprint: fingerprints[slug], sourceFingerprint: sources[slug], buildTool: BUILD_TOOL, directory: path.join(directory, slug) }]));
      candidate = { directory, fingerprint, markerHash: verified.markerHash, totalBytes: verified.totalBytes, generatedAt: now().toISOString() };
    }
    for (const slug of STATIONS) if (await fingerprintSources(configuration.stations[slug].root) !== sources[slug]) throw new Error("source changed during cycle: " + slug);
    // A round that overruns into the next slot also counts as that slot's check: otherwise the
    // ten-minute cron would start another multi-hour round the moment this one ends. Ending with
    // less than SLOT_START_MARGIN_MS left in the slot consumes the following slot as well, since a
    // full four-station round cannot finish in the remaining minutes.
    const finishSlot = slotFor(now());
    const msIntoSlot = now().getTime() % SLOT_MS;
    const nextSlotIfTooLate = msIntoSlot > SLOT_MS - SLOT_START_MARGIN_MS ? finishSlot + 1 : finishSlot;
    state.lastGenerated = candidate; state.lastCheckedSlot = Math.max(slot, nextSlotIfTooLate); state.lastCheckedAt = now().toISOString();
    delete state.lastAttemptSlot; delete state.slotAttempts; delete state.lastAttemptAt;
    await atomicWriteState(work, state);
    const status = options.publish ? await publishWithPending(candidate) : changed ? "ready" : "unchanged";
    if (options.publish) phases.publish = Math.round((now().getTime() - phaseStart) / 1000);
    result = { status, slot, changed, markerHash: candidate.markerHash, directory: candidate.directory, totalBytes: candidate.totalBytes, exitCode: status === "pending" ? 2 : 0, finishedAt: now().toISOString(),
      phases,
      ...(reusedStations.length ? { reusedStations } : {}),
      // Generation was not blocked by an older unconfirmed publication.
      ...(pendingPublication && pendingPublication !== candidate.markerHash ? { previousPublicationPending: true } : {}) };
    await writeFile(path.join(runDirectory, "result.json"), JSON.stringify(result), { flag: "wx" });
    // Only successful, self-created intermediates are redundant; final data lives inside combined.
    for (const name of ["snapshots", "sites"]) await rm(inside(runDirectory, path.join(runDirectory, name)), { recursive: true });
    await maintain();
    return result;
  } catch (error) {
    if (runDirectory) await writeFile(path.join(runDirectory, "failure.json"), JSON.stringify({ status: "failed", error: cleanError(error, context.secrets), finishedAt: now().toISOString() }), { flag: "wx" }).catch(() => {});
    throw new Error(cleanError(error, context.secrets));
  } finally { await lock.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { config: { type: "string" }, scheduled: { type: "boolean" }, publish: { type: "boolean" }, "publish-only": { type: "boolean" } } });
  if (!values.config) throw new Error("--config <explicit configuration file> required; default mode generates only");
  const configuration = JSON.parse(await readFile(path.resolve(values.config), "utf8"));
  const result = await runStaticCycle(configuration, { scheduled: values.scheduled, publish: values.publish, publishOnly: values["publish-only"] });
  console.log(JSON.stringify(result)); process.exitCode = result.exitCode;
}
