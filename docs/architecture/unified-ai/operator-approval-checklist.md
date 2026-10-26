# Operator approval checklist (G4, G6, G7)

No item here can be signed by the implementation. Each one is an operational
fact or an owner decision. `release-report.json` keeps G4/G6/G7 as `NOT_RUN`
until the corresponding evidence exists; a report that marks them `PASS` without
the artefacts below is invalid.

## G4 — topology and safety

- [ ] Confirm the deployment is **one host / one kernel** with one local control
      directory shared by every participant.
- [ ] Confirm the filesystem supports atomic same-directory `rename`, exclusive
      `mkdir` and durable `fsync` on files **and** directories.
      (NFS, SMB, object stores and replicated-file synchronisation are
      unsupported and fail this gate.)
- [ ] Enumerate every AI-capable process: slot, start command, startup wrapper,
      owner, artifact digest. Attach it as `topology-evidence.md` with
      `verified: true` only after checking it.
- [ ] Confirm there is no bypass factory: no production path constructs
      `createDeepSeekProvider` / `createDeepSeekChat` / `createReflector` outside
      a composition. (`CORE_AI_CALL_SITE_INVENTORY` is asserted by
      `test/core-ai-composition.test.mjs`.)
- [ ] Document the fencing procedure: how a hung process and its descendants are
      proven unable to resume, and how an already-submitted order with an unknown
      outcome is reconciled **without** retrying it.
- [ ] Confirm deterministic protection (trailing, harvest, time-stop, operator
      close/cancel) runs through the transition and does not depend on AI.
- [ ] Confirm the dossier evidence chain still resolves on the exact release
      tree: `node scripts/ai_release_verify.mjs --check
      docs/architecture/unified-ai/release-report.json` reports `ok: true` (no
      missing, changed or unindexed evidence), and the participant readiness in
      `observedParticipants` was produced by `scripts/ai_participant_probe.mjs`
      rather than copied from the roster.
- [ ] Confirm no participant is holding an unresolved AI-derived effect (an
      unknown order outcome). Such a process refuses to quiesce until the
      operator reconciles it with an explicit reference.

## G6 — human authorization

- [ ] Approve the exact manifest (provider, canonical endpoint, model id) and
      capability-profile digests.
- [ ] Approve the artifact set per slot (content digests, source commits).
- [ ] Accept the transition behaviour: AI pauses, pending AI approvals are
      invalidated, one trading cycle may be skipped.
- [ ] Decide the financial-risk disposition inherited from v1.0 (unchanged
      gates). The implementation does not resolve it.
- [ ] Authorize any paid evaluation separately. Startup performs **no** smoke
      test and spends nothing.

## G7 — actual release verification (after an authorized activation)

- [ ] Before resuming AI, read the committed `ACTIVE` record and each slot's
      observed binding; reject any wrong generation, manifest or artifact.
- [ ] Confirm every `PREPARED` acknowledgement was collected for the exact
      descriptor; confirm the transition archive exists and predates the commit.
- [ ] At the first authorized inference, compare real request metadata
      (provider, endpoint, model, generation) against the binding. Do not force an
      extra paid call at startup.
- [ ] On mismatch: gate the offending participant, then `pause` and run a
      coordinated rollback. Never switch one process locally.
- [ ] Compare the financial state/journal before and after the transition: equal
      apart from the normal deterministic protection actions you can name
      individually, and no entry (order, fill, closed trade) appears twice. G5
      proves this on the rehearsal's synthetic fixture journal only
      (`limitations.md` #20); the live comparison is yours.
- [ ] Record pending-approval invalidation and any skipped cycle in the
      operational log.

## Sign-off record

| Gate | Who | Reference | Date |
|---|---|---|---|
| G4 | | | |
| G6 | | | |
| G7 | | | |

Until these rows are filled with real references, the release is not eligible.
