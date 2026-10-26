# Unified single-mode AI — v1.1 implementation dossier

Status: **implementation complete, offline-conformant, not deployed, not activated.**
Source task: `t_c7d379c4` (implementation), `t_dd155eb4` (approved v1.1 architecture).
Repository baseline: `f0e8cfcfc7b7256ff87d326495a77e76f1af9b52`.

This dossier is the UAI-09 deliverable: it documents what was built, how it is
verified, and exactly what an operator must establish before any real release.
It does **not** authorize deployment, activation, paid inference, account access
or a pull request.

## What exists now

| Area | Module | Verified by |
|---|---|---|
| Manifest / profile / release schema (UAI-05A) | `src/config/ai-identity-manifest.mjs`, `src/config/ai-release-schema.mjs`, `src/config/jcs.mjs`, `src/ai/operation-profiles.mjs` | `test/ai-identity-manifest.test.mjs` |
| Durable control store + state machine (UAI-05B) | `src/ai/coordination/control-store.mjs`, `src/ai/coordination/release-state.mjs` | `test/ai-control-store.test.mjs`, `test/ai-release-state.test.mjs` |
| Runtime guard + whole-work fencing (UAI-05C) | `src/ai/coordination/generation-guard.mjs`, `src/ai/runtime.mjs` | `test/ai-generation-guard.test.mjs` |
| Core composition + disabled bootstrap observer (UAI-06A) | `src/ai/core-ai-composition.mjs`, narrow edit in `src/index.mjs` | `test/core-ai-composition.test.mjs` |
| Telegram bindings + effect boundary (UAI-06B) | `src/telegram/ai-composition.mjs`, `src/telegram/ai-effect-gateway.mjs`, narrow edits in `src/telegram/bot.mjs` | `test/telegram-ai-integration.test.mjs`, `test/telegram-ai-effect-gateway.test.mjs`, `test/telegram-ai-dispatch-inventory.test.mjs`, `test/telegram-trading-parity.test.mjs` |
| Cross-process conformance XP-01..18 (UAI-06C) | `test/ai-cross-process-identity.test.mjs`, `test/helpers/ai-participant-child.mjs`, `test/helpers/ai-cluster.mjs` | itself — real child processes, real CLI |
| Release tooling + gates (UAI-09) | `scripts/ai_release.mjs`, `scripts/ai_release_rehearsal.mjs`, `scripts/ai_release_verify.mjs`, `scripts/ai_participant_probe.mjs`, `src/config/ai-release-report.mjs` | `test/ai-release-report.test.mjs`, `test/ai-release-evidence.test.mjs`, `evidence/rehearsal-report.json`, `release-report.json` |

Every AI-derived exchange write — entry, AI-proposed exit, stop-check
auto-close, unattended entry — leaves `bot.mjs` through
`src/telegram/ai-effect-gateway.mjs`. That module owns the whole lifecycle:
provenance (a generation-bound sidecar on the preview ticket or exit proposal),
a counted work token acquired synchronously before the first await, the plan's
preparation (instrument metadata, leverage, spot-quantity normalisation, the
drift decision, the position a close uses) under that token, a control read
immediately before the write, and settle / retain / re-arm on the outcome.
Preparation runs in legacy mode too, so the exchange side effects of a plan are
the same with and without the control plane.
Deterministic protection (trailing stops, harvest, time-stop, the operator's
`/orders` close) never touches it and keeps running in every phase.

Legacy behaviour is the default. With `AI_RUNTIME_MODE` unset or `legacy`, no new
code path executes: `loadAIRuntimeConfig` returns `{mode:'legacy'}` before
touching any other variable, `bot.mjs` keeps its previous `createDeepSeekChat`
lazily, and `src/index.mjs` still makes no provider call.

## Supported topology (a constraint, not a verified fact)

One host, one kernel, one local control directory mounted into every
participant, atomic same-filesystem `rename`, exclusive `mkdir`, durable
file and directory `fsync`. No NFS/SMB/object store, no replicated-file
synchronisation, no multi-host deployment. A multi-host inventory **fails the
topology gate** rather than silently selecting another architecture.

`docs/architecture/unified-ai/evidence/topology-evidence.md` records that this
has **not** been verified by an operator, which is why G4 is `NOT_RUN`.

## Reproduce the evidence

Every number in `release-report.json` comes from a file in this dossier. The
logs live in `evidence/logs/` and the report records their SHA-256 in
`evidenceHashes`, so the chain is checkable with one command.

