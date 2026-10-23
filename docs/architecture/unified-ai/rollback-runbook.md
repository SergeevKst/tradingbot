# Rollback and recovery runbook

Rollback is not an emergency override; it is the same barrier pointed at a
previously approved binding. Read `release-runbook.md` first — the columns and
the evidence rules are identical.

## What a rollback is

- A **new** generation (`highWaterGeneration + 1`), never a reused one. The
  `rollback` verb opens that barrier explicitly; `quiesce` with the retained
  descriptor is the same transition and stays available.
- A retained manifest/profile/artifact set that was previously approved and is
  still present in `manifests/`, `profiles/` and `releases/`.
- A complete `QUIESCING -> PREPARING -> ARMED -> ACTIVE` sequence with fresh
  acknowledgements from every live instance.
- Every token, callback and pending approval from the previous generation is
  invalid the moment the new binding is quiesced. That includes human taps on an
  AI card rendered before the transition: the tap is rejected and the operator
  must request a fresh analysis.

## What a rollback is not

- Copying an old `control.json` back into place (the revision and generation
  would go backwards; the store refuses it, and a checksum-valid but stale record
  is outside the trusted-writer boundary anyway).
- Decrementing `generation`.
- A per-process environment change. A participant that restarts with the old
  expected hash refuses readiness while its peers serve the new generation; only
  the barrier may move the fleet. A restart **inside** the current generation is
  equally a barrier action: an occupied slot never expires automatically, so a
  process with a new instance ID reports `SLOT_CONFLICT` until the operator
  retires the old instance (`QUIESCED` or `FENCED` evidence) and activates the
  replacement.
- An order retry mechanism. Already submitted orders are reconciled through the
  existing operational procedure; changing generations never justifies replaying
  an entry. An unknown order outcome must be reconciled before the participant
  can acknowledge quiescence.

## Rehearsal evidence

`evidence/rehearsal-report.json` records a real forward activation (generation 1)
followed by a rollback to the same manifest digest (generation 2) on a real
durable store, with synthetic participants and fake effects:

```
PAUSED(0) -> QUIESCING(0, reserved 1) -> PREPARING(0) -> ARMED(0) -> ACTIVE(1)
ACTIVE(1) -> QUIESCING(1, reserved 2) -> PREPARING(1) -> ARMED(1) -> ACTIVE(2)
```

Acks for both transitions are retained under `evidence/control/acks/<transition>/`,
the transition archives under `evidence/control/transitions/`, and the audit
under `evidence/control/audit.jsonl`.

## Interrupted transition

If the controller dies mid-transition the durable record is the only authority:

1. `inspect` — read the phase, the reservation and the collected evidence.
2. If the current legal edge's invariants are still provable, continue it.
   Otherwise `pause`, then `recover` with a fresh transition id.
3. `recover` keeps every old **and** target instance as an obligation, discards
   prior grants and prepare acknowledgements, and requires fresh
   `QUIESCED`/`PREPARED` evidence.
4. If any instance cannot respond and cannot be fenced, the fleet stays gated.
   There is no quorum, no timeout takeover and no majority shortcut.

## Lost control store

1. Stop every single-mode participant and prove it cannot resume (host/process
   manager evidence), and reconcile open positions and unknown order outcomes.
2. `initialize` a **new** deployment ID — never reuse the old control files.
3. Run the normal first activation. The previous generation high-water is gone
   with the store; that is exactly why the new deployment ID is mandatory.

A control-plane recovery is never a financial-state recovery: no ledger
rollback, no snapshot restore, no inference-driven replay.

## Legacy exit

Returning the fleet to the pre-v1.1 legacy configuration is reported as
`legacy`, not as a rollback. It needs separate owner approval, the same complete
quiescence/fencing, a documented stop of every single-mode process, and a tested
legacy artifact. The first v1.1 release must keep a previous single-mode binding
for protocol rehearsal even when the operational fallback is legacy.
