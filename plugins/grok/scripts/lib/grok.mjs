// Everything that talks to the `grok` CLI: availability/auth, read-only flag
// construction, the supervised runner (watchdog + JSON-envelope parsing), and
// model-capability probing.

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";

// Wall-clock watchdog. Under 9 minutes so a foreground run finishes, and saves
// its result, inside Claude Code's 10-minute Bash cap. The old 15-minute cap
// outlived that cap, so Claude moved the call to the background mid-run and the
// caller saw a "stuck" consult. With the fast defaults below a review takes
// 1-2 minutes; this is only the backstop for a run that keeps working but never
// finishes. Stalls are caught much earlier by the idle timer.
export const DEFAULT_TIMEOUT_MS = 8 * 60_000;

// Kill a run that has produced NO output at all for this long. A stalled relay
// is silent, so this catches it in minutes instead of burning the full wall
// clock. Floor is set by grok's documented success path: after the answer it can
// spend up to 120s draining usage with no events emitted, so anything near that
// would kill healthy runs just before they finish.
export const DEFAULT_IDLE_MS = 3 * 60_000;

export const GROK_BIN = process.env.GROK_BIN || "grok";

// grok's own home (models cache, config). Honours GROK_HOME like the CLI does.
const GROK_HOME = process.env.GROK_HOME
  ? resolve(process.env.GROK_HOME)
  : resolve(homedir(), ".grok");

// Prompt files are written under a directory with this prefix. It doubles as the
// marker that identifies our grok process in `ps` before cancel signals it.
export const PROMPT_DIR_PREFIX = "grok-companion-prompt-";

// Upper bound on the `grok models` probe. It runs synchronously before the
// run's own watchdogs exist, so it needs its own.
const MODEL_PROBE_TIMEOUT_MS = 10_000;

// The same for the availability probes (`grok --version`, `bwrap --version`):
// a wedged binary used to hang setup and every run before any watchdog existed.
const PROBE_TIMEOUT_MS = 10_000;

// Model and reasoning effort, chosen as a named profile. Measured on identical
// review prompts (2026-10-16, grok CLI 1.0.60, on two machines): grok-4.7 at
// medium took 4-15 minutes, made 40-72 tool calls and timed out on real branch
// reviews. grok-4.7-build-fast at low found the same planted bugs, including one
// that needs cross-file context, in about a minute. grok-4.7 at low missed that
// bug every time from the diff alone, but found it once the changed files were
// inlined in full, at about half build-fast's cost and twice its time.
// build-fast is billed at twice grok-4.7's per-token price, so on a subscription
// it uses the allowance faster.
//
// Without a model default the run inherited whatever the user's grok CLI was
// set to, so speed changed with unrelated settings.
export const PROFILES = {
  fast: { model: "grok-4.7-build-fast", effort: "low" },
  thrifty: { model: "grok-4.7", effort: "low" },
  deep: { model: "grok-4.7", effort: "medium" },
};
export const DEFAULT_PROFILE = "fast";

// Precedence, highest first: --model / --effort, --profile, GROK_PLUGIN_MODEL /
// GROK_PLUGIN_EFFORT, GROK_PLUGIN_PROFILE, then `fast`. The env vars are read at
// call time (set them in ~/.claude/settings.json "env"). `default` for a model
// or effort sends no flag and lets the CLI pick.
export function resolveProfile(name) {
  const n = name || process.env.GROK_PLUGIN_PROFILE || DEFAULT_PROFILE;
  const p = Object.hasOwn(PROFILES, n) ? PROFILES[n] : null;
  if (!p) {
    const src = name ? "--profile" : "GROK_PLUGIN_PROFILE";
    throw new Error(`Unknown ${src} "${n}" (expected ${Object.keys(PROFILES).join(", ")}).`);
  }
  return { name: n, ...p, explicit: Boolean(name) };
}

// Resolve the model a run uses, or null for "send no --model flag".
export function resolveModel(model, profile) {
  const p = resolveProfile(profile);
  const m = model || (p.explicit ? p.model : process.env.GROK_PLUGIN_MODEL || p.model);
  return m === "default" ? null : m;
}

function resolveEffort(effort, profile) {
  const p = resolveProfile(profile);
  return effort || (p.explicit ? p.effort : process.env.GROK_PLUGIN_EFFORT || p.effort);
}

