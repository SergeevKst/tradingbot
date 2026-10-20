# TESTNET READINESS SCORECARD

**Date:** 2026-10-02
**Status:** READY FOR FIRST TESTNET ORDER (integration in place)
**Reviewer:** Kilo (TESTNET-INT-001)

## Gate Status

| Gate                      | Status          | Evidence                                      | Blocking |
|---------------------------|-----------------|-----------------------------------------------|----------|
| Configuration             | PASS            | trading-mode, testnet.mjs, live.mjs, mode-guard | No |
| Secrets isolation         | PASS            | Dedicated BYBIT_TESTNET_* vars, no fallback, loadTestnetCredentials fails closed | No |
| Testnet endpoint          | PASS            | TESTNET_REST_BASE_URL = api-testnet.bybit.com, mode-guard refuses mainnet | No |
| Authentication handling   | PASS            | testnet/auth.mjs (HMAC, WS auth), authenticated-rest-client | No |
| Risk Engine               | PASS            | evaluateTrade mandatory in all paths (paper, backtest); same gate for any future testnet | No |
| Idempotency               | PASS            | duplicate-guard, clientOrderId, reconciliation-engine, failure-policy | No |
| Execution                 | PASS            | TRADING_MODE.TESTNET + TestnetExecutionAdapter routes approved entries through the shared reconciliation engine to the authenticated testnet client; session refuses LIVE | No |
| Reconciliation            | PASS            | order-reconciler, startup-reconciler, journal events; TestnetExecutionAdapter reuses the same engine (no second reconciler) | No |
| Recovery                  | PASS            | journal-replay, recovery-session, bounded retries | No |
| Kill switch               | PASS            | createKillSwitch, emergency-controls, evaluateTrade respects it; TESTNET submit tested to make no exchange call when engaged | No |
| AI isolation              | PASS            | assertNoSizingFields, data-only AIAnalysis, Strategy → Risk gate | No |
| Data quality              | PASS            | normalizers, market-state-cache, historical loader, gap detection | No |
| Observability             | PASS            | journal (ORDER_*, RECONCILE_*, KILL_*, LIVE_* events), correlation via IDs | No |
| Tests                     | PASS            | 493 tests, 492 pass, 1 skipped (opt-in live testnet), security suite 24/24 | No |
| Paper/Testnet consistency | PASS            | Same Risk Engine, TradeIntent, kill switch, journal and reconciliation; only the execution adapter differs (paper sim vs testnet authenticated) | No |
| LIVE isolation            | PASS            | live-gate + checklist + credential-separation + live-session refuses all submit; isLiveMode(TESTNET) === false | No |

## Blocking Findings

1. **No integrated TESTNET execution path** (CRITICAL) — **CLOSED (TESTNET-INT-001)**
   - Resolution: `TRADING_MODE.TESTNET` is now a first-class mode. `createTradingSession` selects `PaperExecutionAdapter` for PAPER and `TestnetExecutionAdapter` for TESTNET and refuses LIVE/BACKTEST. The adapter submits risk-approved entries through the existing `ReconciliationEngine` (idempotency, ambiguous-failure recovery) to the authenticated testnet client; the session reuses the same `evaluateTrade`, kill switch and append-only journal.
   - Residual scope (deliberate, not a blocker): `closePosition`/`modifyPositionProtection` on the TESTNET adapter fail closed. Reducing a position is a fresh non-idempotent order and exchange-side stop amendment is a forbidden operation, so neither is armed in this task. Credentials stay in `config/testnet.mjs` (dedicated keys, fail-closed); an ambiguous TESTNET config refuses startup rather than falling back to production.
   - Evidence: 11 new tests in `test/testnet-integration.test.mjs` (mode resolution, ambiguous-config refusal, adapter contract, non-testnet refusal, mode selection, Risk REJECT → 0 exchange calls, kill switch → 0 exchange calls, approved entry → exactly one submission with idempotent duplicate block). Full suite 493 tests / 0 fail; `npm run test:security` 24/24.

## Non-Blocking Observations
- TRADING_MODE now includes TESTNET as a first-class mode (resolved by `resolveTradingMode`; `isLiveMode` is false, `isOfflineMode` excludes it).
- The authenticated TESTNET path lives behind `TestnetExecutionAdapter`; the adapter holds no credentials or signing and refuses any non-testnet client/host.

## Testnet Readiness Prerequisites
- Dedicated testnet keys supported
- Endpoint isolation enforced
- Risk + reconciliation + recovery verified
- Kill switch + emergency controls verified
- AI isolation verified
- Full test suite green
- Observability via journal
- Integrated TESTNET execution session selecting the testnet adapter by mode

## Final Status

**READY FOR FIRST TESTNET ORDER (integration in place; first live-fire order still manual)**

**Blocking finding:** CLOSED — the integrated TESTNET execution path now exists in the canonical session layer.

Approved entries flow TradeProposal → Risk Engine → TestnetExecutionAdapter → ReconciliationEngine → authenticated testnet client, against api-testnet.bybit.com only, with dedicated credentials and no fallback to production. No real order was sent while building this; `closePosition`/`modifyPositionProtection` fail closed by design, and LIVE stays refused.

No credentials were read, no orders were sent, LIVE remains blocked.

---
*This scorecard is the authoritative Testnet Readiness state.*

## Canonical TESTNET Configuration (fixed 2026-10-02)
- Variables: `BYBIT_TESTNET_API_KEY`, `BYBIT_TESTNET_API_SECRET`
- Legacy scripts updated to prefer dedicated TESTNET variables when `BYBIT_TESTNET=true` or `TESTNET_ENABLED=true`
- `.env` loaded via `node --env-file=.env` (package.json)
- No fallback to production credentials
- Configuration tests added for missing keys, naming, and endpoint selection