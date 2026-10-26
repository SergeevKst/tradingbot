# Topology evidence (G4)

verified: false

This file is the *placeholder* an operator must replace with a verified statement
before G4 can pass. It deliberately does not claim any operational fact.

## Required declaration

- host: `<single hostname>` (one host, one kernel)
- control directory: `<absolute path>`
- filesystem: `<type>`; atomic same-directory `rename`: yes
- exclusive `mkdir`: yes
- durable `fsync` on files and directories: yes
- no NFS / SMB / object store / replicated-file synchronisation: confirmed
- process inventory:
  | slot | start command | startup wrapper | artifact digest | owner |
  |---|---|---|---|---|
  | | | | | |

## Participant inventory

| slot | operations | enabled | artifact digest | process |
|---|---|---|---|---|
| core-analysis | ANALYZE | | | core AI consumer (if any) |
| telegram | SCOUT, GUARD, MONITOR, STOPCHECK, REFLECT | | | Telegram bot |
| (observer) core-bootstrap | none | n/a | | `src/index.mjs` bootstrap |

Every enabled process must appear above with its exact artifact digest and its
start wrapper. An unidentified consumer, a second slot holding the same
operations without its own slot entry, or a multi-host layout makes the release
ineligible rather than "close enough".

## Fencing and reconciliation

- process fence evidence: `<how a hung process and its descendants are proven
  unable to resume>`
- open-order / unknown-outcome reconciliation: `<procedure, no retries>`
- deterministic protection during transition: `<trailing, harvest, time-stop,
  operator close/cancel>`

## Why this is `verified: false`

The implementation runs offline. It cannot know the real host, filesystem,
process manager, participant inventory, account state or open positions, and it
must not guess them. G4 is therefore `NOT_RUN` in `release-report.json` and the
release is not eligible until an operator fills this file in and removes this
section.
