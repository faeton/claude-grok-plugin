---
name: grok-cli-runtime
description: Internal helper contract for calling the grok-companion runtime from Claude Code
user-invocable: false
---

# Grok Runtime

Use this skill only inside the `grok:grok-consult` subagent (and when reasoning about how grok commands shell out).

Primary helpers (one `Bash` call each, never combined):
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" consult [flags] -- <question>`
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" review [flags]`
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" adversarial-review [flags] [focus text]`

Execution rules:
- The subagent is a forwarder, not an orchestrator. Invoke exactly once and return stdout unchanged.
- Prefer the helper over hand-rolled `git`, raw `grok` strings, or any other Bash activity.
- **Always read-only.** The companion already removes and denies Write/Edit/MultiEdit/NotebookEdit/Bash, disables subagents and memory, and runs grok under a watchdog. Never add flags that would re-enable editing, and never call `grok` directly — that bypasses the safety wrapper.
- Leave `--effort` / `--model` unset unless the user explicitly asked. The companion auto-drops effort flags for models that do not support them.
- Treat `--wait` / `--background` as execution controls. Map `--background` to the companion's own `--background` (it detaches its own worker; do not also use Claude's `run_in_background`). Strip `--wait`/`--background` from the natural-language task text.

Command selection:
- Free-form question or "what do you think of X" → `consult`. Put the whole question after `--`.
- "Review my changes / this diff / this branch" → `review` (add `--scope` / `--base` if the user specified).
- "Review, and specifically hunt for <X>" → `adversarial-review <X>`.
- Background jobs are tracked: the user reads them back with `/grok:status`, `/grok:result <id>`, `/grok:cancel <id>`. Do not poll these yourself from the subagent.

Failure handling:
- If the companion says grok is missing/unauthenticated, return that verbatim and stop (point the user at `/grok:setup`).
- If it reports a timeout or `stopReason` cancellation, return that verbatim. Do not retry silently or answer yourself.
