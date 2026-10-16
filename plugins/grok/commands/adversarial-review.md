---
description: Run a focused/adversarial Grok review with extra reviewer instructions (read-only)
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [--profile fast|thrifty|deep] [--model <id>] [--effort <level>] [focus text]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run a Grok review with extra adversarial focus instructions. Same read-only guarantees as `/grok:review`; do not fix issues in this turn.

Raw slash-command arguments:
`$ARGUMENTS`

- Any non-flag text is the focus instruction for the reviewer (e.g. "hunt for race conditions in the new worker pool"). It is forwarded as the trailing positional text.
- `--scope`, `--base`, `--profile`, `--model`, `--effort` pass through.
- Execution mode (`--wait` / `--background` / ask once) follows the same rules as `/grok:review`.

Shell quoting (required): pass the raw arguments to the companion as ONE single-quoted shell word, written in place of `'<raw arguments>'` below. Escape every `'` inside them as `'\''`. Never paste the arguments unquoted or inside double quotes — `$(...)`, backticks, `;` and globs in a question or focus text would be run by the shell. The companion splits that single word into flags itself.

Foreground (give the Bash call `timeout: 600000`; the default 2-minute cap would cut the run off):
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" adversarial-review '<raw arguments>'
```

Background:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" adversarial-review '--background <raw arguments>'
```

Return the command stdout verbatim. If the companion reports a failure, return it verbatim.
