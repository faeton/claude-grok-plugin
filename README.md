# Grok plugin for Claude Code

Consult [xAI's Grok CLI](https://x.ai) from inside Claude Code for a **strictly
read-only** second opinion or code review — without ever letting Grok touch your
files.

Think of it as the Grok counterpart to OpenAI's
[`codex-plugin-cc`](https://github.com/openai/codex-plugin-cc): you stay in
Claude Code, and hand specific questions or diffs to Grok when you want an
independent perspective. Grok answers; you decide what to do with it.

```
/grok:consult -- is a sync.Map the right choice for this hot-path cache?
/grok:review --scope working-tree
/grok:adversarial-review hunt for race conditions in the new worker pool
```

---

## Why this exists

Grok's CLI is a full agent — by default it can edit files, run shell commands,
and act on your repo. That is the opposite of what you want from a *consultation*:
when you ask for a second opinion you want an answer, not an agent quietly
rewriting your code. Early naive wrappers had three problems:

1. **Grok edited files during "consult".** It inherited your permissive Claude
   permission rules and happily wrote to the repo.
2. **It hung or silently failed.** A relay-cancelled request returned empty
   stdout with exit code 0 — indistinguishable from success.
3. **No job tracking.** Background runs were fire-and-forget with no status.

This plugin fixes all three:

- **Strictly read-only.** Every Grok invocation removes and denies the mutating
  tools (`Write`, `Edit`, `MultiEdit`, `NotebookEdit`, `Bash`), disables
  subagents and cross-session memory, and (for review) disables web search. The
  deny rules override any allow-rules Grok would otherwise inherit. Grok
  physically cannot edit your working tree.
- **Honest failures.** Output is parsed from Grok's JSON envelope. A relay
  cancellation (`stopReason: Cancelled`), a timeout, or an empty answer is
  reported as a real, non-zero failure — never as a silent empty success. A
  wall-clock watchdog (SIGTERM → SIGKILL on the process group) turns hangs into a
  clear "timed out" result with no orphaned processes.
- **Background jobs with status.** Long consultations/reviews run as detached
  workers tracked in an on-disk registry. Check them with `/grok:status`,
  read them with `/grok:result`, stop them with `/grok:cancel`. Job state lives
  outside your repo, so it never dirties the working tree.

---

## Install

This is a Claude Code plugin distributed as a plugin marketplace.

```text
/plugin marketplace add faeton/claude-grok-plugin
/plugin install grok@claude-grok-plugin
```

Then check your setup:

```text
/grok:setup
```

### Prerequisites

- [Claude Code](https://claude.com/claude-code)
- The `grok` CLI on your `PATH`, authenticated (`grok login`)
- Node.js (ships with Claude Code's environment)

`/grok:setup` verifies the CLI is installed and logged in and tells you what to
fix if not.

---

## Commands

| Command | What it does |
|---|---|
| `/grok:consult -- <question>` | Ask Grok a free-form question. `--file <path>` (repeatable) attaches context. |
| `/grok:review` | Review your local git changes (working tree or branch diff). |
| `/grok:adversarial-review <focus>` | Review with extra focus instructions (e.g. "hunt for auth bypasses"). |
| `/grok:rescue <request>` | Hand a question/review to the `grok-consult` subagent (proactive, model-invocable). |
| `/grok:status [job-id]` | List recent jobs, or show one job (add `--wait` to block until done). |
| `/grok:result [job-id]` | Print the stored final output of a finished job. |
| `/grok:cancel [job-id]` | Cancel a running background job (kills Grok cleanly). |
| `/grok:setup` | Check that the `grok` CLI is installed and authenticated. |

### Common flags

- `--background` — run as a tracked detached job; read it back with
  `/grok:status` / `/grok:result`. (Foreground is the default for small asks.)
- `--model <id>` — pin a specific Grok model.
- `--effort <low|medium|high|xhigh|max>` — reasoning effort. Automatically
  dropped if the target model doesn't support it (so it never 400s).
- `--scope auto|working-tree|branch` and `--base <ref>` — for reviews.
- `--timeout-ms <ms>` — watchdog timeout (default 8 minutes).

### Examples

```text
# Quick second opinion
/grok:consult -- what are the failure modes of this retry loop?

# Consult with file context
/grok:consult --file src/cache.ts --file src/cache.test.ts -- is the eviction correct?

# Review the current working tree, wait for the result
/grok:review --wait

# Review a branch against main, in the background
/grok:review --scope branch --base origin/main --background
/grok:status            # find the job id
/grok:result <job-id>   # read the findings

# Targeted adversarial review
/grok:adversarial-review concurrency safety of the new connection pool
```

---

## How it works

```
commands/         slash commands (thin: parse args, shell out, return verbatim)
agents/           grok-consult subagent (proactive forwarder; loads the skills)
skills/           internal contracts:
                    grok-cli-runtime     how to invoke the companion
                    grok-prompting       how to compose a sharp Grok prompt
                    grok-result-handling how to present output / never auto-fix
scripts/
  grok-companion.mjs    dispatcher: setup/consult/review/adversarial-review/
                        status/result/cancel (+ internal consult-worker)
  lib/
    args.mjs      schema-driven arg parser (handles quotes, escapes, "--" tail)
    grok.mjs      the grok CLI runner: read-only flags, watchdog, JSON envelope
    git.mjs       review-context construction from git state
    state.mjs     on-disk job registry (atomic writes, locked index)
    jobs.mjs      job lifecycle: create → run → terminal; orphan reconciliation
    render.mjs    human-readable output
```

The model is the same one the codex plugin uses: a **thin forwarder**. Slash
commands and the subagent never reason through your problem or act on Grok's
answer — they forward the request to Grok and return its output verbatim. You
review the findings and apply changes yourself.

### Read-only enforcement (defense in depth)

Each `grok` call is constructed with:

```
--disallowed-tools Write,Edit,MultiEdit,NotebookEdit,Bash   # tools removed entirely
--deny Write --deny Edit --deny Bash                        # overrides inherited allow-rules
--no-subagents --no-memory                                  # no side channels
--output-format json                                        # parseable, detect cancellation
[--disable-web-search]                                      # reviews only
```

Job and log state lives under `~/.grok/companion/<workspace>/`, never in your
repo.

---

## Relationship to the Codex plugin

This plugin deliberately mirrors the structure and workflow of
[`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc) (commands,
a forwarding subagent, internal skills, an on-disk job registry, and
`status`/`result`/`cancel`) so the two feel the same to use. The key difference:
**Grok here is read-only by design with no write path at all** — it is a second
opinion, not an agent.

---

## License

MIT © faeton
