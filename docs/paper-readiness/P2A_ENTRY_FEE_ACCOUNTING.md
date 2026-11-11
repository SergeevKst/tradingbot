# P2-A — entry-fee accounting in the paper position

Defect, root cause, fix and the reconciliation it restores. This is the only
production code change in the paper-trading-readiness task (plus the new smoke
script); everything else is tests and documentation.

## The defect

A PAPER round trip did not reconcile with the account it had just changed:

```
equity net PnL  ≠  Σ(round-trip PnL)
```

The research smoke run recorded `$3.65` of equity change against `$4.17` of
summed round-trip PnL. The difference is precisely the entry fees that had been
dropped from each round trip's reported result.

## Root cause

`src/state/paper-position.mjs:validatePaperPosition` rebuilt the position from a
closed field set. `entryFeeUsd` was not in that set, so every call to
`validatePaperPosition` deleted it:

- `markPosition()` — called by the paper executor on **every** market update —
  re-validates the position, so the fee disappeared on the first mark after
  entry;
- `validatePaperAccountState()` — the reload path — re-validates every position,
  so the fee also disappeared on any restart between entry and exit.

Meanwhile `PaperExecutionAdapter.settle()` reads `position.entryFeeUsd` to build

```js
netPnlUsd = grossPnl - exitFee - entryFee
```

and the account ledger had already charged the entry fee in `account.feesUsd`.
A missing field silently becomes `0`, so the round-trip result came out **gross
of the entry fee** while the equity still carried it — a systematic
overstatement of every trade's result by that fee.

The position was never wrong about equity; it was wrong about attribution. That
is the dangerous shape: the ledger reconciles internally, the *reported trade
result* does not, and a UI or report built on per-trade PnL would overstate
performance by exactly the sum of entry fees.

## The fix

`entryFeeUsd` is now part of the validated, persisted field set:

```js
const entryFeeUsd = optionalFee(input.entryFeeUsd, 'entryFeeUsd');
// ...
return Object.freeze({
  // ...
  entryFeeUsd,
  // ...
});

function optionalFee(value, field) {
  if (value === undefined || value === null || value === '') return 0;   // pre-fix state
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new ConfigError(`PaperPosition.${field} must be a finite number >= 0, ...`);
  }
  return parsed;
}
```

Two deliberate decisions:

- **Absent = 0.** State written by an older build has no such field. Refusing to
  restore it would strand every existing paper account; 0 is the only value that
  keeps such a document internally consistent (its fees were already charged).
- **Present but invalid = refuse.** A negative or non-finite fee is corrupt data.
  Silently zeroing it would hide money, so it is a `ConfigError`.

The field is preserved, never recomputed: the fee model is not available inside
the validator, and re-deriving the fee there would be a guess.

## Evidence

Pre-fix reproduction (same fixture, `entryRate = exitRate = 0.001`):

```
after entry: entryFeeUsd 0.17200020000000002  feesUsd 0.17200020000000002
after mark : entryFeeUsd undefined            feesUsd 0.17200020000000002
after close: netPnlUsdOnFill 0.8266001999999767
             equityNetPnl   0.6545999999999594
             delta         -0.17200020000001726   <-- exactly the dropped entry fee
```

Post-fix, same script:

```
after mark : entryFeeUsd 0.17200020000000002
after close: netPnlUsdOnFill 0.6545999999999766
             equityNetPnl   0.6545999999999594
             delta         -1.72e-14
```

`test/paper-fee-reconciliation.test.mjs` pins the identity in ten regression
tests, at a tolerance of `$0.000001`:

| Test | Path covered |
| --- | --- |
| `validatePaperPosition preserves a finite entryFeeUsd` | pure validator |
| `a missing entryFeeUsd defaults to 0 for pre-fix persisted state` | backward compatibility |
| `a negative or non-finite entryFeeUsd is refused` | corrupt-data refusal |
| `markPosition keeps the entry fee through a re-price` | mark to market |
| `account validation keeps the entry fee across a reload` | restart |
| `round-trip net PnL reconciles with equity change after a mark` | the reported defect |
| `round-trip net PnL reconciles across several trades` | 3 round trips |
| `the entry fee and the reconciliation survive persistence and reload` | restart then close |
| `the entry fee and the reconciliation survive a UTC day rollover` | day rollover |
| `an entry fee is never charged twice and never omitted` | double-charge guard |

The identity each test asserts:

```
equity_now - initial_equity
  == realized_gross + unrealized - fees_paid          (ledger identity)
  == Σ(round-trip net PnL) + unrealized               (reconciliation)
```

The smoke run adds an independent check over the same identity, recomputed from
the journal (`Σ POSITION_CLOSED.pnl`), so a future regression in either the
in-memory fills or the persisted audit trail fails a check.

## Out of scope, noted for the record

`src/session/testnet-bootstrap.mjs:39` maps exchange positions into the paper
account shape without an `entryFeeUsd` (the fee is not known from position
value). Those positions therefore default to 0, which is correct for the data
available but means a testnet-restored position's round-trip result is gross of
its entry fee. That path is TESTNET, not PAPER, and was not changed here.
