#!/usr/bin/env node
// Companion for driving the local `grok` CLI from a Claude Code plugin.
//
// Grok is used STRICTLY READ-ONLY here: consult and review are second-opinion
// tools, never agents. Every grok invocation allowlists read-only tools, removes
// the mutating ones and the MCP meta-tools, denies writes/shell/MCP at the
// permission layer, refuses anything needing approval (dontAsk), and runs under
// the OS read-only sandbox (when grok can apply it) — see readOnlyArgs in
// lib/grok.mjs. Memory is disabled, and runs are bounded by both an idle timer and a wall-clock backstop. Output is parsed from grok's
// streaming-json events so a stall or cancellation surfaces as a real failure
// instead of silent empty stdout — and, just as importantly, so a completed
// answer is never discarded because of an unrecognized stopReason.
//
// Subcommands:
//   setup [--json]
//   consult [--background] [--file <p>]... [--profile <p>] [--model <id>] [--effort <lvl>]
//           [--timeout-ms <ms>] [--idle-ms <ms>] [--json] -- <question>
//   review  [--background] [--base <ref>] [--scope auto|working-tree|branch]
//           [--profile <p>] [--model <id>] [--effort <lvl>] [--timeout-ms <ms>] [--idle-ms <ms>] [--json]
//   adversarial-review [...same as review...] [focus text]
//   consult-worker --job-id <id>        (internal: detached background worker)
//   status [job-id] [--all] [--wait] [--timeout-ms <ms>] [--json]
//   result [job-id] [--json]
//   cancel [job-id] [--json]

import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
  DEFAULT_IDLE_MS,
  DEFAULT_TIMEOUT_MS,
  PROMPT_DIR_PREFIX,
  effortArgs,
  getGrokAuthStatus,
  getGrokAvailability,
  readOnlyArgs,
  resolveModel,
  resolveProfile,
  runGrok,
  sandboxAvailability,
  terminateActiveGrok,
  terminateGroups,
} from "./lib/grok.mjs";
import {
  ACTIVE_STATUSES,
  createJob,
  resolveJob,
  reconcile,
  runTrackedJob,
  sortJobsNewestFirst,
  appendLog,
  currentSessionId,
  nowIso,
  transition,
} from "./lib/jobs.mjs";
import { ROOT, listJobs, pidMatches, readJobFile, resolveWorkspaceRoot } from "./lib/state.mjs";
import {
  renderCancel,
  renderConsultResult,
  renderJobStatus,
  renderQueuedLaunch,
  renderReviewResult,
  renderSetup,
  renderStatusTable,
  renderStoredResult,
  reasoningTail,
} from "./lib/render.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
// Next to the job registry, never inside the plugin directory: run from a
// checkout, that put a log file in the user's repo.
const LOG_PATH = join(ROOT, "companion.jsonl");

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

// Millisecond flags. A bad value is an error, not a silent default: a negative
// timeout used to reach setTimeout and kill the run immediately, and `0`
// quietly became 15 minutes. `allowZero` is for --idle-ms, where 0 is the
// documented off-switch.
function parseMs(raw, name, fallback, { allowZero = false } = {}) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || (n === 0 && !allowZero)) {
    throw new Error(
      `--${name} must be a ${allowZero ? "non-negative" : "positive"} number of milliseconds (got "${raw}").`,
    );
  }
  return n;
}

// Status listings carry the summary fields only — not the stored request,
// payload and rendered output, which can be hundreds of kilobytes.
function jobSummary(job) {
  const { request, result, rendered, ...rest } = job;
  return rest;
}

// Map a streaming-json ACP event onto a job-progress update.
//
// Deliberately selective: every progress event with a `message` appends to the
// job log, and answer text arrives as a long sequence of `text` chunks. Echoing
// those would rewrite the log on every token, so only tool activity and errors
// are surfaced — the answer itself is recorded once at the end.
function streamPhase(event) {
  switch (event?.type) {
    case "tool_call":
      return { message: `→ ${shorten(event.title || event.toolName || "tool", 60)}` };
    case "error":
      return { message: `grok error: ${shorten(event.message, 200)}` };
    case "end":
      return { phase: "finishing" };
    default:
      return {};
  }
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
  const sandbox = sandboxAvailability();
  if (!sandbox.available) {
    nextSteps.push(
      sandbox.required
        ? "Install bubblewrap (`bwrap`) or put a standalone binary on PATH — GROK_COMPANION_REQUIRE_SANDBOX=1 makes runs fail without it."
        : "Optional: install bubblewrap (`bwrap`) so grok runs under its OS read-only sandbox; without it runs proceed unsandboxed with a warning.",
    );
  }
  const ready = grok.available && auth.loggedIn && (sandbox.available || !sandbox.required);
  const report = { ready, grok, auth, sandbox, nextSteps };
  out(report, options.json, renderSetup(report));
}

