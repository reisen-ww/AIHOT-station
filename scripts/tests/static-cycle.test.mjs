import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runStaticCycle, runLoggedCommand, validateCycleConfiguration } from '../static-cycle.mjs';
import { atomicWriteState, readState, STATIONS } from '../static-runner-core.mjs';
import { put, sealRunnerStation, writeRunnerSnapshot } from './helpers/static-runner-fixture.mjs';

const json = async (file) => JSON.parse(await readFile(file, 'utf8'));
const missing = async (file) => { try { await lstat(file); return false; } catch (error) { if (error.code === 'ENOENT') return true; throw error; } };
async function setup(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'hot-cycle-test-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('hot-cycle-test-'));
    await rm(root, { recursive: true, force: true });
  });
  const configuration = { schemaVersion: 1, workDirectory: path.join(root, 'work'), budgetBytes: 1_000_000, keepSuccessfulRuns: 2, stations: {} };
  for (const slug of STATIONS) {
    const source = path.join(root, 'sources', slug);
    await put(source, 'site/site.ts', 'export const station = ' + JSON.stringify(slug));
    configuration.stations[slug] = { root: source, databaseEnv: slug.toUpperCase() + '_STATIC_TEST_DB', maxItems: 1000 };
  }
  const control = { content: 0, envelope: 0, exports: [], builds: [], pushes: [], confirmations: 0, remoteReady: false, failPush: false };
  const adapters = {
    async exportStation(slug, snapshot) {
      control.exports.push(slug);
      await writeRunnerSnapshot(snapshot, slug, (fixture) => {
        fixture.manifest.revision = fixture.catalog.revision = 'cycle-fixture-' + (++control.envelope);
        fixture.manifest.asOf = fixture.catalog.asOf = new Date(Date.UTC(2026, 10, 10, 0, 0, control.envelope)).toISOString();
        fixture.data.get('meta').notice = 'synthetic content version ' + control.content;
      });
    },
    async buildStation(slug, snapshot, destination) {
      control.builds.push(slug);
      await cp(snapshot, path.join(destination, 'data'), { recursive: true });
      const manifest = await json(path.join(snapshot, 'manifest.json'));
      const url = 'https://reisen-ww.github.io/hot-pages/' + slug;
      await put(destination, 'index.html', '<html><head><meta name="static-revision" content="' + manifest.revision + '"/><link rel="canonical" href="' + url + '/"/><meta property="og:url" content="' + url + '/"/></head><script src="/hot-pages/' + slug + '/assets/main.js"></script></html>');
      await put(destination, '404.html', '<html>synthetic history shell</html>');
      await put(destination, 'assets/main.js', '/* synthetic build */');
      await sealRunnerStation(destination, slug);
    },
    async publish(candidate, existing, onPrepared) {
      let transport = existing;
      if (!transport) {
        const id = randomUUID(), directory = path.join(configuration.workDirectory, 'publications', id);
        await mkdir(directory, { recursive: true });
        await put(directory, 'publication-owner.json', JSON.stringify({ schemaVersion: 1, owner: 'hot-pages-static-cycle', publicationId: id, createdAt: '2026-11-10T00:00:00Z' }));
        transport = { directory, markerHash: candidate.markerHash, commit: candidate.markerHash.slice(0, 40) };
        await put(directory, 'transport.json', JSON.stringify(transport));
        await onPrepared(transport);
      }
      const durable = await readState(configuration.workDirectory);
      assert.equal(durable.pending.transport.commit, transport.commit, 'commit must already be durable before the fake push');
      assert.equal(durable.pending.candidate.markerHash, candidate.markerHash);
      control.pushes.push(transport.commit);
      if (control.failPush) throw new Error('synthetic push failure');
      return { commit: transport.commit };
    },
    async confirm() { control.confirmations++; return control.remoteReady; },
  };
  let time = new Date('2026-11-10T00:00:00Z');
  const options = { adapters, now: () => time };
  return { root, configuration, control, adapters, options, tick: () => { time = new Date(time.getTime() + 2 * 60 * 60 * 1000); } };
}

