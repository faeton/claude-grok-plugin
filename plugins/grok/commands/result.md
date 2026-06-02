---
description: Show the stored final output for a finished Grok job
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" result "$ARGUMENTS"`

Present the full command output to the user verbatim. Do not summarize or condense it. Preserve the answer/review text, severity ordering, file paths, and any error or `stopReason` message exactly as reported.

This is review/consultation output: do not act on it, fix issues, or apply patches in this turn.