// ---------- consult ----------

function parseConsultOptions(argv) {
  const { options, positionals } = parseArgs(normalizeArgv(argv), {
    valueOptions: [
      "model",
      "profile",
      "effort",
      "reasoning-effort",
      "timeout-ms",
      "idle-ms",
      "cwd",
      "question",
    ],
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
    profile: options.profile || null,
    effort: options.effort || null,
    reasoningEffort: options["reasoning-effort"] || null,
    timeoutMs: parseMs(options["timeout-ms"], "timeout-ms", DEFAULT_TIMEOUT_MS),
    idleMs: parseMs(options["idle-ms"], "idle-ms", DEFAULT_IDLE_MS, { allowZero: true }),
    files: options.file ?? [],
    question,
  };
}

async function runConsult(req, progress) {
  const prompt = buildConsultPrompt({ question: req.question, files: req.files, cwd: req.cwd });
  const eff = effortArgs(req);
  if (eff.dropped) progress?.({ message: eff.dropped });
  const sandbox = sandboxAvailability();
  if (sandbox.warning) progress?.({ message: sandbox.warning });
  const args = [
    // streaming-json (not `stream-json`) so a stalled relay is visible as an
    // absence of events rather than an 8-minute silence.
    "--output-format",
    "streaming-json",
    ...readOnlyArgs({ web: true, sandbox: sandbox.available || sandbox.required }),
    ...eff.args,
  ];
  const model = resolveModel(req.model, req.profile);
  if (model) args.push("--model", model);

  progress?.({ phase: "asking", message: "Sending question to grok…" });
  const result = await runGrok(args, {
    prompt,
    cwd: req.cwd,
    timeoutMs: req.timeoutMs,
    idleMs: req.idleMs,
    onProgress: (event) => progress?.(streamPhase(event)),
    onSpawn: ({ pid }) => progress?.({ grokPid: pid }),
  });
  if (sandbox.warning) {
    result.warning = [sandbox.warning, result.warning].filter(Boolean).join(" ");
  }
  return {
    ok: result.ok,
    exitCode: result.exitCode,
    stopReason: result.stopReason,
    errorMessage: result.errorMessage,
    summary: shorten(result.text || result.errorMessage || req.question),
    warning: result.warning,
    timedOut: result.timedOut,
    idledOut: result.idledOut,
    payload: {
      ok: result.ok,
      text: result.text,
      stopReason: result.stopReason,
      sessionId: result.sessionId,
      model,
      profile: resolveProfile(req.profile).name,
      effort: eff.args[1] ?? null,
      toolCalls: result.toolCalls,
      warning: result.warning,
      timedOut: result.timedOut,
      idledOut: result.idledOut,
      errorMessage: result.errorMessage,
      durationMs: result.durationMs,
      ...(result.ok ? {} : { reasoningTail: reasoningTail(result.thought) || null }),
    },
    rendered: renderConsultResult(result),
  };
}

async function handleConsult(argv) {
  const req = parseConsultOptions(argv);
  resolveProfile(req.profile); // a bad --profile fails now, not in a background worker
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

  installCancelHandlers(workspaceRoot, job.id);
  const execution = await runTrackedJob(job, (progress) => runConsult(req, progress));
  out(execution.payload, req.json, execution.rendered);
  if (!execution.ok) process.exitCode = execution.exitCode || 1;
}

// ---------- review ----------

function parseReviewOptions(argv) {
  const { options, positionals } = parseArgs(normalizeArgv(argv), {
    valueOptions: [
      "base",
      "scope",
      "model",
      "profile",
      "effort",
      "reasoning-effort",
      "timeout-ms",
      "idle-ms",
      "cwd",
    ],
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
    profile: options.profile || null,
    effort: options.effort || null,
    reasoningEffort: options["reasoning-effort"] || null,
    timeoutMs: parseMs(options["timeout-ms"], "timeout-ms", DEFAULT_TIMEOUT_MS),
    idleMs: parseMs(options["idle-ms"], "idle-ms", DEFAULT_IDLE_MS, { allowZero: true }),
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
  const eff = effortArgs(req);
  if (eff.dropped) progress?.({ message: eff.dropped });
  const sandbox = sandboxAvailability();
  if (sandbox.warning) progress?.({ message: sandbox.warning });
  const args = [
    "--output-format",
    "streaming-json",
    ...readOnlyArgs({ web: false, sandbox: sandbox.available || sandbox.required }),
    ...eff.args,
  ];
  const model = resolveModel(req.model, req.profile);
  if (model) args.push("--model", model);

  progress?.({ phase: "reviewing", message: `Reviewing ${target.label}…` });
  const result = await runGrok(args, {
    prompt,
    cwd: req.cwd,
    timeoutMs: req.timeoutMs,
    idleMs: req.idleMs,
    onProgress: (event) => progress?.(streamPhase(event)),
    onSpawn: ({ pid }) => progress?.({ grokPid: pid }),
  });
  if (sandbox.warning) {
    result.warning = [sandbox.warning, result.warning].filter(Boolean).join(" ");
  }
  return {
    ok: result.ok,
    exitCode: result.exitCode,
    stopReason: result.stopReason,
    errorMessage: result.errorMessage,
    summary: `${target.label}: ${shorten(result.text || result.errorMessage || "review", 50)}`,
    warning: result.warning,
    timedOut: result.timedOut,
    idledOut: result.idledOut,
    payload: {
      ok: result.ok,
      text: result.text,
      target,
      stopReason: result.stopReason,
      sessionId: result.sessionId,
      model,
      profile: resolveProfile(req.profile).name,
      effort: eff.args[1] ?? null,
      toolCalls: result.toolCalls,
      warning: result.warning,
      timedOut: result.timedOut,
      idledOut: result.idledOut,
      errorMessage: result.errorMessage,
      durationMs: result.durationMs,
      ...(result.ok ? {} : { reasoningTail: reasoningTail(result.thought) || null }),
    },
    rendered: renderReviewResult(result, { targetLabel: target.label }),
  };
}

async function handleReview(argv, kind = "review") {
  const req = parseReviewOptions(argv);
  resolveProfile(req.profile);
  // Fail on a bad --scope / --base now, before a background job is queued for it.
  ensureGitRepository(req.cwd);
  resolveReviewTarget(req.cwd, { base: req.base, scope: req.scope });
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

  installCancelHandlers(workspaceRoot, job.id);
  const execution = await runTrackedJob(job, (progress) => runReview(req, kind, progress));
  out(execution.payload, req.json, execution.rendered);
  if (!execution.ok) process.exitCode = execution.exitCode || 1;
}

// ---------- background worker ----------

// Identifies our own processes in `ps` before anything signals a stored pid.
const WORKER_MARK = "grok-companion.mjs";

function launchWorker(cwd, jobId) {
  const child = spawn(process.execPath, [SCRIPT_PATH, "consult-worker", "--job-id", jobId, "--cwd", cwd], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
  });
  // Record the worker pid only while the job is still queued with no pid. A
  // fast worker may already be running (and has written its own pid); writing
  // over it from here is how a finished job used to roll back to queued.
  transition(resolveWorkspaceRoot(cwd), jobId, ["queued"], (current) =>
    current.pid == null && child.pid ? { pid: child.pid } : null,
  );
  child.unref();
}

// SIGTERM / SIGINT / SIGHUP: stop grok (escalating to SIGKILL), then record the
// cancellation. Installed for foreground runs as well as workers — grok runs in
// its own process group, so Ctrl-C on a foreground run used to kill only the
// companion and leave grok running.
function installCancelHandlers(workspaceRoot, jobId) {
  let stopping = false;
  const onSignal = async (signal) => {
    if (stopping) return;
    stopping = true;
    // Record the cancellation BEFORE killing grok: once grok dies, the run
    // resolves and would otherwise record the kill as a `failed` job first.
    const { changed, job } = transition(workspaceRoot, jobId, ["queued", "running"], {
      status: "cancelled",
      phase: "cancelled",
      pid: null,
      grokPid: null,
      completedAt: nowIso(),
      errorMessage: `Cancelled (${signal}).`,
    });
    if (changed) appendLog(job.logFile, `Cancelled (${signal}).`);
    await terminateActiveGrok();
    process.exit(130);
  };
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, onSignal);
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
  // Cancelled (or reconciled) before this worker got going: do not run it.
  if (stored.status !== "queued") return;
  installCancelHandlers(workspaceRoot, stored.id);

  const req = stored.request;
  const runner = (progress) =>
    req.subcommand === "consult" ? runConsult(req, progress) : runReview(req, req.subcommand, progress);
  await runTrackedJob({ ...stored, workspaceRoot }, runner);
}

// ---------- status / result / cancel ----------

function visibleJobs(workspaceRoot, { all }) {
  let jobs = sortJobsNewestFirst(listJobs(workspaceRoot))
    .map((j) => reconcile(workspaceRoot, j))
    .map(jobSummary);
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
      const deadline = Date.now() + parseMs(options["timeout-ms"], "timeout-ms", 240_000);
      const interval = parseMs(options["poll-interval-ms"], "poll-interval-ms", 2_000);
      while (ACTIVE_STATUSES.has(job.status) && Date.now() < deadline) {
        await sleep(Math.min(interval, Math.max(0, deadline - Date.now())));
        job = resolveJob(workspaceRoot, reference);
      }
    }
    out(jobSummary(job), options.json, renderJobStatus(job));
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
  const job = resolveJob(workspaceRoot, positionals[0]);
  out(job, options.json, renderStoredResult(job));
}

