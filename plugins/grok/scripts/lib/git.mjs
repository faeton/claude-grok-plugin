// Git helpers + review/consult prompt construction.

import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const MAX_FILE_BYTES = 200_000;

// Run git. Returns { ok, status, stdout } so callers can distinguish "command
// failed" from "command succeeded with empty output" (the old helper collapsed
// both to null, which broke scope detection).
export function git(args, opts = {}) {
  const res = spawnSync("git", args, { encoding: "utf8", ...opts });
  return {
    ok: res.status === 0,
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
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

// Resolve the review target: { mode, baseRef, label }.
export function resolveReviewTarget(cwd, { base, scope } = {}) {
  const requested = scope || "auto";
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
    git(["status", "--porcelain", "--untracked-files=all"], { cwd }).stdout.trim() !== "";
  if (dirty || !resolvedBase) {
    return { mode: "working-tree", baseRef: null, label: "working tree" };
  }
  return { mode: "branch", baseRef: resolvedBase, label: `branch vs ${resolvedBase}` };
}

// Collect the diff/context text for a target. Returns { content, empty }.
export function collectReviewContext(cwd, target) {
  if (target.mode === "branch") {
    const base = target.baseRef;
    const diff = git(["diff", `${base}...HEAD`], { cwd }).stdout;
    const log = git(["log", "--oneline", `${base}..HEAD`], { cwd }).stdout;
    const sections = [`Comparing against base: ${base} (\`git diff ${base}...HEAD\`)`];
    if (log.trim()) {
      sections.push("", "Commits on this branch:", "```", log.trim(), "```");
    }
    sections.push("", "Diff:", "```diff", diff.trim() || "(no diff)", "```");
    return { content: sections.join("\n"), empty: !diff.trim() };
  }

  // working tree
  const sections = ["Reviewing the working tree (staged + unstaged + untracked)."];
  const status = git(["status", "--short", "--untracked-files=all"], { cwd }).stdout;
  if (status.trim()) {
    sections.push("", "git status:", "```", status.trim(), "```");
  }
  const staged = git(["diff", "--cached"], { cwd }).stdout;
  const unstaged = git(["diff"], { cwd }).stdout;
  const diff = [staged, unstaged].filter((s) => s.trim()).join("\n");

  let hasUntracked = false;
  const untracked = git(["ls-files", "--others", "--exclude-standard"], { cwd }).stdout;
  for (const f of untracked.split("\n").map((s) => s.trim()).filter(Boolean)) {
    try {
      const body = readFileSync(resolve(cwd, f), "utf8");
      hasUntracked = true;
      if (body.length <= MAX_FILE_BYTES) {
        sections.push("", `Untracked file ${f}:`, "```", body, "```");
      } else {
        sections.push("", `Untracked file ${f}: (${body.length} bytes, skipped)`);
      }
    } catch {
      /* unreadable */
    }
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
    const body = readFileSync(abs, "utf8");
    const clipped =
      body.length > MAX_FILE_BYTES
        ? body.slice(0, MAX_FILE_BYTES) + `\n… (truncated, ${body.length} bytes total)`
        : body;
    parts.push("", `--- ${f} ---`, "```", clipped, "```");
  }
  return parts.join("\n");
}
