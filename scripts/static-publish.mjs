// Explicit transport only. Importing starts no process or HTTP request.
import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { cp, lstat, mkdir, open, readFile, readdir, writeFile } from "node:fs/promises";
import { devNull } from "node:os";
import path from "node:path";
import { digest, staticInventory } from "./static-validate.ts";
import { PUBLIC_SITE_URL, STATIONS, validateCombinedRelease } from "./static-runner-core.mjs";

const REMOTES = new Set(["git@github.com:reisen-ww/hot-pages.git", "https://github.com/reisen-ww/hot-pages.git"]);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const MAX_GIT_OUTPUT = 8 * 1024 * 1024;
const TRANSPORT_FIELDS = ["directory", "tree", "gitDirectory", "markerHash", "remote", "branch", "expectedParent", "commit"];
const ATTRIBUTES = "* -text -crlf -filter -ident -working-tree-encoding\n";
const record = (value) => !!value && typeof value === "object" && !Array.isArray(value);
class PublicationError extends Error {}
const fail = (message) => new PublicationError(message);

function settings(value) {
  if (!record(value) || !REMOTES.has(value.remote) || value.branch !== "main"
    || typeof value.authorName !== "string" || !value.authorName.trim() || value.authorName.length > 256 || /[\x00-\x1f\x7f<>]/.test(value.authorName)
    || typeof value.authorEmail !== "string" || value.authorEmail.length > 254 || !/^[^\s@<>\x00-\x1f\x7f]+@[^\s@<>\x00-\x1f\x7f]+$/.test(value.authorEmail)) throw fail("explicit hot-pages/main publisher and author identity required");
  if (value.confirmationSeconds !== undefined && (!Number.isSafeInteger(value.confirmationSeconds) || value.confirmationSeconds < 0 || value.confirmationSeconds > 600)) throw fail("invalid confirmation timeout");
  return { remote: value.remote, branch: "main", authorName: value.authorName, authorEmail: value.authorEmail, confirmationSeconds: value.confirmationSeconds ?? 180 };
}

const GIT_OPERATIONS = new Set(["init", "remote", "fetch", "rev-parse", "symbolic-ref", "update-ref", "read-tree", "add", "diff", "commit", "ls-tree", "rev-list", "ls-remote", "push"]);
function gitError(args, reason = "failed") {
  return fail(`git ${GIT_OPERATIONS.has(args[0]) ? args[0] : "command"} ${reason}`);
}

