# Changelog

All notable changes to this plugin are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] — 2026-10-16

Fixes from a whole-codebase review by Codex and Grok, plus a faster default.

### Security

- **Read-only is now an allowlist plus an OS sandbox.** The `--disallowed-tools`
  denylist had gone stale: grok 1.0.50 names its file-writing tool `write` (not
  `write_file`), and also exposed scheduler, workflow, monitor, image and MCP
  meta-tools (`search_tool` / `use_tool`). Only the `--deny Write` permission
  rule stood between Grok and your files. Every run now passes `--tools` with
  only `read_file,grep,list_dir` (plus `web_search,web_fetch` for consult),
  keeps the removal list as a backstop, adds `--deny MCPTool`, uses
  `--permission-mode dontAsk` so anything needing approval is refused, and runs
  under `--sandbox read-only`. grok only *warns* when a sandbox cannot be applied
  and then runs unsandboxed, so the companion now treats that warning as fatal.
  Verified against grok 1.0.50 via its `available_commands` event.
- **Untracked symlinks are no longer followed.** A working-tree review read
  every untracked path with `readFileSync`, so an untracked link to, say,
  `~/.ssh/id_rsa` sent the key to the model. Symlinks are now listed with their
  target and never read; non-regular files are skipped; sizes are checked before
  reading.
- **`--base` can no longer inject git options.** `--base=--output=/path` was
  passed to `git diff` as an option and made git write a file. Bases starting
  with `-` are rejected, must name a commit, and are passed after
  `--end-of-options`.
- **Slash-command arguments are no longer spliced into shell commands.**
  Unquoted `$ARGUMENTS` let `$(...)`, backticks or `;` in a question run in the
  shell. Commands now pass arguments as one single-quoted word.

### Fixed

- **Processes are no longer orphaned.** The SIGKILL escalation timer was
  unref'd, so the companion exited before it fired and a descendant that ignored
  SIGTERM survived. Foreground runs had no signal handler at all, so Ctrl-C left
  grok running, and cancel sent SIGTERM only. Every path now goes through one
  teardown: SIGTERM the group, wait, SIGKILL, and only then exit.
- **Job state can no longer roll back or be clobbered.** All job writes go
  through a guarded transition under one workspace lock, applied to the
  re-read current record. Terminal states are final. Previously:
  - a stale launcher write could reset a finished job to `queued`, and it was
    then reported as orphaned;
  - `/grok:cancel` with no id rewrote the newest job, even a completed one, as
    `cancelled` and hid its output;
  - a queued job with no pid yet was declared dead by a concurrent `status`;
  - `reconcile` trusted a lagging index row over the job file.
- **The state lock never runs unlocked.** After about 1s of contention it used
  to proceed without the lock. It now waits up to 5s and then fails. Stale locks
  are detected by a dead owner pid and reclaimed atomically.
- **Cancel won't signal a reused pid.** Stored pids are checked against `ps`
  before signalling, and `grokPid` is now persisted on the job file.
- **Large reviews don't silently lose content.** git output over 1MB was cut
  off and reviewed as if complete, and prompts over the OS argument limit
  failed with E2BIG. Prompts now go through `--prompt-file`, git gets a 64MB
  buffer, and a diff over 2MB fails with a clear message instead of being
  reviewed in part.
- **Untracked files with spaces or non-ASCII names are included.** `git
  ls-files` quoted those names, and the quoted string was used as a path and
  silently skipped. It now uses `-z`.
- **git failures are errors, not "No changes detected".**
- **A cut stream or an error event is now a failure.** Exit 0 with text but no
  `end` event was stored as a completed job, and an `error` event was ignored
  whenever some text had arrived. Both now fail, with the partial text kept.
  A turn that ends on `tool_use` / `pause_turn` is flagged as truncated.
- **Argument parsing is strict.** `--background=false` used to mean true, a
  value flag could swallow the next flag, unknown flags and `--scope` typos
  were silently ignored, `--timeout-ms -1` killed the run instantly and
  `--timeout-ms 0` meant 15 minutes. All of these are now errors.
- The companion log moved from `plugins/grok/logs/` (inside the repo when run
  from a checkout) to `~/.grok/companion/companion.jsonl`.
- `idledOut` now appears in the job index; usage text, skill and command docs
  match the code.

### Changed

- **Reasoning effort now defaults to `medium`.** No effort flag was sent
  before, so every run used the grok CLI's default of `high`, which made
  consults and reviews very slow. In one whole-repo review, `high` hit the
  15-minute timeout without answering and `medium` finished in about 10
  minutes. Override per call with `--effort`, or globally with the
  `GROK_PLUGIN_EFFORT` env var (`default` = send no flag). The flag is dropped
  only when grok's model cache says the model lacks effort support; unknown
  support still sends it. The `grok models` probe now has a 10s timeout.
- `/grok:cancel` on a job that already finished is a no-op and says so.
- `/grok:result` shows output a cancelled job produced before it was cancelled.

### Added

- `--effort` / `--reasoning-effort` on `review` and `adversarial-review`.
- `test/state.test.mjs`: argument parsing, review-context collection in
  throwaway repos, and the job state machine. The runner tests now cover
  process-group teardown (verified to fail on the old code), the sandbox
  failure path, prompt files, the read-only argv and effort selection.

## [0.4.0] — 2026-08-15

### Added

- **Idle detection.** Runs now switch to `--output-format streaming-json`, so a
  stalled relay is visible as an absence of events. A run producing no output at
  all for `DEFAULT_IDLE_MS` (3 min) is killed with its own distinct message
  rather than sitting until the wall-clock backstop.
  The 3-minute floor is not arbitrary: grok's headless docs describe a
  success-path usage drain of up to 120s with no events emitted after the
  answer, so a shorter idle timer would kill healthy runs just before they
  finish.
