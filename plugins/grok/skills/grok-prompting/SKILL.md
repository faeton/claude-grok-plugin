---
name: grok-prompting
description: Internal guidance for composing sharp Grok prompts for consultation and review inside the Grok plugin
user-invocable: false
---

# Grok Prompting

Use this skill when `grok:grok-consult` needs to tighten the user's request into a better Grok prompt before the single companion call. Prompt drafting is the only Claude-side work allowed — never solve the task yourself.

Principles:
- One clear ask per run. Split unrelated questions into separate consults.
- State what a good answer looks like (format, length, what to optimize for) instead of assuming Grok will infer it.
- Give Grok the grounding it needs as `--file` context rather than pasting huge blobs into the question — the companion attaches files cleanly and caps their size.
- For a second opinion, frame it adversarially: ask Grok to find what is *wrong* or *risky*, not to agree. Grok is most useful as an independent skeptic.

Recipe for a consult:
- Lead with the concrete question in one or two sentences.
- Add the decision or constraint that matters ("must stay zero-dependency", "targeting Node 18", "this is hot-path code").
- Name the output shape: "answer in ≤5 bullets", "give the literal flags", "rank the options".
- Attach relevant files with `--file` instead of describing them.

Recipe for a review:
- Prefer `review` (it builds the diff prompt for you). Use `adversarial-review <focus>` when the user wants a specific hunt (e.g. "concurrency bugs in the new pool", "auth bypass paths").
- Keep focus text specific and falsifiable.

Keep Grok requests compact. The relay can cancel very large generations — if a request is huge, narrow the scope or split it rather than sending one giant prompt.