/** Injectable process boundary; returned command keeps the prefix,args,allowed contract. */
export function createGitCommand({ spawn: spawnCommand = spawn, maxOutputBytes = MAX_GIT_OUTPUT, env } = {}) {
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > MAX_GIT_OUTPUT) throw fail("invalid Git output limit");
  return async (prefix, args, allowed = [0]) => {
    if (![prefix, args].every((parts) => Array.isArray(parts) && parts.every((part) => typeof part === "string" && !part.includes("\0")))
      || !Array.isArray(allowed) || !allowed.length || !allowed.every(Number.isInteger)) throw fail("invalid Git invocation");
    // Ignore inherited repo/index/config overrides, tracing and global Git configuration.
    const environment = Object.fromEntries(Object.entries(env ?? process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
    Object.assign(environment, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: devNull, GIT_CONFIG_GLOBAL: devNull, GIT_ATTR_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" });
    let child;
    try { child = spawnCommand("git", [...prefix, ...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: false, env: environment }); }
    catch { throw gitError(args); }
    const chunks = []; let size = 0, overflow = false, errored = false;
    const closed = new Promise((resolve) => {
      // close follows error in Node: keep the cycle lock until this child's pipes close.
      child.once("error", () => { errored = true; });
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    for (const [stream, keep] of [[child.stdout, true], [child.stderr, false]]) {
      stream.on("error", () => { errored = true; });
      stream.on("data", (chunk) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > maxOutputBytes) overflow = true;
        if (!overflow && keep) chunks.push(bytes);
        // Drain both streams after truncation; do not return or leave a running child.
      });
    }
    const { code, signal } = await closed;
    if (overflow) throw gitError(args, "output exceeds local transport limit");
    if (errored || signal || !allowed.includes(code)) throw gitError(args);
    return { code, stdout: Buffer.concat(chunks).toString("utf8") };
  };
}
const defaultGitCommand = createGitCommand();

function commandAdapter(command) {
  if (typeof command !== "function") throw fail("invalid Git command adapter");
  return async (prefix, args, allowed = [0]) => {
    let result;
    try { result = await command([...prefix], [...args], [...allowed]); } catch { throw gitError(args); }
    if (!record(result) || !allowed.includes(result.code) || typeof result.stdout !== "string") throw gitError(args);
    if (Buffer.byteLength(result.stdout) > MAX_GIT_OUTPUT) throw gitError(args, "output exceeds local transport limit");
    return { code: result.code, stdout: result.stdout };
  };
}

async function optionalStat(file) {
  try { return await lstat(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
async function directoryPath(value, create = false) {
  if (typeof value !== "string" || !value || /[\x00-\x1f]/.test(value)) throw fail("invalid publication directory");
  const root = path.resolve(value), anchor = path.parse(root).root;
  let current = anchor;
  for (const part of ["", ...root.slice(anchor.length).split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part);
    let stat = await optionalStat(current);
    if (!stat && create) {
      try { await mkdir(current); } catch (error) { if (error.code !== "EEXIST") throw error; }
      stat = await lstat(current);
    }
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) throw fail("publication directory missing or symlink/junction refused");
  }
  return root;
}
async function regularText(file) {
  const stat = await lstat(file);
  if (stat.isSymbolicLink() || !stat.isFile()) throw fail("publication file symlink or non-file refused");
  return readFile(file, "utf8");
}
async function exclusiveJSON(file, value) {
  const handle = await open(file, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(value), "utf8"); await handle.sync(); } finally { await handle.close(); }
}
function overlaps(left, right) {
  const within = (a, b) => { const r = path.relative(a, b); return !r || (r !== ".." && !r.startsWith(".." + path.sep) && !path.isAbsolute(r)); };
  return within(left, right) || within(right, left);
}
async function checkedCandidate(candidate) {
  if (!record(candidate) || typeof candidate.directory !== "string" || !/^[a-f0-9]{64}$/.test(candidate.markerHash ?? "")) throw fail("invalid publication candidate");
  let verified;
  try { verified = await validateCombinedRelease(candidate.directory); } catch { throw fail("invalid publication candidate files or marker"); }
  if (verified.markerHash !== candidate.markerHash) throw fail("candidate changed before publication");
  if (Object.keys(verified.release.files).some((file) => file.split("/").some((part) => part.toLowerCase() === ".git"))) throw fail("Git metadata is not a public payload");
  return verified;
}

function repositoryConfig(configuration) {
  return `[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tfilemode = false\n\tlogallrefupdates = true\n[remote "origin"]\n\turl = ${configuration.remote}\n\tfetch = refs/heads/main:refs/remotes/origin/main\n`;
}
function prefixFor(directory, configuration, transport) {
  return ["--no-replace-objects",
    ...(transport ? ["--git-dir", transport.gitDirectory, "--work-tree", transport.tree] : []),
    "-c", `core.hooksPath=${path.join(directory, "hooks")}`, "-c", "core.autocrlf=false", "-c", "core.safecrlf=false",
    "-c", `core.attributesFile=${path.join(directory, "empty-config")}`, "-c", `core.excludesFile=${path.join(directory, "empty-config")}`,
    "-c", "core.fsmonitor=false", "-c", "gc.auto=0", "-c", "maintenance.auto=false",
    "-c", "commit.gpgSign=false", "-c", "tag.gpgSign=false",
    "-c", `user.name=${configuration.authorName}`, "-c", `user.email=${configuration.authorEmail}`];
}

function transportPaths(root, transport) {
  if (!record(transport) || Object.keys(transport).sort().join(",") !== [...TRANSPORT_FIELDS].sort().join(",")) throw fail("invalid pending publication transport");
  for (const field of ["directory", "tree", "gitDirectory"]) if (typeof transport[field] !== "string" || !path.isAbsolute(transport[field])
    || transport[field] !== path.resolve(transport[field])) throw fail("invalid transport path");
  const id = path.basename(transport.directory);
  if (!UUID.test(id) || transport.directory !== path.join(root, id) || transport.tree !== path.join(transport.directory, "tree")
    || transport.gitDirectory !== path.join(transport.directory, "repository", ".git")) throw fail("publication transport path escapes its owned directory");
  return id;
}
async function verifyTransport(root, transport, configuration, markerHash) {
  const id = transportPaths(root, transport);
  if (transport.remote !== configuration.remote || transport.branch !== "main" || transport.markerHash !== markerHash
    || !OID.test(transport.commit ?? "") || !OID.test(transport.expectedParent ?? "") || transport.commit.length !== transport.expectedParent.length) throw fail("invalid pending publication target or commit");
  await directoryPath(transport.directory);
  try { await staticInventory(transport.directory); } catch { throw fail("publication transport symlink/junction or unsupported entry refused"); }
  const owner = JSON.parse(await regularText(path.join(transport.directory, "publication-owner.json")));
  if (!record(owner) || owner.schemaVersion !== 1 || owner.owner !== "hot-pages-static-cycle" || owner.publicationId !== id
    || typeof owner.createdAt !== "string" || !Number.isFinite(Date.parse(owner.createdAt))
    || new Date(owner.createdAt).toISOString() !== owner.createdAt
    || Object.keys(owner).sort().join(",") !== "createdAt,owner,publicationId,schemaVersion") throw fail("invalid publication owner");
  const stored = JSON.parse(await regularText(path.join(transport.directory, "transport.json")));
  transportPaths(root, stored);
  if (TRANSPORT_FIELDS.some((field) => stored[field] !== transport[field])) throw fail("pending transport record changed");
  await directoryPath(transport.tree); await directoryPath(transport.gitDirectory);
  if ((await regularText(path.join(transport.gitDirectory, "config"))) !== repositoryConfig(configuration)
    || (await regularText(path.join(transport.gitDirectory, "info", "attributes"))) !== ATTRIBUTES
    || (await regularText(path.join(transport.directory, "empty-config"))) !== ""
    || (await readdir(path.join(transport.directory, "hooks"))).length || (await readdir(path.join(transport.directory, "empty-template"))).length) throw fail("publication Git isolation changed");
  for (const file of ["commondir", "objects/info/alternates", "info/grafts"]) if (await optionalStat(path.join(transport.gitDirectory, file))) throw fail("external Git object storage or grafts refused");
}

// Cheap change detector for the freshly prepared tree. The commit was hashed in full moments ago,
// so an unchanged inventory (same names, sizes, mtimes and ctimes) cannot have been rewritten. Any
// difference, and every resumed transport, falls back to the full byte-level verification.
async function inventorySignature(root) {
  const signature = [];
  for (const file of await staticInventory(root)) {
    const info = await lstat(path.join(root, file));
    if (!info.isFile()) throw fail("prepared tree entry changed type");
    signature.push([file, info.size, Math.trunc(info.mtimeMs), Math.trunc(info.ctimeMs)]);
  }
  return signature;
}

function sameInventory(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    const a = left[index], b = right[index];
    if (a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2] || a[3] !== b[3]) return false;
  }
  return true;
}

async function verifyCommit(git, transport, candidate) {
  const verified = await checkedCandidate({ directory: transport.tree, markerHash: candidate.markerHash });
  const objectFormat = (await git(["rev-parse", "--show-object-format"])).stdout.trim();
  if (!["sha1", "sha256"].includes(objectFormat) || transport.commit.length !== (objectFormat === "sha1" ? 40 : 64)) throw fail("unsupported Git object format");
  if (transport.commit !== transport.expectedParent) {
    const ancestry = (await git(["rev-list", "--parents", "--max-count=1", transport.commit])).stdout.trim().split(/\s+/);
    if (ancestry.length !== 2 || ancestry[0] !== transport.commit || ancestry[1] !== transport.expectedParent) throw fail("prepared commit has an unexpected parent");
  }
  const listing = (await git(["ls-tree", "-rz", "--full-tree", transport.commit])).stdout;
  if (!listing.endsWith("\0")) throw fail("incomplete prepared commit listing");
  const entries = listing.slice(0, -1).split("\0");
  const expected = new Set([...Object.keys(verified.release.files), "static-site-release.json"]);
  if (entries.length !== expected.size) throw fail("prepared commit file set changed");
  for (const entry of entries) {
    const match = /^(100644|100755) blob ([a-f0-9]+)\t([^\0]+)$/.exec(entry);
    if (!match || match[2].length !== transport.commit.length || !expected.delete(match[3])) throw fail("prepared commit contains an unexpected entry");
    const bytes = await readFile(path.join(transport.tree, match[3]));
    const hash = createHash(objectFormat).update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    if (hash !== match[2]) throw fail("prepared commit blob differs from verified candidate");
  }
  if (expected.size) throw fail("prepared commit is incomplete");
}

export async function publishCandidate(candidate, input, workDirectory, options = {}) {
  try {
    const configuration = settings(input), command = commandAdapter(options.gitCommand ?? defaultGitCommand);
    const verified = await checkedCandidate(candidate);
    const root = path.resolve(workDirectory, "publications");
    if (overlaps(root, path.resolve(candidate.directory))) throw fail("publication workspace overlaps candidate");
    if (!options.transport && typeof options.onPrepared !== "function") throw fail("durable pre-push state callback required");
    await directoryPath(root, true);
    let transport;
    // A transport created by this call is verified in full immediately after its commit is written.
    // Only a resumed transport, or one whose files changed since that check, is hashed again below.
    const resumed = Boolean(options.transport);
    let preparedSignature = null;
    if (options.transport) {
      transport = { ...options.transport };
      await verifyTransport(root, transport, configuration, verified.markerHash);
    } else {
      const id = randomUUID(), directory = path.join(root, id), tree = path.join(directory, "tree"), repository = path.join(directory, "repository");
      await mkdir(directory);
      // Owner is written immediately; only the cycle may later write an online confirmation.
      await exclusiveJSON(path.join(directory, "publication-owner.json"), { schemaVersion: 1, owner: "hot-pages-static-cycle", publicationId: id, createdAt: new Date().toISOString() });
      await cp(candidate.directory, tree, { recursive: true, errorOnExist: true, force: false, dereference: false });
      await checkedCandidate({ directory: tree, markerHash: verified.markerHash });
      await mkdir(path.join(directory, "empty-template")); await mkdir(path.join(directory, "hooks"));
      await writeFile(path.join(directory, "empty-config"), "", { flag: "wx" });
      await command(prefixFor(directory, configuration), ["init", "--quiet", "--object-format=sha1", "--initial-branch=main", `--template=${path.join(directory, "empty-template")}`, repository]);
      const gitDirectory = await directoryPath(path.join(repository, ".git"));
      // Configuration belongs only to this new private repository, never a user worktree.
      const configFile = path.join(gitDirectory, "config"), configStat = await optionalStat(configFile);
      if (configStat && (configStat.isSymbolicLink() || !configStat.isFile())) throw fail("Git config symlink refused");
      await writeFile(configFile, repositoryConfig(configuration));
      await directoryPath(path.join(gitDirectory, "info"), true);
      await writeFile(path.join(gitDirectory, "info", "attributes"), ATTRIBUTES, { flag: "wx" });
      transport = { directory, tree, gitDirectory, markerHash: verified.markerHash, remote: configuration.remote, branch: "main" };
      const git = (args, allowed) => command(prefixFor(directory, configuration, transport), args, allowed);
      if ((await git(["remote", "get-url", "origin"])).stdout.trim() !== configuration.remote) throw fail("unexpected publication origin");
      await git(["fetch", "--quiet", "--depth=1", "origin", "main"]);
      transport.expectedParent = (await git(["rev-parse", "FETCH_HEAD"])).stdout.trim();
      if (!OID.test(transport.expectedParent)) throw fail("existing remote main is required");
      await git(["symbolic-ref", "HEAD", "refs/heads/main"]);
      await git(["update-ref", "refs/heads/main", transport.expectedParent]);
      await git(["read-tree", transport.expectedParent]);
      await git(["add", "--all"]);
      const changes = await git(["diff", "--cached", "--quiet", "--exit-code"], [0, 1]);
      if (changes.code) await git(["commit", "--quiet", "-m", "Publish static release " + verified.markerHash.slice(0, 16)]);
      transport.commit = (await git(["rev-parse", "HEAD"])).stdout.trim();
      if (!OID.test(transport.commit)) throw fail("invalid prepared commit");
      await verifyCommit(git, transport, candidate);
      preparedSignature = await inventorySignature(tree);
      await exclusiveJSON(path.join(directory, "transport.json"), transport);
      try { await options.onPrepared({ ...transport }); } catch { throw fail("pre-push state persistence failed; prepared transport retained"); }
      await verifyTransport(root, transport, configuration, verified.markerHash);
    }
    const git = (args, allowed) => command(prefixFor(transport.directory, configuration, transport), args, allowed);
    if ((await git(["remote", "get-url", "origin"])).stdout.trim() !== configuration.remote) throw fail("publication origin changed");
    // Re-hash everything only when this transport came from disk or the tree moved since the commit
    // was verified; a stat-identical freshly prepared tree is already covered by verifyCommit above.
    // This cannot publish different bytes: the push below sends transport.commit, an immutable object
    // whose content was hashed against the candidate moments ago. Editing the worktree afterwards
    // changes nothing that Git uploads, it only leaves the local transport record stale.
    if (resumed || !sameInventory(preparedSignature, await inventorySignature(transport.tree))) await verifyCommit(git, transport, candidate);
    const head = (await git(["ls-remote", "origin", "refs/heads/main"])).stdout.trim();
    const remote = /^([a-f0-9]{40}|[a-f0-9]{64})\trefs\/heads\/main$/.exec(head)?.[1];
    if (remote !== transport.expectedParent && remote !== transport.commit) throw fail("remote main changed; pending candidate retained for review");
    if (remote !== transport.commit) await git(["push", "origin", transport.commit + ":refs/heads/main"]);
    return { commit: transport.commit, pushed: remote !== transport.commit, transport: { ...transport } };
  } catch (error) {
    if (error instanceof PublicationError) throw error;
    throw fail("publication transport failed; prepared files retained");
  }
}

async function boundedBody(response, url) {
  if (!response?.ok || response.redirected || (response.url && response.url !== url) || !response.body) throw fail("publication HTTP response refused");
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 16 * 1024 * 1024) throw fail("publication response exceeds local limit");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

/** Confirmation is read-only; the cycle alone persists a successful online receipt. */
export async function confirmPublication(candidate, input, options = {}) {
  const configuration = settings(input), fetcher = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now, sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const timeout = options.requestTimeoutMs ?? 15000;
  if (typeof fetcher !== "function" || typeof now !== "function" || typeof sleep !== "function"
    || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 15000) throw fail("invalid publication confirmation adapter");
  let verified;
  try { verified = await checkedCandidate(candidate); } catch { return false; }
  const singleProbe = configuration.confirmationSeconds === 0, deadline = now() + configuration.confirmationSeconds * 1000;
  const files = ["index.html", "404.html", ...STATIONS.flatMap((station) => [station + "/index.html", station + "/data/manifest.json"])];
  do {
    try {
      const request = async (file) => {
        const remaining = singleProbe ? timeout : Math.min(timeout, deadline - now());
        if (remaining <= 0) throw fail("publication confirmation deadline reached");
        const url = PUBLIC_SITE_URL + "/" + file + "?release=" + verified.markerHash;
        const controller = new AbortController(); let timer;
        try {
          // Race the complete body as well as fetch, including adapters ignoring abort.
          return await Promise.race([
            Promise.resolve().then(() => fetcher(url, { headers: { "cache-control": "no-cache" }, signal: controller.signal, redirect: "error" })).then((response) => boundedBody(response, url)),
            new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(fail("publication HTTP timeout")); }, remaining); }),
          ]);
        } finally { clearTimeout(timer); controller.abort(); }
      };
      if (digest(await request("static-site-release.json")) !== verified.markerHash) throw fail("different deployed release");
      for (const file of files) if (digest(await request(file)) !== verified.release.files[file]) throw fail("deployed resource differs from release");
      if (!singleProbe && now() >= deadline) return false;
      return true;
    } catch { /* A successful push is not an online receipt. Keep pending on any error. */ }
    if (singleProbe || now() >= deadline) return false;
    await sleep(Math.min(10000, deadline - now()));
  } while (now() < deadline);
  return false;
}
