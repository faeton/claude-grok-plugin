#!/usr/bin/env node
// Tests for argument parsing, review-context collection, and the job state
// machine (guarded transitions, reconcile, locking).
//
// No dependencies and no network. Job state goes to a temp GROK_COMPANION_HOME
// and git cases run in throwaway repos.
//
//   node plugins/grok/scripts/test/state.test.mjs

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = mkdtempSync(join(tmpdir(), "grok-state-test-"));
process.env.GROK_COMPANION_HOME = join(DIR, "companion");
delete process.env.GROK_COMPANION_SESSION_ID;

const LIB = resolve(dirname(fileURLToPath(import.meta.url)), "..", "lib");
const { parseArgs } = await import(join(LIB, "args.mjs"));
const { collectReviewContext, resolveReviewTarget } = await import(join(LIB, "git.mjs"));
const { createJob, reconcile, runTrackedJob, transition, START_GRACE_MS } = await import(
  join(LIB, "jobs.mjs")
);
const { listJobs, readJobFile, updateJob, withLock } = await import(join(LIB, "state.mjs"));

let failures = 0;
function check(label, cond, got) {
  if (cond) {
    console.log(`  pass  ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}\n        got: ${JSON.stringify(got)}`);
  }
}
function throws(fn, pattern) {
  try {
    fn();
    return false;
  } catch (err) {
    return pattern.test(err.message);
  }
}

// ---------------------------------------------------------------------- args

console.log("\nargument parsing");

const CONFIG = {
  valueOptions: ["model", "scope"],
  repeatable: ["file"],
  booleanOptions: ["json", "background"],
  aliasMap: { m: "model" },
};
let parsed = parseArgs(["--background=false", "--json"], CONFIG);
check("--flag=false is false", parsed.options.background === false && parsed.options.json === true, parsed);
check("a value flag will not swallow the next flag", throws(() => parseArgs(["--file", "--model", "x"], CONFIG), /expects a value/), null);
check("--flag=-value still passes a dash value", parseArgs(["--file=-x"], CONFIG).options.file[0] === "-x", null);
check("an unknown flag is an error", throws(() => parseArgs(["--scpoe", "x"], CONFIG), /Unknown flag --scpoe/), null);
check("a switch rejects a non-boolean value", throws(() => parseArgs(["--json=yes"], CONFIG), /switch/), null);
parsed = parseArgs(["-m", "grok-x", "--", "--not-a-flag", "text"], CONFIG);
check("everything after -- is positional", parsed.positionals.join(" ") === "--not-a-flag text", parsed);
check("negative numbers are values, not flags", parseArgs(["--scope", "-1"], CONFIG).options.scope === "-1", null);

// ----------------------------------------------------------------------- git

console.log("\nreview context");

const g = (cwd, ...args) => spawnSync("git", args, { cwd, encoding: "utf8" });
function makeRepo(name) {
  const repo = join(DIR, name);
  mkdirSync(repo);
  g(repo, "init", "-q", "-b", "main");
  g(repo, "config", "user.email", "t@example.com");
  g(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "a.txt"), "one\n");
  g(repo, "add", ".");
  g(repo, "commit", "-q", "-m", "init");
  return repo;
}

const repo = makeRepo("repo");
const secret = join(DIR, "secret.key");
writeFileSync(secret, "PRIVATE KEY MATERIAL\n");
symlinkSync(secret, join(repo, "leak.key"));
writeFileSync(join(repo, "my file.ts"), "spaced\n");
writeFileSync(join(repo, "naïve.ts"), "unicode\n");
writeFileSync(join(repo, "bin.dat"), Buffer.from([0, 1, 2, 3]));

let ctx = collectReviewContext(repo, { mode: "working-tree" });
check("untracked symlink target is not read", !ctx.content.includes("PRIVATE KEY MATERIAL"), ctx.content);
check("untracked symlink is listed with its target", /leak\.key -> .*secret\.key \(not followed\)/.test(ctx.content), null);
check("file name with a space is included", ctx.content.includes("spaced"), null);
check("non-ASCII file name is included", ctx.content.includes("unicode"), null);
check("binary file is skipped", /bin\.dat: \(binary, skipped\)/.test(ctx.content), null);

