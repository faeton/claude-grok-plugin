// On-disk job registry + config for the Grok companion.
//
// State lives OUTSIDE the user's repo (so consult/review never dirty the working
// tree) under ~/.grok/companion/<workspace-slug>/:
//   jobs/<id>.json   full per-job record (request + result)
//   logs/<id>.log    human-readable progress log
//   index.json       lightweight list of all jobs (newest-relevant fields)
//   config.json      per-workspace config (e.g. default model)

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

const ROOT = resolve(homedir(), ".grok", "companion");

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

// Best-effort exclusive lock via O_EXCL, with a short spin. Used to serialize
// read-modify-write on the shared index so concurrent workers don't lose
// updates. Stale locks (older than maxAgeMs) are reclaimed.
function withLock(lockPath, fn, { tries = 50, waitMs = 20, maxAgeMs = 10_000 } = {}) {
  let fd = null;
  for (let i = 0; i < tries; i++) {
    try {
      fd = openSync(lockPath, "wx");
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      try {
        const ageMs = Date.now() - statMtime(lockPath);
        if (ageMs > maxAgeMs) {
          unlinkSync(lockPath);
          continue;
        }
      } catch {
        /* lock vanished; retry */
      }
      busyWait(waitMs);
    }
  }
  try {
    return fn();
  } finally {
    if (fd !== null) {
      closeSync(fd);
      try {
        unlinkSync(lockPath);
      } catch {
        /* already gone */
      }
    }
  }
}

function statMtime(path) {
  return statSync(path).mtimeMs;
}

function busyWait(ms) {
  // Synchronous sleep without burning CPU; lock contention is rare and short.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function writeJobFile(workspaceRoot, jobId, record) {
  writeJson(jobFilePath(workspaceRoot, jobId), record);
  return record;
}

export function readJobFile(workspaceRoot, jobId) {
  const path = jobFilePath(workspaceRoot, jobId);
  if (!existsSync(path)) return null;
  return readJson(path, null);
}

// index.json holds a compact summary per job. upsertJob merges a patch in.
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

export function upsertJob(workspaceRoot, patch) {
  if (!patch || !patch.id) throw new Error("upsertJob requires an id.");
  const path = indexPath(workspaceRoot);
  return withLock(`${path}.lock`, () => {
    const index = readJson(path, { jobs: {} });
    index.jobs ??= {};
    const merged = {
      ...(index.jobs[patch.id] ?? {}),
      ...pickIndexFields(patch),
      updatedAt: new Date().toISOString(),
    };
    index.jobs[patch.id] = merged;
    writeJson(path, index);
    return merged;
  });
}

// Reconcile: a job marked running/queued whose pid is gone is actually dead.
export function pidAlive(pid) {
  if (!pid || Number.isNaN(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
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
