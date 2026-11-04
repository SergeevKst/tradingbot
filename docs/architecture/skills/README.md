# Skill-Based AI Operations (v2.0)

Implementation of `skill-based-tradingbot-v2.0-architecture-v1.1.md` (task
`t_2d31634f`, APPROVED). This document is the operator-facing companion: what
exists, how to validate and publish a package, how refusals behave, and which
parts are deliberately not implemented yet.

Implementation task: `t_70ac0875`. Nothing here activates production AI: a v2
generation still requires the existing release barrier, G4/G6/G7 evidence and an
operator-signed activation approval.

## 1. What exists

| Area | Code | Tests |
|---|---|---|
| Package format, strict validators, content-addressed digest | `src/config/skill-package.mjs` | `test/skill-package.test.mjs` |
| Publication contracts: attestation, revocation, trust roots, runtime policy, execution plan, binding v2 | `src/config/skill-release-contracts.mjs` | `test/skill-binding-v2.test.mjs` |
| Immutable CAS (read-only runtime role + offline publisher) | `src/ai/skills/package-store.mjs` | `test/skill-store.test.mjs` |
| Resolver (digest + approval + policy + contract compatibility) | `src/ai/skills/resolver.mjs` | `test/skill-structural-refusal.test.mjs` |
| Execution plan builder (six skill/model pairs, capability evidence) | `src/ai/skills/execution-plan.mjs` | `test/skill-binding-v2.test.mjs` |
| Bounded data-only runtime, admission latch, workflow taint | `src/ai/skills/runtime.mjs` | `test/skill-runtime.test.mjs` |
| Declarative renderer | `src/ai/skills/renderer.mjs` | `test/skill-runtime.test.mjs` |
| Bounded JSON Schema compilation (Ajv 8.17.1, closed subset) | `src/ai/skills/schema-validator.mjs` | `test/skill-package.test.mjs` |
| Data capability broker | `src/ai/skills/data-broker.mjs` | `test/skill-runtime.test.mjs` |
| Transport (injected + OpenAI-compatible) | `src/ai/skills/transport.mjs` | `test/skill-runtime.test.mjs` |
| Six operation adapters | `src/ai/skills/adapters/*.mjs` | `test/skill-runtime.test.mjs`, `test/skill-integration.test.mjs` |
| Public operation boundary | `src/ai/skills/composition.mjs` | `test/skill-structural-refusal.test.mjs` |
| Production dispatch (v2 binding -> verified CAS -> runtime) | `src/ai/skills/production.mjs` | `test/skill-production-wiring.test.mjs` |
| Core ANALYZE + Telegram participant wiring | `src/ai/core-ai-composition.mjs`, `src/telegram/ai-composition.mjs` | `test/skill-production-wiring.test.mjs` |
| Migration and rollback rules | `src/ai/skills/migration.mjs` | `test/skill-binding-v2.test.mjs` |
| Six data packages | `skills/<packageId>/1.0.0/` | `test/skill-integration.test.mjs` |
| Offline administration | `scripts/skill_package.mjs`, `scripts/skill_compare.mjs` | CLI smoke in review |

## 2. Package format

A package is a directory of data files. It never contains code.

```
skills/<packageId>/<version>/
  skill.json            closed manifest
  instructions.md       literal UTF-8 system message (no BOM, LF only)
  input.schema.json     JSON Schema 2020-12, bounded subset, closed objects
  output.schema.json    JSON Schema 2020-12, bounded subset, closed objects
  policy.json           capability subset, limits, no tools, no effects
  prompt-layout.json    1..8 { label, valuePointer } parts
  examples/*.json       { input, expectedOutput } pairs
  tests/*.json          declarative acceptance cases (never scripts)
```

Identity is `(packageId, version)` -> `packageDigestSha256`, where the digest is
SHA-256 over the JCS canonical form of
`{format:"skill-package-v1", files:[{path,size,sha256}, ...]}` sorted by path.
The digest covers examples and tests, so a test-only edit requires a new version.
`skill.json` never contains its own digest.

Validation highlights:

- Paths are relative POSIX, lower-case ASCII, allow-listed extensions; symlinks,
  hardlinks, executable bits, hidden files, case collisions and unlisted extras
  are refused.
- Only the reviewed schema subset is accepted (`type`, `properties`, `required`,
  `additionalProperties:false`, `items`, `enum`, `const`, length/number bounds,
  local `$defs`/`$ref`, non-recursive `anyOf`). `pattern`, `format`, recursion,
  remote `$ref` and custom keywords are rejected.
- Every object branch must be closed; the validator never coerces, defaults or
  removes properties.
- Every layout pointer must resolve to a property path present in
  `input.schema.json`; a layout that cannot render for schema-valid input is
  `SKILL_RENDER_INVALID`.

## 3. Admission and failure behaviour

Two families exist and are never conflated:

