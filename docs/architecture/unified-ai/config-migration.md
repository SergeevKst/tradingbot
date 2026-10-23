# Configuration migration: legacy -> single mode

Legacy remains the default. Nothing in this migration is required to keep the
current bot running; it is the procedure for a future approved single-mode
release.

## Identity variables

| Legacy | Single mode |
|---|---|
| `AI_PROVIDER`, `AI_MODEL`, `AI_BASE_URL` | removed as identity sources; must be **unset** |
| `AI_GUARD_MODEL`, `AI_REFLECT_MODEL` | removed; must be unset |
| `SCOUT_PROVIDER`, `GUARD_PROVIDER` | removed; must be unset |
| `SCOUT_BASE_URL`, `GUARD_BASE_URL` | removed; must be unset |
| `SCOUT_MODEL`, `GUARD_MODEL` | removed; must be unset |
| `SCOUT_API_KEY`, `GUARD_API_KEY`, `KIMI_API_KEY` | removed; must be unset (single key only) |
| `SCOUT_REASONING_EFFORT`, `GUARD_REASONING_EFFORT` | removed; per-operation settings live in the capability profile |
| `DEEPSEEK_API_KEY` / `AI_API_KEY` | kept as the local secret; never in the manifest |
| — | `AI_RUNTIME_MODE=single` |
| — | `AI_CONTROL_DIR=<absolute path>` |
| — | `AI_DEPLOYMENT_ID=<uuid from initialize>` |
| — | `AI_EXPECTED_MANIFEST_VERSION`, `AI_EXPECTED_MANIFEST_SHA256` |
| — | `AI_PARTICIPANT_SLOT` (participants only; unset for the core observer) |
| — | `AI_ARTIFACT_SHA256` (participant's approved artifact digest) |

A non-empty legacy identity variable is a hard error in single mode **even when
it holds the value the manifest already says**: two equal-looking authorities
drift independently, and the protocol only accepts one.

Secrets are never written to the manifest, an acknowledgement, a receipt, the
release audit or a report. `describeAIRuntimeConfig()` reports `hasApiKey` only.

## Process inventory

| Process | Slot | Operations | Single-mode bootstrap |
|---|---|---|---|
| core (`src/index.mjs`) | — (observer) | none | validates identity, reports `identityValidated`, never loads a key, never blocks deterministic bootstrap |
| core AI consumer (future/backtest) | `core-analysis` | ANALYZE | `createCoreAIComposition`, registers the slot |
| Telegram bot | `telegram` | SCOUT, GUARD, MONITOR, STOPCHECK, REFLECT | validates identity before AI timers/commands become actionable |

The observer is **not** an ANALYZE consumer and does not occupy the
`core-analysis` slot. A deployment that disables `core-analysis` must report
five active operations, never six.

## Launch expectations

`AI_EXPECTED_MANIFEST_VERSION` / `AI_EXPECTED_MANIFEST_SHA256` are the launch
pins. A process started with stale values becomes non-ready **before** its first
provider request and cannot infer. A retained process may stage a different,
granted target in place; its next restart still needs the updated launch
expectations from the approved dossier.

## Example (single mode)

```env
AI_RUNTIME_MODE=single
AI_CONTROL_DIR=/var/lib/tradingbot/ai-control
AI_DEPLOYMENT_ID=<uuid printed by `ai_release.mjs initialize`>
AI_EXPECTED_MANIFEST_VERSION=uai-v1.1-rehearsal-1
AI_EXPECTED_MANIFEST_SHA256=65bdfa2aa79a1e61bab7466802853a960b5c90c801b07f587ff78e11eacc3f8c
AI_PARTICIPANT_SLOT=telegram
AI_ARTIFACT_SHA256=<approved telegram artifact digest>
AI_API_KEY=<local secret, never committed>
```

## Legacy example (unchanged)

```env
# AI_RUNTIME_MODE is not set
AI_ENABLED=true
AI_PROVIDER=deepseek
AI_MODEL=deepseek-chat
AI_BASE_URL=https://api.deepseek.com
SCOUT_PROVIDER=deepseek
GUARD_PROVIDER=deepseek
DEEPSEEK_API_KEY=<local secret>
```

Both configurations are validated at startup; a conflict is a startup error, not
a silent fallback.
