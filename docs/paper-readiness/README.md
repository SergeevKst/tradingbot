# PAPER trading readiness

This directory is the evidence trail for the "bring the bot to a working,
continuously observable PAPER-trading state" task. It records what is proven,
what is not, and what still blocks the next step.

| Document | Contents |
| --- | --- |
| [P2A_ENTRY_FEE_ACCOUNTING.md](P2A_ENTRY_FEE_ACCOUNTING.md) | the entry-fee defect, its root cause, the fix and the reconciliation evidence |
| [PAPER_SMOKE_RUN.md](PAPER_SMOKE_RUN.md) | how to reproduce the smoke run, the recorded results and the zero-order proof |
| [AI_PIPELINE_READINESS.md](AI_PIPELINE_READINESS.md) | whether the six-operation AI pipeline can supply decisions to PAPER, and the blockers |
| [TELEGRAM_EXECUTION_BLOCKERS.md](TELEGRAM_EXECUTION_BLOCKERS.md) | three recorded defects in the Telegram execution path (recorded only, not fixed) |

## State of the PAPER path, in one table

| Property | Status | Where it is proven |
| --- | --- | --- |
| Simulated entries, exits, fees, equity | working | `scripts/paper_smoke_run.mjs`, `test/paper-execution.test.mjs` |
| Per-trade result reconciles with equity change (1e-6) | fixed and pinned | `test/paper-fee-reconciliation.test.mjs` |
| State survives restart; corrupt state fails closed | working | `test/paper-execution.test.mjs`, `test/paper-session-validation.test.mjs` |
| Deterministic risk gate before every fill | working | `test/risk-*.test.mjs`, `test/paper-session-validation.test.mjs` |
| Runtime kill switch stops new entries, protection continues | working (memory-only) | `test/paper-session-validation.test.mjs` |
| No PAPER path can reach an authenticated exchange request | proven | `test/paper-isolation.test.mjs` |
| LIVE mode refused by the session factory | proven | `test/paper-isolation.test.mjs`, `test/live-safety.test.mjs` |
| Market-data staleness gate inside the session | **missing** | characterized in `test/paper-session-validation.test.mjs` |
| Continuous loop / scheduler for unattended paper trading | **missing** | `src/index.mjs` is one-shot |
| AI decisions feeding PAPER | **not wired** | `AI_PIPELINE_READINESS.md` |

Run the suites:

```bash
npm test                 # full suite
npm run test:paper       # PAPER-focused subset
npm run paper:smoke      # reproducible public-data smoke run
```

## Baseline failures at the pinned commit

`f80609e7d267036138486a92e73807e5dd40e6d4` with dependencies installed: 898
tests, 894 pass, 3 fail, 1 skipped. The three failures are pre-existing
prompt-contract tests and were **not** weakened or deleted:

1. `test/telegram-guard.test.mjs` — `G-5: buildGuardPrompt version is
   risk-guard-v2 with expected payload keys` (`Unexpected token 'S', "SHARED CON"…`)
2. `test/telegram-ideas.test.mjs` — `S-5: buildScoutPrompt strips instrument
   from symbols in user payload` (`Unexpected token 'N', "NEWS:\n{"ne"…`)
3. `test/telegram-monitor.test.mjs` — `buildMonitorPrompt/buildStopcheckPrompt
   versions and payload keys`

They are recorded as blocker **B4** in `AI_PIPELINE_READINESS.md`; all three sit
in the AI prompt layer, not in the PAPER path.

With this task's changes: 938 tests, 934 pass, the **same 3 pre-existing
failures**, 1 skipped (+40 tests, no assertion weakened).
