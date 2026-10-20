# ARCHITECTURE AUDIT

## Bybit Trading Bot — current state vs MASTER_SPEC.md

**Status:** Repository audit (Phase 0 / MASTER_SPEC §45–§50 deliverable)
**Audited revision:** `999c4ff` (`Remove the duplicated equity setting and guard env docs against drift`) **plus uncommitted working-tree changes** (strategy layer, kill switch — see §2.6, §2.7).
**Date:** 2026-10-01 · **Method:** static inspection of `src/`, `test/`, `scripts/`, `mcp/`, `.autopilot/`, `package.json`, `.env.example`, `graphify-out/GRAPH_REPORT.md`; `npm test` run locally.
**Scope:** documentation only. No code, `.env`, or live-trading files were modified. `.env` was never read.

This document maps what exists to what `MASTER_SPEC.md` requires. It makes no claim that a component works unless it was inspected or tested. Evidence is the file/line or the command output cited beside each claim.

**Coverage of MASTER_SPEC §49 (12 required points)** — see the mapping table in §11.

---

## 1. EXISTING ARCHITECTURE

Node.js ESM (`"type": "module"`, `.mjs`), no build step, no TypeScript. Tests use the built-in `node:test` runner. Sole runtime dependency is `bybit-official-trading-server` (an MCP server, not used by the trading core); `@modelcontextprotocol/sdk` is a dev-only dependency for the filtering proxy.

Observed decision flow (confirmed by source and `.autopilot/ARCHITECTURE.md`):

```text
CONFIG -> DOMAIN -> STRATEGY -> RISK -> EXECUTION        (core, one-directional)
              \        |          /
             MARKET   STATE   SESSION
                         |
                   paper journal / state (JSONL + JSON on disk)
```

`graphify` AST report (built from `999c4ff`): **610 nodes, 1247 edges, 31 communities**, no import cycles. Most connected nodes: `ConfigError`, `createPaperSession()`, `createPaperExecutionAdapter()`, `loadConfig()`, `risk-engine.mjs`, `strategy-interface.mjs`.

The current layout is a **subset** of the tree proposed in MASTER_SPEC §6, preserving existing structure per §6/§49:

```text
src/
├── config/    config-error, parse, trading-mode, risk, paper, env
├── domain/    side, reason-code, proposal, account-state, market-state, risk-result
├── risk/      position-sizing, risk-engine, kill-switch
├── execution/ execution-adapter, paper-execution-adapter, live-guard
├── market/    instrument-info, market-snapshot, normalize,
│              market-data-adapter, static-market-data-adapter, rest-market-data-adapter
├── state/     paper-position, paper-account, fee-model, daily-state,
│              journal, jsonl-file, state-store
├── strategy/  strategy-interface, deterministic-ma-crossover, registry   (uncommitted)
├── session/   paper-session
├── util/      logger
└── index.mjs  PAPER bootstrap
```

---

## 2. IMPLEMENTED COMPONENTS

### 2.1 Config and domain (Phase 1 — largely complete)

- `config/env.mjs` — validates at startup; `loadConfig()` reads **no** credentials and reports `credentials: { hasApiKey: false, hasApiSecret: false }` by design (`env.mjs:108`). `loadExchangeCredentials()` is separate (`env.mjs:125`) and used only by `scripts/`.
- `config/trading-mode.mjs` — `BACKTEST | PAPER | LIVE`, default `PAPER` (`trading-mode.mjs:28`); unknown or `LIVE` mode is a hard startup error (`env.mjs:84-94`).
- `config/risk.mjs` — frozen `DEFAULT_RISK_LIMITS` plus cross-field validation (`validateRiskLimits`, `risk.mjs:76`).
- `config/parse.mjs`, `config/config-error.mjs` — strict parsing, typed `ConfigError`.
- `domain/` — `SIDE`, `REASON_CODE`, `TradeProposal` (symbol, side, entryPrice, stopLossPrice, takeProfitPrice, confidence, strategyId, timestamp), account/market/risk-result schemas. Proposals are closed schemas; unknown fields are rejected.
- **Gap in Phase 1:** no `Order`, `OrderFill`, `Position`, `Balance`, `PortfolioSnapshot`, `PnLSnapshot`, `MarketTick`, `OrderBookSnapshot`, `AIAnalysis`, `StrategyDecision` **domain** types (§7). Equivalent objects exist only in `src/state/` (`PaperPosition`, `PaperAccountState`) and the strategy layer's `MarketContext` (`strategy-interface.mjs:81`).

### 2.2 Risk Engine (Phase 4 — core complete)

- `risk/position-sizing.mjs` — pure sizing and price geometry; no I/O, no clock.
- `risk/risk-engine.mjs` — deterministic arbiter enforcing **FAIL CLOSED** (`evaluateTrade` catch-all at `risk-engine.mjs:55-66`) and **CONFIDENCE INERT** (`proposal.confidence` never affects size).
- Implemented checks: kill switch (config + runtime), stop/TP presence, correct-side geometry, zero risk distance, min risk/reward, daily loss %, max drawdown, max open positions, max trades/day, per-symbol and total exposure caps, duplicate/conflicting position, stale-entry deviation vs mark (20% cap), per-trade risk budget, leverage cap, available balance, instrument min/max qty and min notional. See §16 for the Phase 4 additions.
- **Not implemented** (MASTER_SPEC §9): max spread/slippage check, cooldown, symbol/session restrictions, exchange/account state validation. Max consecutive losses is absent (daily/drawdown limits only).

### 2.3 Market data (Phase 2 — public REST + WS complete; see §14)

- `market/market-data-adapter.mjs` — port; the core never sees a Bybit SDK object.
- `market/instrument-info.mjs` — tickSize/qtyStep/min/max from the exchange, never invented; tradable-status gate.
- `market/market-snapshot.mjs`, `normalize.mjs` — normalized snapshot + candles, step/price/quantity normalization (rounding DOWN), crossed-book rejection.
- `market/static-market-data-adapter.mjs` — offline adapter for tests.
- `market/rest-market-data-adapter.mjs` — now a thin re-export of the Phase 2 adapter below (kept for compatibility).
- `adapters/bybit/` — `endpoints.mjs` (public REST paths, public WS URLs, known-host validation, topic helpers), `rest-client.mjs` (GET-only client with §22 taxonomy + §23 retry), `rest-market-data-adapter.mjs` (normalizes into `MarketTick`/`OrderBookSnapshot`/candles + `MarketSnapshot`), `websocket-client.mjs` (public ticker/orderbook/trade stream with subscribe, ping and bounded reconnect).
- `normalizers/` — pure Bybit payload → domain normalizers (ticker, orderbook snapshot + delta, trade, kline); every failure is a typed `DataError`.
- `market-data/` — `retry.mjs` (explicit bounded backoff/jitter, retryable classes only), `market-state-cache.mjs` (validated in-memory state; duplicate deltas ignored, gaps report `needsResync`), `market-data-service.mjs` (feeds the cache from REST + WS and emits observability events), `events.mjs`.
- **Still not implemented:** private REST (account/positions/orders), depth persistence beyond the in-memory cache, authenticated streams (out of scope; no credentials).

### 2.4 Paper execution and state (Phase 5 — complete for PAPER)

