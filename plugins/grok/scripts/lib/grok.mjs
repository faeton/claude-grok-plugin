// Everything that talks to the `grok` CLI: availability/auth, read-only flag
// construction, the supervised runner (watchdog + JSON-envelope parsing), and
// model-capability probing.

import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

// Wall-clock watchdog. Runs that were allowed past the old 8-minute cap have
// completed cleanly at 8.6min and 10.4min with full answers, so 8 minutes was
// truncating real work, not catching hangs. There is no idle detection yet, so
// this stays a bounded backstop rather than going higher.
export const DEFAULT_TIMEOUT_MS = 15 * 60_000;

// Kill a run that has produced NO output at all for this long. A stalled relay
// is silent, so this catches it in minutes instead of burning the full wall
// clock. Floor is set by grok's documented success path: after the answer it can
// spend up to 120s draining usage with no events emitted, so anything near that
// would kill healthy runs just before they finish.
export const DEFAULT_IDLE_MS = 3 * 60_000;

export const GROK_BIN = process.env.GROK_BIN || "grok";

// Compare stopReasons case/separator-insensitively. The CLI switched from
// PascalCase (`EndTurn`) to the snake_case ACP token (`end_turn`) in 1.0.4,
// which silently turned every successful run into a reported failure.
const normReason = (s) => String(s).toLowerCase().replace(/[\s_-]+/g, "");

// Grok produced its answer and stopped cleanly. PascalCase spellings normalize
// onto these too, so pre-1.0.4 CLIs keep working.
const GOOD_STOP_REASONS = new Set(["endturn", "stop", "completed"]);

// The run genuinely failed and any text is not a usable answer.
const BAD_STOP_REASONS = new Set(["cancelled", "refusal"]);

// The run hit a ceiling: whatever text arrived is real but incomplete. Worth
// surfacing with a warning — discarding a truncated 10k-char analysis is the
// exact failure mode this classifier exists to prevent.
const TRUNCATED_STOP_REASONS = new Set([
  "maxtokens",
  "maxturns",
  "maxturnrequests",
  "maxturnsreached",
]);

// grok's docs call the stopReason list explicitly non-exhaustive, so an
// unrecognized value must not fail closed the way the old allowlist did. Fail
// open when there is substantial text to hand back, and fail loudly otherwise.
const UNKNOWN_REASON_MIN_TEXT = 16;

// Decide run outcome from the envelope. Single source of truth: callers must not
// re-derive `ok` from text/exit code separately.
export function classifyStopReason(stopReason, text) {
  const body = (text ?? "").trim();
  const n = stopReason ? normReason(stopReason) : "";

  if (n === "cancelled") {
    return {
      ok: false,
      errorMessage:
        "grok stopped early (stopReason=cancelled) — the relay likely cancelled the request. Retry, or lower the request size.",
    };
  }
  if (BAD_STOP_REASONS.has(n)) {
    return { ok: false, errorMessage: `grok stopped early (stopReason=${stopReason}).` };
  }
  if (TRUNCATED_STOP_REASONS.has(n)) {
    return body
      ? { ok: true, warning: `Answer is truncated (stopReason=${stopReason}).` }
      : { ok: false, errorMessage: `grok truncated with no text (stopReason=${stopReason}).` };
  }
  if (!n || GOOD_STOP_REASONS.has(n)) {
    return body
      ? { ok: true }
      : {
          ok: false,
          errorMessage: "grok returned an empty response (possible relay cancellation).",
        };
  }
  return body.length >= UNKNOWN_REASON_MIN_TEXT
    ? { ok: true, warning: `Unrecognized stopReason=${stopReason}; answer returned as-is.` }
    : { ok: false, errorMessage: `Unrecognized stopReason=${stopReason} with no usable text.` };
}

// Tools that can mutate the workspace or run arbitrary commands, removed from
// the toolset entirely via --disallowed-tools.
//
// CRITICAL: these are grok's INTERNAL tool ids, not Claude's capability names.
// --disallowed-tools silently ignores names it does not recognize, so the old
// list ("Write", "Edit", "MultiEdit", "NotebookEdit", "Bash") removed *nothing*
// — verified against grok 1.0.4 by asking it to enumerate its own toolset, which
// still contained run_terminal_command and search_replace. Read-only was resting
// entirely on the --deny permission layer below.
//
// Note the shell tool is removed as `run_terminal_cmd` but reports itself at
// runtime as `run_terminal_command`; both spellings are kept so a future
// normalization on grok's side cannot quietly reopen the hole.
const MUTATING_TOOLS = [
  "run_terminal_cmd",
  "run_terminal_command",
  "search_replace",
  "write_file",
  "create_file",
  "apply_patch",
  "delete_file",
];