test('default generation never publishes; unchanged envelopes reuse the exact release; real source changes rebuild', async (t) => {
  const f = await setup(t);
  const first = await runStaticCycle(f.configuration, f.options);
  assert.equal(first.status, 'ready'); assert.equal(first.changed, true);
  assert.deepEqual(f.control.builds, STATIONS);
  let state = await readState(f.configuration.workDirectory);
  assert.equal(state.lastGenerated.directory, first.directory);
  assert.equal(state.lastConfirmed, undefined); assert.equal(state.pending, undefined);
  const manifest = await readFile(path.join(first.directory, 'aihot/data/manifest.json'));
  f.tick();
  const unchanged = await runStaticCycle(f.configuration, f.options);
  assert.equal(unchanged.status, 'unchanged'); assert.equal(unchanged.directory, first.directory);
  assert.deepEqual(await readFile(path.join(first.directory, 'aihot/data/manifest.json')), manifest);
  assert.equal(f.control.exports.length, 8); assert.equal(f.control.builds.length, 4); assert.equal(f.control.pushes.length, 0);
  await put(f.configuration.stations.aihot.root, 'site/site.ts', 'export const changed = true');
  f.tick();
  const changed = await runStaticCycle(f.configuration, f.options);
  assert.equal(changed.changed, true); assert.notEqual(changed.directory, first.directory);
  assert.equal(f.control.builds.length, 8);
  state = await readState(f.configuration.workDirectory);
  assert.equal(state.lastConfirmed, undefined);
});

test('score retention is explicit and a changed threshold invalidates an otherwise identical release', async (t) => {
  const f = await setup(t);
  for (const retainScoreAtLeast of [-1, 101, NaN, null, '85']) {
    const stations = { ...f.configuration.stations, cryptohot: { ...f.configuration.stations.cryptohot, retainScoreAtLeast } };
    assert.throws(() => validateCycleConfiguration({ ...f.configuration, stations }), /score|configuration/);
  }
  for (const retainScoreAtLeast of [0, 85.5, 100]) {
    const stations = { ...f.configuration.stations, cryptohot: { ...f.configuration.stations.cryptohot, retainScoreAtLeast } };
    assert.doesNotThrow(() => validateCycleConfiguration({ ...f.configuration, stations }));
  }
  const first = await runStaticCycle(f.configuration, f.options);
  f.configuration.stations.cryptohot.retainScoreAtLeast = 85;
  f.tick();
  const changed = await runStaticCycle(f.configuration, f.options);
  assert.equal(changed.changed, true); assert.notEqual(changed.directory, first.directory);
  f.tick();
  assert.equal((await runStaticCycle(f.configuration, f.options)).status, 'unchanged');
  f.configuration.stations.cryptohot.retainScoreAtLeast = 80;
  f.tick();
  assert.equal((await runStaticCycle(f.configuration, f.options)).changed, true);
  assert.equal(f.control.builds.length, 12); assert.equal(f.control.pushes.length, 0);
});

test('overlapping cycles are busy, missing lock owners are never stolen, and same-slot scheduled calls skip exports', async (t) => {
  const f = await setup(t), original = f.adapters.exportStation;
  let entered, proceed;
  const started = new Promise((resolve) => { entered = resolve; }), wait = new Promise((resolve) => { proceed = resolve; });
  f.adapters.exportStation = async (...args) => { if (!f.control.exports.length) { entered(); await wait; } return original(...args); };
  const running = runStaticCycle(f.configuration, f.options);
  await started;
  assert.deepEqual(await runStaticCycle(f.configuration, f.options), { status: 'busy', exitCode: 75 });
  proceed(); await running;
  assert.equal((await runStaticCycle(f.configuration, { ...f.options, scheduled: true })).status, 'already-checked');
  assert.equal(f.control.exports.length, 4);
  const lock = path.join(f.configuration.workDirectory, 'cycle.lock'); await mkdir(lock);
  assert.equal((await runStaticCycle(f.configuration, f.options)).status, 'busy');
  assert.equal(await missing(path.join(lock, 'owner.json')), true);
});