- `execution/execution-adapter.mjs` — port plus explicit `FORBIDDEN_EXCHANGE_OPERATIONS` (`createOrder`, `batchCreateOrders`, `amendOrder`, `cancelOrder`, `cancelAllOrders`, `setLeverage`, `setMarginMode`, `setAutoAddMargin`, `setTradingStop`, `switchPositionMode`; `execution-adapter.mjs:33-44`); `canPlaceRealOrders` must be `false` or construction fails (`execution-adapter.mjs:109-113`).
- `execution/paper-execution-adapter.mjs` — simulated fills at bid/ask (spread crossed adversely), SL/TP triggers on reference price, deterministic conservative gap resolution, entry and exit slippage, pluggable `FeeModel` and `FillModel`. Refuses a fill when the required book side is missing.
- `execution/fill-model.mjs` — pluggable, deterministic fill sizing: `createFullFillModel()` (default, fills the whole order) and `createNotionalCapFillModel({ maxNotionalPerFillUsd })` (a market taker order partially fills up to a notional cap and the remainder is cancelled, floored to `qtyStep`). A partial fill below `minOrderQty`/`minNotionalUsd` refuses the whole entry rather than opening a micro-position. `assertFillModel` fails closed on an untrusted model.
- `execution/live-guard.mjs` — `LIVE_EXECUTION_IMPLEMENTED = false` hard-coded (`live-guard.mjs:24`); `assertLiveExecutionAllowed()` always throws today. Also requires `TRADING_MODE=LIVE` plus `ALLOW_LIVE_TRADING=true` plus an explicit caller acknowledgement even if the flag were flipped (`live-guard.mjs:39-81`).
- `state/` — local PAPER account, positions with deterministic uPnL, fee model, explicit-UTC daily counters, append-only JSONL journal (`SIGNAL_RECEIVED` … `PARTIAL_FILL`/`POSITION_CLOSED`), schema-versioned state store with **fail-closed recovery** (corrupt/foreign/empty state refuses to start, never silently resets — `state-store.mjs:65-156`). Only `state/jsonl-file.mjs` writes to disk. `paper-account.mjs` also projects the ledger into the validated `PortfolioSnapshot` / `PnLSnapshot` domain types (`toPortfolioSnapshot`, `toPnLSnapshot`, §7).
- `session/paper-session.mjs` — the single orchestrator: `TradeProposal -> account/daily -> Risk Engine -> paper executor -> persist + journal`. The executor never re-litigates a risk decision. Exposes `getPortfolioSnapshot()` / `getPnLSnapshot()` and accepts an optional `fillModel`.

### 2.5 Strategy layer (Phase 3 — first strategy present, uncommitted)

New since the previous audit revision, and currently **uncommitted** in the working tree:

- `strategy/strategy-interface.mjs` — `defineStrategy()` (fail-closed contract), `assertStrategy()`, pure `sma()` / `atr()` indicators, and `buildMarketContext()` returning a frozen `MarketContext` (symbol, timeframe, instrument, snapshot, candles, timestamp, indicator values). A strategy sees no credentials, account state, or execution internals.
- `strategy/deterministic-ma-crossover.mjs` — `deterministic-ma-crossover`: LONG/SHORT on an SMA fast/slow cross of the latest candle, entry at the side-appropriate top of book, stop one ATR-multiple behind entry, target a fixed reward multiple. Deterministic; no randomness, clock, or network. Returns `null` for "no signal".
- `strategy/registry.mjs` — `createStrategyRegistry()` (fail-closed register/get/list/size; duplicate id throws; unknown id throws) and `createDefaultStrategyRegistry()` (holds the MA-crossover strategy).
- `session/paper-session.mjs:427` — `submitFromStrategy({ market, strategyId? })`: builds context, evaluates the strategy, and submits any emitted proposal through the **unchanged** risk → execution path. A strategy that throws is caught and treated as `NO_SIGNAL` (`paper-session.mjs` diff, fail-closed).
- `domain/reason-code.mjs` — added `NO_SIGNAL` and `KILL_SWITCH_ENGAGED`.
- **Not implemented / partial:** feature engine as a separate module (§6 — indicators live inside the strategy interface today); strategy parameterization from configuration (parameters are code defaults); signals/aggregator (§6); strategy decision recording as a first-class domain type; `index.mjs` and `scripts/paper_simulate.mjs` still use a fixed plumbing fixture and do **not** yet call `submitFromStrategy`.

### 2.6 Kill switch (Phase 4 — partial, uncommitted)

- `risk/kill-switch.mjs` — `isKillSwitchEngaged(limits)` returns `limits?.killSwitchEnabled !== false` (fail-closed: only an explicit `false` disengages).
- Wired into `risk/risk-engine.mjs:91-93` ahead of proposal validation, returning `REASON_CODE.KILL_SWITCH_ENGAGED`.
- `config/risk.mjs:46` — `killSwitchEnabled: false` in `DEFAULT_RISK_LIMITS`.
- **Resolved since this snapshot** (see §15–§16): `killSwitchEnabled` is boolean-validated and emitted by `loadRiskLimits`; `createKillSwitch()` is the operational runtime control; the session and the bound `createRiskEngine` both enforce it. Remaining: no env/CLI surface to engage it from outside the process (deliberate).

### 2.7 Supporting tooling (not on the trading path)

- `scripts/` — `paper_state`, `paper_reset` (needs `--confirm-reset`), `paper_simulate`, `paper_test`, `verify_bybit_key`, `test_mcp_proxy`, `list_tools`, `inspect_accounts`, `earn_to_trading` (dry-run by default).
- `mcp/tools.allow.json` + `mcp/bybit-mcp-proxy.mjs` — curated allowlist (~38 of 382 tools) over the official Bybit MCP server. The trading core never calls the proxy.
- `util/logger.mjs` — structured logs with deep secret redaction (`logger.mjs:27-84`).
- `.autopilot/` state docs and `.kilo/agents/` (`trading-supervisor`, `deepseek-developer`); `AGENTS.md`; `graphify-out/` (now gitignored).

---

## 3. BYBIT INTEGRATION STATUS

| Capability | Status | Evidence |
| --- | --- | --- |
| Public market data REST | Implemented, no credentials | `adapters/bybit/rest-market-data-adapter.mjs` |
| Authenticated REST (account/positions/orders) | Not implemented in core | `loadExchangeCredentials()` only in `scripts/` |
| WebSocket market stream (public) | Implemented, no credentials | `adapters/bybit/websocket-client.mjs`, `market-data/market-data-service.mjs` |
| Order place / amend / cancel | Not implemented; refused by port | `FORBIDDEN_EXCHANGE_OPERATIONS`, `live-guard.mjs` |
| Startup reconciliation / idempotency | Not implemented | no exchange or local-state comparison |
| Retries / rate limiting | Implemented for public market data | `market-data/retry.mjs` + `adapters/bybit/rest-client.mjs` (§23–24); retryable classes only, bounded backoff |
| Testnet switching | Config present | `BYBIT_TESTNET` → `api-testnet.bybit.com` (`env.mjs:35-38`); README notes testnet keys return `10003` |
| MCP access for the agent | Implemented | official server + filtering proxy (382→~38) |

**Observation (security, not a live-trading proposal):** the MCP allowlist exposes Bybit **write** tools to the coding agent (`createOrder`, `batchCreateOrders`, `amendOrder`, `cancelOrder`, `setLeverage`, `setTradingStop`, `setAutoAddMargin`, `switchPositionMode`, `setMarginMode` — `mcp/tools.allow.json:26-36`). The deterministic core cannot reach them, but the agent-side surface is broader than the core; this should be reviewed and, unless a task explicitly requires it, narrowed during a later hardening task.

---

## 4. RISK & SAFETY COMPLIANCE

