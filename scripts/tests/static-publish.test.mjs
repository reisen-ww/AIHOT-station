import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { confirmPublication, createGitCommand, publishCandidate } from "../static-publish.mjs";
import { PUBLIC_SITE_URL, STATIONS, validateCombinedRelease } from "../static-runner-core.mjs";
import { staticInventory } from "../static-validate.ts";
import { writeRunnerCombined } from "./helpers/static-runner-fixture.mjs";

const REMOTE = "https://github.com/reisen-ww/hot-pages.git";
const PARENT = "a".repeat(40), EXTERNAL = "b".repeat(40);
const CONFIG = { remote: REMOTE, branch: "main", authorName: "Fixture Publisher", authorEmail: "fixture@example.invalid", confirmationSeconds: 0 };
const MARKER = "static-site-release.json";
const CRITICAL = ["index.html", "404.html", ...STATIONS.flatMap((station) => [station + "/index.html", station + "/data/manifest.json"])];
let fixtureRoot, fixtureCombined;
before(async () => {
  fixtureRoot = await mkdtemp(path.join(tmpdir(), "static-publisher-fixture-"));
  for (const station of STATIONS) await mkdir(path.join(fixtureRoot, station));
  fixtureCombined = await writeRunnerCombined(fixtureRoot);
});
after(async () => { if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true }); });