test('export errors, source drift and corrupted reuse preserve the previous complete candidate and failures', async (t) => {
  const f = await setup(t), first = await runStaticCycle(f.configuration, f.options);
  const exportStation = f.adapters.exportStation;
  f.adapters.exportStation = async (...args) => { if (args[0] === 'cryptohot') throw new Error('synthetic export failure'); return exportStation(...args); };
  await assert.rejects(runStaticCycle(f.configuration, f.options), /synthetic export/);
  assert.equal((await readState(f.configuration.workDirectory)).lastGenerated.directory, first.directory);
  f.adapters.exportStation = exportStation; f.control.content++;
  const buildStation = f.adapters.buildStation;
  f.adapters.buildStation = async (...args) => {
    await buildStation(...args);
    if (args[0] === 'openhot') await put(f.configuration.stations.aihot.root, 'site/drift.ts', 'export const drift = true');
  };
  await assert.rejects(runStaticCycle(f.configuration, f.options), /source changed during cycle/);
  assert.equal((await readState(f.configuration.workDirectory)).lastGenerated.directory, first.directory);
  f.adapters.buildStation = buildStation;
  const second = await runStaticCycle(f.configuration, f.options);
  await writeFile(path.join(second.directory, 'aihot/assets/main.js'), 'tampered');
  await assert.rejects(runStaticCycle(f.configuration, f.options), /checksum/);
  const runs = path.join(f.configuration.workDirectory, 'runs');
  let failures = 0;
  for (const name of await readdir(runs)) if (!await missing(path.join(runs, name, 'failure.json'))) failures++;
  assert.equal(failures, 3);
  assert.equal(await missing(path.join(f.configuration.workDirectory, 'cycle.lock')), true);
});

test('only exact remote confirmation advances lastConfirmed; retries keep the durable commit and block generation', async (t) => {
  const f = await setup(t);
  const pending = await runStaticCycle(f.configuration, { ...f.options, publish: true });
  assert.equal(pending.status, 'pending');
  let state = await readState(f.configuration.workDirectory);
  assert.equal(state.lastConfirmed, undefined); assert.equal(state.pending.status, 'pushed');
  const commit = state.pending.transport.commit, publication = state.pending.transport.directory;
  assert.equal((await runStaticCycle(f.configuration, f.options)).status, 'publication-pending');
  assert.equal(f.control.exports.length, 4);
  f.control.remoteReady = true;
  const confirmed = await runStaticCycle(f.configuration, { ...f.options, publish: true, publishOnly: true });
  assert.equal(confirmed.status, 'confirmed'); assert.deepEqual(f.control.pushes, [commit]);
  state = await readState(f.configuration.workDirectory);
  assert.equal(state.lastConfirmed.commit, commit); assert.equal(state.pending, undefined);
  assert.equal((await json(path.join(publication, 'confirmation.json'))).commit, commit);
  assert.equal(f.control.exports.length, 4);
});

test('a failed push retains prepared transport, then retry uses the same commit without another build', async (t) => {
  const f = await setup(t); f.control.failPush = true;
  await assert.rejects(runStaticCycle(f.configuration, { ...f.options, publish: true }), /synthetic push/);
  let state = await readState(f.configuration.workDirectory);
  const commit = state.pending.transport.commit;
  assert.equal(state.lastConfirmed, undefined);
  f.control.failPush = false;
  f.adapters.confirm = async () => f.control.pushes.length >= 2;
  assert.equal((await runStaticCycle(f.configuration, { ...f.options, publish: true, publishOnly: true })).status, 'confirmed');
  assert.deepEqual(f.control.pushes, [commit, commit]); assert.equal(f.control.builds.length, 4);
  state = await readState(f.configuration.workDirectory);
  assert.equal(state.pending, undefined);
  assert.equal(await missing(path.join(path.dirname(state.lastGenerated.directory), 'failure.json')), false);
});

test('unchanged logs never displace two complete generations; failed and unknown directories and confirmed references survive', async (t) => {
  const f = await setup(t), first = await runStaticCycle(f.configuration, f.options);
  const runs = path.join(f.configuration.workDirectory, 'runs');
  const failed = path.join(runs, 'owned-failed'), unknown = path.join(runs, 'unknown');
  await put(failed, 'run-owner.json', JSON.stringify({ owner: 'hot-pages-static-cycle', runId: 'owned-failed' }));
  await put(failed, 'result.json', JSON.stringify({ status: 'ready', changed: true, directory: path.join(failed, 'combined'), finishedAt: '2025-01-01T00:00:00Z' }));
  await put(failed, 'failure.json', '{}'); await put(unknown, 'original.txt', 'preserve');
  let state = await readState(f.configuration.workDirectory); state.lastConfirmed = { ...state.lastGenerated, confirmedAt: '2026-11-10T00:00:00Z' };
  await atomicWriteState(f.configuration.workDirectory, state);
  f.tick(); f.control.content++; const second = await runStaticCycle(f.configuration, f.options);
  f.tick(); f.control.content++; const third = await runStaticCycle(f.configuration, f.options);
  for (let i = 0; i < 4; i++) { f.tick(); assert.equal((await runStaticCycle(f.configuration, f.options)).status, 'unchanged'); }
  for (const directory of [first.directory, second.directory, third.directory, failed, unknown]) assert.equal(await missing(directory), false, directory);
  state = await readState(f.configuration.workDirectory); delete state.lastConfirmed;
  await atomicWriteState(f.configuration.workDirectory, state); f.tick(); await runStaticCycle(f.configuration, f.options);
  assert.equal(await missing(first.directory), true);
  for (const directory of [second.directory, third.directory, failed, unknown]) assert.equal(await missing(directory), false);
});

