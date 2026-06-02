---
description: Ask Grok a free-form question, optionally with file context (read-only)
argument-hint: '[--wait|--background] [--model <id>] [--effort <level>] [--file <path>]... -- <question>'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), AskUserQuestion
---

Ask Grok a question via the local companion. **Consultation only** — Grok runs strictly read-only and cannot edit files; do not act on its answer in this turn.

Raw slash-command arguments:
`$ARGUMENTS`

Argument shape:
- Everything after `--` is the question text.
- `--file <path>` (repeatable) attaches a file as context. Resolve paths relative to the current working directory.
- `--model`, `--effort`, `--reasoning-effort` are passed through to Grok. The companion drops effort flags automatically if the target model does not support them.

If you cannot tell the question from the flags (no `--` separator and it is ambiguous), use `AskUserQuestion` once to clarify.

Execution mode:
- If `$ARGUMENTS` includes `--wait`, run in the foreground.
- If it includes `--background`, pass `--background` to the companion (the companion detaches its own worker; you do NOT need Claude's `run_in_background`).
- Otherwise default to foreground.

Foreground:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" consult $ARGUMENTS
```
Return the command stdout verbatim.

Background:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" consult --background $ARGUMENTS
```
Then tell the user to check `/grok:status <id>` and `/grok:result <id>`.

If the companion reports a failure (timeout, `stopReason` cancellation, or grok not ready), return that message verbatim — do not substitute your own answer.