- `--idle-ms <ms>` on `consult`, `review` and `adversarial-review`.
- Tool-call activity is now surfaced in the job log as the run progresses,
  instead of the log staying silent until the final output.

### Security

- **`--disallowed-tools` was removing nothing.** It takes Grok's *internal tool
  ids*, not Claude-style capability names, and silently ignores names it does
  not recognize — so the previous list (`Write`, `Edit`, `MultiEdit`,
  `NotebookEdit`, `Bash`) was a complete no-op. Verified against grok 1.0.4 by
  having it enumerate its own toolset: `run_terminal_command` and
  `search_replace` were both still available on every consult and review.

  Read-only was resting entirely on the `--deny` permission layer, which does
  use capability names and was working. The tool-removal layer is now restored
  with the correct ids, and both layers are documented as distinct vocabularies.

  Also adds the special `Agent` entry: `--no-subagents` alone left
  `spawn_subagent` in the toolset.

### Fixed

- **`parseEnvelope` rewritten for type-tagged ACP events.** Answer text arrives
  as a *sequence* of `{"type":"text","data":…}` chunks and must be concatenated;
  the old last-wins merge would have returned an empty answer. The turn's
  `stopReason` is taken only from the final `end` event — the per-response
  `usage` line reports the raw provider reason (`tool_use`, `pause_turn`)
  mid-loop, so reading it would classify a working agent as a failure.
- **Chunk-boundary data loss.** The `onProgress` reader split each socket chunk
  independently with no carry-over buffer, so a JSON event straddling a read was
  silently dropped. It now retains the trailing partial line between chunks.
  (Latent before this release — nothing passed `onProgress`.)

- **Truncated streams reported as clean successes.** `end` is documented as
  always the last event of a turn, so exiting 0 without one means the stream was
  cut mid-answer. Such runs now return their partial text with an explicit
  truncation warning instead of looking indistinguishable from a complete
  answer. The single-object `json` format is unaffected.

- **Idle/wall-clock timer race.** An idle timer armed shortly before the
  wall-clock deadline could fire during the SIGTERM grace window and report a
  wall-clock timeout as a stall. The two timers now disarm each other.

- **A completed turn could be relabelled a stall.** If Grok emitted `end` plus a
  full answer and the process then hung, the idle kill won and the finished
  answer came back as a failure. A turn carrying `end` and text is now
  classified on its own merits first, and merely notes that the process had to
  be killed afterwards.

- **`error` events were parsed and discarded.** `{"type":"error","message":…}`
  was stored and never read, so failures fell back to an unrelated stderr line
  or a bare exit code. Grok's own message is now surfaced.

- **`--idle-ms 0` could not disable idle detection.** `Number(x) || DEFAULT`
  turned the documented off-switch back into the default.

- **`idledOut` is now persisted** alongside `timedOut`. An idle kill also sets
  `timedOut`, so without it a stalled relay was indistinguishable from hitting
  the wall-clock backstop — the same blind spot 0.3.0 fixed for timeouts.

### Added (testing)

- `plugins/grok/scripts/test/runner.test.mjs` — 39 checks over stop-reason
  classification, streaming-json parsing, and the watchdogs, with a shell script
  standing in for the `grok` binary via `GROK_BIN`. No dependencies, no network:
  `node plugins/grok/scripts/test/runner.test.mjs`.

  Anything that decides ok-vs-not-ok is now covered, including the two traps
  that motivated this release: the `usage` line's provider reason must never
  become the turn's, and a JSON event split across socket reads must not be
  dropped.

## [0.3.0] — 2026-08-15

### Fixed

- **Every successful run was reported as a failure.** grok CLI 1.0.4 emits the
  snake_case ACP stop token (`end_turn`) where earlier builds emitted PascalCase
  (`EndTurn`). The runner compared against a PascalCase-only allowlist, so from
  2026-08-14 onward every completed consult and review surfaced as
  *"grok stopped early — the relay likely cancelled the request"* while the full
  answer sat untouched in `result.text`.

  Stop-reason classification now normalizes case and separators, and **fails
  open** on an unrecognized reason that carries substantial text. grok's
  headless docs call the stop-reason list explicitly non-exhaustive, so a
  fail-closed allowlist guarantees this same bug recurs on the next vocabulary
  change. Ceiling hits (`max_tokens`, `max_turn_requests`, `max_turns`) are
  treated as truncated-but-usable and surface a warning instead of discarding
  the text. Genuine failures — `cancelled`, `refusal`, empty text — still fail.

  Replaying the new classifier across 360 stored jobs rescues 48 runs with zero
  regressions; the 15 that still fail all have empty text.

  Independently diagnosed in
  [chaugan/claude-grok-plugin@23ee266](https://github.com/chaugan/claude-grok-plugin/commit/23ee266),
  which reached the same normalization fix.

- **Watchdog raised 8 min → 15 min.** Both runs ever allowed past the old cap
  (via a manual timeout override) completed cleanly at 8.55 min / 9.8k chars and
  10.37 min / 13k chars, so 8 minutes was truncating real work rather than
  catching hangs.

- **Orphaned descendants on timeout.** The SIGTERM → SIGKILL escalation was
  cancelled as soon as the process-group leader closed, so a descendant that
  ignored SIGTERM and dropped the pipes could survive.

- **`timedOut` is now persisted** on the job record. It was declared in
  `INDEX_FIELDS` but never written, so timeouts could only be inferred from
  `durationMs` or the error string — which conflates runs using a custom
  timeout with the default watchdog.

## [0.2.0] — 2026-06-02

Initial public release: commands, the `grok-consult` subagent, three internal
skills, read-only enforcement (`--disallowed-tools` + `--deny`), the supervised
runner, and the on-disk job registry.