// Permission rules use Claude-style capability names — a DIFFERENT vocabulary
// from --disallowed-tools above. These gate execution rather than removing the
// tool, and override any allow-rules inherited from the user's Claude settings
// (the original reason Grok was editing files during consult).
const DENIED_CAPABILITIES = ["Write", "Edit", "Bash"];

// Read-only argv shared by consult and review. `web` toggles web search/fetch
// (on for consult, off for review).
export function readOnlyArgs({ web = true } = {}) {
  const args = [
    "--disallowed-tools",
    // `Agent` is a special --disallowed-tools entry that blocks subagent
    // spawning; --no-subagents alone leaves spawn_subagent in the toolset.
    [...MUTATING_TOOLS, "Agent"].join(","),
    "--no-subagents",
    "--no-memory",
  ];
  for (const tool of DENIED_CAPABILITIES) {
    args.push("--deny", tool);
  }
  if (!web) {
    args.push("--disable-web-search");
  }
  return args;
}

export function getGrokAvailability() {
  const res = spawnSync(GROK_BIN, ["--version"], { encoding: "utf8" });
  if (res.error || res.status !== 0) {
    return { available: false, version: null };
  }
  return { available: true, version: res.stdout.trim() };
}

// Auth heuristic: ~/.grok/auth.json exists and is non-empty.
export function getGrokAuthStatus() {
  try {
    const raw = readFileSync(resolve(homedir(), ".grok", "auth.json"), "utf8");
    const json = JSON.parse(raw);
    const loggedIn = Boolean(json && Object.keys(json).length > 0);
    return { loggedIn };
  } catch {
    return { loggedIn: false };
  }
}

export function detectDefaultModel() {
  const res = spawnSync(GROK_BIN, ["models"], { encoding: "utf8" });
  if (res.status !== 0) return null;
  const m = res.stdout.match(/Default model:\s*(\S+)/);
  return m ? m[1] : null;
}

// Returns true/false, or null when we cannot tell (caller drops the flag
// defensively, because the API 400s when an unsupported model gets the knob).
export function modelSupportsReasoningEffort(modelId) {
  try {
    const cachePath = resolve(homedir(), ".grok", "models_cache.json");
    const cache = JSON.parse(readFileSync(cachePath, "utf8"));
    const entry = cache.models?.[modelId];
    if (!entry) return null;
    return Boolean(entry.info?.supports_reasoning_effort);
  } catch {
    return null;
  }
}

// Build the effort-related argv, dropping the flag when the target model does
// not support it. Returns { args, dropped } where dropped is a message or null.
export function effortArgs({ effort, reasoningEffort, model }) {
  if (!effort && !reasoningEffort) return { args: [], dropped: null };
  const targetModel = model || detectDefaultModel();
  const supported = targetModel ? modelSupportsReasoningEffort(targetModel) : null;
  if (supported) {
    const args = [];
    if (effort) args.push("--effort", effort);
    if (reasoningEffort) args.push("--reasoning-effort", reasoningEffort);
    return { args, dropped: null };
  }
  const label = targetModel || "the selected model";
  return {
    args: [],
    dropped: `${label} does not support reasoning effort — dropped --effort/--reasoning-effort.`,
  };
}

function killTree(child, signal) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal); // negative pid = process group
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

// Track live grok children so a worker can tear them down on SIGTERM (otherwise
// the detached grok process group would orphan when the worker is cancelled).
const activeChildren = new Set();

export function killActiveGrok(signal = "SIGTERM") {
  for (const child of activeChildren) killTree(child, signal);
}

