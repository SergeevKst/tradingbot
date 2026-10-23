# Release / rollback runbook (UAI-09)

Everything below is operator-driven. The tooling deliberately has **no**
implicit activation, no "latest descriptor" selection, no automatic lock
takeover and no timeout-based fencing.

`CONNECT` is the absolute control directory (`AI_CONTROL_DIR`). All verbs are in
`scripts/ai_release.mjs` and print one line of redacted JSON; a nonzero exit
means the transition did not happen.

## 0. Preconditions (all must be true)

1. One host, one local POSIX filesystem, `rename` within the control directory
   is atomic, `mkdir` is exclusive, `fsync` on files **and directories** works.
2. Every AI-capable process is enumerated in the inventory with a unique slot
   and its assigned artifact digest; there is no bypass factory.
3. The approved manifest, capability profile and release descriptor exist as
   files; their digests are recorded by the operator.
4. Deterministic protection (trailing, harvest, time-stop, operator close/cancel)
   is running and does not depend on AI.
5. The operator accepts that a transition pauses AI, invalidates pending AI
   approvals and may skip one cycle.
6. No participant reports an unresolved AI-derived effect. A process that hit an
   unknown exchange outcome keeps its counted scope open and **cannot**
   acknowledge quiescence (`WORK_OUTSTANDING`). Resolve it first: check the
   position/orders on the exchange, then release the token with an explicit
   reference — `reconcileUnresolved({ workId, reference })` — which writes an
   `effect.reconciled` audit line. Never retry the order because the generation
   changed.

### Restarting a participant (no automatic adoption)

An occupied slot never expires by itself. If a participant restarts with a new
instance ID while `ACTIVE`, it comes up `identityReady: false` with
`SLOT_CONFLICT` and AI stays gated for that process (deterministic protection
continues). To restore it, run a normal barrier that replaces the member:

```bash
node scripts/ai_release.mjs quiesce --control-dir "$CONNECT" \
  --descriptor descriptor.json --transition-id <uuid>
node scripts/ai_release.mjs retire --control-dir "$CONNECT" \
  --slot <slot> --instance <old instanceId> --kind QUIESCED|FENCED --evidence <ref>
node scripts/ai_release.mjs prepare --control-dir "$CONNECT"
# new instance registers its target-only slot, stages, writes PREPARED
node scripts/ai_release.mjs collect-prepared --control-dir "$CONNECT"
node scripts/ai_release.mjs observer ... && node scripts/ai_release.mjs arm ... && node scripts/ai_release.mjs activate ...
```

Use `QUIESCED` when the old process is alive and acknowledged (the ordinary
clean-restart case) and `FENCED` only with documented process-fence and
order-reconciliation references. This is the deliberate availability cost of the
protocol: a restart is an operator action, not a silent membership rewrite.

### Pre-release evidence gate

Before any transition that creates a new binding, the committed dossier must
still check out. This is the publisher gate (G1–G3, G5 plus the hash chain):

```bash
node scripts/ai_release_verify.mjs --check docs/architecture/unified-ai/release-report.json
```

The command exits nonzero and lists the offending refs when a referenced file is
missing, has changed since the report was generated, is not in `evidenceHashes`,
or when a `PASS` row carries no hashed evidence. A failing gate means the dossier
is stale: regenerate it (see the dossier README) rather than editing the JSON.

## 1. Initialise a deployment (once)

```bash
node scripts/ai_release.mjs initialize --control-dir "$CONNECT" --inventory inventory.json
```

Prints `deploymentId`. Store it; every participant's `AI_DEPLOYMENT_ID` must
match it. The record starts `PAUSED`, generation 0, empty roster. Initialising
over an existing (even corrupt) record is refused.

## 2. Stage the descriptor (no phase change)

```bash
node scripts/ai_release.mjs stage --control-dir "$CONNECT" --descriptor descriptor.json
```

Validates the descriptor, its binding, the referenced manifest/profile files and
the artifact set, then writes it content-addressed under `releases/`. Staging
cannot open admission.

## 3. Quiesce

```bash
node scripts/ai_release.mjs quiesce --control-dir "$CONNECT" \
  --descriptor descriptor.json --transition-id <uuid>
```

Reserves `highWaterGeneration + 1`, snapshots the old roster, publishes
`QUIESCING`. Each participant closes admission on its next control read and
drains whole workflows; a participant writes `QUIESCED` only when its outstanding
work and pending AI approvals are both zero.

```bash
node scripts/ai_release.mjs collect-quiescence --control-dir "$CONNECT"
node scripts/ai_release.mjs inspect --control-dir "$CONNECT"
```

If a process hangs or dies, the barrier stays blocked. Do **not** wait for a
timeout to "resolve" it. Either keep waiting, or fence it:

```bash
node scripts/ai_release.mjs retire --control-dir "$CONNECT" \
  --slot <slot> --instance <instanceId> --kind FENCED --evidence fence.json
```