- **Paper only — COMPLIANT.** Default mode is `PAPER`; `index.mjs` runs the paper pipeline. No exchange write call exists in `src/`.
- **No live — COMPLIANT.** `TRADING_MODE=LIVE` aborts at startup; `ALLOW_LIVE_TRADING` alone does not enable it; `LIVE_EXECUTION_IMPLEMENTED` is hard-coded `false`.
- **Deterministic risk — COMPLIANT.** No LLM, network, or clock in the decision path; same inputs give the same decision; fail-closed on every throw.
- **AI never bypasses risk — COMPLIANT BY ABSENCE.** No AI layer exists on the trading path. This must be re-enforced (§10/§36) when one is added.
- **TradeIntent separation — COMPLIANT.** A proposal cannot place an order; only the executor fills a risk-approved result. A strategy cannot bypass the gate: `submitFromStrategy` funnels through `submit`.
- **Secrets — COMPLIANT.** Core reads no credentials; credentials have one accessor used only by `scripts/`; logger and journal redact secret-shaped fields; `.env` is gitignored and was not read; `.env.example` holds placeholders.
- **Kill switch / emergency stop (§44) — COMPLIANT in-process.** A validated `killSwitchEnabled` config flag plus a runtime `createKillSwitch()` control are OR-ed inside the Risk Engine (config flag and explicit `killSwitchEngaged` input); both fail closed, and the session journals engage/release. External env/CLI engagement remains deliberately absent.
- **Config validation at startup (§19) — PARTIAL.** Core config covered; no `RuntimeConfig`/`AIConfig`, no credential validation on the core path.
- **Order state machine (§13) and reconciliation (§15) — MISSING** (no exchange orders exist to track yet).

---

## 5. TEST COVERAGE

Verified locally on 2026-10-01: `npm test` → **332 tests, 332 pass, 0 fail** (runner output).

```text
test/risk-engine.test.mjs        risk decisions, geometry, caps, determinism,
                                 confidence inertness, fail-closed
test/market-data.test.mjs        instrument metadata, snapshot/normalize, contract
test/market-data-normalizers.test.mjs  Bybit payload -> MarketTick/OrderBookSnapshot/
                                 trade/candle, crossed/unsorted/malformed refusal
test/market-data-retry.test.mjs  explicit bounded policy, retryable-only, backoff/jitter
test/market-data-cache.test.mjs  validated state, delta merge, idempotent stale,
                                 gap/resync, staleness, risk view
test/bybit-rest-adapter.test.mjs mocked REST: taxonomy mapping, retry, host check,
                                 no-auth GET contract, domain normalization
test/bybit-websocket.test.mjs    fake socket + timers: subscribe, ping, routing,
                                 reconnect backoff, attempt cap, close
test/market-data-service.test.mjs priming, ingest, gap resync, observer/journal events
test/paper-execution.test.mjs    fills, SL/TP, gaps, fees, journal, recovery
test/paper-simulation.test.mjs   fill model contract, partial fills, entry/exit
                                 slippage, portfolio/PnL domain snapshots,
                                 risk-before-execution, determinism
test/paper-state.test.mjs        account/position/fee/daily-state math
test/paper-persistence.test.mjs  state store, atomic write, reset, journal durability
test/security.test.mjs           core isolation, no write paths, no secret reads,
                                 env-var coverage, exact module inventory
test/strategy/strategy.test.mjs  registry contract, no-signal, MA-cross geometry,
                                 session end-to-end, risk-rejected proposal
```

**Well covered:** deterministic risk, sizing, market normalization, paper fills, partial fills, SL/TP ambiguity, entry/exit slippage, fee model, portfolio/PnL domain snapshots, daily counters, persistence/recovery, journal integrity, strategy contract and end-to-end PAPER run, security isolation.

**Gaps vs MASTER_SPEC §32–33:** no AI schema tests; no backtest tests; no reconciliation or duplicate-order tests; no testnet integration test; no kill-switch integration test at the session/CLI level; no property/fuzz tests; no fault injection on in-flight operations (only whole-file corruption). Public REST and WebSocket paths are now covered by tests with mocked I/O (Phase 2, §14), plus one-off live public smokes that required no credentials.

**Documentation drift:** `README.md` still states “176 tests” (`README.md:12,286`); the suite is now 182.

---

## 6. MISSING COMPONENTS (vs MASTER_SPEC §6, §45)

Absent entirely:

- `features/` — feature engine and indicators as a standalone module (§6); indicators currently live inside `strategy-interface.mjs`.
- `ai/` — `AIProvider`, context builder, versioned prompts, output schema (§10–11, §37–39).
- `signals/` — signal engine and aggregator (§6).
- `backtest/` — engine, simulator, metrics, fees/slippage modelling (§27–29).
- `exchange/bybit/` — authenticated REST, WebSocket, mapper, adapter (§12).
- Execution `order-manager`, `reconciliation`, `idempotency` (§13–15).
- `observability/` — metrics, events, audit store beyond the JSONL journal (§20–21).
- Error taxonomy (§22) — only `ConfigError`; no `ExchangeError`/`NetworkError`/`OrderError`/`RiskError`/`AIProviderError` family.
- Retry policy and rate limiting (§23–24).

Present but partial: strategy layer (§25–26 — one strategy, no config-driven parameters, no decision domain type); domain model (§7 — order/fill/portfolio/AI types absent); configuration (§19 — exchange/risk/paper exist, runtime/AI/logging partial); portfolio/PnL (§6 — paper-level aggregates only); kill switch (§44 — field exists, no operational control).

---

## 7. ARCHITECTURAL GAPS VS MASTER_SPEC

| MASTER_SPEC area | Status | Note |
| --- | --- | --- |
| §5 target pipeline | Partial | missing features → signals → AI stages; strategy stage now present |
| §7 domain model | Partial | order/fill/portfolio/AI types absent |
| §9 risk checks | Partial | spread/slippage, cooldown, session/symbol, exchange-state checks missing |
| §10–11, §36–39 AI layer | Absent | not on the path; must never bypass risk when added |
| §12 exchange adapter (auth + WS) | Absent | only public REST market data |
| §13–15 order state, idempotency, reconciliation | Absent | no exchange orders yet |
| §20–21 observability & audit | Partial | JSONL journal exists; metrics/traceability gaps |
| §22–24 errors, retries, rate limiting | Absent | adapters have no retry/throttle policy |
| §25–26 strategy architecture | Partial | interface + registry + one deterministic strategy exist; not yet wired into `index.mjs`/`paper:simulate` |
| §27–29 backtest & costs | Absent | no engine; fee model exists for paper only |
| §42–44 lifecycle, shutdown, kill switch | Partial | startup/validation yes; kill switch field only, no runtime control |
| §46 live gate | Satisfied (blocked) | live is refused by construction |

The target pipeline recorded in `.autopilot/DECISIONS.md` (`Market Data -> Context Builder -> AI Analyst -> Trade Proposal -> AI Review -> Deterministic Risk Engine -> Execution`) is **partially** present: market data, deterministic strategy, proposal, risk and execution exist; context builder and AI stages do not.

---

## 8. TECHNICAL DEBT (MASTER_SPEC §49 item 10)

