// On-disk job registry + config for the Grok companion.
//
// State lives OUTSIDE the user's repo (so consult/review never dirty the working
// tree) under ~/.grok/companion/<workspace-slug>/:
//   jobs/<id>.json   full per-job record (request + result) — the source of truth
//   logs/<id>.log    human-readable progress log
//   index.json       lightweight list of all jobs (newest-relevant fields)
//   state.lock       guards every job-file + index write for the workspace
//   config.json      per-workspace config (e.g. default model)
//
// GROK_COMPANION_HOME overrides the ~/.grok/companion root (used by the tests).

import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  openSync,
  closeSync,
  unlinkSync,
  statSync,
  existsSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

export const ROOT = process.env.GROK_COMPANION_HOME
  ? resolve(process.env.GROK_COMPANION_HOME)
  : resolve(homedir(), ".grok", "companion");

// Resolve the workspace root for a directory: the git toplevel if inside a repo,
// otherwise the directory itself.
export function resolveWorkspaceRoot(cwd = process.cwd()) {
  const res = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
  });
  if (res.status === 0 && res.stdout.trim()) {
    return res.stdout.trim();
  }
  return resolve(cwd);
}

function slugify(workspaceRoot) {
  const base = workspaceRoot.split(/[/\\]/).filter(Boolean).pop() || "workspace";
  const safe = base.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 40);
  const hash = createHash("sha1").update(workspaceRoot).digest("hex").slice(0, 8);
  return `${safe}-${hash}`;
}

export function stateDir(workspaceRoot) {
  return join(ROOT, slugify(workspaceRoot));
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function jobsDir(workspaceRoot) {
  return ensureDir(join(stateDir(workspaceRoot), "jobs"));
}

export function logsDir(workspaceRoot) {
  return ensureDir(join(stateDir(workspaceRoot), "logs"));
}

export function jobFilePath(workspaceRoot, jobId) {
  return join(jobsDir(workspaceRoot), `${jobId}.json`);
}

export function logFilePath(workspaceRoot, jobId) {
  return join(logsDir(workspaceRoot), `${jobId}.log`);
}

function indexPath(workspaceRoot) {
  return join(ensureDir(stateDir(workspaceRoot)), "index.json");
}

export function generateJobId(prefix = "grok") {
  const stamp = Date.now().toString(36);
  const rand = Math.floor(Math.random() * 36 ** 4)
    .toString(36)
    .padStart(4, "0");
  return `${prefix}-${stamp}-${rand}`;
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(path, value) {
  // Atomic: write a temp file then rename, so a reader never sees a torn file.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

// Exclusive lock via O_EXCL. The holder writes its pid into the file so a lock
// left behind by a crashed process can be told apart from a slow live holder.
//
// Never enters `fn` without the lock: the old version fell through to an
// unlocked write after ~1s of contention, which is exactly when lost updates
// happen. Holds are a few milliseconds, so the 5s budget only runs out if
// something is badly wrong — and then failing loudly beats corrupting state.
//
// A stale lock (dead owner, or older than maxAgeMs) is reclaimed by renaming it
// aside rather than unlinking it: only one contender's rename can succeed, so
// two processes cannot both "reclaim" and then both write.
export function withLock(lockPath, fn, { timeoutMs = 5_000, waitMs = 10, maxAgeMs = 30_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let fd = null;
  while (fd === null) {
    try {
      fd = openSync(lockPath, "wx");
      writeFileSync(fd, String(process.pid));
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }
    if (lockIsStale(lockPath, maxAgeMs)) {
      const aside = `${lockPath}.stale.${process.pid}.${Math.random().toString(36).slice(2)}`;
      try {
        renameSync(lockPath, aside);
        unlinkSync(aside);
      } catch {
        /* another contender reclaimed it first */
      }
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for the job-state lock (${lockPath}).`);
    }
    busyWait(waitMs);
  }
  try {
    return fn();
  } finally {
    closeSync(fd);
    try {
      unlinkSync(lockPath);
    } catch {
      /* already gone */
    }
  }
}

function lockIsStale(lockPath, maxAgeMs) {
  try {
    if (Date.now() - statSync(lockPath).mtimeMs > maxAgeMs) return true;
    const owner = Number(readFileSync(lockPath, "utf8").trim());
    // An empty file is a holder between open and write: not stale.
    return Number.isInteger(owner) && owner > 0 && !pidAlive(owner);
  } catch {
    return false; // vanished: the next open attempt will tell
  }
}

function busyWait(ms) {
  // Synchronous sleep without burning CPU; lock contention is rare and short.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function stateLockPath(workspaceRoot) {
  return join(ensureDir(stateDir(workspaceRoot)), "state.lock");
}

export function readJobFile(workspaceRoot, jobId) {
  const path = jobFilePath(workspaceRoot, jobId);
  if (!existsSync(path)) return null;
  return readJson(path, null);
}

// index.json holds a compact summary per job.
const INDEX_FIELDS = [
  "id",
  "kind",
  "kindLabel",
  "title",
  "status",
  "phase",
  "summary",
  "pid",
  "grokPid",
  "sessionId",
  "createdAt",
  "startedAt",
  "completedAt",
  "updatedAt",
  "errorMessage",
  "timedOut",
  "idledOut",
  "stopReason",
];

function pickIndexFields(record) {
  const out = {};
  for (const key of INDEX_FIELDS) {
    if (record[key] !== undefined) out[key] = record[key];
  }
  return out;
}

export function listJobs(workspaceRoot) {
  const index = readJson(indexPath(workspaceRoot), { jobs: {} });
  return Object.values(index.jobs ?? {});
}

// The only way job state changes. Under the workspace lock: read the job file,
// let `mutate` derive the next record from the CURRENT one (never from a
// snapshot taken earlier), then write the file and its index row together.
// `mutate` returns null to leave the job untouched. Returns
// { job, changed } where job is the record now on disk.
export function updateJob(workspaceRoot, jobId, mutate) {
  return withLock(stateLockPath(workspaceRoot), () => {
    const current = readJobFile(workspaceRoot, jobId);
    const next = mutate(current);
    if (!next) return { job: current, changed: false };
    const record = { ...next, id: jobId, updatedAt: new Date().toISOString() };
    writeJson(jobFilePath(workspaceRoot, jobId), record);
    const path = indexPath(workspaceRoot);
    const index = readJson(path, { jobs: {} });
    index.jobs ??= {};
    index.jobs[jobId] = pickIndexFields(record);
    writeJson(path, index);
    return { job: record, changed: true };
  });
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

// Live AND still the process we recorded. A stored pid outlives its process,
// and once the OS reuses it, signalling it (or its group) would hit an
// unrelated program. `needle` is matched against the command line from ps.
export function pidMatches(pid, needle) {
  if (!pidAlive(pid)) return false;
  const res = spawnSync("ps", ["-o", "command=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: 5_000,
  });
  if (res.status !== 0) return false;
  return res.stdout.includes(needle);
}

// ----- config -----

function configPath(workspaceRoot) {
  return join(ensureDir(stateDir(workspaceRoot)), "config.json");
}

export function getConfig(workspaceRoot) {
  return readJson(configPath(workspaceRoot), {});
}

export function setConfig(workspaceRoot, key, value) {
  const config = getConfig(workspaceRoot);
  config[key] = value;
  writeJson(configPath(workspaceRoot), config);
  return config;
}