async function context(t) {
  const root = await mkdtemp(path.join(tmpdir(), "static-publisher-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "candidate");
  await cp(fixtureCombined, directory, { recursive: true });
  return { root, work: path.join(root, "work"), candidate: { directory, ...await validateCombinedRelease(directory) } };
}
const json = async (file) => JSON.parse(await readFile(file, "utf8"));
const count = (git, operation) => git.calls.filter((call) => call.args[0] === operation).length;
async function blobs(directory) {
  const entries = new Map();
  for (const file of await staticInventory(directory)) {
    const bytes = await readFile(path.join(directory, file));
    entries.set(file, { mode: "100644", type: "blob", hash: createHash("sha1").update(Buffer.from("blob " + bytes.length + "\0")).update(bytes).digest("hex") });
  }
  return entries;
}
const sortedEntries = (entries) => [...entries].sort(([a], [b]) => a.localeCompare(b));

// This adapter models only the commands the publisher issues. It never spawns Git.
class FakeGit {
  constructor() {
    this.calls = []; this.repositories = new Map(); this.commits = new Map([[PARENT, { parent: EXTERNAL, entries: new Map([["old-readme.txt", { mode: "100644", type: "blob", hash: "0".repeat(40) }]]) }]]);
    this.remoteHead = PARENT; this.failPushes = 0;
    this.gitCommand = this.command.bind(this);
  }
  async command(prefix, args, allowed) {
    assert.ok(Array.isArray(prefix)); assert.ok(Array.isArray(args)); assert.ok(Array.isArray(allowed));
    this.calls.push({ prefix: [...prefix], args: [...args], allowed: [...allowed] });
    const flag = (name) => prefix[prefix.indexOf(name) + 1];
    if (args[0] === "init") {
      if (this.beforeInit) await this.beforeInit(args);
      const repository = args.at(-1), gitDirectory = path.join(repository, ".git");
      await mkdir(gitDirectory, { recursive: true });
      this.repositories.set(gitDirectory, { head: null, index: new Map(), fetched: null });
      return { code: 0, stdout: "" };
    }
    const gitDirectory = flag("--git-dir"), tree = flag("--work-tree"), repo = this.repositories.get(gitDirectory);
    assert.ok(repo, "only this fake's initialized private repositories are used");
    let stdout = "", code = 0;
    switch (args[0]) {
      case "remote": {
        assert.deepEqual(args, ["remote", "get-url", "origin"]);
        const config = await readFile(path.join(gitDirectory, "config"), "utf8");
        stdout = (this.originOverride ?? /^\s*url = (.+)$/m.exec(config)?.[1]) + "\n";
        break;
      }
      case "fetch": assert.deepEqual(args, ["fetch", "--quiet", "--depth=1", "origin", "main"]); repo.fetched = this.remoteHead; break;
      case "rev-parse": stdout = (args[1] === "--show-object-format" ? "sha1" : args[1] === "FETCH_HEAD" ? repo.fetched : repo.head) + "\n"; break;
      case "symbolic-ref": assert.deepEqual(args, ["symbolic-ref", "HEAD", "refs/heads/main"]); break;
      case "update-ref": assert.equal(args[1], "refs/heads/main"); repo.head = args[2]; break;
      case "read-tree": repo.index = new Map(this.commits.get(args[1]).entries); break;
      case "add": {
        assert.deepEqual(args, ["add", "--all"]);
        repo.index = await blobs(tree);
        break;
      }
      case "diff": {
        assert.deepEqual(args, ["diff", "--cached", "--quiet", "--exit-code"]);
        code = JSON.stringify(sortedEntries(repo.index)) === JSON.stringify(sortedEntries(this.commits.get(repo.head).entries)) ? 0 : 1;
        break;
      }
      case "commit": {
        assert.deepEqual(args.slice(0, 3), ["commit", "--quiet", "-m"]);
        assert.notDeepEqual(sortedEntries(repo.index), sortedEntries(this.commits.get(repo.head).entries), "no empty commits");
        const parent = repo.head;
        repo.head = createHash("sha1").update(parent + JSON.stringify(sortedEntries(repo.index))).digest("hex");
        this.commits.set(repo.head, { parent, entries: new Map(repo.index) });
        break;
      }
      case "rev-list": {
        const commit = args.at(-1), parent = this.wrongParent ? EXTERNAL : this.commits.get(commit).parent;
        stdout = commit + " " + parent + "\n"; break;
      }
      case "ls-tree": {
        const entries = sortedEntries(this.commits.get(args.at(-1)).entries);
        if (this.corruptListing === "missing") entries.pop();
        if (this.corruptListing === "blob") entries[0] = [entries[0][0], { ...entries[0][1], hash: "e".repeat(40) }];
        if (this.corruptListing === "submodule") entries[0] = [entries[0][0], { mode: "160000", type: "commit", hash: "e".repeat(40) }];
        stdout = entries.map(([file, entry]) => entry.mode + " " + entry.type + " " + entry.hash + "\t" + file + "\0").join("");
        if (this.corruptListing === "truncated") stdout = stdout.slice(0, -1);
        break;
      }
      case "ls-remote": assert.deepEqual(args, ["ls-remote", "origin", "refs/heads/main"]); stdout = this.remoteListing ?? this.remoteHead + "\trefs/heads/main\n"; break;
      case "push": {
        assert.deepEqual(args, ["push", "origin", repo.head + ":refs/heads/main"]);
        if (this.beforePush) await this.beforePush();
        if (this.failPushes-- > 0) throw new Error("synthetic-secret-in-git-error");
        assert.equal(this.remoteHead, this.commits.get(repo.head).parent, "only an ordinary fast-forward push is modeled");
        this.remoteHead = repo.head;
        if (this.losePushReceipt) throw new Error("synthetic-secret-after-accepted-push");
        break;
      }
      default: assert.fail("unexpected fake Git command: " + args[0]);
    }
    return { code, stdout };
  }
}
function publish(ctx, git, options = {}, configuration = CONFIG) {
  return publishCandidate(ctx.candidate, configuration, ctx.work, { gitCommand: git.gitCommand, onPrepared: async () => {}, ...options });
}
async function pending(t) {
  const ctx = await context(t), git = new FakeGit(); let transport;
  git.failPushes = 1;
  await assert.rejects(publish(ctx, git, { onPrepared: async (value) => { transport = value; } }), /git push failed/);
  assert.ok(transport);
  return { ...ctx, git, transport };
}

test("publisher fixes the existing hot-pages/main destination and requires durable preparation", async (t) => {
  assert.equal(PUBLIC_SITE_URL, "https://reisen-ww.github.io/hot-pages");
  const ctx = await context(t), git = new FakeGit();
  const invalid = [
    { ...CONFIG, remote: "https://github.com/reisen-ww/reisen-ww.github.io.git" },
    { ...CONFIG, remote: "https://synthetic-user:synthetic-password@github.com/reisen-ww/hot-pages.git" },
    { ...CONFIG, remote: "https://example.invalid/reisen-ww/hot-pages.git" },
    { ...CONFIG, branch: "other" }, { ...CONFIG, authorName: "broken\nidentity" }, { ...CONFIG, confirmationSeconds: 601 },
  ];
  for (const configuration of invalid) {
    await assert.rejects(publish(ctx, git, {}, configuration), (error) => /publisher|timeout/.test(error.message) && !error.stack.includes("synthetic-password"));
  }
  await assert.rejects(publish(ctx, git, { onPrepared: undefined }), /pre-push state callback/);
  assert.equal(git.calls.length, 0);
  assert.deepEqual((await readdir(ctx.root)).sort(), ["candidate"]);
});

test("publisher copies every byte, verifies commit blobs and persists transport before push", async (t) => {
  const ctx = await context(t), git = new FakeGit(); let persisted = false, prepared;
  git.beforeInit = async (args) => {
    const directory = path.dirname(args.at(-1)), owner = await json(path.join(directory, "publication-owner.json"));
    assert.equal(owner.publicationId, path.basename(directory));
    assert.deepEqual(Object.keys(owner).sort(), ["createdAt", "owner", "publicationId", "schemaVersion"]);
    assert.equal(owner.owner, "hot-pages-static-cycle"); assert.equal(owner.schemaVersion, 1);
    assert.equal(new Date(owner.createdAt).toISOString(), owner.createdAt);
  };
  git.beforePush = async () => {
    assert.equal(persisted, true);
    const state = await json(path.join(ctx.work, "fake-pending.json"));
    assert.equal(state.commit, prepared.commit); assert.equal(state.markerHash, ctx.candidate.markerHash);
  };
  const result = await publish(ctx, git, { onPrepared: async (transport) => {
    prepared = { ...transport };
    assert.deepEqual(await json(path.join(transport.directory, "transport.json")), transport);
    await writeFile(path.join(ctx.work, "fake-pending.json"), JSON.stringify(transport), { flag: "wx" });
    persisted = true;
    transport.commit = EXTERNAL; // The callback receives a copy, not mutable internal state.
  } });
  assert.equal(result.pushed, true); assert.equal(result.commit, prepared.commit); assert.deepEqual(result.transport, prepared);
  const originalFiles = await staticInventory(ctx.candidate.directory);
  assert.deepEqual(await staticInventory(prepared.tree), originalFiles);
  for (const file of originalFiles) assert.deepEqual(await readFile(path.join(prepared.tree, file)), await readFile(path.join(ctx.candidate.directory, file)));
  assert.deepEqual(sortedEntries(git.commits.get(result.commit).entries), sortedEntries(await blobs(ctx.candidate.directory)));
  assert.equal(git.commits.get(result.commit).entries.has("old-readme.txt"), false);
  assert.equal(git.commits.get(result.commit).parent, PARENT);
  assert.equal(count(git, "commit"), 1); assert.equal(count(git, "push"), 1);
  assert.deepEqual(git.calls.find((call) => call.args[0] === "diff").allowed, [0, 1]);
  assert.equal((await staticInventory(prepared.directory)).includes("confirmation.json"), false);
  assert.ok(git.calls.every((call) => !call.args.some((arg) => ["--force", "--orphan", "--allow-empty"].includes(arg))));
  const prefix = git.calls.find((call) => call.args[0] === "add").prefix;
  for (const value of ["core.autocrlf=false", "core.safecrlf=false", "core.fsmonitor=false", "gc.auto=0", "maintenance.auto=false", "commit.gpgSign=false", "tag.gpgSign=false"]) assert.ok(prefix.includes(value));
  assert.ok(prefix.includes("core.hooksPath=" + path.join(prepared.directory, "hooks")));
  assert.ok(prefix.includes("core.attributesFile=" + path.join(prepared.directory, "empty-config")));
  assert.equal(await readFile(path.join(prepared.gitDirectory, "info/attributes"), "utf8"), "* -text -crlf -filter -ident -working-tree-encoding\n");
  assert.deepEqual(await readdir(path.join(prepared.directory, "hooks")), []);
});

test("a failed pending push retries the same commit without preparing or committing again", async (t) => {
  const ctx = await pending(t), { git, transport } = ctx;
  const prior = { init: count(git, "init"), add: count(git, "add"), commit: count(git, "commit") };
  const reordered = Object.fromEntries(Object.entries(transport).reverse());
  const result = await publish(ctx, git, { transport: reordered, onPrepared: async () => assert.fail("pending is already durable") });
  assert.equal(result.commit, transport.commit); assert.equal(result.pushed, true);
  for (const operation of Object.keys(prior)) assert.equal(count(git, operation), prior[operation]);
  assert.deepEqual(result.transport, transport);
  assert.equal(count(git, "push"), 2);
  const alreadySent = await publish(ctx, git, { transport });
  assert.equal(alreadySent.pushed, false); assert.equal(alreadySent.commit, transport.commit);
  assert.equal(count(git, "push"), 2);
});

test("a push accepted before a lost receipt can be retried without another push", async (t) => {
  const ctx = await context(t), git = new FakeGit(); let transport;
  git.losePushReceipt = true;
  await assert.rejects(publish(ctx, git, { onPrepared: async (value) => { transport = value; } }), /git push failed/);
  assert.equal(git.remoteHead, transport.commit);
  const result = await publish(ctx, git, { transport });
  assert.equal(result.pushed, false); assert.equal(result.commit, transport.commit); assert.equal(count(git, "push"), 1);
});

test("an external main change or an ambiguous remote listing never overwrites the remote", async (t) => {
  const ctx = await pending(t), pushes = count(ctx.git, "push");
  ctx.git.remoteHead = EXTERNAL;
  await assert.rejects(publish(ctx, ctx.git, { transport: ctx.transport }), /remote main changed/);
  ctx.git.remoteHead = PARENT;
  ctx.git.remoteListing = PARENT + "\trefs/heads/main\n" + EXTERNAL + "\trefs/heads/other\n";
  await assert.rejects(publish(ctx, ctx.git, { transport: ctx.transport }), /remote main changed/);
  assert.equal(count(ctx.git, "push"), pushes);
  assert.deepEqual(await json(path.join(ctx.transport.directory, "transport.json")), ctx.transport);
});

test("an identical complete tree does not create an empty commit or push", async (t) => {
  const ctx = await context(t), git = new FakeGit(); let transport;
  git.commits.set(PARENT, { parent: EXTERNAL, entries: await blobs(ctx.candidate.directory) });
  const result = await publish(ctx, git, { onPrepared: async (value) => { transport = value; } });
  assert.equal(result.commit, PARENT); assert.equal(transport.commit, PARENT); assert.equal(result.pushed, false);
  assert.equal(count(git, "commit"), 0); assert.equal(count(git, "push"), 0);
  assert.deepEqual(sortedEntries(git.commits.get(PARENT).entries), sortedEntries(await blobs(ctx.candidate.directory)));
});

test("a failed pre-push callback retains preparation without pushing or exposing its error", async (t) => {
  const ctx = await context(t), git = new FakeGit(); let transport;
  await assert.rejects(publish(ctx, git, { onPrepared: async (value) => { transport = value; throw new Error("synthetic-secret-in-callback"); } }), (error) => {
    assert.match(error.message, /pre-push state persistence failed/); assert.ok(!error.stack.includes("synthetic-secret")); assert.equal(error.cause, undefined); return true;
  });
  assert.equal(count(git, "push"), 0);
  assert.deepEqual(await json(path.join(transport.directory, "transport.json")), transport);
});

test("commit verification rejects missing files, wrong blobs, submodules, truncation and wrong ancestry", async (t) => {
  for (const corruption of ["missing", "blob", "submodule", "truncated", "parent"]) await t.test(corruption, async (t) => {
    const ctx = await context(t), git = new FakeGit(); let prepared = false;
    if (corruption === "parent") git.wrongParent = true; else git.corruptListing = corruption;
    await assert.rejects(publish(ctx, git, { onPrepared: async () => { prepared = true; } }), /prepared commit/);
    assert.equal(prepared, false); assert.equal(count(git, "push"), 0);
  });
});


test("pending transports reject escaping paths, mismatched records and foreign ownership before Git", async (t) => {
  const cases = {
    escape: async (ctx) => ({ ...ctx.transport, directory: path.join(ctx.root, "outside") }),
    wrongTree: async (ctx) => ({ ...ctx.transport, tree: path.join(ctx.transport.directory, "repository") }),
    wrongGitDirectory: async (ctx) => ({ ...ctx.transport, gitDirectory: path.join(ctx.transport.directory, "other", ".git") }),
    extraField: async (ctx) => ({ ...ctx.transport, extra: "not-in-contract" }),
    changedCommit: async (ctx) => ({ ...ctx.transport, commit: EXTERNAL }),
    changedDiskRecord: async (ctx) => { await writeFile(path.join(ctx.transport.directory, "transport.json"), JSON.stringify({ ...ctx.transport, commit: EXTERNAL })); return ctx.transport; },
    foreignOwner: async (ctx) => { const file = path.join(ctx.transport.directory, "publication-owner.json"); await writeFile(file, JSON.stringify({ ...await json(file), owner: "another-program" })); return ctx.transport; },
    wrongOwnerId: async (ctx) => { const file = path.join(ctx.transport.directory, "publication-owner.json"); await writeFile(file, JSON.stringify({ ...await json(file), publicationId: "00000000-0000-4000-8000-000000000000" })); return ctx.transport; },
    missingOwner: async (ctx) => { await rm(path.join(ctx.transport.directory, "publication-owner.json")); return ctx.transport; },
  };
  for (const [name, change] of Object.entries(cases)) await t.test(name, async (t) => {
    const ctx = await pending(t), transport = await change(ctx);
    ctx.git.calls.length = 0;
    await assert.rejects(publish(ctx, ctx.git, { transport }), /transport|owner|publication/);
    assert.equal(ctx.git.calls.length, 0);
  });
});

test("pending Git config, attributes, hooks and alternate object stores cannot bypass isolation", async (t) => {
  const changes = {
    pushUrl: (ctx) => writeFile(path.join(ctx.transport.gitDirectory, "config"), '\n[remote "origin"]\n\tpushurl = https://synthetic-user:synthetic-password@example.invalid/elsewhere\n', { flag: "a" }),
    attributes: (ctx) => writeFile(path.join(ctx.transport.gitDirectory, "info/attributes"), "* filter=synthetic\n"),
    hook: (ctx) => writeFile(path.join(ctx.transport.directory, "hooks/pre-push"), "synthetic hook"),
    template: (ctx) => writeFile(path.join(ctx.transport.directory, "empty-template/config"), "synthetic config"),
    alternates: async (ctx) => { await mkdir(path.join(ctx.transport.gitDirectory, "objects/info"), { recursive: true }); await writeFile(path.join(ctx.transport.gitDirectory, "objects/info/alternates"), "synthetic-external-objects"); },
    commondir: (ctx) => writeFile(path.join(ctx.transport.gitDirectory, "commondir"), "synthetic-external-repository"),
    grafts: (ctx) => writeFile(path.join(ctx.transport.gitDirectory, "info/grafts"), "synthetic-graft"),
  };
  for (const [name, change] of Object.entries(changes)) await t.test(name, async (t) => {
    const ctx = await pending(t); await change(ctx); ctx.git.calls.length = 0;
    await assert.rejects(publish(ctx, ctx.git, { transport: ctx.transport }), (error) => {
      assert.match(error.message, /isolation|storage|grafts/); assert.ok(!error.stack.includes("synthetic-password")); return true;
    });
    assert.equal(ctx.git.calls.length, 0);
  });
});

test("directory links and junctions in transport paths are rejected without following them", async (t) => {
  for (const field of ["tree", "gitDirectory", "directory", "publications"]) await t.test(field, async (t) => {
    const ctx = await pending(t), target = field === "publications" ? path.join(ctx.work, "publications") : ctx.transport[field];
    const moved = target + "-retained";
    await rename(target, moved);
    await symlink(moved, target, process.platform === "win32" ? "junction" : "dir");
    ctx.git.calls.length = 0;
    await assert.rejects(publish(ctx, ctx.git, { transport: ctx.transport }), /symlink|junction|directory/);
    assert.equal(ctx.git.calls.length, 0);
    assert.ok((await readdir(moved)).length > 0, "linked files remain intact");
  });
});

test("a callback cannot change prepared bytes and a publication workspace cannot overlap its candidate", async (t) => {
  const ctx = await context(t), git = new FakeGit();
  await assert.rejects(publish(ctx, git, { onPrepared: async (transport) => { await writeFile(path.join(transport.tree, "404.html"), "changed after persistence"); } }), /candidate/);
  assert.equal(count(git, "push"), 0);
  const overlapping = { ...ctx, work: path.join(ctx.candidate.directory, "work") }, unusedGit = new FakeGit();
  await assert.rejects(publish(overlapping, unusedGit), /overlaps candidate/);
  assert.equal(unusedGit.calls.length, 0);
  assert.equal((await staticInventory(ctx.candidate.directory)).some((file) => file.startsWith("work/")), false);
});

test("a changed origin, missing main, or rejected adapter result cannot push", async (t) => {
  for (const problem of ["origin", "main", "code", "stdout", "throw"]) await t.test(problem, async (t) => {
    const ctx = await context(t), git = new FakeGit();
    if (problem === "origin") git.originOverride = "https://synthetic-user:synthetic-password@example.invalid/foreign.git";
    if (problem === "main") git.remoteHead = "";
    const adapter = async (prefix, args, allowed) => {
      if (args[0] === "fetch" && ["code", "stdout", "throw"].includes(problem)) {
        if (problem === "throw") throw new Error("synthetic-password from adapter");
        return { code: problem === "code" ? 1 : 0, stdout: problem === "stdout" ? null : "synthetic-password" };
      }
      return git.gitCommand(prefix, args, allowed);
    };
    await assert.rejects(publish(ctx, git, { gitCommand: adapter }), (error) => {
      assert.match(error.message, /origin|main|git fetch failed/); assert.ok(!error.stack.includes("synthetic-password")); assert.equal(error.cause, undefined); return true;
    });
    assert.equal(count(git, "push"), 0);
  });
});

async function httpFixture(ctx, respond = ({ bytes }) => new Response(bytes)) {
  const contents = new Map();
  for (const file of [MARKER, ...CRITICAL]) contents.set(file, await readFile(path.join(ctx.candidate.directory, file)));
  const calls = [];
  const fetch = async (url, options) => {
    const parsed = new URL(url), file = parsed.pathname.slice("/hot-pages/".length);
    assert.equal(parsed.origin, "https://reisen-ww.github.io"); assert.equal(parsed.pathname, "/hot-pages/" + file);
    assert.equal(parsed.search, "?release=" + ctx.candidate.markerHash);
    assert.equal(options.redirect, "error"); assert.equal(options.headers["cache-control"], "no-cache");
    assert.ok(options.signal instanceof AbortSignal); assert.ok(contents.has(file));
    calls.push({ file, url, options });
    return respond({ file, bytes: Buffer.from(contents.get(file)), url, options, calls });
  };
  return { fetch, calls };
}

test("HTTP confirmation verifies the exact marker and all ten critical resources without writing a receipt", async (t) => {
  const ctx = await context(t), http = await httpFixture(ctx), files = await staticInventory(ctx.root);
  // Cached caller metadata is not authority; disk validation supplies the hashes.
  ctx.candidate.release = { files: {} };
  assert.equal(await confirmPublication(ctx.candidate, CONFIG, { fetch: http.fetch }), true);
  assert.deepEqual(http.calls.map((call) => call.file), [MARKER, ...CRITICAL]);
  assert.deepEqual(await staticInventory(ctx.root), files);
  assert.equal(http.calls.length, 11);
});

test("HTTP confirmation rejects even semantically equal marker bytes and each changed critical file", async (t) => {
  const ctx = await context(t);
  for (const changed of [MARKER, ...CRITICAL]) await t.test(changed, async () => {
    const http = await httpFixture(ctx, ({ file, bytes }) => new Response(file === changed ? Buffer.concat([bytes, Buffer.from(" ")]) : bytes));
    assert.equal(await confirmPublication(ctx.candidate, CONFIG, { fetch: http.fetch }), false);
    assert.ok(http.calls.some((call) => call.file === changed));
  });
});

test("HTTP status, redirects, network errors, truncated streams and oversized bodies never confirm", async (t) => {
  const ctx = await context(t);
  const variants = {
    status: () => new Response("unavailable", { status: 503 }),
    redirect: ({ bytes, url }) => ({ ok: true, redirected: true, url, body: [bytes] }),
    differentUrl: ({ bytes }) => ({ ok: true, url: "https://example.invalid/foreign", body: [bytes] }),
    network: () => { throw new Error("synthetic-private-upstream"); },
    missingBody: () => ({ ok: true, body: null }),
    truncated: ({ bytes }) => new Response(bytes.subarray(0, bytes.length - 1)),
    brokenStream: ({ bytes }) => ({ ok: true, body: (async function* () { yield bytes.subarray(0, 1); throw new Error("synthetic-private-stream"); })() }),
    oversized: () => ({ ok: true, body: (async function* () { const chunk = Buffer.alloc(1024 * 1024); for (let i = 0; i < 17; i++) yield chunk; })() }),
  };
  for (const [name, respond] of Object.entries(variants)) await t.test(name, async () => {
    const http = await httpFixture(ctx, respond);
    assert.equal(await confirmPublication(ctx.candidate, CONFIG, { fetch: http.fetch }), false);
    assert.equal(http.calls.length, 1);
  });
});

test("request timeout covers fetch and body readers even when an adapter ignores abort", async (t) => {
  const ctx = await context(t);
  for (const phase of ["fetch", "body"]) await t.test(phase, { timeout: 2000 }, async () => {
    let signal;
    const fetch = async (_url, options) => {
      signal = options.signal;
      if (phase === "fetch") return new Promise(() => {});
      return { ok: true, body: (async function* () { await new Promise(() => {}); yield Buffer.alloc(0); })() };
    };
    assert.equal(await confirmPublication(ctx.candidate, CONFIG, { fetch, requestTimeoutMs: 10 }), false);
    assert.equal(signal.aborted, true);
  });
});

test("confirmation retries are bounded by the overall deadline and late exact bytes do not confirm", async (t) => {
  const ctx = await context(t); let clock = 0, sleeps = 0;
  const late = await httpFixture(ctx, ({ file, bytes }) => { if (file === CRITICAL.at(-1)) clock = 1000; return new Response(bytes); });
  assert.equal(await confirmPublication(ctx.candidate, { ...CONFIG, confirmationSeconds: 1 }, { fetch: late.fetch, now: () => clock }), false);
  assert.equal(late.calls.length, 11);
  clock = 0;
  const failed = await httpFixture(ctx, () => new Response("retry", { status: 503 }));
  assert.equal(await confirmPublication(ctx.candidate, { ...CONFIG, confirmationSeconds: 1 }, { fetch: failed.fetch, now: () => clock, sleep: async (ms) => { sleeps++; clock += ms; } }), false);
  assert.equal(sleeps, 1); assert.equal(failed.calls.length, 1);
  clock = 0;
  const eventual = await httpFixture(ctx, ({ bytes, calls }) => calls.length === 1 ? new Response("retry", { status: 503 }) : new Response(bytes));
  assert.equal(await confirmPublication(ctx.candidate, { ...CONFIG, confirmationSeconds: 12 }, { fetch: eventual.fetch, now: () => clock, sleep: async (ms) => { clock += ms; } }), true);
  assert.equal(eventual.calls.length, 12);
});

test("invalid local candidates fail real validation before any Git or HTTP", async (t) => {
  const changes = {
    root404: (ctx) => writeFile(path.join(ctx.candidate.directory, "404.html"), "tampered"),
    marker: (ctx) => writeFile(path.join(ctx.candidate.directory, MARKER), "{}"),
    missingIndex: (ctx) => rm(path.join(ctx.candidate.directory, "index.html")),
    extraFile: (ctx) => writeFile(path.join(ctx.candidate.directory, "extra.txt"), "unlisted"),
    candidateJunction: async (ctx) => {
      const moved = ctx.candidate.directory + "-retained"; await rename(ctx.candidate.directory, moved);
      await symlink(moved, ctx.candidate.directory, process.platform === "win32" ? "junction" : "dir");
    },
  };
  for (const [name, change] of Object.entries(changes)) await t.test(name, async (t) => {
    const ctx = await context(t), git = new FakeGit(); await change(ctx); let httpCalls = 0;
    await assert.rejects(publish(ctx, git), /candidate/);
    assert.equal(await confirmPublication(ctx.candidate, CONFIG, { fetch: async () => { httpCalls++; throw new Error("must not fetch"); } }), false);
    assert.equal(git.calls.length, 0); assert.equal(httpCalls, 0);
  });
});


function fakeChild() {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.finish = (code = 0, signal = null) => { child.stdout.end(); child.stderr.end(); child.emit("close", code, signal); };
  return child;
}

test("Git output truncation, stream errors and process errors wait for the same child's close", async (t) => {
  for (const problem of ["overflow", "process", "stream", "status", "signal"]) await t.test(problem, async () => {
    const child = fakeChild(), command = createGitCommand({ spawn: () => child, maxOutputBytes: 32 });
    let settled = false;
    const result = command([], ["fetch", "origin", "main"]).then((value) => { settled = true; return value; }, (error) => { settled = true; return error; });
    if (problem === "overflow") child.stdout.write("x".repeat(33));
    if (problem === "process") child.emit("error", new Error("synthetic-secret-process"));
    if (problem === "stream") child.stdout.emit("error", new Error("synthetic-secret-stream"));
    child.stderr.write("synthetic-secret");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false, "do not release the cycle while its Git child is alive");
    child.finish(problem === "status" ? 1 : 0, problem === "signal" ? "SIGTERM" : null);
    const error = await result;
    assert.ok(error instanceof Error); assert.match(error.message, /git fetch/);
    assert.ok(!error.message.includes("synthetic-secret")); assert.ok(!error.stack.includes("synthetic-secret")); assert.equal(error.cause, undefined);
    if (problem === "overflow") assert.match(error.message, /output exceeds/);
  });
});

test("the default Git boundary isolates inherited settings, uses no shell and preserves allowed exit codes", async () => {
  const child = fakeChild(); let invocation;
  const command = createGitCommand({ env: { PATH: "synthetic-path", SSH_AUTH_SOCK: "synthetic-agent", HOME: "synthetic-home", GIT_DIR: "synthetic-other-repo", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "filter.synthetic.clean", GIT_CONFIG_VALUE_0: "synthetic-command", GIT_SSH_COMMAND: "synthetic-override", GIT_TRACE: "synthetic-log", git_index_file: "synthetic-index" }, spawn: (...args) => { invocation = args; return child; } });
  const prefix = ["--no-replace-objects", "-c", "core.autocrlf=false"], args = ["diff", "--cached", "--quiet", "--exit-code"];
  const pending = command(prefix, args, [0, 1]);
  child.stdout.write("expected-output"); child.stderr.write("synthetic-secret"); child.finish(1);
  assert.deepEqual(await pending, { code: 1, stdout: "expected-output" });
  assert.equal(invocation[0], "git"); assert.deepEqual(invocation[1], [...prefix, ...args]);
  const options = invocation[2];
  assert.equal(options.shell, false); assert.equal(options.windowsHide, true); assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(options.env.PATH, "synthetic-path"); assert.equal(options.env.SSH_AUTH_SOCK, "synthetic-agent");
  const overrides = Object.fromEntries(Object.entries(options.env).filter(([key]) => key.toUpperCase().startsWith("GIT_")));
  assert.deepEqual(overrides, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: devNull, GIT_CONFIG_GLOBAL: devNull, GIT_ATTR_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" });
  assert.deepEqual(prefix, ["--no-replace-objects", "-c", "core.autocrlf=false"]);
});

test("Git spawn errors are safe and only exit codes explicitly allowed by the caller succeed", async () => {
  await assert.rejects(createGitCommand({ spawn: () => { throw new Error("synthetic-secret-spawn"); } })([], ["fetch"]), (error) => {
    assert.equal(error.message, "git fetch failed"); assert.ok(!error.stack.includes("synthetic-secret")); assert.equal(error.cause, undefined); return true;
  });
  const child = fakeChild(), command = createGitCommand({ spawn: () => child });
  const pending = command([], ["diff"]);
  child.finish(1);
  await assert.rejects(pending, /git diff failed/);
  await assert.rejects(command([], ["fetch", "bad\0argument"]), /invalid Git invocation/);
});