- **Structural** (`SKILL_MISSING`, `SKILL_REGISTRY_INVALID`,
  `SKILL_INTEGRITY_MISMATCH`, `SKILL_NOT_APPROVED`, `SKILL_REVOKED`,
  `SKILL_INCOMPATIBLE`, `SKILL_DEPENDENCY_UNSUPPORTED`,
  `SKILL_EXECUTABLE_FORBIDDEN`, `SKILL_SCHEMA_INVALID`, `SKILL_RENDER_INVALID`,
  `SKILL_CAPABILITY_MISMATCH`, `SKILL_POLICY_DENIED`) — the public operation code
  is always `ACTIVATION_PAUSED`, the cause stays in safe diagnostic metadata,
  participant-local admission latches closed for the active generation, the
  joined workflow is tainted and every unconsumed approval/effect handle is
  invalidated. Zero model calls, zero effects, no durable control-store write.
- **Ordinary** (`SKILL_INPUT_INVALID`, `SKILL_DATA_STALE`,
  `SKILL_OUTPUT_INVALID`, `SKILL_TOOL_DENIED`, `SKILL_RESOURCE_EXCEEDED`,
  `SKILL_TIMEOUT`, `SKILL_PROVIDER_ERROR`) — a per-request failure that taints
  only its own workflow and never latches a healthy participant.

The latch cannot be cleared by a retry, a file replacement, an environment
change or a same-generation restart. Clearing it fleet-wide requires the
authorized higher-generation transition; rollback to old content also needs a
new, higher generation.

## 4. Production dispatch

`AI_SKILL_MODE` selects the reviewed dispatch path for the two production
participants (core ANALYZE and the Telegram participant). It is a reviewed
configuration value, never inferred from a missing registry, a directory scan or
the environment of a running process.

| `AI_SKILL_MODE` | Control record | Behaviour |
|---|---|---|
| `legacy` (default) | v1 | The pre-Skill prompt/completion dispatch. This is the explicitly authorized migration compatibility mode (architecture §10 Phase C). |
| `legacy` | v2 | Refused: every operation answers `ACTIVATION_PAUSED` with cause `SKILL_INCOMPATIBLE`. |
| `v2` | v2 | Every operation dispatches through its approved package and bound model identity. |
| `v2` | v1 / empty | Refused: every operation answers `ACTIVATION_PAUSED` with cause `SKILL_REGISTRY_INVALID`. |

`AI_SKILL_MODE=v2` also requires `AI_RUNTIME_MODE=single`: without a manifest
identity there is nothing to bind a package to, so `loadAIRuntimeConfig` refuses
the launch (`CONFIGURATION_ERROR`) instead of silently keeping the hard-coded
prompts.

In `v2` mode:

1. The admitted generation's schemaVersion 2 binding supplies
   `skillRegistrySha256`, `modelRegistrySha256`, `executionPlanSha256` and
   `runtimePolicySha256`.
2. `src/ai/skills/production.mjs` reads each document from the immutable CAS,
   re-derives the plan and requires `composition.planSha256` to equal the bound
   `executionPlanSha256`. A plan that does not reproduce the approved digest is
   refused (`SKILL_INTEGRITY_MISMATCH`, or `SKILL_MISSING` when the plan bytes
   were never published).
3. Each operation is rendered from its package instructions/layout and sent to
   its own resolved model identity with the reviewed settings. The legacy chat
   facade, the hard-coded prompts and `_completeGuard(prompt)` are not used:
   those entry points throw `CONFIGURATION_ERROR` in v2 mode.
4. Provider credentials are selected by resolved provider identity
   (`createProviderCredentialResolver`) and injected only inside the transport; a
   key is never reused across origins. Because the provider comes from the bound
   model registry, a provider credential is not a competing identity: a
   DeepSeek + Kimi deployment starts with `AI_API_KEY`/`DEEPSEEK_API_KEY` for
   DeepSeek and `KIMI_API_KEY` for Kimi. Under `legacy` dispatch the same
   `KIMI_API_KEY` still selects the Kimi endpoint for REFLECT, so it remains a
   refused identity variable there. Provider/model/endpoint variables
   (`AI_PROVIDER`, `AI_MODEL`, `AI_BASE_URL`, `SCOUT_*`, `GUARD_*`,
   `AI_GUARD_MODEL`, `AI_REFLECT_MODEL`, `SCOUT_API_KEY`, `GUARD_API_KEY`) are
   refused in both modes.

The Telegram composition exposes typed `monitor(input)` / `stopcheck(input)`
methods for this path and keeps `generateIdeas` / `filterIdea` as structured
wrappers. `getChatClient().operationMode` tells a trusted caller which mode the
client implements, so a call site never has to guess.

## 5. Operating the offline tooling

```bash
# validate one package (structural + schema + examples + acceptance DSL)
node scripts/skill_package.mjs validate skills/trading.reflect/1.0.0

# inspect digest, index, policy and contracts
node scripts/skill_package.mjs inspect skills/trading.reflect/1.0.0

# compare an approved baseline with a candidate (deterministic JSON report)
node scripts/skill_compare.mjs skills/trading.reflect/1.0.0 path/to/candidate

# publish verified bytes with a signed approval (administrative; never activates)
node scripts/skill_package.mjs publish <dir> --store <controlDir> \
  --attestation approval.json --trust-roots trust-roots.json
```

