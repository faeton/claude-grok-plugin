// Job lifecycle: create, run-with-tracking, snapshot, resolve for status/result/cancel.
//
// Every state change is a guarded transition through updateJob(): it re-reads
// the job under the workspace lock and only applies when the job is still in an
// allowed source status. That is what keeps the state machine one-way:
//
//   queued ──▶ running ──▶ completed | failed
//      │          │
//      └──────────┴──────▶ cancelled | failed (orphaned)
//
// Terminal states never change again, so a late or stale writer (a slow
// launcher, a cancel racing a finish, a reconcile reading an old index row)
// becomes a no-op instead of rolling a finished job backwards.

import { appendFileSync, writeFileSync } from "node:fs";
import {
  generateJobId,
  logFilePath,
  readJobFile,
  updateJob,
  listJobs,
  pidAlive,
} from "./state.mjs";

export const SESSION_ID_ENV = "GROK_COMPANION_SESSION_ID";

export const ACTIVE_STATUSES = new Set(["queued", "running"]);
export const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

// A queued job has no worker pid until launchWorker records one, so "no pid"
// only means "dead" once the job has had time to start.
export const START_GRACE_MS = 30_000;

export function nowIso() {
  return new Date().toISOString();
}

export function currentSessionId(env = process.env) {
  return env[SESSION_ID_ENV] ?? null;
}

export function appendLog(logFile, message) {
  const normalized = String(message ?? "").trim();
  if (!logFile || !normalized) return;
  try {
    appendFileSync(logFile, `[${nowIso()}] ${normalized}\n`, "utf8");
  } catch {
    /* logging is best-effort */
  }
}

export function appendLogBlock(logFile, title, body) {
  if (!logFile || !body) return;
  try {
    appendFileSync(logFile, `\n[${nowIso()}] ${title}\n${String(body).trimEnd()}\n`, "utf8");
  } catch {
    /* best-effort */
  }
}

// Apply `patch` (an object, or a fn of the current record) only while the job's
// status is one of `from`. Returns { job, changed }.
export function transition(workspaceRoot, jobId, from, patch) {
  const allowed = new Set(from);
  return updateJob(workspaceRoot, jobId, (current) => {
    if (!current || !allowed.has(current.status)) return null;
    const delta = typeof patch === "function" ? patch(current) : patch;
    return delta ? { ...current, ...delta } : null;
  });
}

export function createJob({ workspaceRoot, kind, kindLabel, title, summary, prefix, request }) {
  const id = generateJobId(prefix ?? "grok");
  const sessionId = currentSessionId();
  const logFile = logFilePath(workspaceRoot, id);
  writeFileSync(logFile, "", "utf8");
  const record = {
    id,
    kind,
    kindLabel: kindLabel ?? kind,
    title,
    summary: summary ?? "",
    status: "queued",
    phase: "queued",
    workspaceRoot,
    logFile,
    pid: null,
    grokPid: null,
    request: request ?? null,
    createdAt: nowIso(),
    ...(sessionId ? { sessionId } : {}),
  };
  return updateJob(workspaceRoot, id, () => record).job;
}