async function handleCancel(argv) {
  const { options, positionals } = parseArgs(normalizeArgv(argv), {
    valueOptions: ["cwd"],
    booleanOptions: ["json"],
  });
  const workspaceRoot = resolveWorkspaceRoot(resolveCwd(options));
  const job = resolveJob(workspaceRoot, positionals[0]);
  // Record the cancellation first, and only for a job that is still active: a
  // finished job is left alone (cancel with no id picks the newest job, which
  // used to rewrite a completed review as cancelled and hide its output).
  const { changed, job: latest } = transition(workspaceRoot, job.id, ["queued", "running"], {
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    grokPid: null,
    completedAt: nowIso(),
    errorMessage: "Cancelled by user.",
  });
  if (!changed) {
    out(
      { jobId: job.id, status: latest?.status ?? job.status, cancelled: false },
      options.json,
      renderCancel(latest ?? job, { cancelled: false }),
    );
    return;
  }
  appendLog(latest.logFile, "Cancelled by user.");
  // Stop the worker (its handler tears down grok) and, as a backstop, grok's own
  // group — but only pids that are verifiably still ours: a stored pid can have
  // been reused by an unrelated process since it was recorded.
  const pids = [];
  if (pidMatches(job.pid, WORKER_MARK)) pids.push(job.pid);
  if (pidMatches(job.grokPid, PROMPT_DIR_PREFIX)) pids.push(job.grokPid);
  await terminateGroups(pids);
  out({ jobId: job.id, status: "cancelled", cancelled: true }, options.json, renderCancel(latest));
}

