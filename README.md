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

- **Strictly read-only, in layers.** Every Grok invocation *allowlists* only
  read-only tools (`read_file`, `grep`, `list_dir`, plus web search/fetch for
  consult), *removes* the mutating tools and the MCP meta-tools, *denies*
  writes, shell and MCP calls at the permission layer, refuses anything that
  would need approval (`--permission-mode dontAsk`), and runs Grok inside the
  OS **`read-only` sandbox** (Seatbelt on macOS, Landlock on Linux) — which also
  covers anything Grok spawns, such as hooks or local MCP servers. If the
  sandbox can't be applied, Grok would carry on unsandboxed, so the companion
  stops the run instead. On Linux the sandbox also needs bubblewrap (`bwrap`)
  on PATH. Without it, runs go ahead without the OS sandbox and show a
  warning (the tool and permission layers still apply). The same fallback
  covers macOS when grok cannot resolve a container-runtime socket it must deny
  — e.g. OrbStack's `/var/run/docker.sock` symlink: grok refuses before any tool
  call, and the companion retries once without `--sandbox`. Set
  `GROK_COMPANION_REQUIRE_SANDBOX=1` to fail instead. Memory is disabled, and reviews also disable web access.

  The tool lists use two different vocabularies and both matter: `--tools` /
  `--disallowed-tools` take Grok's **internal tool ids**, while `--allow`/`--deny`
  take **Claude-style capability names**. Unknown names are silently ignored —
  which is why the allowlist exists: the old denylist missed Grok's `write`
  tool entirely.
- **Honest failures — in both directions.** A relay cancellation, a stall, or an
  empty answer is reported as a real, non-zero failure, never as a silent empty
  success. Just as importantly, a *completed* answer is never thrown away:
  stop-reason matching is case- and separator-insensitive and fails open on
  unrecognized values that carry text, because Grok documents its stop-reason
  list as non-exhaustive. An answer cut by the output limit (`max_tokens`) is
  returned with a warning rather than discarded. A run that stopped before it
  wrote its answer (`max_turn_requests`, `tool_use`) fails, with its text and
  the end of its reasoning shown as partial output, so a one-line preamble is
  never reported as a finished review.
- **Stall detection.** Runs stream their events, so a stalled relay is caught as
  an absence of output within minutes instead of burning the full watchdog. A
  wall-clock backstop still bounds the worst case. Every way a run can end
  early — timeout, stall, `/grok:cancel`, Ctrl-C — sends SIGTERM to Grok's
  process group and escalates to SIGKILL before the companion exits, so no
  process is left behind.
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
- `--profile fast|thrifty|deep` — model and effort together (see below).
  **Defaults to `fast`.**
- `--model <id>` — Grok model; overrides the profile.
- `--effort <low|medium|high|xhigh|max>` — reasoning effort, on `consult`,
  `review` and `adversarial-review`; overrides the profile. Automatically
  dropped if the target model doesn't support it (so it never 400s).
