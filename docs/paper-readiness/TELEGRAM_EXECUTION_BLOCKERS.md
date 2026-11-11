# Telegram execution blockers (recorded, NOT fixed)

These three defects were **recorded only**. Fixing them would have turned this
task into a live-execution rewrite, which its scope explicitly forbids. No file
in `src/telegram/` was modified, and no Telegram execution behaviour changed.

Each item was verified by reading the current `main` baseline
(`f80609e7d267036138486a92e73807e5dd40e6d4`), not by trusting the research
report.

Why they are recorded here at all: none of them is reachable from a PAPER
session (the PAPER import closure contains no `src/telegram/*` module — see
`test/paper-isolation.test.mjs`), but each one blocks the *next* step, which is
letting AI decisions drive real or testnet execution.

---

## T-1 — Incomplete account-risk snapshot in `sizePosition`

**Location:** `src/telegram/size.mjs:50-57`

```js
const account = {
  equityUsd: wallet.equityUsd,
  availableBalanceUsd: wallet.availableBalanceUsd,
  dailyRealizedPnlUsd: 0,
  peakEquityUsd: wallet.equityUsd,
  openPositions: [],
  openOrders: [],
  tradesToday: 0,
};
```

**Defect:** the object handed to the deterministic Risk Engine asserts facts
that are not verified:

- `openPositions: []` and `openOrders: []` — the engine cannot see existing
  exposure, so `maxOpenPositions`, `maxSymbolExposurePct` and
  `maxTotalExposurePct` are evaluated against an empty book;
- `dailyRealizedPnlUsd: 0` — the daily loss limit `maxDailyLossPct` can never
  trip, however much was lost today;
- `peakEquityUsd: wallet.equityUsd` — the drawdown limit `maxDrawdownPct` is
  evaluated against today's equity, not the real high-water mark, so a slow bleed
  from a higher peak is invisible;
- `tradesToday: 0` — `maxTradesPerDay` never trips.

**Impact:** the "deterministic gate always supervises AI output" property is
true in the core PAPER path and **not true** on this path. Every AI-driven
Telegram entry is risk-gated against a fabricated flat account.

---

## T-2 — Futures closing orders are not `reduceOnly`

**Location:** `src/telegram/execute.mjs:143-180` (`placeMarketOrder`); call sites
for closes at `src/telegram/bot.mjs:2311` and `src/telegram/bot.mjs:2381`

```js
const bodyObj = {
  category: 'linear',
  symbol: order.symbol,
  side: order.side,
  orderType: 'Market',
  qty: order.qty,
  timeInForce: 'IOC',
  orderLinkId: order.orderLinkId,
};
```

`reduceOnly` appears **nowhere** in the repository (`grep -rn reduceOnly src` →
no matches). A close is an opposite-side market order whose size is read from a
position snapshot taken earlier.

**Defect:** if the position was already closed externally, partially closed, or
was reduced between the snapshot and the dispatch, the opposite-side order does
not fail as a reduce — it opens a new position in the opposite direction. A
closing order must be `reduceOnly: true` (or the equivalent bybit semantics) so
an over-sized close is refused by the exchange instead of flipping the book.

**Impact:** the failure mode is a silent position reversal, which is worse than
a rejected close. This matters for `MONITOR`/`STOPCHECK` auto-close as well, so
T-1 and T-3 are not independent of it.

---

## T-3 — STOPCHECK loss gate uses the absolute PnL

**Location:** `src/telegram/bot.mjs:2034-2036`

```js
const lossBig = pnlUsd <= -2;
const lossPct = pos.avgPrice > 0 ? Math.abs(pnlUsd) / (pos.avgPrice * pos.size) * 100 : 0;
const lossMeaningful = lossBig || lossPct >= 1;
```

**Defect:** `lossBig` is signed and correct. `lossPct` is computed from
`Math.abs(pnlUsd)`, so a position that is **up** by 1% or more also sets
`lossMeaningful = true`. The flag is then passed to `shouldConsultStopcheck()`
and, downstream, to `decideStopcheckAction({ llmAction, lossMeaningful,
trendAgainst })` (`src/telegram/stopcheck.mjs:60-66`), where
`lossMeaningful && trendAgainst` escalates a model `CLOSE` verdict to
`AUTO_CLOSE`.

**Impact:** a winning position that happens to be trend-against is presented to
the model as a "meaningful loss" and can be auto-closed unattended. The sign
error inverts the meaning of the gate on half of all possible states.

---

## Status

Recorded, not fixed. Any future change to these paths needs its own task with
its own tests, because a wrong fix here moves real money.