// ---------- shared ----------

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
        await handleCancel(argv);
        break;
      case undefined:
      case "help":
      case "--help":
        process.stdout.write(usage());
        break;
      default:
        throw new Error(`Unknown subcommand: ${subcommand}`);
    }
    // A handler reports a failed run through process.exitCode, not by throwing.
    logEvent({ event: "exit", run_id: runId, ok: !process.exitCode, duration_ms: Date.now() - startedAt });
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
    "  grok-companion.mjs consult [--background] [--file <p>]... [--profile <p>] [--model <id>] [--effort <lvl>] [--timeout-ms <ms>] [--idle-ms <ms>] [--json] -- <question>",
    "  grok-companion.mjs review [--background] [--base <ref>] [--scope auto|working-tree|branch] [--profile <p>] [--model <id>] [--effort <lvl>] [--timeout-ms <ms>] [--idle-ms <ms>] [--json]",
    "  grok-companion.mjs adversarial-review [...review flags...] [focus text]",
    "  grok-companion.mjs status [job-id] [--all] [--wait] [--timeout-ms <ms>] [--json]",
    "  grok-companion.mjs result [job-id] [--json]",
    "  grok-companion.mjs cancel [job-id] [--json]",
    "",
    "  --profile     fast (grok-4.7-build-fast, low; default), thrifty (grok-4.7, low) or deep",
    "                (grok-4.7, medium). Default $GROK_PLUGIN_PROFILE or fast.",
    "  --model       grok model, overrides the profile ($GROK_PLUGIN_MODEL; 'default' = CLI's own).",
    "  --effort      reasoning effort, overrides the profile ($GROK_PLUGIN_EFFORT; 'default' = CLI's own).",
    "  --timeout-ms  wall-clock backstop (default 8m).",
    "  --idle-ms     kill after this long with no output at all (default 3m, 0 disables).",
    "",
  ].join("\n");
}

main();
