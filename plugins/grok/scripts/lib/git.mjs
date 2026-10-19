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

// Budget for the full current text of changed files inlined into a review.
// From the diff alone grok either missed bugs that need the surrounding code or
// spent most of the run paging through the changed files with read_file; with
// the files inlined every config found every planted bug, and grok-4.7 at low
// effort went from missing a cross-file bug every run to finding it every run.
// Past ~150 KB it stopped helping (a 175 KB real consult got slower and dearer),
// so files that do not fit are listed and left to the read tools.
// GROK_PLUGIN_INLINE_BYTES overrides it; 0 turns inlining off.
const DEFAULT_INLINE_BYTES = 150_000;

function inlineBudget() {
  const raw = process.env.GROK_PLUGIN_INLINE_BYTES;
  if (raw === undefined || raw === "") return DEFAULT_INLINE_BYTES;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_INLINE_BYTES;
}

// Files whose full text is noise to a reviewer: lockfiles, minified bundles and
// source maps. Their diff hunks still show.
const SKIP_INLINE =
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|Gemfile\.lock|composer\.lock|go\.sum|flake\.lock)$|\.min\.(js|css)$|\.map$/;

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

// A code fence longer than any backtick run in the body, so a file that itself
// contains ``` cannot close the block early.
function fence(body) {
  const longest = Math.max(2, ...(body.match(/`+/g) ?? []).map((r) => r.length));
  return "`".repeat(longest + 1);
}

function nulList(out) {
  return out.split("\0").filter(Boolean);
}

// The full current text of each changed (not deleted) file: from HEAD for a
// branch review, from disk for a working-tree review. Symlinks, submodules and
// binaries are skipped, and nothing outside the budget is read. `git diff
// --name-only` paths are relative to the top level, not to cwd, so everything
// here runs from the top level.
function changedFilesSection(cwd, target, paths) {
  let left = inlineBudget();
  if (!left || !paths.length) return null;
  const top = gitOrThrow(["rev-parse", "--show-toplevel"], cwd).trim();
  const shown = [];
  const skipped = [];
  const blobs = new Map();
  if (target.mode === "branch") {
    // <mode> SP <type> SP <object> SP <size> TAB <path>. Batched so a branch with
    // thousands of changed paths cannot overflow argv (E2BIG).
    for (let i = 0; i < paths.length; i += 500) {
      const batch = paths.slice(i, i + 500);
      const tree = gitOrThrow(["--literal-pathspecs", "ls-tree", "-z", "-l", "HEAD", "--", ...batch], top);
      for (const entry of nulList(tree)) {
        const m = entry.match(/^(\d+) (\w+) (\S+) +(\S+)\t(.*)$/s);
        if (m) blobs.set(m[5], { mode: m[1], type: m[2], size: Number(m[4]) });
      }
    }
  }
  for (const f of paths) {
    if (SKIP_INLINE.test(f)) {
      skipped.push(`${f} (lockfile or generated)`);
      continue;
    }
    let size;
    let read;
    if (target.mode === "branch") {
      const b = blobs.get(f);
      if (!b || b.type !== "blob" || b.mode === "120000") continue;
      size = b.size;
      read = () => gitOrThrow(["cat-file", "blob", `HEAD:${f}`], top);
    } else {
      const abs = resolve(top, f);
      let st;
      try {
        st = lstatSync(abs);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      size = st.size;
      read = () => readHead(abs, size).body;
    }
    if (size > left) {
      skipped.push(`${f} (${size} bytes, over the inline budget)`);
      continue;
    }
    const body = read();
    if (body.includes("\0")) continue;
    left -= size;
    const fc = fence(body);
    shown.push("", `--- ${f} ---`, fc, body.replace(/\n$/, ""), fc);
  }
  if (!shown.length && !skipped.length) return null;
  const where = target.mode === "branch" ? "as of HEAD" : "as on disk now";
  const out = [];
  if (shown.length) {
    out.push(
      `Full current text of the changed files (${where}). These are complete: do not read them again with tools.`,
      ...shown,
    );
  }
  if (skipped.length) {
    out.push("", "Changed files not shown in full (read them with the tools if needed):");
    for (const s of skipped) out.push(`- ${s}`);
  }
  return out.join("\n");
}

// Collect the diff/context text for a target. Returns { content, empty }.
export function collectReviewContext(cwd, target) {
  if (target.mode === "branch") {
    const base = target.baseRef;
    const diff = gitOrThrow(["diff", "--no-ext-diff", "--no-textconv", "--end-of-options", `${base}...HEAD`], cwd);
    checkDiffSize(diff);
    const log = gitOrThrow(["log", "--oneline", "--end-of-options", `${base}..HEAD`], cwd);
    const sections = [`Comparing against base: ${base} (\`git diff ${base}...HEAD\`)`];
    if (log.trim()) {
      sections.push("", "Commits on this branch:", "```", log.trim(), "```");
    }
    sections.push("", "Diff:", "```diff", diff.trim() || "(no diff)", "```");
    const files = nulList(
      gitOrThrow(["diff", "--name-only", "-z", "--diff-filter=d", "--end-of-options", `${base}...HEAD`], cwd),
    );
    const full = changedFilesSection(cwd, target, files);
    if (full) sections.push("", full);
    return { content: sections.join("\n"), empty: !diff.trim() };
  }

  // working tree
  const sections = ["Reviewing the working tree (staged + unstaged + untracked)."];
  const status = gitOrThrow(["status", "--short", "--untracked-files=all"], cwd);
  if (status.trim()) {
    sections.push("", "git status:", "```", status.trim(), "```");
  }
  const staged = gitOrThrow(["diff", "--no-ext-diff", "--no-textconv", "--cached"], cwd);
  const unstaged = gitOrThrow(["diff", "--no-ext-diff", "--no-textconv"], cwd);
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
  const changed = new Set([
    ...nulList(gitOrThrow(["diff", "--cached", "--name-only", "-z", "--diff-filter=d"], cwd)),
    ...nulList(gitOrThrow(["diff", "--name-only", "-z", "--diff-filter=d"], cwd)),
  ]);
  const full = changedFilesSection(cwd, target, [...changed]);
  if (full) sections.push("", full);
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

// How to spend the investigation. Left to itself grok paged through files in
// small offset/limit reads, re-read the same file up to 7 times and surveyed
// unrelated code (every registrar adapter, the config, the tests): 40-80 tool
// calls, each followed by a slow reasoning pass, which is what pushed reviews
// past the timeout. A hard "at most N reads" cap was faster but sometimes cut
// the one read that found a cross-file bug, so this asks for coverage of every
// changed hunk and what depends on it, and budgets only the wasted motion.
// Benchmarked against both: same findings as the uncapped run, in about a minute.
export const REVIEW_METHOD =
  "Working method: review every changed hunk, using the diff and any full files above as primary " +
  "evidence; files shown in full need no read_file. For each " +
  "change, check what depends on it: callers, consumers of changed values, strings, defaults or " +
  "return codes, and the invariants the surrounding code relies on. Read the code you need for that " +
  "and nothing else: aim for at most 6 investigation steps, batch independent reads into one step, " +
  "read whole functions instead of paging, never re-read the same range, and do not survey unrelated " +
  "implementations. Then write the final answer; list anything you could not verify.";

// The consult equivalent: a question, not necessarily a diff, so it asks for
// the same economy without the per-hunk coverage rule.
export const CONSULT_METHOD =
  "Working method: treat the question and any attached files above as primary evidence. Read other " +
  "files only where the answer depends on them: batch independent reads into one step, read whole " +
  "functions instead of paging, never re-read the same range, and do not survey unrelated code. Then " +
  "write the final answer; list anything you could not verify.";

export function buildReviewPrompt(cwd, target, context, { focusText } = {}) {
  const sections = [...REVIEW_HEADER, "", `Working directory: ${cwd}`];
  if (focusText && focusText.trim()) {
    sections.push("", `Extra focus from the user: ${focusText.trim()}`);
  }
  sections.push("", context.content, "", REVIEW_METHOD);
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
  parts.push("", CONSULT_METHOD);
  return parts.join("\n");
}
