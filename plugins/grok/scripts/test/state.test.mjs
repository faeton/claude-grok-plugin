#!/usr/bin/env node
// Tests for argument parsing, review-context collection, and the job state
// machine (guarded transitions, reconcile, locking).
//
// No dependencies and no network. Job state goes to a temp GROK_COMPANION_HOME
// and git cases run in throwaway repos.
//
//   node plugins/grok/scripts/test/state.test.mjs

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = mkdtempSync(join(tmpdir(), "grok-state-test-"));
process.env.GROK_COMPANION_HOME = join(DIR, "companion");
delete process.env.GROK_COMPANION_SESSION_ID;

const LIB = resolve(dirname(fileURLToPath(import.meta.url)), "..", "lib");
const { parseArgs } = await import(join(LIB, "args.mjs"));
const { buildConsultPrompt, collectReviewContext, resolveReviewTarget } = await import(join(LIB, "git.mjs"));
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

// Working tree as one net diff against HEAD.
const net = makeRepo("net");
writeFileSync(join(net, "a.txt"), "STAGED-BUG\n");
g(net, "add", "a.txt");
writeFileSync(join(net, "a.txt"), "fixed\n");
ctx = collectReviewContext(net, { mode: "working-tree" });
const mainDiff = ctx.content.split("Staged and on-disk versions differ")[0];
check("a staged change undone on disk is not in the main diff", !mainDiff.includes("STAGED-BUG") && mainDiff.includes("+fixed"), ctx.content);
check("...and appears only as the labeled staged version", ctx.content.includes("+STAGED-BUG") && /what `git commit` would record/.test(ctx.content), null);

// Index-only changes are shown too, as the staged version.
const idx = makeRepo("index");
writeFileSync(join(idx, "added.txt"), "ADDED-THEN-DELETED\n");
g(idx, "add", "added.txt");
spawnSync("rm", [join(idx, "added.txt")]);
ctx = collectReviewContext(idx, { mode: "working-tree" });
check("a staged file deleted on disk (AD) is reviewed", !ctx.empty && ctx.content.includes("+ADDED-THEN-DELETED"), ctx.content);
const mm = makeRepo("mm");
writeFileSync(join(mm, "a.txt"), "STAGED-VERSION\n");
g(mm, "add", "a.txt");
writeFileSync(join(mm, "a.txt"), "DISK-VERSION\n");
ctx = collectReviewContext(mm, { mode: "working-tree" });
check("MM: both the on-disk and the staged version are shown", ctx.content.includes("+DISK-VERSION") && ctx.content.includes("+STAGED-VERSION") && /what `git commit` would record/.test(ctx.content), ctx.content);
const rmc = makeRepo("rmcached");
g(rmc, "rm", "-q", "--cached", "a.txt");
ctx = collectReviewContext(rmc, { mode: "working-tree" });
check("git rm --cached shows the staged deletion", /deleted file mode[\s\S]*-one/.test(ctx.content), ctx.content);

const unborn = join(DIR, "unborn");
mkdirSync(unborn);
g(unborn, "init", "-q", "-b", "main");
writeFileSync(join(unborn, "first.txt"), "first file\n");
g(unborn, "add", "first.txt");
ctx = collectReviewContext(unborn, { mode: "working-tree" });
check("a repo with no commits yet diffs against the empty tree", !ctx.empty && ctx.content.includes("+first file"), ctx.content);

// Repo-configured programs must not run during context collection.
const hostile = makeRepo("hostile");
const marker = join(DIR, "ran-a-program");
const prog = join(DIR, "prog.sh");
writeFileSync(prog, `#!/bin/sh\ntouch "${marker}"\ncat "$1" 2>/dev/null\n`);
chmodSync(prog, 0o755);
g(hostile, "config", "diff.external", prog);
g(hostile, "config", "diff.conv.textconv", prog);
writeFileSync(join(hostile, ".gitattributes"), "*.txt diff=conv\n");
writeFileSync(join(hostile, "a.txt"), "two\n");
ctx = collectReviewContext(hostile, { mode: "working-tree" });
check("diff.external and textconv drivers are not run", !existsSync(marker) && ctx.content.includes("+two"), ctx.content);

// A FIFO must neither hang the review nor be read.
const fifoRepo = makeRepo("fifo");
const fifo = join(fifoRepo, "pipe");
const mk = spawnSync("mkfifo", [fifo]);
if (mk.status === 0) {
  ctx = collectReviewContext(fifoRepo, { mode: "working-tree" });
  check("an untracked FIFO is skipped without blocking", !ctx.content.includes("Untracked file pipe"), null);
  check("a --file FIFO is refused, not read", throws(() => buildConsultPrompt({ question: "q", files: [fifo], cwd: fifoRepo }), /not a regular file/), null);
}

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
