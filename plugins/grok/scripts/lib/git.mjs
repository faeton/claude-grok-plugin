// Git helpers + review/consult prompt construction.

import { spawnSync } from "node:child_process";
import { closeSync, existsSync, fstatSync, lstatSync, openSync, readSync, readlinkSync } from "node:fs";
import { resolve } from "node:path";

const MAX_FILE_BYTES = 200_000;

// Above this the review fails instead of running on part of the change. A
// review that silently saw only the first megabyte can report a change clean.
const MAX_DIFF_BYTES = 2_000_000;

// Total budget for untracked file bodies inlined into a working-tree review.
const MAX_UNTRACKED_BYTES = 1_000_000;

// spawnSync's default 1MB buffer kills git and hands back a truncated stdout
// that looked like a complete diff. The size limits above are enforced on the
// result instead, with a clear error.
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

// Run git. Returns { ok, status, stdout, stderr, error } so callers can tell
// "command failed" from "command succeeded with empty output".
export function git(args, opts = {}) {
  const res = spawnSync("git", args, { encoding: "utf8", maxBuffer: GIT_MAX_BUFFER, ...opts });
  return {
    ok: !res.error && res.status === 0,
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    error: res.error ?? null,
  };
}

// For context collection: a failed git call must not turn into "no changes".
function gitOrThrow(args, cwd) {
  const res = git(args, { cwd });
  if (!res.ok) {
    const why =
      res.error?.code === "ENOBUFS"
        ? `output exceeded ${GIT_MAX_BUFFER} bytes`
        : res.stderr.trim().split("\n")[0] || res.error?.message || `exit code ${res.status}`;
    throw new Error(`\`git ${args[0]}\` failed: ${why}`);
  }
  return res.stdout;
}

export function isGitRepository(cwd = process.cwd()) {
  return git(["rev-parse", "--is-inside-work-tree"], { cwd }).ok;
}

export function ensureGitRepository(cwd = process.cwd()) {
  if (!isGitRepository(cwd)) {
    throw new Error("Not inside a git repository — `review` needs git state to diff.");
  }
}

export function detectBase(cwd = process.cwd()) {
  const head = git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd });
  if (head.ok && head.stdout.trim()) {
    const ref = head.stdout.trim();
    if (git(["merge-base", "HEAD", ref], { cwd }).ok) return ref;
  }
  for (const candidate of ["origin/main", "origin/master", "main", "master"]) {
    if (git(["rev-parse", "--verify", "--quiet", candidate], { cwd }).ok) {
      return candidate;
    }
  }
  return null;
}

// --base reaches `git diff` / `git log` as a revision. A value starting with "-"
// would be parsed as an option (`--output=<path>` makes git write a file), so
// reject it outright, and require it to name a real commit.
export function validateBase(cwd, base) {
  if (base.startsWith("-")) {
    throw new Error(`Invalid --base "${base}": a ref cannot start with "-".`);
  }
  const res = git(["rev-parse", "--verify", "--quiet", "--end-of-options", `${base}^{commit}`], {
    cwd,
  });
  if (!res.ok) throw new Error(`--base "${base}" is not a commit in this repository.`);
}

export const REVIEW_SCOPES = ["auto", "working-tree", "branch"];

// Resolve the review target: { mode, baseRef, label }.
export function resolveReviewTarget(cwd, { base, scope } = {}) {
  const requested = scope || "auto";
  if (!REVIEW_SCOPES.includes(requested)) {
    throw new Error(`Unknown --scope "${requested}" (expected ${REVIEW_SCOPES.join(", ")}).`);
  }
  if (base) validateBase(cwd, base);
  const resolvedBase = base || detectBase(cwd);

  if (requested === "branch") {
    if (!resolvedBase) {
      throw new Error("Could not detect a base branch; pass --base <ref>.");
    }
    return { mode: "branch", baseRef: resolvedBase, label: `branch vs ${resolvedBase}` };
  }

  if (requested === "working-tree") {
    return { mode: "working-tree", baseRef: null, label: "working tree" };
  }

  // auto: prefer working tree if dirty, else branch diff vs base.
  const dirty =
    gitOrThrow(["status", "--porcelain", "--untracked-files=all"], cwd).trim() !== "";
  if (dirty || !resolvedBase) {
    return { mode: "working-tree", baseRef: null, label: "working tree" };
  }
  return { mode: "branch", baseRef: resolvedBase, label: `branch vs ${resolvedBase}` };
}

function checkDiffSize(diff) {
  const bytes = Buffer.byteLength(diff, "utf8");
  if (bytes > MAX_DIFF_BYTES) {
    const mb = (n) => (n / 1_000_000).toFixed(1);
    throw new Error(
      `The diff is ${mb(bytes)}MB, over the ${mb(MAX_DIFF_BYTES)}MB review limit. ` +
        "Narrow it (--base, --scope, or commit in smaller pieces) rather than review part of it.",
    );
  }
}

// Read at most `limit` bytes of a regular file, reporting its full size, without
// loading a multi-gigabyte artifact into memory first.
function readHead(abs, limit) {
  const fd = openSync(abs, "r");
  try {
    const size = fstatSync(fd).size;
    const buf = Buffer.alloc(Math.min(size, limit));
    const n = readSync(fd, buf, 0, buf.length, 0);
    return { size, body: buf.subarray(0, n).toString("utf8"), binary: buf.subarray(0, n).includes(0) };
  } finally {
    closeSync(fd);
  }
}

