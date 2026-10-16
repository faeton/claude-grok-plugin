#!/usr/bin/env node
// Tests for the grok runner: stop-reason classification, streaming-json parsing,
// the idle / wall-clock watchdogs, process-group teardown, the read-only argv,
// and effort selection.
//
// No dependencies and no network: a shell script stands in for the `grok` binary
// via GROK_BIN, so the real wire format can be replayed deterministically.
//
//   node plugins/grok/scripts/test/runner.test.mjs
//
// These exist because a PascalCase-vs-snake_case stop-reason mismatch once made
// every successful consult report as a relay cancellation while the full answer
// sat in `result.text`. Anything that decides ok/not-ok belongs under test.

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LIB = resolve(dirname(fileURLToPath(import.meta.url)), "..", "lib", "grok.mjs");
const DIR = mkdtempSync(join(tmpdir(), "grok-runner-test-"));

let failures = 0;
function check(label, cond, got) {
  if (cond) {
    console.log(`  pass  ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}\n        got: ${JSON.stringify(got)}`);
  }
}

// Write a fake `grok` that emits `body` verbatim, then import a fresh copy of the
// runner so it picks up the new GROK_BIN.
async function runFake(name, body, options = {}) {
  const path = join(DIR, `${name}.sh`);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  process.env.GROK_BIN = path;
  const mod = await import(`${LIB}?case=${name}`);
  return mod.runGrok([], { timeoutMs: 20_000, idleMs: 0, ...options });
}

const emit = (lines) =>
  `#!/bin/sh\ncat <<'JSONEOF'\n${lines.map((l) => JSON.stringify(l)).join("\n")}\nJSONEOF\n`;

const { classifyStopReason } = await import(LIB);

// ---------------------------------------------------------------- classifier

console.log("\nstop-reason classification");
const TEXT = "x".repeat(500);
for (const [reason, text, expected, label] of [
  ["end_turn", TEXT, true, "end_turn (grok 1.0.4 success)"],
  ["EndTurn", TEXT, true, "EndTurn (pre-1.0.4 success)"],
  ["END_TURN", TEXT, true, "END_TURN normalizes"],
  ["end-turn", TEXT, true, "end-turn normalizes"],
  ["end_turn", "OK", true, "two-character answer is still an answer"],
  ["end_turn", "", false, "empty text fails even on a good reason"],
  [null, TEXT, true, "absent stopReason with text"],
  [null, "", false, "absent stopReason without text"],
  ["cancelled", TEXT, false, "cancelled fails"],
  ["Cancelled", TEXT, false, "Cancelled normalizes and fails"],
  ["refusal", TEXT, false, "refusal fails even with text"],
  ["max_tokens", TEXT, true, "max_tokens kept as truncated"],
  ["max_turn_requests", TEXT, true, "max_turn_requests kept as truncated"],
  ["MaxTurns", TEXT, true, "MaxTurns kept as truncated"],
  ["max_tokens", "", false, "truncated with no text fails"],
  ["a_future_reason", TEXT, true, "unknown reason with text fails OPEN"],
  ["tool_use", TEXT, true, "tool_use turn kept as truncated"],
  ["pause_turn", "", false, "pause_turn with no text fails"],
  ["a_future_reason", "hi", false, "unknown reason without real text fails"],
]) {
  const verdict = classifyStopReason(reason, text);
  check(label, verdict.ok === expected, verdict);
}

// ------------------------------------------------------------------ streaming

console.log("\nstreaming-json parsing");

let r = await runFake(
  "stream",
  emit([
    { type: "thought", data: "Analyzing..." },
    { type: "tool_call", toolCallId: "c1", title: "Read", toolName: "read_file" },
    { type: "text", data: "Here's a " },
    { type: "text", data: "summary." },
    // The per-response usage line reports the raw provider reason mid-loop.
    // Treating it as the turn result would fail a perfectly healthy run.
    { type: "usage", messageId: "r1", stopReason: "tool_use" },
    { type: "end", stopReason: "end_turn", sessionId: "abc123" },
  ]),
);
check("text chunks are concatenated", r.text === "Here's a summary.", r.text);
check("stopReason comes from `end`, not `usage`", r.stopReason === "end_turn", r.stopReason);
check("classified ok", r.ok === true, r.errorMessage);
check("sessionId extracted", r.sessionId === "abc123", r.sessionId);
check("thought captured", r.thought === "Analyzing...", r.thought);