- `--scope auto|working-tree|branch` and `--base <ref>` — for reviews.
- `--timeout-ms <ms>` — wall-clock backstop (default 8 minutes, so a
  foreground run finishes inside Claude Code's 10-minute Bash cap; must be > 0).
- `--idle-ms <ms>` — kill a run that produces no output at all for this long
  (default 3 minutes). Catches a stalled relay long before the backstop. Don't
  set it much lower: Grok can spend up to 120s draining usage after the answer
  without emitting anything.

### Profiles

| Profile | Model / effort | Typical review | Use it for |
|---|---|---|---|
| **`fast`** (default) | `grok-4.7-build-fast` / `low` | about 1 min | everyday reviews and consults |
| `thrifty` | `grok-4.7` / `low` | about 2 min | the same findings on about half the allowance |
| `deep` | `grok-4.7` / `medium` | 4-15 min | a slower, more thorough pass |

`grok-4.7-build-fast` is billed at twice `grok-4.7`'s per-token price, so on a
subscription `fast` uses the allowance about twice as fast per token as
`thrifty`. Measured cost on the hard review below: `fast` about $0.10-0.14,
`thrifty` about $0.05-0.09 (from `grok usage <session-id>`).

Reviews paste the full current text of every changed file into the prompt
(up to 150 KB in total; lockfiles, minified files and source maps are left
out), so Grok sees the code around each hunk without paging through it. That
is what lets `thrifty` find bugs that need the surrounding code. Files that
don't fit are listed, and Grok can still read them and anything else in the
repo with its read-only tools. Set `GROK_PLUGIN_INLINE_BYTES` to change the
budget (`0` turns it off).

### Why these defaults

Measured on identical review prompts against Codex and Claude (grok CLI 1.0.60,
October 2026), using diffs with planted bugs as an answer key:

| Grok config | Seeded review | Hard review (cross-file bug) | Real 16 KB consult |
|---|---|---|---|
| `grok-4.7` / `medium` (old default) | 304 s, 40 tool calls | 3/3 bugs, 254 s | 915 s (past the old 15-min timeout in practice) |
| `grok-4.7` / `low` | 124 s | 2/3 bugs (misses the cross-file one every run) | 512 s |
| `grok-4.7` / `low` + full changed files | - | 3/3 bugs, 96-155 s | - |
| **`grok-4.7-build-fast` / `low`** (+ lean context, working-method prompt) | **49-62 s** | **3/3 bugs, 54-63 s** | **232 s** |

For comparison, Codex took 31-74 s and Opus 57-78 s on the hard review. Every
config found all four bugs in the easier seeded review, so grok-4.7 at medium
was spending its extra time without finding more. A timed-out run used to
report "no response from grok" and keep one preamble sentence; it now says
what grok was doing and shows the end of its reasoning as working notes.

A second machine (macOS, a different network and continent) gave the same
token counts and throughput, and the grok.com web app took 126 s on the same
diff prompt. The time is the model's reasoning, not the network or the CLI.

### Changing the defaults

Per call, pass `--profile`, or `--model` / `--effort`, e.g.
`/grok:review --profile deep` or `/grok:review --model grok-4.7 --effort high`.

To change the default for every call, set `GROK_PLUGIN_PROFILE` (or
`GROK_PLUGIN_MODEL` / `GROK_PLUGIN_EFFORT`, which override it) in
`~/.claude/settings.json` (or a project's `.claude/settings.json`) and restart
Claude Code:

```json
{
  "env": {
    "GROK_PLUGIN_PROFILE": "thrifty"
  }
}
```

Precedence: `--model` / `--effort`, then `--profile`, then `GROK_PLUGIN_MODEL` /
`GROK_PLUGIN_EFFORT`, then `GROK_PLUGIN_PROFILE`, then `fast`. Use `"default"`
for the model or effort to send no flag and let the grok CLI decide.

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

# Slower, deeper review
/grok:review --profile deep --background
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
    grok.mjs      the grok CLI runner: read-only flags, idle + wall-clock
                  watchdogs, streaming event parsing, stop-reason classification
    git.mjs       review-context construction from git state
    state.mjs     on-disk job registry (atomic writes, locked index)
    jobs.mjs      job lifecycle: create → run → terminal; orphan reconciliation
    render.mjs    human-readable output
```

Run the test suite with:

```text
node --test plugins/grok/scripts/test/*.test.mjs
```

`runner.test.mjs` replays Grok's real streaming wire format through a stub
binary (classification, watchdogs, process-group teardown, read-only argv,
effort selection); `state.test.mjs` covers argument parsing, review-context
collection in throwaway repos, and the job state machine. No dependencies, no
network.

The model is the same one the codex plugin uses: a **thin forwarder**. Slash
commands and the subagent never reason through your problem or act on Grok's
answer — they forward the request to Grok and return its output verbatim. You
review the findings and apply changes yourself.

### Read-only enforcement (defense in depth)

Each `grok` call is constructed with:

```
--prompt-file <tmp>/prompt.md                               # no argv size limit
# Grok's INTERNAL tool ids — an allowlist, then a removal backstop:
--tools read_file,grep,list_dir[,web_search,web_fetch]      # web: consult only
--disallowed-tools run_terminal_cmd,run_terminal_command,search_replace,write,\
                   write_file,create_file,apply_patch,delete_file,\
                   search_tool,use_tool,Agent               # incl. MCP meta-tools
# Claude-style CAPABILITY names — a different vocabulary, gates execution:
--deny Write --deny Edit --deny Bash --deny MCPTool
[--deny WebFetch --deny WebSearch --disable-web-search]     # reviews only
--permission-mode dontAsk                                   # refuse, never prompt or auto-run
--sandbox read-only                                         # OS-enforced; fatal if not applied
                                                            # (omitted, with a warning, on Linux without bwrap
                                                            #  or on a socket-deny failure — see above)
--no-subagents --no-memory                                  # no side channels
--output-format streaming-json                              # parseable + liveness signal
```

What this does **not** cover: Grok still reads your files (that is the point)
and, for consult, can reach the web — so anything in the attached files or the
repo can end up in a web request. Hooks you have configured for Grok still run,
but inside the sandbox. On macOS the sandbox does not block network access from
processes Grok spawns.

Job state and the companion's own log live under `~/.grok/companion/`, never
in your repo.

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