// One untracked path → a prompt section (or null to skip it silently).
//
// Never follows symlinks: an untracked link to ~/.ssh/id_rsa would otherwise
// ship a file from outside the repo to the model. The link itself is the change,
// so its target path is shown instead of the target's contents.
function describeUntracked(cwd, f, budget) {
  const abs = resolve(cwd, f);
  let st;
  try {
    st = lstatSync(abs);
  } catch {
    return null;
  }
  if (st.isSymbolicLink()) {
    let target = "?";
    try {
      target = readlinkSync(abs);
    } catch {
      /* unreadable link */
    }
    return { text: `Untracked symlink ${f} -> ${target} (not followed)`, bytes: 0 };
  }
  if (!st.isFile()) return null;
  if (st.size > MAX_FILE_BYTES) {
    return { text: `Untracked file ${f}: (${st.size} bytes, skipped — over the per-file limit)`, bytes: 0 };
  }
  if (st.size > budget.left) {
    return { text: `Untracked file ${f}: (${st.size} bytes, skipped — review size budget used up)`, bytes: 0 };
  }
  const { body, binary } = readHead(abs, MAX_FILE_BYTES);
  if (binary) return { text: `Untracked file ${f}: (binary, skipped)`, bytes: 0 };
  return { text: [`Untracked file ${f}:`, "```", body, "```"].join("\n"), bytes: st.size };
}

// Collect the diff/context text for a target. Returns { content, empty }.
export function collectReviewContext(cwd, target) {
  if (target.mode === "branch") {
    const base = target.baseRef;
    const diff = gitOrThrow(["diff", "--end-of-options", `${base}...HEAD`], cwd);
    checkDiffSize(diff);
    const log = gitOrThrow(["log", "--oneline", "--end-of-options", `${base}..HEAD`], cwd);
    const sections = [`Comparing against base: ${base} (\`git diff ${base}...HEAD\`)`];
    if (log.trim()) {
      sections.push("", "Commits on this branch:", "```", log.trim(), "```");
    }
    sections.push("", "Diff:", "```diff", diff.trim() || "(no diff)", "```");
    return { content: sections.join("\n"), empty: !diff.trim() };
  }

  // working tree
  const sections = ["Reviewing the working tree (staged + unstaged + untracked)."];
  const status = gitOrThrow(["status", "--short", "--untracked-files=all"], cwd);
  if (status.trim()) {
    sections.push("", "git status:", "```", status.trim(), "```");
  }
  const staged = gitOrThrow(["diff", "--cached"], cwd);
  const unstaged = gitOrThrow(["diff"], cwd);
  const diff = [staged, unstaged].filter((s) => s.trim()).join("\n");
  checkDiffSize(diff);

  // -z: NUL-separated and unquoted. Without it git C-quotes names containing
  // spaces, tabs, newlines or non-ASCII bytes, and those quoted strings are not
  // real paths — such files silently vanished from the review.
  let hasUntracked = false;
  const budget = { left: MAX_UNTRACKED_BYTES };
  const untracked = gitOrThrow(["ls-files", "-z", "--others", "--exclude-standard"], cwd);
  for (const f of untracked.split("\0").filter(Boolean)) {
    const section = describeUntracked(cwd, f, budget);
    if (!section) continue;
    hasUntracked = true;
    budget.left -= section.bytes;
    sections.push("", section.text);
  }

  sections.push("", "Diff:", "```diff", diff.trim() || "(no tracked diff)", "```");
  return { content: sections.join("\n"), empty: !diff.trim() && !hasUntracked };
}

const REVIEW_HEADER = [
  "You are reviewing the following local code changes. Be a sharp, skeptical reviewer:",
  "- Call out real correctness bugs, race conditions, security issues, and broken edge cases.",
  "- Flag missing tests for risky changes.",
  "- Skip nitpicks, style preferences, and 'consider extracting' suggestions unless they materially help.",
  "- If the diff looks clean, say so briefly.",
  "",
  "Output format: a short summary, then findings grouped by severity (HIGH / MEDIUM / LOW).",
];

export function buildReviewPrompt(cwd, target, context, { focusText } = {}) {
  const sections = [...REVIEW_HEADER, "", `Working directory: ${cwd}`];
  if (focusText && focusText.trim()) {
    sections.push("", `Extra focus from the user: ${focusText.trim()}`);
  }
  sections.push("", context.content);
  return sections.join("\n");
}

export function buildConsultPrompt({ question, files = [], cwd = process.cwd() }) {
  if (!question || !question.trim()) {
    throw new Error('consult needs a question (positional text after "--" or --question "…").');
  }
  const parts = [question.trim()];
  for (const f of files) {
    const abs = resolve(cwd, f);
    if (!existsSync(abs)) {
      throw new Error(`file not found: ${f}`);
    }
    // An explicit --file is the user's choice, so symlinks are followed here,
    // but only the first MAX_FILE_BYTES are ever read.
    const { size, body } = readHead(abs, MAX_FILE_BYTES);
    const clipped =
      size > MAX_FILE_BYTES ? body + `\n… (truncated, ${size} bytes total)` : body;
    parts.push("", `--- ${f} ---`, "```", clipped, "```");
  }
  return parts.join("\n");
}
