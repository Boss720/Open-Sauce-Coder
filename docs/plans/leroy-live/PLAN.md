# Leroy Live Screen upgrade — plan

Wire the `gemini-live-agent` ("Leroy") harness at `C:\Users\Hp\projects\gemini-live-agent`
into OpenCode Desktop's Live Screen as a **Python sidecar process**, so the floating
Live window gains tool calling with approval gating, dual-key tier failover, and
session resumption + usage/cost readout.

Decision (2026-08-06, with the operator): sidecar, not a TypeScript port. Reuses the
189-test Python core unchanged. Cost: the app needs a Python interpreter with the agent's
`.venv` present; Leroy mode is therefore opt-in and degrades to the existing built-in
Gemini Live path when the sidecar is unavailable.

## Architecture

```
Live window (renderer)  <--oc:leroy:* IPC-->  main/leroy/sidecar.ts
                                                   |  NDJSON over stdin/stdout
                                             python bridge_stdio.py
                                                   |
                                             Supervisor (tools, policy, tiers, media)
```

- The sidecar owns audio and screen capture (Python `media/`), so in Leroy mode the
  renderer does NOT run the mic worklet or the canvas frame pump. It is a control and
  transcript surface.
- stdout carries **only** NDJSON. All logging goes to stderr.
- The Google API key is passed to the child through the environment from `keys.ts`
  (`safeStorage`), never through the protocol or argv.

## Modules

- [x] M0 — recon: read both codebases, pin the protocol surface
- [x] M1 — python: `bridge_stdio.py` NDJSON driver + tests
- [x] M2 — main: `src/main/leroy/protocol.ts` (types, parse, validation) + tests
- [x] M3 — main: `src/main/leroy/sidecar.ts` (spawn, framing, lifecycle) + tests
- [x] M4 — IPC `oc:leroy:*`, preload bridge, CONTRACTS.md
- [x] M5 — renderer: Leroy panel in the Live window (approvals, gating, usage, tier)
- [x] M6 — gate: typecheck + lint + test, both repos

## Protocol (pinned)

Commands (renderer -> sidecar), one JSON object per line:

| `type`            | fields                                  |
|:------------------|:----------------------------------------|
| `connect`         | `settings` (partial AppSettings dict)   |
| `disconnect`      | —                                       |
| `send_text`       | `text`                                  |
| `set_mic_gate`    | `open`                                  |
| `set_share_screen`| `enabled`, `monitor?`                   |
| `approve_tool`    | `call_id`                               |
| `deny_tool`       | `call_id`, `reason?`                    |
| `cancel_tool`     | `call_ids`                              |
| `set_gating_mode` | `mode` (`guarded`\|`yolo`), `duration_minutes?` |
| `ping`            | —                                       |

Events (sidecar -> renderer) are the `core/events.py` dataclasses, snake_case `type`
tag plus their own fields, `timestamp` as an ISO-8601 string. Plus two bridge-only
events: `ready` (handshake, carries `protocol` version) and `fatal` (driver crashed).

## Non-goals this pass

Audit-journal surfacing in the UI (the journal still writes to disk), and any change
to the existing built-in Gemini Live path, which stays the default.
