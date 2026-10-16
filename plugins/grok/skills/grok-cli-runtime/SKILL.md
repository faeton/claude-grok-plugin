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
- **Always read-only.** The companion allowlists grok's read-only tools (`read_file`, `grep`, `list_dir`, plus web search/fetch for consult), removes the mutating and MCP tools, denies `Write`/`Edit`/`Bash`/`MCPTool`, refuses anything that would need approval (`--permission-mode dontAsk`), runs grok under the OS `read-only` sandbox (and stops the run if the sandbox cannot be applied; on Linux without `bwrap` it runs unsandboxed and the result carries a warning — relay it), disables subagents and memory, and supervises it with idle and wall-clock watchdogs. Never add flags that would re-enable editing, and never call `grok` directly — that bypasses the safety wrapper.
- Leave `--profile` / `--effort` / `--model` unset unless the user explicitly asked. The default profile `fast` (`grok-4.7-build-fast`, effort `low`) finishes a typical review in about a minute; `thrifty` (`grok-4.7`, `low`) takes about twice as long on about half the subscription allowance; `deep` (`grok-4.7`, `medium`) is the thorough option when the user asks for a deeper or slower pass (4-15 minutes). `GROK_PLUGIN_PROFILE` sets the user's default; `--model` / `--effort` override any profile. The companion drops effort for models that do not support it.
- **Give the Bash call `timeout: 600000`** (10 minutes). Without it the Bash tool's default 2-minute cap cuts the run off, and Claude moves it to the background. The companion's own deadline is 8 minutes, so it always finishes and reports inside that window.
- Shell-quote the question: pass it after `--` inside single quotes (escape any embedded `'` as `'\''`), never in double quotes or bare — `$(...)`, backticks and `;` in the text would otherwise run in the shell.
- **Always run the companion in the foreground — never pass the companion's `--background`.** Strip `--wait`/`--background` from the natural-language task text. Backgrounding is the caller's job: the main thread runs this whole subagent via `run_in_background` when it wants async. The companion's `--background` detaches its own worker, which gets orphaned the moment this subagent returns and its process tree is torn down (the worker then reconciles to `failed` / "Worker process exited without finishing"). Foreground is the only safe mode inside the subagent.

Command selection:
- Free-form question or "what do you think of X" → `consult`. Put the whole question after `--`.
- "Review my changes / this diff / this branch" → `review` (add `--scope` / `--base` if the user specified).
- "Review, and specifically hunt for <X>" → `adversarial-review <X>`.
- Background jobs (created only by the direct `/grok:consult` / `/grok:review` slash commands, never by this subagent) are tracked: the user reads them back with `/grok:status`, `/grok:result <id>`, `/grok:cancel <id>`. Do not poll these yourself from the subagent.

Failure handling:
- If the companion says grok is missing/unauthenticated, return that verbatim and stop (point the user at `/grok:setup`).
- If it reports a timeout or `stopReason` cancellation, return that verbatim. Do not retry silently or answer yourself.