// Environment for every grok child. grok scans Claude Code's and Cursor's
// skills, MCP servers and hooks by default: on a typical Claude Code machine
// that put ~21 KB of Claude skill descriptions and several MCP servers into
// every model call, irrelevant to a read-only review and resent on every loop.
// Hooks are off for safety as much as speed: they run commands. Project rules
// and CLAUDE.md stay on, since they carry the repo's real constraints.
export const LEAN_ENV = {
  GROK_CLAUDE_SKILLS_ENABLED: "0",
  GROK_CLAUDE_MCPS_ENABLED: "0",
  GROK_CLAUDE_HOOKS_ENABLED: "0",
  GROK_CURSOR_SKILLS_ENABLED: "0",
  GROK_CURSOR_MCPS_ENABLED: "0",
  GROK_CURSOR_HOOKS_ENABLED: "0",
};

export function childEnv(base = process.env) {
  return { ...base, ...LEAN_ENV };
}

// Compare stopReasons case/separator-insensitively. The CLI switched from
// PascalCase (`EndTurn`) to the snake_case ACP token (`end_turn`) in 1.0.4,
// which silently turned every successful run into a reported failure.
const normReason = (s) => String(s).toLowerCase().replace(/[\s_-]+/g, "");

// Grok produced its answer and stopped cleanly. PascalCase spellings normalize
// onto these too, so pre-1.0.4 CLIs keep working.
const GOOD_STOP_REASONS = new Set(["endturn", "stop", "completed"]);

// The run genuinely failed and any text is not a usable answer.
const BAD_STOP_REASONS = new Set(["cancelled", "refusal"]);

// The answer was being written and got cut by the output-token limit: the text
// is real but incomplete. Surfaced with a warning, since discarding a truncated
// 10k-char analysis is the exact failure mode this classifier exists to prevent.
const TRUNCATED_STOP_REASONS = new Set(["maxtokens"]);