1. **Uncommitted strategy/kill-switch work.** The strategy layer and kill switch are untracked/modified in the working tree at `999c4ff`. Until committed and reviewed, the audit's revision ID and the graph report are stale. *(Evidence: `git status` shows `?? src/strategy/`, `?? src/risk/kill-switch.mjs`, `?? test/strategy/`, modified `src/risk/risk-engine.mjs`, `src/session/paper-session.mjs`.)*
2. **Kill switch is not operational.** `killSwitchEnabled` cannot be set from the environment, is not boolean-validated, is undocumented in `.env.example`/README, and has no CLI/runtime toggle. Its default `false` plus the `!== false` predicate means any hand-built risk-limit object that omits the field is treated as *engaged* — safe, but surprising and untested at the session level.
3. **`process.env` ownership claim is overstated.** `config/env.mjs:4` states it is “the ONLY module allowed to read `process.env`”, but `config/risk.mjs:160` and `config/paper.mjs:88` also default their `env` parameter to `process.env`. Harmless today (all in the config layer), but the stated invariant and the code disagree.
4. **Two parallel proposal fixtures.** `index.mjs` and `scripts/paper_simulate.mjs` still build a fixed `paper-simulate-fixture` proposal instead of calling `submitFromStrategy`; the new strategy layer is exercised only by tests. This is intentional plumbing, but it means the running product does not yet use the strategy.
5. **README drift.** Test count (176 → 182) and the existence of the strategy layer/kill switch are not reflected.
6. **Single error class.** Everything throws `ConfigError`, including market-data HTTP failures and exchange API errors (`rest-market-data-adapter.mjs:70,74`). No §22 taxonomy, so callers cannot distinguish retryable from fatal.
7. **No retry/backoff/rate limiting anywhere.** The REST adapter has a timeout but no throttling; §23–24 are unmet ahead of any authenticated/streaming adapter.
8. **Indicators coupled to the strategy interface.** `sma`/`atr`/`buildMarketContext` live in `strategy-interface.mjs`; §6 anticipates a separate feature engine, and the AI context builder (§37) will want these too.
9. **Strategy parameters are hard-coded defaults.** `MA_CROSSOVER_DEFAULTS` and `DEFAULT_INDICATOR_CONFIG` are code constants, not configuration; §47 warns against hard-coded trading parameters long-term.
10. **`graphify-out/` was generated from `999c4ff`** and is now gitignored; the report predates the strategy layer, so its stats describe the committed core only.

---

## 9. WHAT TO PRESERVE / WHAT TO REFACTOR (§50 items 5–6)

**Preserve (do not rewrite):** `config/` centralized env access and startup validation; the deterministic fail-closed `risk/` engine and pure sizing; the new `strategy/` interface + registry + fail-closed `submitFromStrategy` wiring; `execution/` port + paper executor + forbidden-operations list + live guard; `market/` adapter port and normalization; `state/` fail-closed persistence, atomic write, append-only journal, UTC daily state; the `session/paper-session.mjs` orchestration shape; `test/security.test.mjs` isolation guarantees.

**Refactor / extend in place, incrementally:** commit the strategy/kill-switch work; make the strategy layer the real proposal source for `index.mjs`/`paper:simulate`; make the kill switch env/CLI-controllable, validated, documented, and tested; grow `domain/` with order/fill/portfolio types; add a real error taxonomy; add §20–21 observability fields without weakening the journal; narrow the MCP write-tool surface unless a task explicitly requires it.

---

## 10. SECURITY CONCERNS (§50 item 8)

- **Secret isolation is strong and tested** — one credential accessor, used only by `scripts/`; core never reads keys; logger redacts secret-shaped keys; `.env` gitignored. No concern found.
- **Agent-side write surface (MCP)** — the allowlist grants the coding agent Bybit write tools. The core cannot use them, but they are reachable by the agent. Recommend narrowing.
- **Kill switch not operational** — the safety control exists as a field but cannot be exercised operationally yet (§44).
- **Error messages may echo exchange text** — *(addressed in Phase 2)* the REST client now throws the stable `retCode` and never echoes `retMsg`; see §14.
- **`baseUrl` is not validated against the known-host list at adapter construction** — *(addressed in Phase 2)* `assertBybitRestBaseUrl` rejects any host that is not a known Bybit mainnet/testnet URL; see §14.

---

## 11. RECOMMENDED DEVELOPMENT ORDER (first priorities)

Ordered to reuse the existing deterministic core and keep every stage PAPER-only. No live trading is proposed at any priority; live remains forbidden per §46.

1. **Commit and review the strategy layer + kill switch (Phase 3/4).** Make the kill switch env-configurable, boolean-validated, documented in `.env.example`/README, and covered by a session-level test; commit `src/strategy/`, `src/risk/kill-switch.mjs` and tests. *Removes debt items 1–2.*
2. **Wire the strategy into the running product (Phase 3).** Use `createDefaultStrategyRegistry` / `submitFromStrategy` in `index.mjs` and `scripts/paper_simulate.mjs` so the product actually trades on a strategy rather than a fixture. *Removes debt item 4.*
3. **Feature engine (Phase 2/3).** Extract pure indicator/market-feature functions out of `strategy-interface.mjs` into a `features/` module; deterministic and unit-tested. Supplies strategies and a future AI context builder.
4. **Backtest engine + metrics (Phase 7).** Historical data → strategy → existing Risk Engine → simulated execution (model on `paper-execution-adapter`) → portfolio → metrics with fees and slippage (§27–29). Must reuse the same strategy and risk logic as PAPER.
5. **Observability, error taxonomy, retry/rate-limit policy (Phases 1/2).** Complete the §20–21 audit trail, add the §22 error classes, and give market adapters explicit §23–24 retry/backoff/throttle policies — the foundation required before any authenticated or streaming adapter.

Then: 6. **AI analysis layer (Phase 6)** — `AIProvider` interface (model-independent), context builder, versioned prompts, strict structured-output schema where invalid output yields **NO TRADE**. AI may suggest only; the deterministic Risk Engine remains the sole gate.

Deferred and gated behind the above: authenticated Bybit read-only adapter and reconciliation (Phase 9), testnet (Phase 8), and live-safety work (Phase 10) — the last forbidden until §46 is satisfied.

---

## 12. AUDIT SUMMARY

The repository is a well-tested, deterministic **PAPER** core: complete risk layer (now including a kill-switch field), public market data over REST **and** a public WebSocket feed, a hardened paper simulation (pluggable fill model with partial fills, entry/exit slippage, portfolio/PnL domain snapshots), durable audit state, and a deterministic strategy layer with a fail-closed registry and session integration — all verified by **332 passing tests** (§5, §17). It faithfully preserves the MASTER_SPEC safety principles (paper only, no live, deterministic fail-closed risk, secret isolation). The dominant gaps are the higher layers the spec anticipates — a separate feature engine, signals, backtest, AI, and authenticated/reconciling exchange I/O — plus hardening in error taxonomy, observability, retry policy, and making the kill switch operationally enforceable. The strategy/kill-switch work is currently **uncommitted**. No architectural conflict with MASTER_SPEC was found; the spec explicitly permits adapting the directory structure to the existing repository (§6).

### Coverage of MASTER_SPEC §49 (12 required points)

| §49 item | Where covered |
| --- | --- |
| 1. Current architecture | §1 |
| 2. Current files/modules | §1, §2 |
| 3. Existing Bybit integration | §3 |
| 4. Existing market-data functionality | §2.3, §3 |
| 5. Existing strategies | §2.5 |
| 6. Existing AI integration | §2.5 (none), §6 |
| 7. Current configuration | §2.1, §4 |
| 8. Current tests | §5 |
| 9. Architectural gaps | §6, §7 |
| 10. Technical debt | §8 |
| 11. Conflicts with this Master Specification | §7, §12 |
| 12. Recommended implementation sequence | §11 |

### Coverage of MASTER_SPEC §50 (10-section format)

§1 existing architecture → §1; §2 existing components → §2; §3 what works → §2, §5; §4 what is incomplete → §2, §6, §7; §5 what to preserve → §9; §6 what to refactor → §9; §7 missing components → §6; §8 security concerns → §10; §9 testing gaps → §5; §10 proposed roadmap → §11.

---

## 13. PHASE 1 UPDATE — DOMAIN FOUNDATION (2026-10-01)

**Task:** PHASE1-001. Additive Phase 1 work (MASTER_SPEC §1, §7, §19, §22, §45 Phase 1). No live, execution, strategy, backtest or AI code was added; no `.env` or credential file was read.

**New modules**

