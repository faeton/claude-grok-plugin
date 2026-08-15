#!/usr/bin/env node
// Tests for the grok runner: stop-reason classification, streaming-json parsing,
// and the idle / wall-clock watchdogs.
//
// No dependencies and no network: a shell script stands in for the `grok` binary
// via GROK_BIN, so the real wire format can be replayed deterministically.
//
//   node plugins/grok/scripts/test/runner.test.mjs
//
// These exist because a PascalCase-vs-snake_case stop-reason mismatch once made
// every successful consult report as a relay cancellation while the full answer
// sat in `result.text`. Anything that decides ok/not-ok belongs under test.

import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
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
check("missing `end` warns about truncation", /truncat/i.test(r.warning || ""), r);

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
  { timeoutMs: 25_000, idleMs: 1_200 },
);
check("completed answer survives a post-answer hang", r.ok === true, r);
check("completed-then-killed run is flagged", Boolean(r.warning), r.warning);

// ---------------------------------------------------------------------------

console.log(
  failures ? `\n${failures} check(s) failed\n` : `\nall checks passed\n`,
);
process.exit(failures ? 1 : 0);