r = await runFake("legacy", emit([{ text: "legacy answer", stopReason: "EndTurn" }]));
check("single-object json still parses", r.ok === true && r.text === "legacy answer", r);
check("legacy path raises no truncation warning", !r.warning, r.warning);

r = await runFake(
  "cancelled",
  emit([{ type: "text", data: "partial work" }, { type: "end", stopReason: "cancelled" }]),
);
check("cancelled turn fails", r.ok === false, r.ok);
check("cancelled turn keeps its partial text", r.text === "partial work", r.text);

r = await runFake("noend", emit([{ type: "text", data: "half an answer" }]));
check("missing `end` still yields the text", r.text === "half an answer", r.text);
check("missing `end` is a failure, not a completed answer", r.ok === false, r);
check("missing `end` says the answer is incomplete", /incomplete/.test(r.errorMessage || ""), r.errorMessage);

r = await runFake(
  "errafter",
  emit([{ type: "text", data: "some commentary" }, { type: "error", message: "backend exploded" }]),
);
check("error event after text still fails", r.ok === false, r);
check("error event after text keeps the message", /backend exploded/.test(r.errorMessage || ""), r.errorMessage);
check("error event after text keeps the partial text", r.text === "some commentary", r.text);

r = await runFake(
  "errthenend",
  emit([
    { type: "error", message: "transient" },
    { type: "text", data: "recovered answer" },
    { type: "end", stopReason: "end_turn" },
  ]),
);
check("a later `end` overrides an earlier error event", r.ok === true, r);

r = await runFake(
  "tooluse",
  emit([{ type: "text", data: "partial analysis so far" }, { type: "end", stopReason: "tool_use" }]),
);
check("turn ending on tool_use is flagged as truncated", r.ok === true && /truncated/.test(r.warning || ""), r);

r = await runFake(
  "errorevent",
  emit([{ type: "error", message: "backend exploded" }]),
);
check("error event fails", r.ok === false, r.ok);
check("error event message is surfaced", /backend exploded/.test(r.errorMessage || ""), r.errorMessage);

r = await runFake(
  "aftend",
  emit([
    { type: "text", data: "A" },
    { type: "end", stopReason: "end_turn" },
    { type: "text", data: "B" },
  ]),
);
check("text after `end` is not lost", r.text === "AB", r.text);

r = await runFake(
  "nonewline",
  `#!/bin/sh\nprintf '{"type":"text","data":"tail"}\\n{"type":"end","stopReason":"end_turn"}'\n`,
);
check("final line without a newline parses", r.ok === true && r.stopReason === "end_turn", r);

r = await runFake("crash", `#!/bin/sh\nprintf '{"type":"text","data":"partial"}\\n'\nexit 3\n`);
check("nonzero exit fails", r.ok === false && r.exitCode === 3, r);
check("nonzero exit keeps partial text", r.text === "partial", r.text);

// onProgress must survive a JSON object split across two socket reads.
const seen = [];
r = await runFake(
  "split",
  `#!/bin/sh\nprintf '{"type":"text","da'\nsleep 0.3\nprintf 'ta":"split ok"}\\n'\n` +
    `printf '{"type":"end","stopReason":"end_turn"}\\n'\n`,
  { onProgress: (e) => seen.push(e) },
);
check("split line is reassembled", r.text === "split ok", r.text);
check(
  "onProgress sees the split event",
  seen.some((e) => e.type === "text" && e.data === "split ok"),
  seen,
);

// --------------------------------------------------------------- prompt file

console.log("\nprompt delivery");

// The fake grok prints the --prompt-file it was given, plus that path.
r = await runFake(
  "promptfile",
  `#!/bin/sh\nwhile [ "$1" != "--prompt-file" ]; do shift; done\n` +
    `printf '{"type":"text","data":"%s|%s"}\\n' "$(cat "$2")" "$2"\n` +
    `printf '{"type":"end","stopReason":"end_turn"}\\n'\n`,
  { prompt: "the prompt body" },
);
const [body, promptPath] = r.text.split("|");
check("prompt arrives via --prompt-file", body === "the prompt body", r.text);
check("prompt file is removed afterwards", promptPath && !existsSync(promptPath), promptPath);