```text
src/errors/   app-error, taxonomy, index        §22 error taxonomy
src/types/    enums, primitives, index          shared, dependency-free primitives
src/domain/   order, order-fill, position, portfolio, market-tick,
              orderbook-snapshot, signal, strategy-decision,
              market-feature, ai-analysis       §7 missing domain objects
src/config/   schema                            §19 RuntimeConfig schema + validation
```

**Gaps closed from §6/§7**

- **Error taxonomy (§22) present.** `AppError` root with stable `code`, explicit `retryable` and structured `details`; eleven subclasses (`ValidationError`, `ConfigurationError`, `ExchangeError`, `NetworkError`, `AuthenticationError`, `RateLimitError`, `OrderError`, `RiskError`, `AIProviderError`, `DataError`, `ReconciliationError`). `isRetryable()` is fail-closed (unknown ⇒ not retryable). The pre-existing `ConfigError` now extends `ConfigurationError`, so it keeps its `name`/`field`/`value` shape while joining the hierarchy (backward compatible; all 182 pre-existing tests still pass).
- **Domain model (§7) extended.** Explicit, closed, validated constructors now exist for `OrderRequest`, `Order`, `OrderFill`, `Position`, `Balance`, `PortfolioSnapshot`, `PnLSnapshot`, `MarketTick`, `OrderBookSnapshot`, `TradingSignal`, `StrategyDecision`, `MarketFeature` and `AIAnalysis`. Corrupt market data is refused (crossed books, unsorted levels); `StrategyDecision` cannot be `NO_SIGNAL` with a signal or `EMIT` without one.
- **`AI` is a data contract only.** `AIAnalysis` is a closed schema with no provider, prompt, network call or dependency. It carries bias/confidence and explicitly cannot carry `quantity`/`leverage`. No AI integration was added.
- **Configuration schema (§19).** `RuntimeConfig` composes `ExchangeConfig` / `TradingConfig` / `RiskConfig` / `StrategyConfig` / `AIConfig` / `LoggingConfig`; `assertRuntimeConfig()` validates the composed object and refuses `LIVE`, invalid risk limits, unknown log levels and non-numeric strategy parameters.
- **Interfaces.** `Strategy` is now a named interface (`strategy-interface.mjs`); `RiskEngine` gained an explicit contract (`assertRiskEngine`) beside the existing `createRiskEngine`; `ExchangeAdapter` already had `assertExecutionAdapter`.

**Deliberate modelling decisions (no architecture redefinition)**

- `TradeIntent` (§8) is mapped to the existing `TradeProposal`; `quantity`/`leverage` are deliberately absent because sizing is owned by the Risk Engine and must not travel in from a strategy or AI model.
- `RiskDecision` (§7) aliases the existing `RiskResult`.

**Still deferred (unchanged by this task)**

The new types are **not yet wired into the trading path**: no order manager, reconciliation, retry/rate-limit policy (§23–24), observability fields (§20–21), strategy-parameter loading from configuration, or AI provider exists. `AIConfig.enabled` is `false` and there is no AI code path. Feature/signals/backtest/AI stages remain absent as the audit recorded.

**Verification**

`npm test` → **210 tests, 210 pass, 0 fail** (182 pre-existing + 28 new covering error codes/retryability, the `ConfigError` hierarchy, every new domain constructor, and the config schema). The security isolation suite still passes; the module inventory in `test/security.test.mjs` was updated to include the new files. None of the new modules read `process.env`, touch credentials, perform I/O, or name an exchange write endpoint.

---

## 14. PHASE 2 UPDATE — MARKET DATA (2026-10-01)

**Task:** PHASE2-001. Public market-data ingestion only. No authenticated endpoint, private stream, order path, strategy, AI, backtest or live code was added; no `.env` or credential file was read; the trading core's credentials policy is unchanged.

**New modules**

```text
src/adapters/bybit/  endpoints           public REST paths, public WS URLs, known-host
                                         validation, topic helpers
src/adapters/bybit/  rest-client         GET-only public client; §22 taxonomy; §23 retry
src/adapters/bybit/  rest-market-data-adapter   public REST -> MarketTick /
                                         OrderBookSnapshot / candles / MarketSnapshot
src/adapters/bybit/  websocket-client    public ticker/orderbook/trade stream;
                                         subscribe, ping, bounded reconnect
src/normalizers/     bybit-ticker, bybit-orderbook, bybit-trade, bybit-kline,
                     bybit-values, index  payload -> domain, typed DataError on failure
src/market-data/     retry                explicit bounded backoff/jitter, retryable-only
src/market-data/     market-state-cache   validated in-memory state; idempotent deltas;
                                         gap/staleness detection
src/market-data/     market-data-service  wires REST + WS into the cache; emits events
src/market-data/     events, index
```

**What the layer does**

- **REST (§12).** `createBybitRestMarketDataAdapter` serves `/v5/market/{instruments-info,tickers,orderbook,kline}` over `GET`. Tickers become domain `MarketTick`, orderbooks become domain `OrderBookSnapshot`, klines are validated candles, and `getSnapshot` still returns the existing `MarketSnapshot`. The legacy `market/rest-market-data-adapter.mjs` is now a re-export shim, so there is one implementation.
- **WebSocket (§12).** `createBybitPublicWebSocket` subscribes to `tickers.*`, `orderbook.<depth>.*` and `publicTrade.*`, answers Bybit's ping, and reconnects with bounded exponential backoff. The socket constructor and timers are injectable, so tests use a fake socket with no network.
- **Normalization + validation.** Every payload is normalized to a domain type through `normalizers/`; crossed books, unsorted levels, missing prices/timestamps, bad sides and unknown intervals fail closed with a typed `DataError` (preserving the domain `ValidationError` as `cause`). Nothing is defaulted or invented.
- **Market state cache.** `market-state-cache.mjs` stores validated ticks, snapshots and trades. Orderbook deltas are merged; a duplicate/stale delta is ignored idempotently, and a sequence gap, a delta with no snapshot, or a merge that would cross the book reports `needsResync` instead of corrupting state. Staleness is explicit, and `toRiskMarketState` yields the `{ markPrice, bestBid, bestAsk }` view the Risk Engine already accepts.
- **Errors, retries, rate limiting (§22–24).** `rest-client.mjs` maps transport timeouts/5xx to retryable `NetworkError`, HTTP 429 and Bybit retCodes 10006/10018 to retryable `RateLimitError`, and HTTP 4xx / malformed JSON / other retCodes to non-retryable `DataError`. `retry.mjs` implements an explicit bounded policy (attempts, exponential backoff, jitter) and replays only `isRetryable` classes. Exchange `retMsg` is no longer echoed.
- **Observability (§20–21).** The service emits `MARKET_DATA_CONNECTED/DISCONNECTED/TICK/ERROR` to an injectable observer; the append-only journal gained those four event types, so the feed is recordable without coupling market data to storage. `flush()` awaits in-flight observer writes.
- **Host validation (security).** `assertBybitRestBaseUrl` refuses any base URL that is not a known Bybit mainnet/testnet host, closing the audit's "accepts any `baseUrl`" concern.

**Deliberately out of scope (unchanged):** authenticated REST, private WebSocket, order placement/amend/cancel, strategies, AI, backtest, and live trading. The public WebSocket needs no key, so no configuration or WS key was added.

**Verification**

`npm test` → **266 tests, 266 pass, 0 fail** (210 pre-existing + 56 new for normalizers, retry, cache, REST adapter, WebSocket client and service). Security/isolation tests still pass; the module inventory in `test/security.test.mjs` was extended with the 15 new files. No new module reads `process.env`, touches credentials, writes to disk, imports a network client (`node:http`/`https`, `undici`, `axios`), or names an exchange write endpoint. Integration smoke (no credentials): a live public REST ticker for `BTCUSDT` and a live public WebSocket ticker both normalized successfully on 2026-10-01.

