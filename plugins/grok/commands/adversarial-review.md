---
description: Run a focused/adversarial Grok review with extra reviewer instructions (read-only)
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [--model <id>] [focus text]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run a Grok review with extra adversarial focus instructions. Same read-only guarantees as `/grok:review`; do not fix issues in this turn.

Raw slash-command arguments:
`$ARGUMENTS`

- Any non-flag text is the focus instruction for the reviewer (e.g. "hunt for race conditions in the new worker pool"). It is forwarded as the trailing positional text.
- `--scope`, `--base`, `--model` pass through.
- Execution mode (`--wait` / `--background` / ask once) follows the same rules as `/grok:review`.

Foreground:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" adversarial-review $ARGUMENTS
```

Background:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" adversarial-review --background $ARGUMENTS
```

Return the command stdout verbatim. If the companion reports a failure, return it verbatim.
