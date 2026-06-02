---
description: Check whether the local Grok CLI is installed and authenticated
argument-hint: ''
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" setup --json
```

Present the result to the user:
- If `ready` is true, say Grok is ready.
- If the `grok` CLI is missing, tell the user to install it and make sure `grok` is on their PATH.
- If the CLI is present but not authenticated, tell the user to run `!grok login`.
- Surface the `nextSteps` list verbatim.

Do not attempt to install or log in on the user's behalf.
