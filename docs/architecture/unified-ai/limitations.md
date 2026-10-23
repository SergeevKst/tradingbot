# Known limitations and open risks (v1.1 implementation)

These are properties of the approved design as implemented, not defects that can
be fixed by a larger test suite.

## Deployment

1. **One host only.** The control store assumes one local POSIX filesystem with
   atomic `rename`, exclusive `mkdir` and durable `fsync`. Multi-host
   deployments cannot activate v1.1 by copying files and are explicitly
   ineligible until a separately reviewed coordinator exists.
2. **Availability over safety, deliberately.** A hung or crashed participant
   blocks the barrier indefinitely. There is no lease expiry, heartbeat
   eviction, quorum or timeout takeover. An operator must fence.
3. **Topology is unverified here.** G4 is `NOT_RUN`; the operator must confirm
   host, filesystem, process inventory and wrapping.
4. **Duplicate ownership of one slot is an operational constraint.** Only the
   instance ID committed in ACTIVE may serve the slot; a restart with a new
   instance ID fails closed with `SLOT_CONFLICT` (see 5). Process-manager
   uniqueness per slot is still required for the committed instance ID.

## Control plane

5. **A restart does not adopt an occupied slot.** An occupied slot never expires
   automatically (§5 step 3), §9.3 has no ACTIVE self-transition that replaces a
   member, and UAI-05B requires explicit fencing evidence for a member
   replacement. A restarted process whose fresh instance ID does not match the
   committed member therefore reports `identityReady: false` with
   `SLOT_CONFLICT`, keeps deterministic protection running, and leaves admission
   closed until the operator replaces the member through a transition:
   `quiesce` → `retire` with `QUIESCED` (the old process is alive and
   acknowledged) or `FENCED` (the operator asserts and documents that it is
   gone) evidence → `register-target` for the new instance → `arm` → `activate`.
   The cost is availability, not correctness: a crash-restart needs one explicit
   operator step, and an unreachable old process needs a documented fence.
6. **Fencing is evidence, not a mechanism.** `FENCED` carries operator references
   to process-fence and reconciliation artefacts. The tooling cannot prove a
   process is gone, and does not kill anything.
7. **Trust boundary.** A checksum-valid record written by an unauthorized process
   is outside the protocol. Filesystem permissions and operator discipline are
   the authority; hashes detect drift, not a malicious writer. The audit trail
   records a non-identifying host label (`local-host`) and a PID — never a
   machine name — and lock recovery refuses a lock carrying any other label
   instead of stealing it.
8. **Model aliases can move underneath.** Identity is configured provider +
   canonical endpoint + model id + capability profile. It is not proof of
   immutable vendor weights. Pin vendor revisions where available and disclose
   alias mutability in evaluation.

## Effects

9. **Exchange writes are not transactional.** An already submitted order is
   reconciled, never retried, when the generation changes. Every AI-derived write
   (entry, AI-proposed exit, stop-check auto-close, unattended entry) is dispatched
   through `src/telegram/ai-effect-gateway.mjs`, which holds one counted scope
   across the *whole* effect: the plan's preparation (instrument metadata, the
   leverage call, spot-quantity normalisation, the drift decision, the position a
   close will use) runs under the token first, the control record is reread
   immediately before the write, and the scope is settled afterwards. A
   preparation that throws or asks to abort is definitively "nothing was sent":
   the scope is released (never retained), and a ticket-bound plan keeps its
   provenance so the operator can retry the same card — e.g. choose a lower
   leverage after the exchange refused one.
10. **An unknown dispatch outcome keeps the process unable to quiesce.** A
   transport error with no exchange answer (timeout, socket reset) is *not*
   treated as "no order": the counted token is retained, `acknowledgeQuiesced()`
   fails with `WORK_OUTSTANDING`, and a transition cannot complete until an
   operator reconciles the position and releases the token with an explicit
   reference (`reconcileUnresolved({ workId, reference })`, audited as
   `effect.reconciled`). A definite rejection (exchange error code) is different:
   it re-arms the provenance so the same card can be retried.
