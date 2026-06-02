---
description: Run a Grok code review against local git state (read-only)
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [--model <id>]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run a Grok code review through the local companion. **Review only** — Grok runs strictly read-only and web search is disabled; do not fix issues or apply patches in this turn.

Raw slash-command arguments:
`$ARGUMENTS`

Execution mode rules:
- If the raw arguments include `--wait`, do not ask. Run in the foreground.
- If the raw arguments include `--background`, do not ask. Run with the companion's `--background` (it detaches its own worker — you do NOT need Claude's `run_in_background`).
- Otherwise, estimate the review size first:
  - Working tree: `git status --short --untracked-files=all`, plus `git diff --shortstat --cached` and `git diff --shortstat`.
  - Base branch: `git diff --shortstat <base>...HEAD`.
  - Treat untracked files as reviewable even when the diff stat is empty.
  - Recommend waiting only when the change is clearly tiny (~1-2 files). Otherwise recommend background. When in doubt, run it.
- Then use `AskUserQuestion` exactly once with two options, recommended first with `(Recommended)`:
  - `Wait for results`
  - `Run in background`

Argument handling:
- Preserve the user's arguments. `--scope`, `--base`, `--model` pass through to the companion.
- `/grok:review` does not take focus text. For focused/adversarial framing use `/grok:adversarial-review`.

Foreground:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" review $ARGUMENTS
```
Return the command stdout verbatim. Do not fix any issues mentioned.

Background:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" review --background $ARGUMENTS
```
Then tell the user: "Grok review started in the background. Check `/grok:status` for progress and `/grok:result <id>` for findings."

If the companion reports a failure, return it verbatim.