// A 1MB prompt would be E2BIG as a -p argument.
r = await runFake(
  "bigprompt",
  `#!/bin/sh\nwhile [ "$1" != "--prompt-file" ]; do shift; done\n` +
    `printf '{"type":"text","data":"%s"}\\n' "$(wc -c < "$2" | tr -d ' ')"\n` +
    `printf '{"type":"end","stopReason":"end_turn"}\\n'\n`,
  { prompt: "y".repeat(1_000_000) },
);
check("prompt larger than ARG_MAX is delivered", r.ok && r.text === "1000000", r.text);

// ------------------------------------------------------------------- sandbox

console.log("\nsandbox");

r = await runFake(
  "nosandbox",
  `#!/bin/sh\necho "warning: sandbox could not be applied: unsupported kernel" >&2\n` +
    `sleep 0.5\nprintf '{"type":"text","data":"ran unsandboxed"}\\n'\n` +
    `printf '{"type":"end","stopReason":"end_turn"}\\n'\nsleep 30\n`,
  { timeoutMs: 25_000, graceMs: 500 },
);
check("sandbox failure stops the run", r.ok === false && r.sandboxFailed === true, r);
check("sandbox failure is named", /sandbox/.test(r.errorMessage || ""), r.errorMessage);
check("sandbox failure is caught before the answer", !r.text.includes("ran unsandboxed"), r.text);

r = await runFake(
  "nobwrap",
  `#!/bin/sh\necho "Error: this sandbox could not enforce its deny list on Linux: bwrap exec failed: No such file or directory (os error 2). Install bubblewrap with \\\`apt install -y bubblewrap\\\`. Refusing to start with denied paths unprotected." >&2\nexit 1\n`,
);
check("bwrap refusal fails the run", r.ok === false && r.sandboxFailed === true, r);
check("bwrap refusal explains the fix", /bubblewrap/.test(r.errorMessage || "") && /PATH/.test(r.errorMessage || ""), r.errorMessage);

const { readOnlyArgs, sandboxAvailability } = await import(LIB);
check("unsandboxed fallback omits --sandbox", !readOnlyArgs({ web: false, sandbox: false }).includes("--sandbox"));
check(
  "unsandboxed fallback keeps the tool allowlist",
  readOnlyArgs({ web: false, sandbox: false }).includes("--tools"),
);
if (process.platform !== "linux") {
  check("sandbox counts as available off Linux", sandboxAvailability().available === true);
}
const consultArgs = readOnlyArgs({ web: true });
const reviewArgs = readOnlyArgs({ web: false });
const valueOf = (args, flag) => args[args.indexOf(flag) + 1];
check(
  "consult allowlists read + web tools only",
  valueOf(consultArgs, "--tools") === "read_file,grep,list_dir,web_search,web_fetch",
  valueOf(consultArgs, "--tools"),
);
check("review allowlists read tools only", valueOf(reviewArgs, "--tools") === "read_file,grep,list_dir", reviewArgs);
check("read-only sandbox requested", valueOf(reviewArgs, "--sandbox") === "read-only", reviewArgs);
check("unapproved tools are refused", valueOf(reviewArgs, "--permission-mode") === "dontAsk", reviewArgs);
check(
  "MCP meta-tools and `write` are removed",
  ["search_tool", "use_tool", "write", "Agent"].every((t) => valueOf(reviewArgs, "--disallowed-tools").split(",").includes(t)),
  valueOf(reviewArgs, "--disallowed-tools"),
);
check("MCP calls are denied", reviewArgs.join(" ").includes("--deny MCPTool"), reviewArgs);

// -------------------------------------------------------------------- effort

console.log("\neffort");

