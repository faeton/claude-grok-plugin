#!/usr/bin/env node
// Companion for driving the local `grok` CLI from a Claude Code plugin.
//
// Grok is used STRICTLY READ-ONLY here: consult and review are second-opinion
// tools, never agents. Every grok invocation removes and denies the mutating
// tools (Write/Edit/MultiEdit/NotebookEdit/Bash), disables subagents/memory, and
// runs under a wall-clock watchdog. Output is parsed from grok's JSON envelope so
// a relay cancellation surfaces as a real failure instead of silent empty stdout.
//
// Subcommands:
//   setup [--json]
//   consult [--background] [--file <p>]... [--model <id>] [--effort <lvl>]
//           [--timeout-ms <ms>] [--json] -- <question>
//   review  [--background] [--base <ref>] [--scope auto|working-tree|branch]
//           [--model <id>] [--timeout-ms <ms>] [--json]
//   adversarial-review [...same as review...] [focus text]
//   consult-worker --job-id <id>        (internal: detached background worker)
//   status [job-id] [--all] [--wait] [--timeout-ms <ms>] [--json]
//   result [job-id] [--json]
//   cancel [job-id] [--json]

import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import {
  buildConsultPrompt,
  buildReviewPrompt,
  collectReviewContext,
  ensureGitRepository,
  resolveReviewTarget,
} from "./lib/git.mjs";
import {
  DEFAULT_TIMEOUT_MS,
  effortArgs,
  getGrokAuthStatus,
  getGrokAvailability,
  killActiveGrok,
  readOnlyArgs,
  runGrok,
} from "./lib/grok.mjs";
import {
  createJob,
  resolveJob,
  reconcile,
  runTrackedJob,
  sortJobsNewestFirst,
  appendLog,
  currentSessionId,
} from "./lib/jobs.mjs";
import {
  getConfig,
  listJobs,
  readJobFile,
  resolveWorkspaceRoot,
  upsertJob,
  writeJobFile,
  pidAlive,
} from "./lib/state.mjs";
import {
  renderCancel,
  renderConsultResult,
  renderJobStatus,
  renderQueuedLaunch,
  renderReviewResult,
  renderSetup,
  renderStatusTable,
  renderStoredResult,
} from "./lib/render.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = dirname(SCRIPT_PATH);
const LOG_PATH = resolve(SCRIPT_DIR, "..", "logs", "companion.jsonl");

function logEvent(event) {
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    appendFileSync(
      LOG_PATH,
      JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ...event }) + "\n",
    );
  } catch {
    /* logging must never break a run */
  }
}

function out(value, asJson, rendered) {
  if (asJson) {
    process.stdout.write(JSON.stringify(value, null, 2) + "\n");
  } else {
    process.stdout.write(rendered ?? String(value));
  }
}

function normalizeArgv(argv) {
  if (argv.length === 1 && typeof argv[0] === "string") {
    const trimmed = argv[0].trim();
    if (!trimmed) return [];
    // A single blob from "$ARGUMENTS": split it shell-style.
    return splitRawArgumentString(argv[0]);
  }
  return argv;
}

function resolveCwd(options) {
  return options.cwd ? resolve(process.cwd(), options.cwd) : process.cwd();
}