// The model ran out of turns, or stopped to call a tool (most likely one the
// read-only policy refused), before it ever wrote its answer. What text exists
// is commentary from before the investigation ("I'll review the catch code…"),
// not a result. Reporting it as a completed job made a one-sentence preamble
// look like a clean review, so it fails, with the text kept as partial output.
const UNFINISHED_STOP_REASONS = new Set([
  "maxturns",
  "maxturnrequests",
  "maxturnsreached",
  "tooluse",
  "pauseturn",
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
  if (UNFINISHED_STOP_REASONS.has(n)) {
    return {
      ok: false,
      errorMessage: `grok stopped before writing its answer (stopReason=${stopReason}).`,
    };
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

// Read-only enforcement, in independent layers. Each one alone has had a hole,
// so none is trusted alone:
//
// 1. --tools: an ALLOWLIST of grok's internal tool ids. The old denylist missed
//    tools it did not know about — grok 1.0.50 ships its file-writing tool as
//    `write` (not `write_file`), plus scheduler/workflow/monitor/image tools,
//    all of which stayed available. An allowlist cannot go stale that way.
//    Verified against grok 1.0.50 via the `available_commands` event: with this
//    flag the toolset is exactly the listed ids (MCP meta-tools included in the
//    removal once they are also in --disallowed-tools).
const READ_TOOLS = ["read_file", "grep", "list_dir"];
const WEB_TOOLS = ["web_search", "web_fetch"];

// 2. --disallowed-tools: still removes the known mutating ids (it wins over
//    --tools) as a backstop if a future CLI ignores or widens the allowlist.
//    `search_tool` / `use_tool` are the MCP meta-tools, which --tools alone
//    leaves in place. `Agent` blocks subagent spawning.
const REMOVED_TOOLS = [
  "run_terminal_cmd",
  "run_terminal_command",
  "search_replace",
  "write",
  "write_file",
  "create_file",
  "apply_patch",
  "delete_file",
  "search_tool",
  "use_tool",
  "Agent",
];

// 3. --deny: permission rules use Claude-style capability names, a DIFFERENT
//    vocabulary from the tool ids above. They gate execution and override any
//    allow-rules inherited from the user's settings (the original reason Grok
//    was editing files during consult).
const DENIED_CAPABILITIES = ["Write", "Edit", "Bash", "MCPTool"];

// 4. --permission-mode dontAsk: anything that would need approval is refused
//    instead of auto-run, so a tool that slips past every list still cannot act.
//
// 5. --sandbox read-only: the OS boundary (Seatbelt / Landlock). Applies to the
//    whole grok process and everything it spawns — hooks and stdio MCP servers
//    included — and allows writes only to ~/.grok and temp dirs. If the sandbox
//    cannot be applied grok merely warns and runs unsandboxed, so runGrok treats
//    that warning as fatal (see SANDBOX_FAILED).
//
//    On Linux the profile also write-denies grok's hook and config files with a
//    bubblewrap bind-mount, and without `bwrap` grok refuses the profile outright
//    (SANDBOX_REFUSED). Plain grok runs fine there, so rather than fail every run
//    the companion drops --sandbox and says so (see sandboxAvailability): layers
//    1-4 still keep grok's own tools read-only, but hooks and stdio MCP servers
//    it spawns are no longer OS-confined. GROK_COMPANION_REQUIRE_SANDBOX=1 keeps
//    the sandbox mandatory instead.
//
//    On macOS grok 1.0.70+ also fails the profile when a container-runtime socket
//    it must deny (e.g. /var/run/docker.sock) is a symlink to a path outside its
//    deny list — OrbStack installs exactly that. grok refuses before any tool
//    call, so runGrokReadOnly retries once without --sandbox and says so, same
//    trade-off as the Linux no-bwrap case. GROK_COMPANION_REQUIRE_SANDBOX=1
//    keeps the failure fatal.
export const SANDBOX_PROFILE = "read-only";
const SANDBOX_FAILED = /sandbox could not be applied/i;
const SOCKET_DENY_FAILED = /socket deny resolution failed/i;
const SANDBOX_REFUSED = /bwrap|bubblewrap|could not enforce its deny list/i;
const BWRAP_HINT =
  "On Linux grok needs bubblewrap (`bwrap`) for its read-only sandbox. Install it, " +
  "or put a standalone `bwrap` binary on PATH (e.g. ~/.local/bin), or unset " +
  "GROK_COMPANION_REQUIRE_SANDBOX to run without the OS sandbox.";

// Whether grok can apply the read-only sandbox here. Only Linux has a missing
// dependency to detect; elsewhere the run's own SANDBOX_FAILED check covers it.
export function sandboxAvailability() {
  if (process.platform !== "linux") return { available: true, required: true, warning: null };
  const required = process.env.GROK_COMPANION_REQUIRE_SANDBOX === "1";
  const res = spawnSync("bwrap", ["--version"], {
    stdio: "ignore",
    timeout: PROBE_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  // A bwrap that hangs is present but broken, not missing: the run stops
  // instead of quietly going unsandboxed or waiting out grok's watchdogs.
  if (res.error?.code === "ETIMEDOUT") {
    const problem = `\`bwrap --version\` did not answer within ${PROBE_TIMEOUT_MS / 1000}s, so grok's sandbox cannot be trusted to start`;
    return { available: false, required: true, warning: null, problem };
  }
  if (required || (!res.error && res.status === 0)) {
    return { available: !res.error && res.status === 0, required: true, warning: null };
  }
  return {
    available: false,
    required: false,
    warning:
      "Ran without grok's OS read-only sandbox: bubblewrap (`bwrap`) is not on PATH. " +
      "grok's tools are still limited to read-only ones, but its hooks and MCP " +
      "servers are not OS-confined.",
  };
}

// Read-only argv shared by consult and review. `web` toggles web search/fetch
// (on for consult, off for review); `sandbox: false` omits --sandbox when
// sandboxAvailability() says it cannot be applied.
export function readOnlyArgs({ web = true, sandbox = true } = {}) {
  const args = [
    "--tools",
    [...READ_TOOLS, ...(web ? WEB_TOOLS : [])].join(","),
    "--disallowed-tools",
    REMOVED_TOOLS.join(","),
    "--permission-mode",
    "dontAsk",
    ...(sandbox ? ["--sandbox", SANDBOX_PROFILE] : []),
    "--no-subagents",
    "--no-memory",
  ];
  for (const capability of DENIED_CAPABILITIES) {
    args.push("--deny", capability);
  }
  if (!web) {
    args.push("--disable-web-search", "--deny", "WebFetch", "--deny", "WebSearch");
  }
  return args;
}

export function getGrokAvailability() {
  const res = spawnSync(GROK_BIN, ["--version"], {
    encoding: "utf8",
    timeout: PROBE_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  if (res.error?.code === "ETIMEDOUT") {
    return { available: false, version: null, problem: `\`grok --version\` did not answer within ${PROBE_TIMEOUT_MS / 1000}s` };
  }
  if (res.error || res.status !== 0) {
    return { available: false, version: null, problem: null };
  }
  return { available: true, version: res.stdout.trim(), problem: null };
}

// Auth heuristic: ~/.grok/auth.json exists and is non-empty.
export function getGrokAuthStatus() {
  try {
    const raw = readFileSync(resolve(GROK_HOME, "auth.json"), "utf8");
    const json = JSON.parse(raw);
    const loggedIn = Boolean(json && Object.keys(json).length > 0);
    return { loggedIn };
  } catch {
    return { loggedIn: false };
  }
}

export function detectDefaultModel() {
  const res = spawnSync(GROK_BIN, ["models"], {
    encoding: "utf8",
    timeout: MODEL_PROBE_TIMEOUT_MS,
  });
  if (res.error || res.status !== 0) return null;
  const m = res.stdout.match(/Default model:\s*(\S+)/);
  return m ? m[1] : null;
}

// Returns true/false from grok's models cache, or null when it cannot tell
// (no cache, unreadable cache, a model id the cache does not list, or an entry
// that says nothing about effort). An advertised `reasoning_efforts` menu is
// support; only an explicit `supports_reasoning_effort: false` is "unsupported".
// A missing field used to count as false, which silently dropped the flag.
export function modelSupportsReasoningEffort(modelId) {
  try {
    const cachePath = resolve(GROK_HOME, "models_cache.json");
    const cache = JSON.parse(readFileSync(cachePath, "utf8"));
    const info = cache.models?.[modelId]?.info;
    if (!info) return null;
    if (Array.isArray(info.reasoning_efforts) && info.reasoning_efforts.length) return true;
    if (typeof info.supports_reasoning_effort === "boolean") return info.supports_reasoning_effort;
    return null;
  } catch {
    return null;
  }
}

// Build the effort-related argv. Returns { args, dropped } where dropped is a
// message or null. When neither flag is given, the profile's effort applies.
//
// The flag is dropped ONLY when the cache positively says the model lacks
// support (the API 400s on the knob then). Unknown support sends it: treating
// "unknown" as "unsupported" meant a cold or stale cache silently fell back to
// the CLI's slow `high` default — the very thing the effort default exists to stop.
// --effort and --reasoning-effort are aliases in the CLI, so only one is sent.
export function effortArgs({ effort, reasoningEffort, model, profile }) {
  const explicit = Boolean(effort || reasoningEffort);
  let level = resolveEffort(effort || reasoningEffort, profile);
  if (level === "default") level = null;
  if (!level) return { args: [], dropped: null };
  const targetModel = resolveModel(model, profile) || detectDefaultModel();
  const supported = targetModel ? modelSupportsReasoningEffort(targetModel) : null;
  if (supported !== false) return { args: ["--effort", level], dropped: null };
  if (!explicit) return { args: [], dropped: null };
  return {
    args: [],
    dropped: `${targetModel} does not support reasoning effort — dropped --effort ${level}.`,
  };
}

// grok is spawned detached, so it leads its own process group and every signal
// goes to the group: a descendant is never left behind holding the repo.
export function signalGroup(pid, signal) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(-pid, signal); // negative pid = process group
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
}

function probe(target) {
  try {
    process.kill(target, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

// True while the group led by `pid` — or, for a process that is not a group
// leader (a foreground companion), the process itself — is still around.
export function groupAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  return probe(-pid) || probe(pid);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// SIGTERM each group, wait up to graceMs for them to go, SIGKILL whatever is
// left — and only resolve once that is done. Every abort path (watchdog, idle,
// cancel, Ctrl-C) goes through here, so escalation cannot be skipped by the
// caller exiting early.
export async function terminateGroups(pids, { graceMs = 5_000 } = {}) {
  const live = pids.filter((pid) => groupAlive(pid));
  for (const pid of live) signalGroup(pid, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (live.some(groupAlive) && Date.now() < deadline) await sleep(100);
  for (const pid of live) if (groupAlive(pid)) signalGroup(pid, "SIGKILL");
}

// Live grok children of this process, so a signal handler can tear them down
// (otherwise the detached grok group would orphan when the companion dies).
const activeChildren = new Set();

export function terminateActiveGrok(options) {
  return terminateGroups(
    [...activeChildren].map((child) => child.pid),
    options,
  );
}

// Write the prompt to a private temp file for --prompt-file. Passing it as a
// `-p` argument fails with E2BIG once a review diff passes the OS argv limit
// (~256KB on macOS). Lives outside the repo; the read-only sandbox can read it.
function writePromptFile(prompt) {
  const dir = mkdtempSync(join(tmpdir(), PROMPT_DIR_PREFIX));
  const path = join(dir, "prompt.md");
  writeFileSync(path, prompt, { encoding: "utf8", mode: 0o600 });
  return { dir, path };
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
//   args        argv passed to grok (must include --output-format)
//   prompt      prompt text, delivered via --prompt-file (or put -p in args)
//   cwd         working directory
//   timeoutMs   wall-clock backstop
//   idleMs      kill after this long with no output at all (0 disables)
//   graceMs     SIGTERM -> SIGKILL escalation window
//   onProgress  optional (event) => void for streaming-json lines
export function runGrok(args, options = {}) {
  const {
    prompt,
    cwd = process.cwd(),
    timeoutMs = DEFAULT_TIMEOUT_MS,
    idleMs = DEFAULT_IDLE_MS,
    graceMs = 5_000,
    onProgress,
    onSpawn,
  } = options;

  return new Promise((resolveRun) => {
    const startedAt = Date.now();
    let promptFile = null;
    let child;
    try {
      if (prompt !== undefined) {
        promptFile = writePromptFile(prompt);
        args = ["--prompt-file", promptFile.path, ...args];
      }
      child = spawn(GROK_BIN, args, {
        cwd,
        env: childEnv(),
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
      if (promptFile) rmSync(promptFile.dir, { recursive: true, force: true });
    }
    if (!child) return;
    activeChildren.add(child);
    onSpawn?.({ pid: child.pid });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let idledOut = false;
    let sandboxFailed = false;
    let killTimer = null;
    let idleTimer = null;

    const abort = () => {
      if (killTimer) return;
      signalGroup(child.pid, "SIGTERM");
      killTimer = setTimeout(() => signalGroup(child.pid, "SIGKILL"), graceMs);
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
    // What the run was doing, so a timeout can say so instead of "no response".
    const activity = { toolCalls: 0, lastEventAt: null };

    // Stateful decoding: a multibyte character split across chunks stays intact.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (buf) => {
      touch();
      const chunk = buf.toString("utf8");
      stdout += chunk;
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? ""; // last element is incomplete until a newline
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        let event;
        try {
          event = JSON.parse(t);
        } catch {
          continue; /* not a json line */
        }
        activity.lastEventAt = Date.now();
        if (event?.type === "tool_call") activity.toolCalls++;
        onProgress?.(event);
      }
    });
    child.stderr.on("data", (buf) => {
      touch();
      stderr += buf.toString("utf8");
      // grok prints this and then carries on WITHOUT the sandbox. Read-only must
      // fail closed, so kill the run before it gets to any tool call.
      if (!sandboxFailed && SANDBOX_FAILED.test(stderr)) {
        sandboxFailed = true;
        clearTimeout(watchdog);
        if (idleTimer) clearTimeout(idleTimer);
        abort();
      }
    });

    let finished = false;
    const finish = async (result) => {
      // `error` and `close` can both fire for one child.
      if (finished) return;
      finished = true;
      clearTimeout(watchdog);
      if (idleTimer) clearTimeout(idleTimer);
      if (promptFile) rmSync(promptFile.dir, { recursive: true, force: true });
      // The group leader closing does not mean the group is gone: a descendant
      // that ignores SIGTERM and dropped the pipes is still alive. Finish the
      // escalation BEFORE resolving — the old code unref'd the SIGKILL timer,
      // so the companion exited first and the descendant survived.
      if (killTimer) clearTimeout(killTimer);
      // Also after a clean exit: a descendant that closed its pipes can outlive
      // the leader. No-op when the group is already gone.
      await terminateGroups([child.pid], { graceMs });
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
      if (sandboxFailed) {
        ok = false;
        errorMessage =
          `grok could not apply the ${SANDBOX_PROFILE} sandbox, so the run was stopped ` +
          `rather than continue unsandboxed: ${firstStderrLine(stderr)}`;
      } else if (!completeTurn && code !== 0 && SANDBOX_REFUSED.test(stderr)) {
        // grok refused to start the profile at all (Linux without bwrap).
        ok = false;
        sandboxFailed = true;
        errorMessage = `${firstStderrLine(stderr)} ${BWRAP_HINT}`;
      } else if (completeTurn) {
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
        errorMessage = timeoutMessage(timeoutMs, activity);
      } else if (code !== 0) {
        ok = false;
        // An `error` event carries grok's own description of the failure, which
        // beats a generic exit-code message or an unrelated stderr line.
        errorMessage =
          envelope?.errorEvent ||
          firstStderrLine(stderr) ||
          `grok exited with code ${code}.`;
      } else if (envelope?.errorEvent) {
        // An explicit error with no `end` after it is a failed run, even when
        // some commentary arrived first. The text is kept as partial output.
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
        // is incomplete. That is a failure — "exit 0 + some text" stored as a
        // completed job is exactly the silent truncation this runner exists to
        // catch — but the text is kept and shown as partial output.
        ok = false;
        errorMessage = text
          ? "Stream ended without a final event — the answer is incomplete."
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
        sandboxFailed,
        text,
        stopReason,
        sessionId: envelope?.sessionId ?? null,
        thought: envelope?.thought ?? null,
        toolCalls: activity.toolCalls,
        stderr,
        errorMessage,
        raw: envelope,
      });
    });
  });
}

// runGrok under the read-only sandbox, falling back to an unsandboxed run only
// for the socket-deny failure above. `buildArgs(sandbox)` returns the argv for
// either attempt; `sandbox: false` skips the sandboxed attempt entirely.
export async function runGrokReadOnly(buildArgs, { sandbox = true, onFallback, ...options } = {}) {
  const result = await runGrok(buildArgs(sandbox), options);
  if (
    !sandbox ||
    !result.sandboxFailed ||
    !SOCKET_DENY_FAILED.test(result.stderr || "") ||
    process.env.GROK_COMPANION_REQUIRE_SANDBOX === "1"
  ) {
    return result;
  }
  const warning =
    `Ran without grok's OS read-only sandbox: ${firstStderrLine(result.stderr).replace(/^warning:\s*/i, "")}. ` +
    "grok's tools are still limited to read-only ones, but its hooks and MCP servers " +
    "are not OS-confined. Set GROK_COMPANION_REQUIRE_SANDBOX=1 to fail instead.";
  onFallback?.(warning);
  const retry = await runGrok(buildArgs(false), options);
  retry.warning = [warning, retry.warning].filter(Boolean).join(" ");
  return retry;
}

// The wall-clock deadline fired. Say what grok was doing: the old "no response
// from grok" was wrong for the common case of a run that was busy reading files
// and reasoning right up to the deadline.
export function timeoutMessage(timeoutMs, { toolCalls = 0, lastEventAt = null } = {}, now = Date.now()) {
  const secs = Math.round(timeoutMs / 1000);
  if (!lastEventAt) {
    return `Timed out after ${secs}s with no output from grok.`;
  }
  const ago = Math.max(0, Math.round((now - lastEventAt) / 1000));
  return (
    `Timed out after ${secs}s before grok wrote its answer. It was still working ` +
    `(${toolCalls} tool call${toolCalls === 1 ? "" : "s"}, last activity ${ago}s ago). ` +
    `Narrow the question or diff, or raise --timeout-ms.`
  );
}
function firstStderrLine(stderr) {
  const line = String(stderr ?? "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .find((s) => !s.startsWith("[grok-companion]"));
  return line ?? "";
}
