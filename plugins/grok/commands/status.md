---
description: Show active and recent Grok jobs for this workspace
argument-hint: '[job-id] [--wait] [--timeout-ms <ms>] [--all]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" status "$ARGUMENTS"`

If no job ID was passed:
- Render the output as a single compact Markdown table of current and recent jobs.
- Preserve the job ID, kind, status, phase, elapsed, and summary columns. No extra prose.

If a job ID was passed:
- Present the full command output verbatim. Do not summarize.
- If the job is complete, remind the user they can run `/grok:result <id>` for the full output.
