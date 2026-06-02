// Everything that talks to the `grok` CLI: availability/auth, read-only flag
// construction, the supervised runner (watchdog + JSON-envelope parsing), and
// model-capability probing.

import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

export const DEFAULT_TIMEOUT_MS = 8 * 60_000;
export const GROK_BIN = process.env.GROK_BIN || "grok";

// stopReasons that mean "Grok produced its answer and stopped cleanly".
const GOOD_STOP_REASONS = new Set(["EndTurn", "Stop", "Completed", "MaxTurns"]);

// Tools that can mutate the workspace or run arbitrary commands. We both remove
// them (--disallowed-tools, so the model is never offered them) AND deny them
// (--deny, which overrides any inherited allow-rules from the user's Claude
// settings — the actual reason Grok was editing files during consult).
const MUTATING_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"];

// Read-only argv shared by consult and review. `web` toggles web search/fetch
// (on for consult, off for review).
export function readOnlyArgs({ web = true } = {}) {
  const args = [
    "--disallowed-tools",
    MUTATING_TOOLS.join(","),
    "--no-subagents",
    "--no-memory",
  ];
  for (const tool of ["Write", "Edit", "Bash"]) {
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
// Primary mode is a single JSON object (--output-format json). The streaming
// fallback merges across lines so a trailing metadata-only line (e.g. just
// {stopReason}) does not clobber answer text emitted on an earlier line.
function parseEnvelope(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const lines = trimmed.split(/\r?\n/).filter(Boolean);
    let answer = null;
    const meta = {};
    for (const line of lines) {
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (obj == null || typeof obj !== "object") continue;
      if (obj.text !== undefined) answer = { ...(answer ?? {}), ...obj };
      for (const key of ["stopReason", "sessionId", "thought"]) {
        if (obj[key] !== undefined) meta[key] = obj[key];
      }
    }
    if (answer) return { ...meta, ...answer };
    return Object.keys(meta).length ? meta : null;
  }
}

// Run `grok` under supervision. Resolves (never rejects) with a normalized
// result so callers can record a clean failure instead of hanging.
//
//   args        argv passed to grok (must include -p/--prompt-file + --output-format)
//   cwd         working directory
//   timeoutMs   wall-clock watchdog
//   graceMs     SIGTERM -> SIGKILL escalation window
//   onProgress  optional (event) => void for streaming-json lines
export function runGrok(args, options = {}) {
  const {
    cwd = process.cwd(),
    timeoutMs = DEFAULT_TIMEOUT_MS,
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
    let killTimer = null;

    const watchdog = setTimeout(() => {
      timedOut = true;
      killTree(child, "SIGTERM");
      killTimer = setTimeout(() => killTree(child, "SIGKILL"), graceMs);
    }, timeoutMs);

    child.stdout.on("data", (buf) => {
      const chunk = buf.toString("utf8");
      stdout += chunk;
      if (onProgress) {
        for (const line of chunk.split(/\r?\n/)) {
          const t = line.trim();
          if (!t) continue;
          try {
            onProgress(JSON.parse(t));
          } catch {
            /* not a json line */
          }
        }
      }
    });
    child.stderr.on("data", (buf) => {
      stderr += buf.toString("utf8");
    });

    const finish = (result) => {
      clearTimeout(watchdog);
      if (killTimer) clearTimeout(killTimer);
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

      let ok = code === 0 && !timedOut && Boolean(text);
      let errorMessage = null;
      if (timedOut) {
        ok = false;
        errorMessage = `Timed out after ${timeoutMs}ms (no response from grok).`;
      } else if (code !== 0) {
        ok = false;
        errorMessage =
          firstStderrLine(stderr) || `grok exited with code ${code}.`;
      } else if (stopReason && !GOOD_STOP_REASONS.has(stopReason)) {
        ok = false;
        errorMessage = `grok stopped early (stopReason=${stopReason}) — the relay likely cancelled the request. Retry, or lower the request size.`;
      } else if (!text) {
        ok = false;
        errorMessage =
          firstStderrLine(stderr) ||
          "grok returned an empty response (possible relay cancellation).";
      }

      finish({
        ok,
        exitCode: timedOut ? 124 : code ?? 1,
        signal,
        timedOut,
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