test('confirmed transport retention keeps two while preserving unknown and failed publication trees', async (t) => {
  const f = await setup(t); f.control.remoteReady = true;
  const publications = path.join(f.configuration.workDirectory, 'publications');
  await runStaticCycle(f.configuration, { ...f.options, publish: true });
  const old = (await readState(f.configuration.workDirectory)).lastConfirmed.publicationDirectory;
  await put(path.join(publications, 'unknown'), 'original.txt', 'untouched');
  const failed = path.join(publications, 'failed');
  await put(failed, 'publication-owner.json', JSON.stringify({ schemaVersion: 1, owner: 'hot-pages-static-cycle', publicationId: 'failed', createdAt: '2025-01-01T00:00:00Z' }));
  await put(failed, 'transport.json', JSON.stringify({ directory: failed, markerHash: 'a'.repeat(64), commit: 'a'.repeat(40) }));
  await put(failed, 'confirmation.json', JSON.stringify({ schemaVersion: 1, markerHash: 'a'.repeat(64), commit: 'a'.repeat(40), confirmedAt: '2025-01-01T00:00:00Z' }));
  await put(failed, 'failure.json', '{}');
  for (let i = 0; i < 2; i++) { f.tick(); f.control.content++; await runStaticCycle(f.configuration, { ...f.options, publish: true }); }
  assert.equal(await missing(old), true);
  assert.equal(await missing(failed), false); assert.equal(await missing(path.join(publications, 'unknown/original.txt')), false);
  assert.equal((await readdir(publications)).length, 4);
});