// Parse grok's output envelope: { text, stopReason, sessionId, thought, ... }.
//
// Two wire formats end up here:
//
//   --output-format json            one JSON object, the whole answer at once
//   --output-format streaming-json  NDJSON, one `type`-tagged ACP event per line
//
// The streaming form needs real accumulation, not a last-wins merge: answer text
// arrives as a SEQUENCE of {"type":"text","data":"..."} chunks that must be
// concatenated. Only the final {"type":"end"} event carries the turn stopReason;
// the per-response `usage` line reports the raw provider reason (`tool_use`,
// `pause_turn`) mid-loop, so treating it as the turn result would classify a
// working agent as a failure.
function parseEnvelope(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    const single = JSON.parse(trimmed);
    // A lone type-tagged event is still a stream (one-line edge case).
    if (single && typeof single === "object" && single.type === undefined) {
      return single;
    }
  } catch {
    /* not a single object — fall through to the stream reader */
  }

  const text = [];
  const thought = [];
  const meta = {};
  let sawEvent = false;
  let legacy = null;

  for (const line of trimmed.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    let obj;
    try {
      obj = JSON.parse(t);
    } catch {
      continue;
    }
    if (obj == null || typeof obj !== "object") continue;

    switch (obj.type) {
      case "text":
        sawEvent = true;
        if (typeof obj.data === "string") text.push(obj.data);
        break;
      case "thought":
        sawEvent = true;
        if (typeof obj.data === "string") thought.push(obj.data);
        break;
      case "end":
        // Authoritative: always the last event of the turn.
        sawEvent = true;
        if (obj.stopReason !== undefined) meta.stopReason = obj.stopReason;
        if (obj.sessionId !== undefined) meta.sessionId = obj.sessionId;
        meta.sawEnd = true;
        break;
      case "error":
        sawEvent = true;
        if (obj.message) meta.errorEvent = String(obj.message);
        break;
      case undefined:
        // Pre-1.0.4 shape: bare {text, stopReason, ...} objects across lines.
        if (obj.text !== undefined) legacy = { ...(legacy ?? {}), ...obj };
        for (const key of ["stopReason", "sessionId", "thought"]) {
          if (obj[key] !== undefined) meta[key] = obj[key];
        }
        break;
      default:
        // usage / tool_call / plan / auto_compact_* / anything future: the docs
        // call this list non-exhaustive, so ignore rather than guess. Notably
        // `usage.stopReason` is per-response and must NOT become the turn's.
        sawEvent = true;
        break;
    }
  }

  if (legacy && !text.length) return { ...meta, ...legacy };
  if (sawEvent || text.length) {
    // `streamed` lets the runner tell "no end event because this is the
    // single-object json format" from "no end event because the stream was cut".
    return {
      ...meta,
      streamed: true,
      text: text.join(""),
      thought: thought.join("") || null,
    };
  }
  return Object.keys(meta).length ? meta : null;
}

