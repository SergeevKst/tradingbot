# PAPER smoke run — procedure and recorded evidence

`scripts/paper_smoke_run.mjs` is the reproducible PAPER smoke run. It is the
executable answer to "can this thing actually trade on paper, and is the
accounting honest?".

## What it does

1. Reads PUBLIC market data from Bybit over unauthenticated `GET /v5/market/*`
   (tickers, orderbook, instruments-info, kline). No key, no account, no order
   endpoint.
2. Records the raw snapshot to `<out>/market-data.json` together with the
   endpoint list and a SHA-256 of the recorded payload, so the run can be
   replayed byte-for-byte without a network.
3. Replays each candle through the canonical PAPER session:
   `deterministic-ma-crossover` → Risk Engine → simulated fill → persistence →
   journal. The session clock follows the replayed candle, so the journal of a
   replay is identical to the journal of the original run.
4. Closes whatever is still open at the last candle (`END_OF_REPLAY`), so every
   round trip is complete.
5. Writes `<out>/smoke-summary.json` with trades, fees, equity change and five
   self-checks, and exits non-zero if any check fails.

### Modelling assumptions (stated, not hidden)

- **Bid/ask per candle are derived.** Public klines carry no book. The spread is
  the observed live spread at fetch time, applied symmetrically around each
  candle close, then snapped to the instrument tick size. The exact figure is in
  `summary.market.spreadModel`.
- **Fee rates are the project's synthetic placeholders** (0.10% in, 0.10% out),
  not Bybit's real schedule.
- **The strategy is a signal source, not an edge.** A 3/6 SMA crossover with an
  ATR stop. The run demonstrates plumbing and accounting; it says nothing about
  profitability.
- **Slippage beyond the spread is not modelled.** Fills cross the spread
  pessimistically (a buyer pays the ask, a seller receives the bid); nothing else
  is simulated.

## How to reproduce

```bash
# Fetch fresh public data and run
node scripts/paper_smoke_run.mjs --out artifacts/paper-smoke --symbol BTCUSDT --interval 5 --candles 200

# Replay a recorded run offline, byte-identically
node scripts/paper_smoke_run.mjs --replay artifacts/paper-smoke/market-data.json --out artifacts/paper-smoke-replay
```

Options: `--symbol`, `--interval`, `--candles`, `--out`, `--replay`,
`--spread-usd`, `--equity`. The output directory must not already contain a
paper account — the script refuses to run on a non-flat state instead of
silently continuing someone else's account.

## Recorded run (2026-11-11)

Command:

```bash
node scripts/paper_smoke_run.mjs \
  --out artifacts/paper-smoke --symbol BTCUSDT --interval 5 --candles 200
```

| Item | Value |
| --- | --- |
| Data | `BTCUSDT` 5m, 200 candles, 2026-11-11T00:50Z → 2026-11-11T17:25Z |
| Data source | public REST `https://api.bybit.com` |
| Data SHA-256 | `c00c2207978bffdb6c0e083aa0a652d97cda10199b986aa7b2809144602b714f` |
| Spread model | observed live spread 0.1 USD around each close, tick 0.1 |
| Strategy | `deterministic-ma-crossover` (3/6 SMA, ATR 5 × 1.5 stop, 2R target) |
| Entries | 5 |
| Exits | 5 — 4 `TAKE_PROFIT`, 1 `STOP_LOSS` |
| Rejections | 41 — `CONFLICTING_POSITION` 21, `DUPLICATE_PROPOSAL` 20 |
| Equity start | 340.000000 USD |
| Equity end | 344.558888 USD |
| Equity change | +4.558888 USD |
| Σ round-trip net PnL | +4.558888 USD |
| Reconciliation delta | 2.309e-14 USD (tolerance 1e-6) |
| Fees paid | 2.953112 USD (entry 1.474893 + exit 1.478219) |
| Realized (gross of fees) | 7.512000 USD |
| Network requests | 4, all `GET /v5/market/*`; 0 non-market, 0 non-GET |
| Real orders placed | **0** |

### Per-trade detail (from `paper-smoke/smoke-summary.json`)

| # | Side | Qty | Entry | Exit | Exit reason | Entry fee | Exit fee | Gross | **Net** |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | SHORT | 0.004 | 73662.0 | 73939.7 | STOP_LOSS | 0.294648 | 0.295759 | −1.110800 | **−1.701207** |
| 2 | SHORT | 0.004 | 73839.2 | 73518.8 | TAKE_PROFIT | 0.295357 | 0.294075 | 1.281600 | **0.692168** |
| 3 | LONG | 0.004 | 73731.4 | 74091.0 | TAKE_PROFIT | 0.294926 | 0.296364 | 1.438400 | **0.847110** |
| 4 | SHORT | 0.004 | 73869.5 | 73388.9 | TAKE_PROFIT | 0.295478 | 0.293556 | 1.922400 | **1.333366** |
| 5 | LONG | 0.004 | 73621.2 | 74616.3 | TAKE_PROFIT | 0.294485 | 0.298465 | 3.980400 | **3.387450** |
| | | | | | | | | Σ | **4.558888** |