---

## 15. PHASE 3 UPDATE — STRATEGY LAYER + KILL SWITCH (2026-10-01)

**Task:** PHASE3-001. Make the strategy layer operational and validated, and turn the kill-switch field into a validated, runtime-controllable emergency stop (MASTER_SPEC §25–26, §44; audit roadmap items 1–2). No live path, no order placement, no backtest, no AI. No `.env` or credential file was read and no credential accessor was touched.

**No new `src/` modules.** This task changed six existing files, so the `test/security.test.mjs` module inventory is unchanged and still passes:

```text
src/risk/kill-switch.mjs          operational kill switch (createKillSwitch)
src/config/risk.mjs               killSwitchEnabled boolean validation + emitted by loadRiskLimits
src/state/journal.mjs             STRATEGY_DECISION / KILL_SWITCH_* event types
src/session/paper-session.mjs     kill-switch API, effective risk config, strategy-decision journal
scripts/paper_simulate.mjs        opt-in --strategy mode
README.md / docs/ARCHITECTURE_AUDIT.md
```

**Operational kill switch (§44).**

- **Config layer.** `killSwitchEnabled` was already in `DEFAULT_RISK_LIMITS`; it is now **boolean-validated** by `validateRiskLimits` (a non-boolean refuses to start), and `loadRiskLimits` emits the field so a loaded `RiskConfig` is always complete and validated. There is deliberately **no env var and no CLI flag yet** — the task defers those; the runtime control below is the operational path.
- **Runtime layer.** `createKillSwitch()` is an in-memory control with `engage(reason)`, `disengage()`, `isEngaged()` and `snapshot()`. It **fails closed**: `engage()` always engages, even with no reason (recorded as `UNSPECIFIED`), so a forgotten argument can never fail to stop trading. The clock is injectable, so behaviour is deterministic in tests.
- **Session.** Every `PaperSession` owns a kill switch (default disengaged). `submit` OR-s `killSwitch.isEngaged()` into the risk config, so the unchanged Risk Engine returns `KILL_SWITCH_ENGAGED` and no executor call happens. `engageKillSwitch(reason)` / `disengageKillSwitch()` are the operational controls and each appends an audit event; `killSwitchState()` reads state without changing it.
- **Two-layer gate.** Either the static config flag or the runtime switch blocks an entry; neither can widen a limit.

**Strategy layer (§25–26, §7, §20–21).**

- The uncommitted interface/registry/MA-crossover/`submitFromStrategy` work is retained and now exercised: `submitFromStrategy` builds a first-class `StrategyDecision` (with a `TradingSignal` on `EMIT`) and records a `STRATEGY_DECISION` journal event for **EMIT, NO_SIGNAL and STRATEGY_ERROR**. "No signal" is therefore auditable instead of invisible (§21).
- A strategy that throws is caught, recorded as `STRATEGY_ERROR`, and treated as `NO_SIGNAL` — fail closed. A strategy that returns a malformed proposal cannot crash the audit path; the proposal still travels through the unchanged risk gate and is rejected there.
- **Risk-owned sizing is preserved and tested.** A strategy returns prices only; `quantity`/`leverage` never appear on a proposal or signal, and the position size is produced by the Risk Engine (`test/strategy/strategy.test.mjs` asserts both).
- **`paper:simulate --strategy <id>`** runs a registered strategy over real candles through the same risk → execution path. Without the flag the fixed fixture is used (unchanged default), so the manual harness keeps working offline-friendly while the product gains a real strategy path.

**Deliberately deferred (unchanged by this task):** strategy parameters are still code defaults, not loaded from `RuntimeConfig.strategy.parameters`; the indicators remain inside `strategy-interface.mjs` (no standalone `features/` engine); there is no signals/aggregator; the kill switch has no env/CLI surface; no AI/backtest/authenticated I/O exists. The strategy/kill-switch work is still **uncommitted** at the time of writing.

**Verification.**

`npm test` → **282 tests, 282 pass, 0 fail** (266 prior + 9 kill-switch unit tests + 7 strategy tests). New coverage: config-flag fail-closed semantics; runtime engage/disengage including the reason-less engage; injected-control contract; config boolean validation; engine-level `KILL_SWITCH_ENGAGED`; deterministic repeated decisions; default registry contents; `STRATEGY_DECISION` journaling for EMIT and NO_SIGNAL; runtime and config kill switches blocking an end-to-end `submitFromStrategy` and releasing; a throwing strategy failing closed; and strategy-sourcing of prices only. Security/isolation suite unchanged and green; no new module reads `process.env`, touches credentials, performs I/O, or names an exchange write endpoint. `README.md` test count corrected from 176 to the current 282.

---

## 16. PHASE 4 UPDATE — RISK ENGINE HARDENING (2026-10-01)

**Task:** PHASE4-001. Make the Risk Engine the unbreakable gate for every trade intent: exposure controls, a maximum-drawdown limit, full kill-switch enforcement at the engine boundary, and exhaustive tests. No live path, no orders, no backtest, no AI. No `.env` or credential file was read.

**No new `src/` modules.** Seven existing files changed, so the `test/security.test.mjs` module inventory is unchanged and still passes:

```text
src/domain/reason-code.mjs        MAX_DRAWDOWN, SYMBOL_EXPOSURE_LIMIT, TOTAL_EXPOSURE_LIMIT
src/config/risk.mjs               maxDrawdownPct / maxSymbolExposurePct / maxTotalExposurePct + env + cross-field validation
src/domain/account-state.mjs      peakEquityUsd (clamped high-water mark)
src/risk/position-sizing.mjs      exposure-headroom cap on sizing
src/risk/risk-engine.mjs          drawdown + exposure gates, runtime kill-switch input, bound engine + decision sink
src/state/paper-account.mjs       high-water-mark tracking + notional projection
src/session/paper-session.mjs     passes the runtime kill switch to the engine explicitly
```

**Exposure controls (§9 "maximum position size / maximum account exposure").**

- `maxSymbolExposurePct` caps a single symbol's notional as a percent of equity; `maxTotalExposurePct` caps all open positions plus the proposed one as a percent of equity. Both are validated (`> 0`), cross-checked (`symbol <= total`), env-configurable (`RISK_MAX_SYMBOL_EXPOSURE_PCT`, `RISK_MAX_TOTAL_EXPOSURE_PCT`) and documented in `.env.example`.
- Existing exposure is summed from each open position's `notionalUsd`, falling back to `quantity * entryPrice`; a position with neither contributes zero rather than `NaN`.
- Exposure is enforced as a **sizing cap** (like the leverage and balance caps), so a position is shrunk to the remaining headroom and refused only if that leaves it below `minPositionNotionalUsd`. A symbol/account with zero headroom is refused outright with `SYMBOL_EXPOSURE_LIMIT` / `TOTAL_EXPOSURE_LIMIT`.

**Maximum drawdown.**

- `maxDrawdownPct` (default 20%, must exceed `maxDailyLossPct`, env `RISK_MAX_DRAWDOWN_PCT`) halts new trading when peak-to-trough equity drawdown reaches the limit, returning `MAX_DRAWDOWN`.
- The `AccountState` gains `peakEquityUsd`. It is always clamped to at least the current equity, so a stale or rounded peak can never fabricate (or hide) a drawdown. `PaperAccountState` now tracks the high-water mark across `recomputeAccount`, persists it, and projects it to the engine; a missing peak defaults to current equity (no drawdown known) rather than failing closed on absent context.

**Full kill-switch enforcement (§44).**