`validate`/`inspect` need no keys and no network. `publish` writes only into
`skill-packages/<digest>/`, `skill-attestations/<digest>.json` and the
requested immutable registry document; it never writes `control.json`.

Store layout inside a control directory:

```
skill-packages/<digest>/payload/...        immutable package bytes
skill-packages/<digest>/package-index.json digest-committed file index
skill-registries/<digest>.json             six-operation mapping
model-registries/<digest>.json             routed Model Registry
execution-plans/<digest>.json              verified six skill/model pairs
runtime-policies/<digest>.json             host grants, limits, evidence
capability-evidence/<digest>.json          reviewed model/adapter evidence
skill-attestations/<digest>.json           signed publication approval
skill-revocations/<digest>.json            signed revocation events
```

## 6. Release identity

`BindingV2` keeps the five v1 fields for lineage and adds
`modelRegistrySha256`, `skillRegistrySha256`, `executionPlanSha256`,
`runtimePolicySha256`, with `bindingSha256` hashing the body (never itself).
Changing either a skill package or a model route produces a new plan, a new
binding and therefore a new generation. A v1 and a v2 binding are never
considered equal, so a mixed participant set cannot arm.

Release descriptor v2 adds `skillApprovalRefs` (six package digest -> attestation
digest pairs) and `planApprovalRef`; both are inside the descriptor digest.

## 7. Migration and rollback

- A v1 control record may be converted **only** while `PAUSED` or `QUIESCING`.
  The result is a validated v2 `PAUSED` record with no active or target binding,
  preserved deployment, monotonic generation high-water mark, inventory and the
  prior descriptor digest as audit evidence. Conversion performs no inference.
- The authorized writer is `controlStore.migrateRecord({ record, expectedRevision,
  operatorApprovalId })`. It is the only path that changes `control.json`
  schemaVersion: it validates the converted record, refuses any other phase or
  schema, keeps the exact pre-migration bytes under `migrations/` as a forensic
  backup, audits the transition and never copies the backup back over a running
  store.
- Runtime mode is never inferred from the environment: `v2` requires a
  schemaVersion 2 control record, `legacy` refuses one. A v2 descriptor cannot be
  staged into a v1 record and a v1 descriptor cannot be staged into a v2 record,
  so mixed-version activation is rejected at the release barrier.
- Rollback targets a previously approved complete v2 pair at a strictly higher
  generation. Revoked or missing packages cannot be restored, and there is no
  online rollback to a v1-only binary.

## 8. Model routing prerequisites (SKILL-01)

The verified v1.2 integration gaps are closed in this branch:

1. `core-ai-composition.mjs` no longer freezes a resolution object and then
   assigns to it; the resolved provider input is built once and frozen, and an
   unresolvable ANALYZE route refuses instead of falling back to the manifest.
2. `telegram/ai-composition.mjs` declares its per-operation resolution cache
   before rebuilding it (the previous assignment ran in the temporal dead zone,
   so routing was silently disabled).
3. MONITOR and STOPCHECK dispatch through `_completeOperation` with their own
   resolved provider, endpoint, model and settings; REFLECT uses the reflect
   model's origin.
4. `createTelegramAICompositionFromEnv` supplies the registry: explicitly, or by
   reading the model registry that the committed generation binds.
5. The `api.moonshot.ai` host no longer silently rewrites the reviewed
   temperature; a profile that the host cannot honour is rejected.

## 9. Known limitations (not production activation)

- Production activation is out of scope: there is no operator-signed v2
  activation, no live deployment and no live model call in this branch.
- The release tooling (`scripts/ai_release_*.mjs`) still emits v1 descriptors and
  bindings. A v2 generation requires (a) the execution plan and runtime policy to
  be published into the CAS (`store.publishExecutionPlan`,
  `store.publishRuntimePolicy`), and (b) a schemaVersion 2 release descriptor with
  the six `skillApprovalRefs` and `planApprovalRef`. `scripts/skill_package.mjs`
  publishes packages and registries only, so assembling a signed v2 candidate
  descriptor is still a release-engineering step, not a CLI verb.
- The v2 adapters are intentionally stricter than the legacy prompts on missing
  market data: ANALYZE requires a non-empty chronological candle series and
  MONITOR/STOPCHECK require a complete precomputed trend block. A host snapshot
  that lacks them is `SKILL_INPUT_INVALID` (operation skipped, no model call, no
  effect) where the legacy prompt would have rendered `null`. These rejections
  are per-request and never latch the participant.
- ACK, observer receipts and participant target grants keep the schemaVersion 1
  body in this branch; they compare bindings through
  `bindingComparisonFields`, so a v2 binding is compared field-by-field, but a
  dedicated v2 ACK body carrying `executionPlanSha256` inline is still pending.
- The six packages carry the current verified operation wording. A formal
  `skill_compare` dossier against a frozen baseline, per §9.2, still has to be
  produced for each package before activation.
- Capability evidence documents under `capability-evidence/` are reviewed,
  hash-pinned fixtures. They must be replaced with real, vendor-revision-specific
  attestations before production activation.
- Package signing keys, trust-root provisioning and rotation remain operator
  responsibilities; the offline tooling accepts whatever trust roots it is given.