// Run `runner` (an async fn returning an execution result) while keeping the job
// file + index in sync. The runner result shape:
//   { ok, exitCode, payload, rendered, summary, stopReason }
//
// Returns null without running when the job is no longer queued (e.g. it was
// cancelled before its worker got going).
export async function runTrackedJob(job, runner, { onProgress } = {}) {
  const { workspaceRoot, id } = job;
  const started = transition(workspaceRoot, id, ["queued"], {
    status: "running",
    phase: "running",
    pid: process.pid,
    startedAt: nowIso(),
  });
  if (!started.changed) return null;
  const running = started.job;
  appendLog(running.logFile, `Running ${running.title}.`);

  try {
    const execution = await runner((event) => {
      const patch = {};
      if (event?.phase) patch.phase = event.phase;
      if (event?.grokPid) patch.grokPid = event.grokPid;
      if (Object.keys(patch).length) transition(workspaceRoot, id, ["running"], patch);
      if (event?.message) appendLog(running.logFile, event.message);
      onProgress?.(event);
    });

    const finished = transition(workspaceRoot, id, ["running"], {
      status: execution.ok ? "completed" : "failed",
      phase: execution.ok ? "done" : "failed",
      pid: null,
      grokPid: null,
      completedAt: nowIso(),
      stopReason: execution.stopReason ?? null,
      // Persisted so timeouts can be counted directly instead of being inferred
      // from durationMs or the error string (which silently conflates runs that
      // used a custom --timeout with the default watchdog).
      timedOut: execution.timedOut ?? false,
      // Recorded separately: an idle kill also sets timedOut, so without this a
      // stalled relay is indistinguishable from hitting the wall-clock backstop.
      idledOut: execution.idledOut ?? false,
      warning: execution.warning ?? null,
      summary: execution.summary ?? running.summary,
      errorMessage: execution.ok ? null : execution.errorMessage ?? "Run failed.",
      result: execution.payload,
      rendered: execution.rendered,
    });
    if (!finished.changed) {
      // Cancelled while grok was running. Keep the cancellation, but hold on to
      // any answer text that arrived so /grok:result can still show it. The
      // "exited with code 143" failure caused by the cancel itself is not kept.
      transition(workspaceRoot, id, ["cancelled"], (current) =>
        current.rendered || !execution.payload?.text
          ? null
          : { result: execution.payload, rendered: execution.rendered },
      );
    }
    appendLogBlock(running.logFile, "Final output", execution.rendered);
    return execution;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    transition(workspaceRoot, id, ["running"], {
      status: "failed",
      phase: "failed",
      pid: null,
      grokPid: null,
      completedAt: nowIso(),
      errorMessage: message,
    });
    appendLog(running.logFile, `Failed: ${message}`);
    throw error;
  }
}

export function sortJobsNewestFirst(jobs) {
  return [...jobs].sort((a, b) => {
    const at = Date.parse(a.updatedAt ?? a.createdAt ?? 0) || 0;
    const bt = Date.parse(b.updatedAt ?? b.createdAt ?? 0) || 0;
    return bt - at;
  });
}

// Is this active job's worker gone? Decided from the job FILE, never the index:
// the index can lag (it is the summary), and acting on a lagging row is how a
// just-finished job used to get relabelled as orphaned.
function workerIsDead(job, now = Date.now()) {
  if (Number.isInteger(job.pid)) return !pidAlive(job.pid);
  const created = Date.parse(job.createdAt ?? "") || 0;
  return now - created > START_GRACE_MS;
}

// Reconcile a queued/running job whose worker is dead: persist it as
// failed/orphaned so status, result, and the index all agree. Also repairs an
// index row that lags the job file. Returns the up-to-date record.
export function reconcile(workspaceRoot, job) {
  const { job: current } = transition(
    workspaceRoot,
    job.id,
    ["queued", "running"],
    (latest) =>
      workerIsDead(latest)
        ? {
            status: "failed",
            phase: "orphaned",
            pid: null,
            grokPid: null,
            completedAt: latest.completedAt ?? nowIso(),
            errorMessage: latest.errorMessage ?? "Worker process exited without finishing.",
          }
        : null,
  );
  if (!current) return job; // no job file at all: nothing better to show
  if (current.status !== job.status) {
    // The index row was stale (e.g. a lost update). Rewrite it from the file.
    updateJob(workspaceRoot, job.id, (latest) => latest);
  }
  return current;
}

// preferActive: with no reference, pick the newest still-active job (what a bare
// cancel means) and fall back to the newest job overall.
export function resolveJob(workspaceRoot, reference, { preferActive = false } = {}) {
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  if (reference) {
    const match = jobs.find((j) => j.id === reference);
    if (!match) throw new Error(`No job found with id ${reference}.`);
    return reconcile(workspaceRoot, match);
  }
  if (jobs.length === 0) throw new Error("No Grok jobs found for this workspace.");
  if (preferActive) {
    const active = jobs.find((j) => ACTIVE_STATUSES.has(j.status));
    if (active) return reconcile(workspaceRoot, active);
  }
  return reconcile(workspaceRoot, jobs[0]);
}