function shorten(text, limit = 80) {
  const norm = String(text ?? "").replace(/\s+/g, " ").trim();
  return norm.length <= limit ? norm : norm.slice(0, limit - 1) + "…";
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- setup ----------

async function handleSetup(argv) {
  const { options } = parseArgs(normalizeArgv(argv), {
    valueOptions: ["cwd"],
    booleanOptions: ["json"],
  });
  const grok = getGrokAvailability();
  const auth = grok.available ? getGrokAuthStatus() : { loggedIn: false };
  const nextSteps = [];
  if (!grok.available) {
    nextSteps.push("Install the Grok CLI and ensure `grok` is on your PATH.");
  } else if (!auth.loggedIn) {
    nextSteps.push("Run `!grok login` to authenticate.");
  }
  const report = { ready: grok.available && auth.loggedIn, grok, auth, nextSteps };
  out(report, options.json, renderSetup(report));
}

// ---------- consult ----------

function parseConsultOptions(argv) {
  const { options, positionals } = parseArgs(normalizeArgv(argv), {
    valueOptions: ["model", "effort", "reasoning-effort", "timeout-ms", "cwd", "question"],
    repeatable: ["file"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: { m: "model" },
  });
  const cwd = resolveCwd(options);
  const question = options.question || positionals.join(" ").trim();
  return {
    cwd,
    json: Boolean(options.json),
    background: Boolean(options.background),
    model: options.model || null,
    effort: options.effort || null,
    reasoningEffort: options["reasoning-effort"] || null,
    timeoutMs: Number(options["timeout-ms"]) || DEFAULT_TIMEOUT_MS,
    files: options.file ?? [],
    question,
  };
}

async function runConsult(req, progress) {
  const prompt = buildConsultPrompt({ question: req.question, files: req.files, cwd: req.cwd });
  const eff = effortArgs(req);
  if (eff.dropped) progress?.({ message: eff.dropped });
  const args = [
    "-p",
    prompt,
    "--output-format",
    "json",
    "--permission-mode",
    "default",
    ...readOnlyArgs({ web: true }),
    ...eff.args,
  ];
  if (req.model) args.push("--model", req.model);

  progress?.({ phase: "asking", message: "Sending question to grok…" });
  const result = await runGrok(args, {
    cwd: req.cwd,
    timeoutMs: req.timeoutMs,
    onSpawn: ({ pid }) => progress?.({ grokPid: pid }),
  });
  return {
    ok: result.ok,
    exitCode: result.exitCode,
    stopReason: result.stopReason,
    errorMessage: result.errorMessage,
    summary: shorten(result.text || result.errorMessage || req.question),
    warning: result.warning,
    timedOut: result.timedOut,
    payload: {
      ok: result.ok,
      text: result.text,
      stopReason: result.stopReason,
      sessionId: result.sessionId,
      warning: result.warning,
      timedOut: result.timedOut,
      errorMessage: result.errorMessage,
      durationMs: result.durationMs,
    },
    rendered: renderConsultResult(result),
  };
}

async function handleConsult(argv) {
  const req = parseConsultOptions(argv);
  if (!req.question) {
    throw new Error('consult needs a question (positional text after "--" or --question "…").');
  }
  ensureGrokReady();
  const workspaceRoot = resolveWorkspaceRoot(req.cwd);
  const job = createJob({
    workspaceRoot,
    kind: "consult",
    kindLabel: "consult",
    title: "Grok Consult",
    summary: shorten(req.question),
    prefix: "consult",
    request: { subcommand: "consult", ...req },
  });

  if (req.background) {
    launchWorker(req.cwd, job.id);
    out({ jobId: job.id, status: "queued", title: job.title }, req.json, renderQueuedLaunch(job));
    return;
  }

  const execution = await runTrackedJob(job, (progress) => runConsult(req, progress));
  out(execution.payload, req.json, execution.rendered);
  if (!execution.ok) process.exitCode = execution.exitCode || 1;
}

// ---------- review ----------

function parseReviewOptions(argv) {
  const { options, positionals } = parseArgs(normalizeArgv(argv), {
    valueOptions: ["base", "scope", "model", "timeout-ms", "cwd"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: { m: "model" },
  });
  return {
    cwd: resolveCwd(options),
    json: Boolean(options.json),
    background: Boolean(options.background),
    base: options.base || null,
    scope: options.scope || "auto",
    model: options.model || null,
    timeoutMs: Number(options["timeout-ms"]) || DEFAULT_TIMEOUT_MS,
    focusText: positionals.join(" ").trim(),
  };
}

async function runReview(req, kind, progress) {
  ensureGitRepository(req.cwd);
  const target = resolveReviewTarget(req.cwd, { base: req.base, scope: req.scope });
  const context = collectReviewContext(req.cwd, target);
  if (context.empty) {
    return {
      ok: false,
      exitCode: 0,
      errorMessage: "No changes detected to review.",
      summary: "nothing to review",
      payload: { ok: false, errorMessage: "No changes detected to review.", target },
      rendered: "[grok] No changes detected to review.\n",
    };
  }
  const prompt = buildReviewPrompt(req.cwd, target, context, {
    focusText: kind === "adversarial-review" ? req.focusText : "",
  });
  const args = [
    "-p",
    prompt,
    "--output-format",
    "json",
    "--permission-mode",
    "default",
    ...readOnlyArgs({ web: false }),
  ];
  if (req.model) args.push("--model", req.model);

  progress?.({ phase: "reviewing", message: `Reviewing ${target.label}…` });
  const result = await runGrok(args, {
    cwd: req.cwd,
    timeoutMs: req.timeoutMs,
    onSpawn: ({ pid }) => progress?.({ grokPid: pid }),
  });
  return {
    ok: result.ok,
    exitCode: result.exitCode,
    stopReason: result.stopReason,
    errorMessage: result.errorMessage,
    summary: `${target.label}: ${shorten(result.text || result.errorMessage || "review", 50)}`,
    warning: result.warning,
    timedOut: result.timedOut,
    payload: {
      ok: result.ok,
      text: result.text,
      target,
      stopReason: result.stopReason,
      warning: result.warning,
      timedOut: result.timedOut,
      errorMessage: result.errorMessage,
      durationMs: result.durationMs,
    },
    rendered: renderReviewResult(result, { targetLabel: target.label }),
  };
}

async function handleReview(argv, kind = "review") {
  const req = parseReviewOptions(argv);
  ensureGrokReady();
  const workspaceRoot = resolveWorkspaceRoot(req.cwd);
  const title = kind === "adversarial-review" ? "Grok Adversarial Review" : "Grok Review";
  const job = createJob({
    workspaceRoot,
    kind,
    kindLabel: kind,
    title,
    summary: req.focusText ? shorten(req.focusText) : kind,
    prefix: "review",
    request: { subcommand: kind, ...req },
  });

  if (req.background) {
    launchWorker(req.cwd, job.id);
    out({ jobId: job.id, status: "queued", title: job.title }, req.json, renderQueuedLaunch(job));
    return;
  }

  const execution = await runTrackedJob(job, (progress) => runReview(req, kind, progress));
  out(execution.payload, req.json, execution.rendered);
  if (!execution.ok) process.exitCode = execution.exitCode || 1;
}

// ---------- background worker ----------

function launchWorker(cwd, jobId) {
  const child = spawn(process.execPath, [SCRIPT_PATH, "consult-worker", "--job-id", jobId, "--cwd", cwd], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
  });
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  // Only record the worker pid. Do NOT rewrite status/phase here: a fast worker
  // may already have advanced to running/terminal, and regressing it to queued
  // would corrupt the state machine.
  const stored = readJobFile(workspaceRoot, jobId);
  if (stored && stored.status === "queued") {
    writeJobFile(workspaceRoot, jobId, { ...stored, pid: child.pid ?? null });
    upsertJob(workspaceRoot, { id: jobId, pid: child.pid ?? null });
  }
  child.unref();
}

async function handleWorker(argv) {
  const { options } = parseArgs(normalizeArgv(argv), { valueOptions: ["job-id", "cwd"] });
  if (!options["job-id"]) throw new Error("consult-worker requires --job-id.");
  const cwd = resolveCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const stored = readJobFile(workspaceRoot, options["job-id"]);
  if (!stored || !stored.request) {
    throw new Error(`No stored request for job ${options["job-id"]}.`);
  }
  // If cancelled (worker receives SIGTERM), tear down the detached grok child
  // before exiting so it does not orphan, then mark the job cancelled.
  const onSignal = () => {
    killActiveGrok("SIGTERM");
    const latest = readJobFile(workspaceRoot, stored.id) ?? stored;
    if (latest.status === "running" || latest.status === "queued") {
      const cancelled = {
        ...latest,
        status: "cancelled",
        phase: "cancelled",
        pid: null,
        grokPid: null,
        completedAt: new Date().toISOString(),
        errorMessage: "Cancelled by user.",
      };
      writeJobFile(workspaceRoot, stored.id, cancelled);
      upsertJob(workspaceRoot, cancelled);
    }
    process.exit(130);
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  const req = stored.request;
  const runner = (progress) =>
    req.subcommand === "consult" ? runConsult(req, progress) : runReview(req, req.subcommand, progress);
  await runTrackedJob({ ...stored, workspaceRoot }, runner);
}

// ---------- status / result / cancel ----------

function visibleJobs(workspaceRoot, { all }) {
  let jobs = sortJobsNewestFirst(listJobs(workspaceRoot)).map((j) => reconcile(workspaceRoot, j));
  if (!all) {
    const sid = currentSessionId();
    if (sid) {
      const scoped = jobs.filter((j) => j.sessionId === sid);
      if (scoped.length) jobs = scoped;
    }
  }
  return jobs;
}

async function handleStatus(argv) {
  const { options, positionals } = parseArgs(normalizeArgv(argv), {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"],
  });
  const cwd = resolveCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const reference = positionals[0];

  if (reference) {
    let job = resolveJob(workspaceRoot, reference);
    if (options.wait) {
      const deadline = Date.now() + (Number(options["timeout-ms"]) || 240000);
      const interval = Number(options["poll-interval-ms"]) || 2000;
      while ((job.status === "queued" || job.status === "running") && Date.now() < deadline) {
        await sleep(Math.min(interval, Math.max(0, deadline - Date.now())));
        job = resolveJob(workspaceRoot, reference);
      }
    }
    out(job, options.json, renderJobStatus(job));
    return;
  }
  if (options.wait) throw new Error("`status --wait` requires a job id.");
  const jobs = visibleJobs(workspaceRoot, { all: options.all });
  out({ jobs }, options.json, renderStatusTable(jobs));
}

function handleResult(argv) {
  const { options, positionals } = parseArgs(normalizeArgv(argv), {
    valueOptions: ["cwd"],
    booleanOptions: ["json"],
  });
  const workspaceRoot = resolveWorkspaceRoot(resolveCwd(options));
  const summary = resolveJob(workspaceRoot, positionals[0]);
  const full = readJobFile(workspaceRoot, summary.id) ?? summary;
  out(full, options.json, renderStoredResult(full));
}

function handleCancel(argv) {
  const { options, positionals } = parseArgs(normalizeArgv(argv), {
    valueOptions: ["cwd"],
    booleanOptions: ["json"],
  });
  const workspaceRoot = resolveWorkspaceRoot(resolveCwd(options));
  const job = resolveJob(workspaceRoot, positionals[0]);
  // Signal the worker (which tears down its grok child via SIGTERM handler), and
  // also directly kill the detached grok process group as a backstop in case the
  // worker is wedged.
  signalPidGroup(job.pid, "SIGTERM");
  signalPidGroup(job.grokPid, "SIGTERM");
  const stored = readJobFile(workspaceRoot, job.id) ?? job;
  const cancelled = {
    ...stored,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt: new Date().toISOString(),
    errorMessage: "Cancelled by user.",
  };
  writeJobFile(workspaceRoot, job.id, cancelled);
  upsertJob(workspaceRoot, cancelled);
  appendLog(stored.logFile, "Cancelled by user.");
  out({ jobId: job.id, status: "cancelled" }, options.json, renderCancel(job));
}

// ---------- shared ----------

function signalPidGroup(pid, signal) {
  if (!pid || !pidAlive(pid)) return;
  try {
    process.kill(-pid, signal); // process group
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
}

function ensureGrokReady() {
  const grok = getGrokAvailability();
  if (!grok.available) {
    throw new Error("grok CLI not found on PATH. Run `/grok:setup` for guidance.");
  }
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  const runId = `${Date.now().toString(36)}-${process.pid.toString(36)}`;
  logEvent({ event: "start", run_id: runId, sub: subcommand, cwd: process.cwd() });
  const startedAt = Date.now();

  try {
    switch (subcommand) {
      case "setup":
        await handleSetup(argv);
        break;
      case "consult":
        await handleConsult(argv);
        break;
      case "review":
        await handleReview(argv, "review");
        break;
      case "adversarial-review":
        await handleReview(argv, "adversarial-review");
        break;
      case "consult-worker":
        await handleWorker(argv);
        break;
      case "status":
        await handleStatus(argv);
        break;
      case "result":
        handleResult(argv);
        break;
      case "cancel":
        handleCancel(argv);
        break;
      case undefined:
      case "help":
      case "--help":
        process.stdout.write(usage());
        break;
      default:
        throw new Error(`Unknown subcommand: ${subcommand}`);
    }
    logEvent({ event: "exit", run_id: runId, ok: true, duration_ms: Date.now() - startedAt });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[grok-companion] ${message}\n`);
    logEvent({ event: "exit", run_id: runId, ok: false, error: message, duration_ms: Date.now() - startedAt });
    process.exitCode = 1;
  }
}

function usage() {
  return [
    "Usage:",
    "  grok-companion.mjs setup [--json]",
    '  grok-companion.mjs consult [--background] [--file <p>]... [--model <id>] [--timeout-ms <ms>] [--json] -- <question>',
    "  grok-companion.mjs review [--background] [--base <ref>] [--scope auto|working-tree|branch] [--model <id>] [--json]",
    "  grok-companion.mjs adversarial-review [...review flags...] [focus text]",
    "  grok-companion.mjs status [job-id] [--all] [--wait] [--json]",
    "  grok-companion.mjs result [job-id] [--json]",
    "  grok-companion.mjs cancel [job-id] [--json]",
    "",
  ].join("\n");
}

main();