const home = join(DIR, "grokhome");
mkdirSync(home);
writeFileSync(
  join(home, "models_cache.json"),
  JSON.stringify({
    models: {
      "m-yes": { info: { supports_reasoning_effort: true } },
      "m-no": { info: { supports_reasoning_effort: false } },
    },
  }),
);
async function effortFor(name, req, env = {}) {
  const fakeModels = join(DIR, `${name}-models.sh`);
  writeFileSync(fakeModels, `#!/bin/sh\necho "Default model: ${env.defaultModel ?? "m-yes"}"\n`);
  chmodSync(fakeModels, 0o755);
  process.env.GROK_BIN = fakeModels;
  process.env.GROK_HOME = home;
  if (env.effort === undefined) delete process.env.GROK_PLUGIN_EFFORT;
  else process.env.GROK_PLUGIN_EFFORT = env.effort;
  const mod = await import(`${LIB}?effort=${name}`);
  return mod.effortArgs(req);
}
let e = await effortFor("default", {});
check("default effort is medium", e.args.join(" ") === "--effort medium", e);
e = await effortFor("explicit", { effort: "high" });
check("explicit effort wins", e.args.join(" ") === "--effort high", e);
e = await effortFor("envset", {}, { effort: "low" });
check("GROK_PLUGIN_EFFORT sets the default", e.args.join(" ") === "--effort low", e);
e = await effortFor("envdefault", {}, { effort: "default" });
check("GROK_PLUGIN_EFFORT=default sends no flag", e.args.length === 0 && !e.dropped, e);
e = await effortFor("unknown", {}, { defaultModel: "m-uncached" });
check("unknown support still sends the default", e.args.join(" ") === "--effort medium", e);
e = await effortFor("nosupport", {}, { defaultModel: "m-no" });
check("unsupported model drops the implicit default quietly", e.args.length === 0 && !e.dropped, e);
e = await effortFor("nosupportexplicit", { effort: "high", model: "m-no" });
check("unsupported model drops an explicit effort with a message", e.args.length === 0 && Boolean(e.dropped), e);
e = await effortFor("alias", { reasoningEffort: "low" });
check("--reasoning-effort is sent once, as --effort", e.args.join(" ") === "--effort low", e);
delete process.env.GROK_PLUGIN_EFFORT;

// -------------------------------------------------------------------- timers

console.log("\nwatchdogs");

r = await runFake("stall", "#!/bin/sh\nsleep 30\n", { timeoutMs: 25_000, idleMs: 1_500 });
check("idle timer fires on silence", r.idledOut === true, r);
check("idle failure names the stall", /No output from grok/.test(r.errorMessage || ""), r.errorMessage);

const slowDrip =
  `#!/bin/sh\ni=0\nwhile [ $i -lt 50 ]; do printf '{"type":"text","data":"."}\\n'; sleep 0.2; i=$((i+1)); done\n`;
r = await runFake("race", slowDrip, { timeoutMs: 1_500, idleMs: 1_000 });
check(
  "wall-clock timeout is not misreported as a stall",
  r.timedOut === true && r.idledOut === false,
  { timedOut: r.timedOut, idledOut: r.idledOut, error: r.errorMessage },
);

// A turn that completed before the process hung must not be thrown away.
r = await runFake(
  "hangafterend",
  `#!/bin/sh\nprintf '{"type":"text","data":"complete answer"}\\n'\n` +
    `printf '{"type":"end","stopReason":"end_turn"}\\n'\nsleep 30\n`,
  // Idle must outlast a slow shell start under load, or it fires before the
  // answer is printed and the test flakes.
  { timeoutMs: 25_000, idleMs: 3_000 },
);
check("completed answer survives a post-answer hang", r.ok === true, r);
check("completed-then-killed run is flagged", Boolean(r.warning), r.warning);

// A descendant that ignores SIGTERM and drops the pipes must still be SIGKILLed,
// even when the companion exits as soon as runGrok resolves. Runs in a separate
// node process because the bug was the parent exiting before escalation fired.
const pidFile = join(DIR, "stubborn.pid");
const stubborn = join(DIR, "stubborn.sh");
writeFileSync(
  stubborn,
  `#!/bin/sh\n( trap '' TERM; exec sh -c 'trap "" TERM; echo $$ > ${pidFile}; while :; do sleep 1; done' ) >/dev/null 2>&1 &\n` +
    `sleep 30\n`,
);
chmodSync(stubborn, 0o755);
const driver = join(DIR, "driver.mjs");
writeFileSync(
  driver,
  `process.env.GROK_BIN = ${JSON.stringify(stubborn)};\n` +
    `const { runGrok } = await import(${JSON.stringify(LIB)});\n` +
    `await runGrok([], { timeoutMs: 800, idleMs: 0, graceMs: 700 });\n`,
);
spawnSync(process.execPath, [driver], { timeout: 20_000 });
const stubbornPid = Number(readFileSync(pidFile, "utf8").trim());
await new Promise((r) => setTimeout(r, 200));
let survived = true;
try {
  process.kill(stubbornPid, 0);
} catch {
  survived = false;
}
if (survived) process.kill(stubbornPid, "SIGKILL");
check("SIGTERM-ignoring descendant is killed before the companion exits", !survived, stubbornPid);

// ---------------------------------------------------------------------------

console.log(
  failures ? `\n${failures} check(s) failed\n` : `\nall checks passed\n`,
);
process.exit(failures ? 1 : 0);