- `evaluateTrade` now accepts an explicit `killSwitchEngaged` input, OR-ed with the static config flag. It is fail-closed: `undefined`/`false` release, **every other value engages**.
- `createRiskEngine` accepts an injected `killSwitch`, validates it at construction (`assertKillSwitch`), and evaluates against it; it can only narrow a decision. It also accepts an `onDecision` audit sink that is invoked for **every** decision and cannot suppress or crash one if it throws.
- `PaperSession.submit` passes `killSwitch.isEngaged()` into the engine instead of rewriting the config, so the engine owns the gate and there is a single code path.

**Verification.**

`npm test` → **313 tests, 313 pass, 0 fail** (282 prior + 29 new risk-exposure/drawdown/kill-switch engine tests + 2 paper-account high-water-mark/projection tests). New coverage: symbol and total exposure caps at their boundaries, headroom consumption and notional fallback, dust-after-cap refusal, drawdown at/inside the limit, profit resetting the measure, malformed peak and malformed toggle fail-closed, config coherence (`symbol > total`, `drawdown <= daily loss`), deterministic and non-mutating evaluation, and the bound engine's kill switch / decision sink / sink-failure behaviour. Security/isolation suite unchanged and green; no new module reads `process.env`, touches credentials, performs I/O, or names an exchange write endpoint.

---

## 17. PHASE 5 UPDATE — SIMULATION HARDENING (2026-10-01)

**Task:** PHASE5-001. Validate and harden the simulation layer (simulated execution, paper trading, portfolio tracking, PnL) as the foundation for backtest/testnet. No real orders, no backtest historical run, no AI, no live path. No `.env` or credential file was read.

**New module (one):** `src/execution/fill-model.mjs` — pluggable, deterministic fill sizing. The `test/security.test.mjs` exact module inventory was updated accordingly, and the new module reads no `process.env`, imports no network client, and names no exchange write operation.

```text
src/execution/fill-model.mjs     FillModel contract; full fill (default) + notional-cap partial fill; assertFillModel
src/execution/paper-execution-adapter.mjs  fill model wired in; partial-fill accounting; exit slippage; single POSITION_CLOSED
src/execution/execution-adapter.mjs        Fill typedef documents requested/filled/unfilled/partial
src/execution/index.mjs          re-exports fill-model
src/state/journal.mjs            PARTIAL_FILL event type
src/state/paper-account.mjs      toPortfolioSnapshot / toPnLSnapshot / toDomainPosition (domain §7 types)
src/session/paper-session.mjs    optional fillModel; getPortfolioSnapshot() / getPnLSnapshot()
```

**Simulated fills — partial fills.**

- `FillModel.resolveFill()` returns `{ filledQuantity, unfilledQuantity, partial, reason }`. The default `createFullFillModel()` preserves the original whole-order behaviour exactly.
- `createNotionalCapFillModel({ maxNotionalPerFillUsd })` models a market taker order with finite liquidity: it fills up to the cap, floors the size to `qtyStep`, and cancels the remainder (it never rests). A cap that leaves a size below `minOrderQty`/`minNotionalUsd` refuses the entry with `UNREPRESENTABLE_QUANTITY` instead of opening a dust position.
- The adapter treats the model's answer as untrusted: a non-finite, negative or over-requested fill is a hard failure, never a silent clamp. Fees, initial margin and the locked-margin guard are all computed on the **filled** notional, so a partial never risks more than the approved full size. A partial entry still consumes exactly one daily trade slot, and a `PARTIAL_FILL` journal event plus `partial`/`requestedQuantity`/`unfilledQuantity` metadata make the shortfall auditable.

**Fee and slippage modelling.**

- Fees were already pluggable (`FeeModel`); the new tests pin that a partial fill is charged on the filled notional, not the requested one.
- Exit slippage is now modelled, not hard-coded to zero. It is measured against the requested reference (the protective trigger level, an explicit close price, or the current reference price) and signed so a positive value is always a cost: closing a LONG sells below the request, closing a SHORT buys above it. A gap through the stop therefore records an adverse slippage; a favourable gap records a negative one; an explicit close at an exact price records zero.

**Portfolio tracking.**

- `state/paper-account.mjs` projects the ledger into the existing validated domain types (§7): `toPortfolioSnapshot` (`PortfolioSnapshot` + `Balance` + `Position`, source `"paper"`), `toPnLSnapshot` (`PnLSnapshot`, `netPnlUsd = realized + unrealized − fees`), and `toDomainPosition`. The session exposes `getPortfolioSnapshot()` / `getPnLSnapshot()`. The projections are frozen and never mutate the ledger; a non-positive equity is refused by the domain schema rather than clamped.

**Risk gate precedes execution.**

- Unchanged by construction, and now explicitly tested: a risk-rejected proposal emits **no** `ORDER_SUBMITTED`/`ORDER_FILLED` and moves no money, and the adapter called directly with a non-approval returns `EXECUTION_REQUIRES_APPROVAL` without mutating the account.

**Audit fix.** A manual `closePosition` previously emitted `POSITION_CLOSED` twice (the passed event and the generic close marker); the generic marker is now suppressed when the primary event is already `POSITION_CLOSED`. A test pins one close per close.

**Verification.**

`npm test` → **332 tests, 332 pass, 0 fail** (313 prior + 19 new in `test/paper-simulation.test.mjs`). New coverage: fill-model contract and misconfiguration, notional-cap partial and below-minimum refusal, partial-fill accounting and journal shortfall, approved-risk not exceeded, adverse/favourable/zero exit slippage, portfolio/PnL snapshot validation and mapping, non-positive-equity refusal, risk-before-execution, deterministic replay of a partial-fill flow, and SHORT partial-fill stop settlement. Security/isolation suite (exact module inventory included) green.

---

## 18. PHASE 7 UPDATE — BACKTESTING (2026-10-01)

**Task:** PHASE7-001. Implement historical data, simulator, metrics, fees and slippage (MASTER_SPEC §27–29). Offline only: no live path, no real orders, no `.env` or credential file was read. The engine never calls `Date.now()` in its decision path and cannot reach an exchange client.

**New modules (eight):**

```text
src/backtest/historical-data.mjs   loader + data-quality gate; JSON/JSONL/array; gap detection
src/backtest/slippage-model.mjs    pluggable slippage (zero / adverse rate); assertSlippageModel
src/backtest/metrics.mjs           Sharpe, win rate, PnL, profit factor, drawdown, exposure, costs
src/backtest/signal-source.mjs     strategy replay + AI-gated strategy replay (analysis-only)
src/backtest/engine.mjs            bar replay -> strategy -> Risk Engine -> paper execution -> metrics
src/backtest/index.mjs             backtest barrel
src/simulator/market-replay.mjs    bars -> deterministic market snapshots (close/low/high views)
src/simulator/index.mjs            simulator barrel
```

Supporting additive change: `state/journal.mjs` gains `BACKTEST_STARTED`, `BACKTEST_BAR`, `BACKTEST_COMPLETED`. `src/index.mjs` no longer claims no engine exists; the offline CLI is `npm run backtest` (`scripts/backtest_run.mjs`). The `test/security.test.mjs` exact module inventory was updated for the eight modules.

**Pipeline — the same logic as PAPER.** Historical candles -> `simulator/market-replay.mjs` -> signal source -> the unchanged `evaluateTrade` Risk Engine -> the unchanged `PaperExecutionAdapter` (same fee/fill/domain models) -> `PaperAccountState` -> `metrics.mjs`. Position sizing, protective-order requirements, daily counters and SL/TP ambiguity all remain owned by the existing layers.