```bash
D=docs/architecture/unified-ai
git worktree add --detach /tmp/uai-baseline f0e8cfc
(cd /tmp/uai-baseline && ln -s "$PWD/node_modules" node_modules 2>/dev/null; npm test > "$OLDPWD/$D/evidence/logs/baseline-suite.log" 2>&1)

npm test > "$D/evidence/logs/candidate-suite.log" 2>&1
node --test test/ai-cross-process-identity.test.mjs > "$D/evidence/logs/xp-cross-process.log" 2>&1
node --test test/telegram-trading-parity.test.mjs  > "$D/evidence/logs/parity.log" 2>&1

node scripts/ai_release_verify.mjs \
  --control-dir "$PWD/$D/evidence/control" \
  --descriptor-sha 210460420fcf69bf1efa0a66ce2b89f3a6572c5427553614d9a51abe4af57f6a \
  --candidate-log "$D/evidence/logs/candidate-suite.log" \
  --baseline-log  "$D/evidence/logs/baseline-suite.log" \
  --baseline-commit f0e8cfcfc7b7256ff87d326495a77e76f1af9b52 \
  --xp-log        "$D/evidence/logs/xp-cross-process.log" \
  --parity-log    "$D/evidence/logs/parity.log" \
  --rehearsal-report "$D/evidence/rehearsal-report.json" \
  --topology-evidence "$D/evidence/topology-evidence.md" \
  --out "$D/release-report.json"

# The release gate: re-hash every referenced file of the committed report.
node scripts/ai_release_verify.mjs --check "$D/release-report.json"
```

Notes on the recipe:

- `--candidate-log` and `--baseline-log` must be two different files; the
  verifier refuses the same file for both. G1 is computed from the baseline run
  at `f0e8cfc` (570/574 pass, the three documented stale prompt-layout failures)
  **and** requires the candidate run to have no failure outside that documented
  set.
- `identityReady` for each committed participant is produced by running
  `scripts/ai_participant_probe.mjs` in its own process at report time. It writes
  nothing and loads no key; it proves the identity/membership contract holds,
  not that the process is alive.
- G5 reads `evidence/rehearsal-report.json` (a real fake-effects forward
  activation plus rollback on a durable store) together with XP-09/XP-10/XP-17.
  The report also carries `financialState`: the synthetic fixture journal before
  and after the transition, the two fixture-declared deterministic actions (each
  applied inside a barrier's PREPARING phase, since deterministic protection is
  not paused by a transition), the residual hashes (which must be equal) and the
  duplicate-entry check (which must be empty). That half is proven on the fixture
  only; live financial-state equivalence stays a G7/operator obligation
  (`limitations.md` #20).
- A rollback starts with `node scripts/ai_release.mjs rollback` — a thin
  composite that requires an already staged descriptor and an explicit
  transition id and opens the same barrier at `highWaterGeneration + 1`; the
  following columns are identical to a forward release
  (`release-runbook.md` §8).
- `--check` is the gate a reviewer or publisher runs: it fails on a missing
  file, a changed file, an unhashable `PASS` row, or a ref that is not in the
  evidence index. `evidence/evidence-index.json` is hash-pinned in the same
  index, so the synthetic-artifact disclosure cannot be edited unnoticed.

The rehearsal itself is reproducible from the same dossier files:

```bash
rm -rf "$D/evidence/control"
node scripts/ai_release_rehearsal.mjs \
  --control-dir "$D/evidence/control" \
  --manifest "$D/evidence/manifest.json" \
  --profile  "$D/evidence/profile.json" \
  --descriptor "$D/evidence/descriptor.json" \
  --report   "$D/evidence/rehearsal-report.json"
```

It refuses to run into an existing control store, drives the forward activation
with `quiesce` and the rollback with the real `rollback` verb, and writes the
journal evidence (`financialState`) into the report.

The rehearsal control directory is synthetic evidence: its artifact digests are
digests of fixture strings (`evidence/evidence-index.json` says so), its
acknowledgements come from `scripts/ai_release_rehearsal.mjs`, and no provider,
exchange, Telegram or account call is reachable from the tooling.

## Current conclusion

`release-report.json` is generated, not written by hand. On this exact tree it
reports `OFFLINE_CONFORMANT` with G1–G3 and G5 `PASS`, G4/G6/G7 `NOT_RUN`, and
the blockers listed in the report. `ACTIVATION_VERIFIED` is unreachable offline
by construction. `node scripts/ai_release_verify.mjs --check
docs/architecture/unified-ai/release-report.json` re-hashes every referenced file
and currently reports `ok: true` with no evidence problems.

## What this dossier does not contain

- No deployment, unit file, container or process-manager command.
- No production inventory, asset balance, credential or account identifier.
- No claim about model quality, suitability or profitability.
- No financial-risk disposition: the v1.0 gates (C1–C5, C8–C9) are inherited
  unchanged and remain open.