test('invalid paths and redirected workspaces fail before side effects; a bad clock still releases its own lock', async (t) => {
  const f = await setup(t);
  assert.throws(() => validateCycleConfiguration({ ...f.configuration, workDirectory: f.configuration.stations.aihot.root }), /outside|overlap/);
  assert.throws(() => validateCycleConfiguration({ ...f.configuration, keepSuccessfulRuns: 1 }), /at least two/);
  await assert.rejects(runStaticCycle(f.configuration, { ...f.options, publishOnly: true }), /requires explicit/);
  await assert.rejects(runStaticCycle(f.configuration, { ...f.options, now: () => new Date('invalid') }), /invalid cycle date/);
  assert.equal(await missing(path.join(f.configuration.workDirectory, 'cycle.lock')), true);
  const outside = path.join(f.root, 'outside'); await mkdir(outside);
  const redirected = path.join(f.root, 'redirected'); await symlink(outside, redirected, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(runStaticCycle({ ...f.configuration, workDirectory: redirected }, f.options), /physical directory/);
  assert.deepEqual(await readdir(outside), []);
});

test('a logging failure waits for its child to finish; stage failures and logged secrets are handled', async (t) => {
  const f = await setup(t), done = path.join(f.root, 'child-finished');
  const script = path.join(f.root, 'child.mjs');
  await writeFile(script, "import { writeFile } from 'node:fs/promises'; console.log('first line'); setTimeout(async()=>{await writeFile(process.argv[2],'finished');console.log('last line');},100);");
  await assert.rejects(runLoggedCommand(process.execPath, [script, done], { cwd: f.root, env: process.env, logFile: f.root }), /EISDIR|EPERM|EACCES/);
  assert.equal(await readFile(done, 'utf8'), 'finished');
  const secret = 'synthetic-database-secret', logFile = path.join(f.root, 'stage.log');
  await assert.rejects(runLoggedCommand(process.execPath, ['-e', "console.log(process.argv[1]);process.exitCode=3", secret], { cwd: f.root, env: process.env, logFile, secrets: [secret] }), /stage command failed/);
  const log = await readFile(logFile, 'utf8'); assert.ok(!log.includes(secret)); assert.ok(log.includes('<REDACTED>'));
});

test('default command adapters pass explicit inputs and closed switches, preserve the first build and move complete outputs', async (t) => {
  const f = await setup(t), helper = new URL('./helpers/static-runner-fixture.mjs', import.meta.url).href;
  f.configuration.stations.cryptohot.retainScoreAtLeast = 85;
  f.configuration.stations.acadhot.retainScoreAtLeast = 0;
  const switches = ['MODEL_CALLS_ENABLED', 'COLLECT_ENABLED', 'FEISHU_INTERNAL_ENABLED', 'FEISHU_CONTENT_PUSH_ENABLED', 'INDEXNOW_SUBMIT_ENABLED', 'ALLOW_PRIVATE_NETWORK_FETCH'];
  const environmentCheck = "import assert from 'node:assert/strict'; for (const key of " + JSON.stringify(switches) + ") assert.equal(process.env[key],'false'); assert.equal(process.env.STATIC_FIXTURE_DOTENV,undefined);";
  const exportScript = environmentCheck + "import { parseArgs } from 'node:util'; import { writeRunnerSnapshot } from " + JSON.stringify(helper) + "; const {values}=parseArgs({options:Object.fromEntries(['station','out','database-url','site-url','max-items','retain-score-at-least','cache-dir','assets-dir'].map(k=>[k,{type:'string'}]))}); assert.equal(values['max-items'],'1000'); assert.equal(values['retain-score-at-least'],values.station==='cryptohot'?'85':values.station==='acadhot'?'0':undefined); assert.equal(values['database-url'],'postgres://synthetic.invalid/isolated_fixture_only'); assert.ok(values['site-url'].endsWith('/'+values.station)); await writeRunnerSnapshot(values.out,values.station);";
  const buildScript = environmentCheck + "import { cp,readFile } from 'node:fs/promises'; import path from 'node:path'; import { put,sealRunnerStation } from " + JSON.stringify(helper) + "; assert.equal(process.env.AIHOT_STATIC_BUILD,'1'); const slug=process.env.AIHOT_STATIC_STATION, snapshot=process.env.AIHOT_STATIC_DATA, destination=path.resolve(import.meta.dirname,'../apps/web/build-static/client'); await cp(snapshot,path.join(destination,'data'),{recursive:true}); const m=JSON.parse(await readFile(path.join(snapshot,'manifest.json'),'utf8')); const url=process.env.AIHOT_STATIC_URL; const html='<meta content='+JSON.stringify(m.revision)+'/><link rel='+JSON.stringify('canonical')+' href='+JSON.stringify(url+'/')+'/><meta property='+JSON.stringify('og:url')+' content='+JSON.stringify(url+'/')+'/><script src='+JSON.stringify('/hot-pages/'+slug+'/assets/main.js')+'></script>'; await put(destination,'index.html',html); await put(destination,'404.html','synthetic history'); await put(destination,'assets/main.js','fixture'); await sealRunnerStation(destination,slug);";
  const oldEnvironment = new Map();
  for (const slug of STATIONS) {
    const station = f.configuration.stations[slug], key = station.databaseEnv;
    oldEnvironment.set(key, process.env[key]); process.env[key] = 'postgres://synthetic.invalid/isolated_fixture_only';
    await put(station.root, 'scripts/export-static.ts', exportScript);
    await put(station.root, 'scripts/build-static.ts', buildScript);
    await put(station.root, '.env', 'STATIC_FIXTURE_DOTENV=must_not_load');
    await put(station.root, 'apps/web/build-static/client/original.txt', 'preserve existing local build');
  }
  t.after(() => { for (const [key, value] of oldEnvironment) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const result = await runStaticCycle(f.configuration, { now: f.options.now });
  assert.equal(result.status, 'ready'); assert.equal(result.changed, true);
  const preserved = path.join(f.configuration.workDirectory, 'preserved-builds');
  assert.equal((await readdir(preserved)).length, 4);
  for (const name of await readdir(preserved)) assert.equal(await readFile(path.join(preserved, name, 'original.txt'), 'utf8'), 'preserve existing local build');
  for (const slug of STATIONS) {
    assert.equal(await missing(path.join(f.configuration.stations[slug].root, 'apps/web/build-static/client')), true);
    assert.equal(await missing(path.join(result.directory, slug, 'static-release.json')), false);
  }
  assert.equal((await readState(f.configuration.workDirectory)).lastConfirmed, undefined);
});