**Intrabar honesty and determinism.** A bar hides its path, so the engine never guesses it: it tests the adverse extreme first (`low` then `high` for a LONG, `high` then `low` for a SHORT), marks at the close, and enters at the close. A bar that satisfies both the stop and the target therefore resolves to the stop, never the favourable branch. Every timestamp is derived from the replayed bar, so identical inputs reconstruct an identical run (`metrics`, `trades`, `equityCurve`, `journal` and `account` all `deepEqual`).

**Costs.** Fees reuse the existing `FeeModel`. Slippage is a new pluggable `SlippageModel` that widens the executable book adversarially on both sides; spread is a separate `spreadBps`. Both are charged inside every simulated fill, and totals appear in the metrics.

**Metrics (§28).** Total return, net PnL, gross profit/loss, win rate, average win/loss, profit factor, maximum drawdown (USD and %), Sharpe-like ratio, number of trades, average trade, exposure, fees, slippage and liquidation events. Every mathematically undefined ratio (zero-variance Sharpe, no-loss profit factor, no-trade win rate) is reported as `null`, never `NaN`/`Infinity`.

**AI replay.** `createAISignalSource({ strategy, provider })` replays a deterministic strategy vetoed by an AI analysis: the strategy owns the price geometry, the model may only agree or veto (an invalid/absent analysis is a veto). It is exercised offline with the existing mock provider; AI still cannot size or place anything.

**Verification.** `npm test` → **377 tests, 377 pass, 0 fail** (347 prior + 30 new). New coverage: `test/backtest-historical-data.test.mjs` (validation, ordering, duplicates, impossible candles, gaps, JSON/JSONL loading), `test/backtest-slippage.test.mjs` (zero/rate models, book widening, crossed-book refusal), `test/backtest-metrics.test.mjs` (drawdown, Sharpe edge cases, full metric set, undefined-as-null), and `test/backtest-engine.test.mjs` (take profit, stop on the adverse extreme, both-crossed conservatism, end-of-run settlement, fees/slippage costing, risk-gate non-bypass, fail-closed signal errors, AI agreement/veto/invalid, bit-for-bit determinism, input validation). The end-to-end CLI runs `npm run backtest` and reports metrics with `real orders: 0`. No new module reads `process.env`, imports a network/AI SDK, names an exchange write operation, or performs disk I/O on the trading path.

---

## 19. PHASE 10 UPDATE — LIVE SAFETY LAYER (2026-10-01)

**Task:** PHASE10-001. Implement the live safety layer (MASTER_SPEC Phase 10, §46): explicit activation, production credential separation, final risk/kill-switch checks, emergency controls and audit verification. **Live trading remains FORBIDDEN.** No live path was enabled, no order was placed, no real execution was added, and `.env` was not read or modified.

**New modules (seven):**

```text
src/config/live.mjs                    LIVE_ENABLED + TRADING_MODE=LIVE config; dedicated live credentials
src/safety/checklist.mjs               the fourteen §46 conditions; fail-closed attestation evaluator
src/safety/credential-separation.mjs   live vs testnet credential-domain separation (pure, value-based)
src/safety/live-gate.mjs               evaluateLiveReadiness() + assertLiveReady(); the single gate
src/safety/emergency-controls.mjs      audited engage/release around the existing kill switch
src/safety/index.mjs                   safety-layer barrel
src/session/live-session.mjs           the audited live boundary; refuses every order
```

Supporting additive changes: `domain/reason-code.mjs` gains nine `LIVE_*` codes; `state/journal.mjs` gains seven `LIVE_*` events; `.env.example` documents `LIVE_ENABLED`, `BYBIT_LIVE_API_KEY` and `BYBIT_LIVE_API_SECRET`; `test/security.test.mjs` records the new modules and enforces four new isolation properties.

**The gate (`assertLiveReady`).** One deterministic, side-effect-free decision combining three independent kinds of evidence, with no default and no bypass:

1. the explicit flag — `LIVE_ENABLED=true` **and** `TRADING_MODE=LIVE`, read from config, never from a caller's claim;
2. the thirteen §46 attestations (unit/integration tests, backtest, paper, testnet, reconciliation, restart recovery, duplicate-order protection, risk limits, kill switch, logging, secrets, production credentials), each of which must be an explicit `true` — `false`, missing, `"yes"` and `1` all fail;
3. runtime objects the gate inspects directly — validated risk limits, a functional emergency stop (and not engaged), properly separated credentials, and a usable append-only audit journal.

`evaluateLiveReadiness` returns a frozen decision with every failure enumerated; `assertLiveReady` throws a `ConfigError` on any failure. An empty input is refused.

**Production credential separation.** Live uses its own pair, loaded only by `config/live.mjs` and only from `BYBIT_LIVE_*`, with no fallback to testnet or operational keys. A `BYBIT_TESTNET=true` / `TESTNET_ENABLED=true` configuration is refused outright, and the gate refuses a key shared with the testnet domain — so a testnet mistake can never reach production, or the reverse.

**Emergency controls and audit.** `createEmergencyControls` binds the existing runtime kill switch to the journal: engaging and releasing the stop append `LIVE_EMERGENCY_ENGAGED` / `LIVE_EMERGENCY_RELEASED`. `createLiveSession` records the activation attempt *before* evaluating, then the evaluation and its outcome; a refusal leaves a complete audit trail and throws. Engaging the stop disables trading and can only be released explicitly.

**Live remains forbidden.** `LIVE_ENABLED` defaults to `false`, and `LIVE_EXECUTION_IMPLEMENTED` is still hard-coded `false`. Even a session whose gate passes refuses every `submit()` with `LIVE_TRADING_DISABLED` and records the refusal. The gate grants *readiness*, not trading.

**§46 checklist — implementation status:**

```text
[x] unit tests pass                     gate attestation + 482-test suite
[x] integration tests pass              gate attestation
[x] backtest works                      gate attestation (Phase 7 CLI)
[x] paper trading works                 gate attestation
[x] testnet works                       gate attestation (Phase 8)
[x] reconciliation works                gate attestation (Phase 9)
[x] restart recovery tested             gate attestation (Phase 9)
[x] duplicate order protection tested   gate attestation (Phase 9)
[x] risk limits tested                  gate attestation + concrete validateRiskLimits check
[x] kill switch tested                  gate attestation + concrete control/engaged checks
[x] logging verified                    gate attestation + concrete append-only journal check
[x] secrets verified                    gate attestation
[x] production credentials verified     concrete separation check (no testnet keys in live)
[x] LIVE flag explicitly enabled        read from config (LIVE_ENABLED + TRADING_MODE=LIVE)

Until every condition holds:  LIVE TRADING = FORBIDDEN
```

Every line above is now *evaluated by the gate*; the boxes describe the gate's checks, not a claim that live has been enabled. `LIVE_ENABLED` stays `false`.

**Verification.** `npm test` → **482 tests, 481 pass, 0 fail, 1 skipped** (the opt-in real-testnet check). New coverage in `test/live-safety.test.mjs` (29 tests): config defaults and explicit dual-flag activation, testnet refusal, dedicated-credential loading without fallback, the 14-line checklist, fail-closed attestation evaluation (missing / false / non-boolean), credential separation (separated / missing / testnet-enabled / shared), every gate failure mode (unset flag, unattested item, shared credentials, invalid risk limits, engaged or malformed stop, missing journal), determinism, `assertLiveReady` throwing, audited emergency engage/release, and an audited live session that refuses construction when refused and refuses every order even when ready. `test/security.test.mjs` adds four isolation properties: only `config/live.mjs` may name live credentials, no non-live module may import the live boundary, the session barrel must not re-export live, and an empty gate input can never be ready. No new non-live module reads `process.env`, imports an exchange client, writes to disk directly, or names an exchange write operation.