11. **Pending AI approvals are invalidated by design.** A human tap that arrives
   after quiescence is rejected and the operator must request fresh analysis.
   This is an accepted UX cost, not a bug.
12. **Downtime and skipped cycles.** A transition pauses AI and may skip one
   cycle. Deterministic protection and operator close/cancel remain available;
   `/orders` closes are operator controls and are deliberately not gated.

## Deterministic protection

13. **Bot parallelism is unchanged.** Guard fan-out stays concurrent in ACTIVE;
    the guard adds local control reads and work accounting. No throughput or
    latency claim is made beyond the conformance tests.
14. **Trading behaviour is unchanged.** Thresholds, sizing, ranking, order
    arguments and journals are untouched; the parity suite asserts the exported
    decision helpers still produce the same values and that the Telegram
    composition imports no risk/execution/state module.

## Evidence

15. **`ACTIVATION_VERIFIED` cannot be produced offline.** G7 requires a real,
    authorized activation. The dossier therefore stops at
    `OFFLINE_CONFORMANT`.
16. **`identityReady` is observed, not asserted — but it is not liveness.**
    `ai_release_verify.mjs` spawns `scripts/ai_participant_probe.mjs` once per
    committed participant and records what that process observed against the
    durable record. That proves the identity/membership contract is satisfiable
    now; it does not prove the real participant process is running or that it is
    the only one. Those remain G4 (topology/inventory) and G7 (live verification).
17. **Evidence refs are hash-pinned.** Every gate and XP row names a
    dossier-relative file whose SHA-256 is recorded in `evidenceHashes`;
    `node scripts/ai_release_verify.mjs --check docs/architecture/unified-ai/release-report.json`
    re-hashes them and fails on a missing or changed file. A `PASS` row without
    hashed evidence is rejected by the schema, so absent evidence cannot read as
    readiness.
18. **Synthetic dossier artifacts.** The evidence in
    `evidence/` uses fixture digests, not built bundles. It proves the protocol
    and the tooling; it does not certify any binary.
19. **Financial-risk gates from v1.0 remain open.** Risk thresholds, sizing and
    execution behaviour are unchanged; the inherited financial-risk disposition
    is still an owner decision.

## Release evidence and tooling

20. **G5's financial half is proven on a fixture, not on live financial state.**
    The rehearsal hashes a synthetic fixture journal before and after the
    forward+rollback transition, adds only the fixture-declared normal
    deterministic actions (each one inside a barrier's PREPARING phase, because
    deterministic protection is not paused by a transition), asserts that the
    residual journal hashes are equal and that no entry id appears twice. That
    proves the harness and the reporting contract; it cannot prove anything about
    the live ledger, the exchange or the trading journal. Live before/after
    financial-state equivalence and duplicate-entry absence remain a G7/operator
    obligation, stated in the G5 note of `release-report.json` and checked in
    `operator-approval-checklist.md`.
21. **`rollback` is a barrier, not a shortcut.** The verb opens the ordinary
    `QUIESCING` transition for a descriptor that is already staged under
    `releases/`, requires an explicit transition id, and only runs from an
    `ACTIVE` record; it refuses an unstaged descriptor, a retained transition
    (use `recover`) and a stale revision. It cannot commit a binding, cannot skip
    quiescence/prepare/observer/arm/activate and never copies a control file.
    Reusing the old digest under a higher generation is a rollback; reusing the
    old generation is not.

## Pre-existing baseline failures

Three prompt-layout tests fail on the pinned baseline (`G-5`, `S-5`,
`buildMonitorPrompt/buildStopcheckPrompt versions and payload keys`). They are
unrelated to the AI release protocol and were failing before this work; they are
documented here so the baseline gate is read correctly rather than silently
"fixed" by editing unrelated prompt fixtures.
