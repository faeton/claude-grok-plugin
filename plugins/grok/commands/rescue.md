---
description: Hand a question or code review to xAI's Grok via the grok-consult subagent
argument-hint: '[--wait|--background] [--file <path>]... <question or review request>'
allowed-tools: Agent, Bash(node:*)
---

Forward the user's request to the `grok-consult` subagent (xAI Grok).

Raw slash-command arguments:
`$ARGUMENTS`

Routing rules:

- Invoke the `grok-consult` subagent via the `Agent` tool (`subagent_type: "grok:grok-consult"`), forwarding `$ARGUMENTS` as the prompt.
- Do not answer the question or perform the review yourself — the subagent forwards it to Grok.
- Execution mode:
  - If `$ARGUMENTS` includes `--background`, run the subagent in the background.
  - If it includes `--wait`, run it in the foreground.
  - Otherwise default to foreground for a small, clearly bounded ask; background for a large or open-ended one.
- `--file <path>` and any `--effort` / `--model` flags are for Grok — leave them in the forwarded text so the subagent passes them through.
- Return the subagent's output verbatim. Do not paraphrase, summarize, or act on Grok's findings in this turn.