Both a losing and a winning round trip are present, so the reconciliation is not
an artefact of only-good trades. The identity that must hold for any run is the
one the checks assert:

```
equity_change == Σ(round-trip net PnL) == Σ(POSITION_CLOSED.pnl in journal)
```

both within 1e-6. The authoritative numbers are always the ones inside that
run's `smoke-summary.json`.

### Journal excerpt (first round trip, a stop-out)

```
{"timestamp":"2026-11-11T01:50:00.000Z","eventType":"STRATEGY_DECISION","side":"SHORT","reason":"EMIT","metadata":{"strategyId":"deterministic-ma-crossover"}}
{"timestamp":"2026-11-11T01:50:00.000Z","eventType":"SIGNAL_RECEIVED","side":"SHORT","metadata":{"entryPrice":73662,"stopLossPrice":73901.97,"takeProfitPrice":73182.06,"mode":"PAPER"}}
{"timestamp":"2026-11-11T01:50:00.000Z","eventType":"RISK_ACCEPTED","quantity":0.00461567701121338,"reason":"APPROVED","metadata":{"riskAmountUsd":1.1076240123808803,"positionNotionalUsd":340,"riskReward":2}}
{"timestamp":"2026-11-11T01:50:00.000Z","eventType":"ORDER_FILLED","quantity":0.004,"price":73662,"fee":0.294648,"reason":"market entry filled at bid"}
{"timestamp":"2026-11-11T01:50:00.000Z","eventType":"POSITION_OPENED","quantity":0.004,"price":73662,"metadata":{"stopLoss":73901.97,"takeProfit":73182.06,"leverage":2,"initialMarginUsd":147.324}}
{"timestamp":"2026-11-11T05:45:00.000Z","eventType":"STOP_LOSS_FILLED","quantity":0.004,"price":73939.7,"pnl":-1.7012067999999885,"fee":0.2957588,"metadata":{"entryPrice":73662,"grossPnlUsd":-1.1107999999999885,"exitFeeUsd":0.2957588,"entryFeeUsd":0.294648,"triggerLevel":73901.97}}
{"timestamp":"2026-11-11T05:45:00.000Z","eventType":"POSITION_CLOSED","quantity":0.004,"price":73939.7,"pnl":-1.7012067999999885,"fee":0.2957588,"metadata":{"entryPrice":73662,"equityUsd":338.5934412}}
```

The `pnl` on the close event is `grossPnlUsd - exitFeeUsd - entryFeeUsd`
(`−1.1108 − 0.2957588 − 0.294648`), and that is exactly the equity change for the
trade (`340 → 338.5934412`). The entry fee is carried on the position and
subtracted at close, which is the P2-A fix made visible in the audit trail.

## Reproducibility proof

Two runs over the same recorded file:

```
cmp paper-smoke/journal.jsonl paper-smoke-replay/journal.jsonl      -> identical
cmp paper-smoke/paper-state.json paper-smoke-replay/paper-state.json -> identical
diff paper-smoke/smoke-summary.json paper-smoke-replay/smoke-summary.json
  -> only `provenance.source`, `provenance.endpoints` and `execution.network.*`
     differ (the replay makes no requests)
```

Both runs end at the same equity (344.558888), the same fees (2.953112) and the
same reconciliation delta (2.309e-14).

## Zero-order proof

Two independent mechanisms, both exercised:

1. **Design:** the market-data adapter is wired to an audited `fetch` wrapper
   (`scripts/lib/audited-market-fetch.mjs`). Every request is recorded, and the
   wrapper throws on a non-`GET` method, on any path outside `/v5/market/`, on
   `/v5/order|position|account|asset`, and on any auth-looking header. A write
   attempt therefore fails the run, it cannot pass silently. The wrapper itself
   is unit-tested in `test/paper-smoke-audit-fetch.test.mjs` (8 cases) — a guard
   nobody tests is a comment.
2. **Structure:** `test/paper-isolation.test.mjs` proves the PAPER import closure
   has no HTTP client at all and that a full lifecycle performs zero network
   calls (`globalThis.fetch` replaced with a counting stub → 0).

## What this run does not prove

- It does not prove the strategy is profitable, and no profit claim should be
  derived from it. Five take-profits in a 200-candle window is a sample, not an
  edge.
- It does not cover a continuously running process: there is still no supervised
  loop (see `AI_PIPELINE_READINESS.md`, blocker B7).
- It does not exercise any AI decision: signals came from the deterministic
  strategy.
