# AI pipeline readiness for PAPER trading

Status: assessment complete, **AI decisions are NOT wired into PAPER and were
NOT exercised**. This document records what was verified, what was refused, and
what has to be true before the six-operation AI pipeline may supply decisions to
a PAPER session.

Scope reminder: this task was allowed to *assess* the AI pipeline only. It was
not allowed to activate Skill v2 production dispatch, to call paid model
inference, or to expand the architecture. Nothing below was changed to make the
assessment pass.

## 1. What was actually exercised

| Decision source | Exercised in this task | Evidence |
| --- | --- | --- |
| Deterministic strategy (`deterministic-ma-crossover`) | **yes** | `scripts/paper_smoke_run.mjs`, `test/paper-session-validation.test.mjs` |
| Deterministic Risk Engine gate | **yes** | smoke run + `test/paper-session-validation.test.mjs` |
| AI `ANALYZE` (core) | no — identity observation only | `src/index.mjs` calls `observeCoreIdentity()`, which performs no inference |
| AI `SCOUT` / `GUARD` / `MONITOR` / `STOPCHECK` / `REFLECT` (Telegram) | no | requires `TELEGRAM_BOT_TOKEN`, a paid model key and a live Telegram bot; not started |
| Skill v2 production dispatch | no — deliberately refused, see §4 | `src/ai/skills/production.mjs` |

No paid model inference was performed. No model credential was read.

## 2. Where the six operations live

`src/ai/operation-profiles.mjs` is the reviewed registry of the six operations
and their role split:

- `core-analysis` → `ANALYZE`
- `telegram` → `SCOUT`, `GUARD`, `MONITOR`, `STOPCHECK`, `REFLECT`

Implementation and consumers:

| Operation | Produces | Consumer today |
| --- | --- | --- |
| `ANALYZE` | validated `AIAnalysis` (`src/ai/interface.mjs`) | advisory only; `AIAnalysis` never sizes and never places an order — the Risk Engine remains the only gate |
| `SCOUT` | trade ideas (`src/telegram/ideas.mjs`, probes in `deepseek-client.mjs`) | Telegram bot pipeline |
| `GUARD` | APPROVED / REJECTED verdict (`src/telegram/risk-filter.mjs`) | Telegram bot; hard numeric rules are enforced in code *before* the model |
| `MONITOR` | HOLD / EXIT / TRAIL (`src/telegram/monitor.mjs`) | Telegram bot; an EXIT dispatches `placeMarketOrder` (mainnet) |
| `STOPCHECK` | CLOSE / HOLD (`src/telegram/stopcheck.mjs`) | Telegram bot; `AUTO_CLOSE` dispatches `placeMarketOrder` (mainnet) |
| `REFLECT` | informational lessons (`src/telegram/reflect.mjs`) | journal / next prompts |

The safety-relevant claim about `ANALYZE` is structural and holds: an AI output
cannot widen a risk limit, cannot size a position and cannot execute. That is
what makes an AI decision *admissible* in principle.

## 3. Answer: can the AI pipeline supply decisions to PAPER today?

**No.** Not because the decisions are wrong, but because there is no path from
those decisions to a PAPER session, and two of the paths that do exist would be
actively misleading in paper form.

Evidence (all verified by reading the code, not by assumption):

1. **No PAPER consumer exists in the Telegram pipeline.** `grep` for
   `createPaperSession`/`paper-session` in `src/` resolves only to
   `src/index.mjs`, `src/session/*` and `scripts/*`. No module under
   `src/telegram/` imports the paper session.
2. **The AI-driven order path is mainnet, not paper.** `src/telegram/bot.mjs`
   imports `execute.mjs`, which `POST`s to `https://api.bybit.com/v5/order/create`
   (`src/telegram/execute.mjs:121`, `:171`, `:286`, `:374`). AI-derived
   dispatches are funnelled through `src/telegram/ai-effect-gateway.mjs`, whose
   terminal effect is that same executor. There is no adapter that turns a
   Scout/Guard/Monitor/Stopcheck decision into a `PaperSession.submit()` call.
3. **Paid inference is required.** The scout/guard caller
   (`src/telegram/deepseek-client.mjs`) targets `api.deepseek.com` and
   `api.moonshot.cn` and needs a provider key; the bot refuses to start without
   `TELEGRAM_BOT_TOKEN`. Running the real pipeline means paid inference and a
   live bot process, both outside this task's constraints.
4. **The AI gate is only as good as the account snapshot it is handed.** See
   blocker **B2** in §5 — the Telegram sizing path fabricates a flat account.
5. **The AI stop logic currently mis-reads profit as loss.** See blocker **B1**
   in §5.

## 4. Skill v2 production dispatch: refused, by design

`src/ai/skills/production.mjs` admits a v2 dispatch only for a
`schemaVersion: 2` joint binding whose four digests (skill registry, model
registry, execution plan, runtime policy) reproduce from the immutable CAS. A
mismatch yields a *refusing* composition that answers every operation with the
exact `ACTIVATION_PAUSED` envelope, zero model calls and zero effects. A
v2-bound generation cannot be executed by a legacy-configured process, and a
legacy generation is refused in v2 mode.

