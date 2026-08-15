# STATUS — active

Revived 2026-08-15 from the 2026-07-26 archive to ship v0.3.0.

## v0.3.0 — stopReason classifier + watchdog

Grok CLI 1.0.4 switched `stopReason` from PascalCase (`EndTurn`) to the
snake_case ACP token (`end_turn`). The runner matched a PascalCase-only
allowlist, so from 2026-08-14 onward *every* successful consult and review was
reported as `ok: false` with "the relay likely cancelled the request" — while
the complete answer sat untouched in `result.text`.

Measured against the local job registry (360 jobs): a clean cutover, last
`EndTurn` 2026-08-10, first `end_turn` 2026-08-14. Replaying the new classifier
over that history rescues 48 runs with zero regressions; the 15 that still fail
all have `textlen == 0`.

The watchdog was raised 8min → 15min. Both runs ever allowed past 8 minutes
(under a manual `--timeout`) completed cleanly at 8.55min/9.8k chars and
10.37min/13k chars, so the old cap was truncating real work.

## Known gaps

- No idle detection: a stalled relay still burns the full wall clock. Fixing it
  properly means `--output-format streaming-json` plus a rewritten
  `parseEnvelope` — the current parser only understands top-level envelope
  objects, so flipping the flag alone would turn hangs into empty results.
- `parseEnvelope`'s JSONL path splits per chunk with no leftover buffer, so a
  JSON line straddling a chunk boundary is dropped. Latent today (no caller
  passes `onProgress`); must be fixed before any streaming work.