`fence.json` is the closed FENCED object: deployment, transition, slot,
instance, operator approval id, and references to the process-fence evidence and
the open-order/outcome reconciliation. Those references must be real files in the
release evidence; a hash alone is not proof.

## 4. Prepare

```bash
node scripts/ai_release.mjs prepare --control-dir "$CONNECT"
```

Only legal once every old member is `QUIESCED` or `FENCED`. Then:

- a **retained** process needs a trusted grant (only after its own QUIESCED
  evidence exists):

  ```bash
  node scripts/ai_release.mjs grant --control-dir "$CONNECT" \
    --slot <slot> --instance <instanceId> --descriptor-sha <sha>
  ```

- a **new or replacement** process starts with the target
  `AI_EXPECTED_MANIFEST_VERSION/HASH` and `AI_ARTIFACT_SHA256`, registers its
  target-only slot, stages the runtime and writes `PREPARED`. It cannot infer
  before `ACTIVE`.

```bash
node scripts/ai_release.mjs collect-prepared --control-dir "$CONNECT"
```

## 5. Observer receipt (disabled core bootstrap)

```bash
node scripts/ai_release.mjs observer --control-dir "$CONNECT" \
  --transition-id <uuid> --observer-id core-bootstrap \
  --artifact-sha <core artifact> \
  --manifest-version <target version> --manifest-sha <target sha>
```

Runs the side-effect-free validation seam in a separate process: no key, no
provider request, no slot claim. A missing required receipt blocks `arm`.

## 6. Arm and activate

```bash
node scripts/ai_release.mjs arm      --control-dir "$CONNECT"
node scripts/ai_release.mjs activate --control-dir "$CONNECT"
```

`arm` re-reads the retained evidence (acks, receipts, grants) from disk; it does
not trust arguments passed earlier. `activate` revalidates the same evidence and
performs the atomic commit: generation, binding, inventory, descriptor and
roster. Transition evidence is archived under `transitions/` **before** the
commit record is written.

## 7. Post-activation verification (G7, live operation only)

For each slot confirm, from the process's own status output, that
`generation`, `manifestVersion`, `manifestSha256` and `artifactSha256` equal the
committed record, and that `identityReady/inferenceEnabled` are true. Compare
real request metadata at the first authorized inference — do **not** force a paid
call at startup. Any mismatch: gate that participant, then pause and start a
coordinated rollback. Never switch one process locally.

## 8. Rollback

A rollback is a **new barrier** to a retained binding, with a **higher**
generation. `rollback` is a thin composite verb: it validates that the target
descriptor is already an immutable file under `releases/` (a binding this
deployment approved earlier), requires an explicit transition id, and opens the
ordinary `QUIESCING` transition at `highWaterGeneration + 1`. It does not add a
state edge, does not weaken the barrier, cannot commit a binding and never copies
a control file:

```bash
node scripts/ai_release.mjs rollback --control-dir "$CONNECT" \
  --descriptor previous-descriptor.json --transition-id <uuid>
# then, exactly as in a forward release:
#   collect-quiescence -> prepare -> grants/registration -> collect-prepared
#   -> observer -> arm -> activate
```

`quiesce` with the retained descriptor remains equivalent — `rollback` only makes
the approved CLI contract explicit and refuses a descriptor that was never staged.
Every previous token and pending approval is invalid as soon as the new barrier is
open. Copying `control.json` or decrementing a generation is not a rollback;
reusing the old digest under a higher generation is, reusing the old generation is
not. A retained transition that is already in progress is continued with
`recover`, not restarted with `rollback`.


## 9. Pause and recovery

```bash
node scripts/ai_release.mjs pause   --control-dir "$CONNECT" --reason "operator hold"
node scripts/ai_release.mjs recover --control-dir "$CONNECT" \
  --descriptor descriptor.json --transition-id <uuid>
```

`pause` keeps the whole transition (target roster, reservation, evidence) and
admits nothing. `recover` starts a **fresh** barrier at `highWaterGeneration + 1`,
retains the union of all old and target instances as obligations, and discards
all prior grants and acknowledgements — the retained instances must acknowledge
again under the new transition id.

## 10. Controller crash and lost store

- Writer lock held by a dead controller: `recover-lock` requires operator
  approval plus fencing and reconciliation references, and refuses while the
  owning PID is alive on this host.

  ```bash
  node scripts/ai_release.mjs recover-lock --control-dir "$CONNECT" \
    --approval-id <id> --fence-ref <ref> --reconcile-ref <ref>
  ```

- Lost disk, wrong deployment, uncertain high-water: fence every old
  participant, reconcile open positions/orders, then `initialize` a **new**
  deployment ID and use the normal first activation. Never reuse stale control
  files, never restore a financial ledger from this protocol.

## 11. Rollback to the legacy fleet

Outside the single-mode invariant and explicitly reported as `legacy`: requires
separate owner approval, the same complete quiescence/fencing of every
single-mode member, and an operator-controlled fleet restart with the tested
legacy artifact/config. No participant switches mode on its own.
