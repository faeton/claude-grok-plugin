// Job lifecycle: create, run-with-tracking, snapshot, resolve for status/result/cancel.

import { appendFileSync, writeFileSync } from "node:fs";
import {
  generateJobId,
  jobFilePath,
  logFilePath,
  readJobFile,
  writeJobFile,
  upsertJob,
  listJobs,
  pidAlive,
} from "./state.mjs";

export const SESSION_ID_ENV = "GROK_COMPANION_SESSION_ID";

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
    request: request ?? null,
    createdAt: nowIso(),
    ...(sessionId ? { sessionId } : {}),
  };
  writeJobFile(workspaceRoot, id, record);
  upsertJob(workspaceRoot, record);
  return record;
}

// Run `runner` (an async fn returning an execution result) while keeping the job
// file + index in sync. The runner result shape:
//   { ok, exitCode, payload, rendered, summary, stopReason }
export async function runTrackedJob(job, runner, { onProgress } = {}) {
  const running = {
    ...job,
    status: "running",
    phase: "running",
    pid: process.pid,
    startedAt: nowIso(),
  };
  writeJobFile(job.workspaceRoot, job.id, running);
  upsertJob(job.workspaceRoot, running);
  appendLog(job.logFile, `Running ${job.title}.`);

  try {
    const execution = await runner((event) => {
      if (event?.phase) {
        upsertJob(job.workspaceRoot, { id: job.id, phase: event.phase });
      }
      if (event?.grokPid) {
        upsertJob(job.workspaceRoot, { id: job.id, grokPid: event.grokPid });
      }
      if (event?.message) appendLog(job.logFile, event.message);
      onProgress?.(event);
    });

    const status = execution.ok ? "completed" : "failed";
    const completedAt = nowIso();
    const stored = {
      ...running,
      status,
      phase: execution.ok ? "done" : "failed",
      pid: null,
      completedAt,
      stopReason: execution.stopReason ?? null,
      summary: execution.summary ?? running.summary,
      errorMessage: execution.ok ? null : execution.errorMessage ?? "Run failed.",
      result: execution.payload,
      rendered: execution.rendered,
    };
    writeJobFile(job.workspaceRoot, job.id, stored);
    upsertJob(job.workspaceRoot, stored);
    appendLogBlock(job.logFile, "Final output", execution.rendered);
    return execution;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const existing = readJobFile(job.workspaceRoot, job.id) ?? running;
    const completedAt = nowIso();
    const stored = {
      ...existing,
      status: "failed",
      phase: "failed",
      pid: null,
      completedAt,
      errorMessage: message,
    };
    writeJobFile(job.workspaceRoot, job.id, stored);
    upsertJob(job.workspaceRoot, stored);
    appendLog(job.logFile, `Failed: ${message}`);
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

// Reconcile a job marked running/queued whose worker pid is dead: persist it as
// failed/orphaned so status, result, and the index all agree. Without the
// persist, `status` would show failed (in-memory) while `result` re-read the
// stale running record and claimed "no output yet".
export function reconcile(workspaceRoot, job) {
  if ((job.status === "running" || job.status === "queued") && !pidAlive(job.pid)) {
    const failed = {
      ...(readJobFile(workspaceRoot, job.id) ?? job),
      status: "failed",
      phase: "orphaned",
      pid: null,
      completedAt: job.completedAt ?? nowIso(),
      errorMessage: job.errorMessage ?? "Worker process exited without finishing.",
    };
    writeJobFile(workspaceRoot, job.id, failed);
    upsertJob(workspaceRoot, failed);
    return failed;
  }
  return job;
}

export function resolveJob(workspaceRoot, reference) {
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  if (reference) {
    const match = jobs.find((j) => j.id === reference);
    if (!match) throw new Error(`No job found with id ${reference}.`);
    return reconcile(workspaceRoot, match);
  }
  if (jobs.length === 0) throw new Error("No Grok jobs found for this workspace.");
  return reconcile(workspaceRoot, jobs[0]);
}