const onlyQuoted = makeRepo("quoted");
writeFileSync(join(onlyQuoted, "only new file.ts"), "content\n");
ctx = collectReviewContext(onlyQuoted, { mode: "working-tree" });
check("a tree whose only change is a quoted name is not 'empty'", ctx.empty === false, ctx);

check(
  "--base starting with - is rejected",
  throws(() => resolveReviewTarget(repo, { base: "--output=/tmp/pwned", scope: "branch" }), /cannot start with/),
  null,
);
check(
  "--base that is not a commit is rejected (not 'no changes')",
  throws(() => resolveReviewTarget(repo, { base: "no-such-branch", scope: "branch" }), /not a commit/),
  null,
);
check(
  "unknown --scope is rejected",
  throws(() => resolveReviewTarget(repo, { scope: "brnach" }), /Unknown --scope/),
  null,
);
check(
  "a failing git call surfaces as an error",
  throws(() => collectReviewContext(repo, { mode: "branch", baseRef: "no-such-ref" }), /git diff.*failed/),
  null,
);

// Full text of changed files.
const full = makeRepo("full");
mkdirSync(join(full, "src"));
writeFileSync(join(full, "src", "lib.py"), "def f():\n    return 1\n\n\ndef g():\n    return 2  # untouched context\n");
writeFileSync(join(full, "package-lock.json"), "{}\n");
writeFileSync(join(full, "huge.txt"), "y\n".repeat(100_000));
writeFileSync(join(full, "fenced.md"), "text\n```\ncode\n```\n");
g(full, "add", ".");
g(full, "commit", "-q", "-m", "files");
writeFileSync(join(full, "src", "lib.py"), "def f():\n    return 3\n\n\ndef g():\n    return 2  # untouched context\n");
writeFileSync(join(full, "package-lock.json"), '{"x":1}\n');
writeFileSync(join(full, "huge.txt"), "z\n".repeat(100_000));
writeFileSync(join(full, "fenced.md"), "text\n```\ncode2\n```\n");
ctx = collectReviewContext(join(full, "src"), { mode: "working-tree" });
check("a changed file's untouched code is inlined", ctx.content.includes("# untouched context"), null);
check("inlined from a subdirectory cwd", ctx.content.includes("--- src/lib.py ---"), null);
check("lockfiles are listed, not inlined", /package-lock\.json \(lockfile/.test(ctx.content) && !ctx.content.includes("--- package-lock.json ---"), null);
check("a file over the budget is listed, not inlined", /huge\.txt \(\d+ bytes, over the inline budget\)/.test(ctx.content), null);
check("a file containing ``` gets a longer fence", ctx.content.includes("````\ntext\n```\ncode2"), null);
g(full, "checkout", "-q", "-b", "feature");
g(full, "commit", "-qam", "change");
writeFileSync(join(full, "src", "lib.py"), "uncommitted\n");
ctx = collectReviewContext(full, { mode: "branch", baseRef: "main" });
check("a branch review inlines files as of HEAD", ctx.content.includes("return 3") && !ctx.content.includes("uncommitted"), null);
process.env.GROK_PLUGIN_INLINE_BYTES = "0";
ctx = collectReviewContext(full, { mode: "branch", baseRef: "main" });
check("GROK_PLUGIN_INLINE_BYTES=0 turns inlining off", !ctx.content.includes("Full current text"), null);
delete process.env.GROK_PLUGIN_INLINE_BYTES;

const big = makeRepo("big");
writeFileSync(join(big, "a.txt"), "x".repeat(2_500_000) + "\n");
check(
  "a diff over the limit fails instead of being truncated",
  throws(() => collectReviewContext(big, { mode: "working-tree" }), /review limit/),
  null,
);

// ---------------------------------------------------------------------- jobs

console.log("\njob state machine");

const ws = join(DIR, "workspace");
mkdirSync(ws);
const newJob = () =>
  createJob({ workspaceRoot: ws, kind: "consult", title: "T", summary: "s", prefix: "t", request: {} });

let job = newJob();
check("new job is queued", job.status === "queued" && job.pid === null, job);

let res = transition(ws, job.id, ["queued"], { status: "running", pid: process.pid });
check("queued -> running applies", res.changed && res.job.status === "running", res);
res = transition(ws, job.id, ["running"], { status: "completed" });
check("running -> completed applies", res.changed && res.job.status === "completed", res);
res = transition(ws, job.id, ["queued", "running"], { status: "cancelled" });
check("cancel on a completed job is a no-op", !res.changed && readJobFile(ws, job.id).status === "completed", res);
res = transition(ws, job.id, ["queued"], { status: "queued", pid: 4242 });
check("a stale launcher write cannot roll a job back", !res.changed && readJobFile(ws, job.id).status === "completed", res);

job = newJob();
let rec = reconcile(ws, job);
check("a fresh queued job with no pid is NOT orphaned", rec.status === "queued", rec);
updateJob(ws, job.id, (j) => ({ ...j, createdAt: new Date(Date.now() - START_GRACE_MS - 1000).toISOString() }));
rec = reconcile(ws, job);
check("a queued job that never started is orphaned after the grace period", rec.status === "failed" && rec.phase === "orphaned", rec);

job = newJob();
transition(ws, job.id, ["queued"], { status: "running", pid: 999_999 });
rec = reconcile(ws, { ...job, status: "running" });
check("a running job with a dead pid is orphaned", rec.phase === "orphaned", rec);

// Index says running, file says completed (a lost index update): reconcile must
// trust the file and repair the index, not orphan a finished job.
job = newJob();
transition(ws, job.id, ["queued"], { status: "completed", pid: null });
rec = reconcile(ws, { ...job, status: "running", pid: 999_999 });
check("reconcile trusts the job file over a stale index row", rec.status === "completed", rec);
check("reconcile repairs the stale index row", listJobs(ws).find((j) => j.id === job.id).status === "completed", null);

job = newJob();
transition(ws, job.id, ["queued"], { status: "cancelled" });
const ran = await runTrackedJob({ ...job, workspaceRoot: ws }, async () => {
  throw new Error("runner must not be called");
});
check("a job cancelled before its worker starts is not run", ran === null, ran);

job = newJob();
const exec = await runTrackedJob({ ...job, workspaceRoot: ws }, async () => {
  transition(ws, job.id, ["running"], { status: "cancelled", phase: "cancelled" });
  return { ok: true, payload: { text: "late" }, rendered: "late output\n" };
});
const afterCancel = readJobFile(ws, job.id);
check("a finish after cancel keeps the cancellation", afterCancel.status === "cancelled", afterCancel);
check("a finish after cancel keeps the output", afterCancel.rendered === "late output\n", afterCancel);
check("runTrackedJob still returns the execution", exec.ok === true, exec);

// ---------------------------------------------------------------------- lock

console.log("\nlocking");

const lockPath = join(DIR, "held.lock");
writeFileSync(lockPath, String(process.pid)); // held by a live process: us
check(
  "a lock held by a live process times out instead of writing unlocked",
  throws(() => withLock(lockPath, () => "entered", { timeoutMs: 200 }), /Timed out/),
  null,
);
writeFileSync(lockPath, "999999"); // owner long gone
check("a lock whose owner died is reclaimed", withLock(lockPath, () => "entered", { timeoutMs: 1_000 }) === "entered", null);

// ---------------------------------------------------------------------------

console.log(
  failures ? `\n${failures} check(s) failed\n` : `\nall checks passed\n`,
);
process.exit(failures ? 1 : 0);