// Run `grok` under supervision. Resolves (never rejects) with a normalized
// result so callers can record a clean failure instead of hanging.
//
//   args        argv passed to grok (must include -p/--prompt-file + --output-format)
//   cwd         working directory
//   timeoutMs   wall-clock backstop
//   idleMs      kill after this long with no output at all (0 disables)
//   graceMs     SIGTERM -> SIGKILL escalation window
//   onProgress  optional (event) => void for streaming-json lines
export function runGrok(args, options = {}) {
  const {
    cwd = process.cwd(),
    timeoutMs = DEFAULT_TIMEOUT_MS,
    idleMs = DEFAULT_IDLE_MS,
    graceMs = 5_000,
    onProgress,
    onSpawn,
  } = options;

  return new Promise((resolveRun) => {
    const startedAt = Date.now();
    let child;
    try {
      child = spawn(GROK_BIN, args, {
        cwd,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolveRun({
        ok: false,
        exitCode: 127,
        signal: null,
        timedOut: false,
        text: "",
        stopReason: null,
        sessionId: null,
        thought: null,
        stderr: "",
        errorMessage: `Failed to spawn grok: ${err.message}`,
        durationMs: 0,
        raw: null,
      });
    }
    if (!child) return;
    activeChildren.add(child);
    onSpawn?.({ pid: child.pid });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let idledOut = false;
    let killTimer = null;
    let idleTimer = null;

    const abort = () => {
      killTree(child, "SIGTERM");
      killTimer = setTimeout(() => killTree(child, "SIGKILL"), graceMs);
    };

    const watchdog = setTimeout(() => {
      timedOut = true;
      // Disarm idle before aborting. Otherwise an idle timer armed shortly
      // before the wall-clock deadline can still fire during the SIGTERM grace
      // window and flip idledOut, reporting a wall-clock timeout as a stall.
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      abort();
    }, timeoutMs);

    // Idle detection. A stalled relay returns nothing at all, so any byte on
    // either pipe counts as liveness — parsing a JSON event is not required and
    // would miss tool-call chatter that proves the run is alive.
    const touch = () => {
      if (!idleMs || timedOut || idledOut) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (timedOut) return; // wall-clock already won the race
        idledOut = true;
        timedOut = true;
        clearTimeout(watchdog);
        abort();
      }, idleMs);
    };
    touch();

    // Carries the trailing partial line between chunks. A JSON event split
    // across a socket read would otherwise be parsed as two invalid fragments
    // and silently dropped from onProgress.
    let pending = "";

    child.stdout.on("data", (buf) => {
      touch();
      const chunk = buf.toString("utf8");
      stdout += chunk;
      if (!onProgress) return;
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? ""; // last element is incomplete until a newline
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        try {
          onProgress(JSON.parse(t));
        } catch {
          /* not a json line */
        }
      }
    });
    child.stderr.on("data", (buf) => {
      touch();
      stderr += buf.toString("utf8");
    });

    const finish = (result) => {
      clearTimeout(watchdog);
      if (idleTimer) clearTimeout(idleTimer);
      // Deliberately NOT cancelling killTimer on a timed-out run. The group
      // leader closing does not mean the group is gone: a descendant that
      // ignores SIGTERM and drops the pipes would survive if escalation were
      // cancelled here. unref() lets the process exit without waiting on it.
      if (killTimer) {
        if (timedOut) killTimer.unref?.();
        else clearTimeout(killTimer);
      }
      activeChildren.delete(child);
      resolveRun({ ...result, durationMs: Date.now() - startedAt });
    };

    child.on("error", (err) => {
      finish({
        ok: false,
        exitCode: 127,
        signal: null,
        timedOut,
        text: "",
        stopReason: null,
        sessionId: null,
        thought: null,
        stderr,
        errorMessage: `Failed to spawn grok: ${err.message}`,
        raw: null,
      });
    });

    child.on("close", (code, signal) => {
      const envelope = parseEnvelope(stdout);
      const text = (envelope?.text ?? (envelope ? "" : stdout)).trim();
      const stopReason = envelope?.stopReason ?? null;

      let ok;
      let errorMessage = null;
      let warning = null;
      // A turn that emitted `end` plus text is finished, and stays finished even
      // if the process then lingered and got killed. Checked first so a complete
      // answer is never thrown away as a "stall" — the whole point of this file.
      const completeTurn = Boolean(envelope?.streamed && envelope.sawEnd && text);
      if (completeTurn) {
        const verdict = classifyStopReason(stopReason, text);
        ok = verdict.ok;
        warning = verdict.warning ?? null;
        errorMessage = verdict.ok
          ? null
          : firstStderrLine(stderr) || verdict.errorMessage;
        if (ok && (idledOut || timedOut)) {
          warning = warning
            ? `${warning} (Process was killed after the answer completed.)`
            : "Answer completed, but the process had to be killed afterwards.";
        }
      } else if (idledOut) {
        ok = false;
        errorMessage =
          `No output from grok for ${Math.round(idleMs / 1000)}s — the relay stalled. ` +
          `Retry, or lower the request size.`;
      } else if (timedOut) {
        ok = false;
        errorMessage = `Timed out after ${timeoutMs}ms (no response from grok).`;
      } else if (code !== 0) {
        ok = false;
        // An `error` event carries grok's own description of the failure, which
        // beats a generic exit-code message or an unrelated stderr line.
        errorMessage =
          envelope?.errorEvent ||
          firstStderrLine(stderr) ||
          `grok exited with code ${code}.`;
      } else if (envelope?.errorEvent && !text) {
        ok = false;
        errorMessage = envelope.errorEvent;
      } else if (envelope?.streamed && envelope.sawEnd) {
        // A complete turn: classify on its stopReason even if the process then
        // lingered. Checked before the truncation branch so a finished answer is
        // never relabelled as a cut stream.
        const verdict = classifyStopReason(stopReason, text);
        ok = verdict.ok;
        warning = verdict.warning ?? null;
        errorMessage = verdict.ok
          ? null
          : firstStderrLine(stderr) || verdict.errorMessage;
      } else if (envelope?.streamed && !envelope.sawEnd) {
        // grok documents `end` as always the last event of a turn. Exit 0 with
        // no `end` means the stream was cut mid-answer, so whatever text we have
        // is incomplete. Surface it rather than discard it, but never as a clean
        // success — "exit 0 + some text" is exactly the silent-truncation shape
        // this runner exists to catch.
        ok = Boolean(text);
        warning = ok
          ? "Stream ended without a final event — the answer may be truncated."
          : null;
        errorMessage = ok
          ? null
          : firstStderrLine(stderr) ||
            "grok produced no output and the stream ended without a final event.";
      } else {
        const verdict = classifyStopReason(stopReason, text);
        ok = verdict.ok;
        warning = verdict.warning ?? null;
        errorMessage = verdict.ok
          ? null
          : firstStderrLine(stderr) || verdict.errorMessage;
      }

      finish({
        ok,
        warning,
        exitCode: timedOut ? 124 : code ?? 1,
        signal,
        timedOut,
        idledOut,
        text,
        stopReason,
        sessionId: envelope?.sessionId ?? null,
        thought: envelope?.thought ?? null,
        stderr,
        errorMessage,
        raw: envelope,
      });
    });
  });
}

function firstStderrLine(stderr) {
  const line = String(stderr ?? "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .find((s) => !s.startsWith("[grok-companion]"));
  return line ?? "";
}