Consequence for this task: v2 dispatch stays refused and was not activated. The
deterministic strategy path is what produced the smoke-run trades.

## 5. Remaining blockers for continuous AI paper trading

Ordered by what has to happen first. **B1 and B2 are recorded in
`TELEGRAM_EXECUTION_BLOCKERS.md` and were deliberately not fixed here.**

| ID | Blocker | Evidence | Why it blocks AI paper trading |
| --- | --- | --- | --- |
| B1 | `STOPCHECK` gate treats an absolute PnL as a loss | `src/telegram/bot.mjs:2034-2036` (`Math.abs(pnlUsd)` feeds `lossPct`) | a profitable position that is trend-against can be sent through the stopcheck path and auto-closed; any AI exit logic ported to paper would inherit the wrong verdict |
| B2 | The risk snapshot handed to the deterministic gate is incomplete | `src/telegram/size.mjs:50-57` (empty `openPositions`/`openOrders`, `dailyRealizedPnlUsd: 0`, `peakEquityUsd = equity`, `tradesToday: 0`) | the "deterministic gate" in the AI path is blind to existing exposure, daily loss, drawdown peak and trade count — the guarantee that makes AI output admissible does not actually hold on that path |
| B3 | No AI → PAPER bridge | §3.1, §3.2 | the six operations have no consumer in the paper session; wiring one is new code, explicitly out of scope for this task |
| B4 | Prompt/parser contract is unverified at HEAD | 3 failing tests: `telegram-guard.test.mjs` `G-5`, `telegram-ideas.test.mjs` `S-5`, `telegram-monitor.test.mjs` `buildMonitorPrompt/buildStopcheckPrompt versions and payload keys` | parsing a model answer against a prompt whose contract test is red cannot be trusted for unattended decisions. These failures pre-date this task and were not weakened |
| B5 | PAPER session applies no market-data staleness gate | characterization test in `test/paper-session-validation.test.mjs`; the mechanism exists in `src/market-data/market-state-cache.mjs` (`isStale`) | a continuous loop that hands the session a stale snapshot will trade on it; the loop, not the session, must gate on `snapshot.timestamp` |
| B6 | Runtime kill switch is memory-only | characterization test in `test/paper-session-validation.test.mjs` | a restart silently clears an operator stop, so an unattended run cannot be stopped durably |
| B7 | No continuous loop / scheduler exists | `src/index.mjs` performs exactly one snapshot + mark pass, then exits | "continuously observable PAPER trading" needs a supervised loop that feeds snapshots; none exists in the repo |
| B8 | Cost control for real inference is unproven | `src/telegram/deepseek-client.mjs`, `src/ai/operation-profiles.mjs` | a continuous AI loop needs an explicit per-hour call and spend ceiling; there is no measured budget |
| B9 | Skill v2 dispatch is refused without a v2 joint binding | `src/ai/skills/production.mjs` | packaged-Skill execution is off until a release plan is bound; this is the intended state, not a bug |

## 6. Conditions to enable AI-driven PAPER trading (recommended order)

1. Fix **B1** (loss sign) and **B2** (real account snapshot) — both are small,
   self-contained, and each one individually makes the AI path unsafe.
2. Repair or re-baseline the prompt contract (**B4**) so the parser is verified
   against the prompt actually sent.
3. Add a `PaperDecisionSink` adapter — an interface that accepts a validated
   decision and calls `PaperSession.submit()` — and route the six operations
   through it instead of `execute.mjs`. Keep the deterministic Risk Engine as the
   only gate, exactly as the smoke run does today.
4. Add the staleness gate and a durable kill-switch record in the loop (**B5**,
   **B6**), then the loop itself (**B7**) with a heartbeat and a spend ceiling
   (**B8**).
5. Only then consider v2 dispatch (**B9**), after a release plan is bound.

Until steps 1–4 are done, PAPER trading is "deterministic strategy + deterministic
gate" and is honestly observable. It is not "AI paper trading".

## 7. Update — Codex subscription provider and the PAPER bridge

A follow-up task added a Codex provider (the owner's ChatGPT/Codex subscription,
no API key) and the PAPER bridge this document asked for. Full evidence and the
residual risks live in [CODEX_INTEGRATION.md](CODEX_INTEGRATION.md); the effect on
the blockers above is:

| ID | Status after the Codex integration |
| --- | --- |
| B3 | **implemented, not yet driven by a loop** — `src/ai/paper-decision-sink.mjs` forwards a validated `AIAnalysis` to `PaperSession.submit()`; the Risk Engine remains the only gate |
| B5 | **closed for the AI path** — the sink refuses a snapshot older than `stalenessMs`; the PAPER session itself still has no gate |
| B8 | **bounded** — measured ≈ 15.9 k input tokens and ≈ 10 s per call, single in-flight call, hourly call budget; the cost is a subscription allowance, not metered billing |

B1, B2, B4, B6, B7 and B9 are unchanged. AI dispatch is still disabled by default
(`AI_CODEX_ENABLED=false`), and the Telegram live path was not modified.
