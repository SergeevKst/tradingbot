# MASTER TECHNICAL SPECIFICATION

## Autonomous Crypto Trading Bot

**Document status:** Master specification
**Development mode:** AI-supervised development
**Primary architect/reviewer:** Grok 4.3
**Developer subagent:** DeepSeek V4.1 Flash
**Exchange:** Bybit
**Initial operating mode:** Backtest → Paper/Simulation → Testnet → Live
**Live trading:** MUST NOT be enabled during initial development

---

# 1. SYSTEM MISSION

Build a modular, testable and observable cryptocurrency trading system capable of:

1. Receiving market data from Bybit.
2. Normalizing and storing market data.
3. Calculating technical/market features.
4. Generating trading signals.
5. Optionally using an AI analysis layer.
6. Applying deterministic risk management.
7. Creating trade intents.
8. Validating trade intents against risk and account constraints.
9. Executing orders through Bybit.
10. Tracking orders, fills, positions and PnL.
11. Recovering safely after crashes/restarts/network failures.
12. Recording every important decision for later analysis.
13. Running in backtest, simulation, testnet and live modes without rewriting the core strategy.
14. Allowing strategies and AI providers to be replaced independently.

The system must be designed as a real software product, not as a single trading script.

---

# 2. CORE DEVELOPMENT PRINCIPLE

The project must be developed incrementally.

No large uncontrolled rewrite.

Every implementation task must:

* have a clearly defined scope;
* identify affected modules;
* define acceptance criteria;
* include tests;
* avoid unrelated changes;
* preserve existing working functionality;
* produce a reviewable git diff.

The supervisor must never ask the developer to "implement everything".

Large features must be decomposed into small Tasks.

---

# 3. AI DEVELOPMENT ORGANIZATION

## 3.1 Grok 4.3 — Supervisor

Grok is responsible for:

* understanding the complete architecture;
* decomposing requirements;
* creating implementation tasks;
* deciding implementation order;
* reviewing DeepSeek's work;
* checking architectural consistency;
* checking security;
* checking tests;
* rejecting incomplete implementations;
* requesting corrections;
* maintaining the project roadmap.

Grok should NOT write large amounts of production code itself when the task can be delegated to DeepSeek.

Grok should use DeepSeek as the implementation agent.

---

## 3.2 DeepSeek V4.1 Flash — Developer

DeepSeek is responsible for:

* implementing assigned tasks;
* modifying source code;
* writing tests;
* running permitted local tests;
* inspecting relevant existing code;
* reporting implementation details;
* identifying blockers.

DeepSeek must not redefine architecture independently.

If an implementation conflicts with the architecture, DeepSeek must report the conflict instead of silently changing architectural decisions.

---

# 4. IMPORTANT SEPARATION OF RESPONSIBILITIES

There are two different AI roles in this project.

## Coding-time AI

```text
Grok
  ↓
Task
  ↓
DeepSeek Developer
  ↓
Code
```

This exists only to build the software.

## Runtime Trading AI

The trading bot itself may later use an AI model for market analysis.

That is a completely separate subsystem:

```text
Market Data
     ↓
Context Builder
     ↓
AI Provider
     ↓
Market Analysis
     ↓
Strategy / Decision Layer
     ↓
Risk Engine
     ↓
Execution
```

The coding-time DeepSeek agent must NEVER be treated as the runtime trading AI.

---

# 5. HIGH-LEVEL SYSTEM ARCHITECTURE

Target architecture:

```text
                    ┌─────────────────────┐
                    │       Bybit         │
                    │ REST + WebSocket    │
                    └──────────┬──────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │   Market Data       │
                    │   Ingestion         │
                    └──────────┬──────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │ Normalization /     │
                    │ Validation           │
                    └──────────┬──────────┘
                               │
                 ┌─────────────┴─────────────┐
                 │                           │
                 ▼                           ▼
        ┌─────────────────┐        ┌─────────────────┐
        │ Historical Data │        │ Live Market     │
        │ / Storage       │        │ State           │
        └────────┬────────┘        └────────┬────────┘
                 │                           │
                 └─────────────┬─────────────┘
                               ▼
                    ┌─────────────────────┐
                    │ Feature Engine      │
                    │ Indicators /        │
                    │ Market Features     │
                    └──────────┬──────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │ Strategy Engine     │
                    └──────────┬──────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │ AI Analysis Layer   │
                    │ optional            │
                    └──────────┬──────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │ Signal Aggregator   │
                    └──────────┬──────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │ Risk Engine         │
                    └──────────┬──────────┘
                               │
                         approved?
                         /       \
                       NO         YES
                       │           │
                       ▼           ▼
                    REJECT      Trade Intent
                                   │
                                   ▼
                         ┌─────────────────┐
                         │ Execution       │
                         │ Engine          │
                         └────────┬────────┘
                                  │
                                  ▼
                               Bybit
                                  │
                                  ▼
                         Orders / Fills
                                  │
                                  ▼
                         Position Manager
                                  │
                                  ▼
                         PnL / Analytics
```

---

# 6. ARCHITECTURAL MODULES

The system should be divided into explicit modules.

Suggested structure:

```text
src/
├── core/
│   ├── domain/
│   ├── events/
│   ├── types/
│   └── errors/
│
├── exchange/
│   └── bybit/
│       ├── rest/
│       ├── websocket/
│       ├── mapper/
│       └── adapter/
│
├── market-data/
│   ├── ingestion/
│   ├── normalization/
│   ├── validation/
│   └── storage/
│
├── features/
│   ├── indicators/
│   ├── market/
│   └── feature-engine/
│
├── strategies/
│   ├── interfaces/
│   ├── implementations/
│   └── registry/
│
├── ai/
│   ├── interfaces/
│   ├── providers/
│   ├── context-builder/
│   ├── prompts/
│   └── schemas/
│
├── signals/
│   ├── signal-engine/
│   └── aggregator/
│
├── risk/
│   ├── position-sizing/
│   ├── limits/
│   ├── validation/
│   └── exposure/
│
├── execution/
│   ├── order-manager/
│   ├── execution-engine/
│   ├── reconciliation/
│   └── idempotency/
│
├── portfolio/
│   ├── positions/
│   ├── balances/
│   └── pnl/
│
├── backtest/
│   ├── engine/
│   ├── simulator/
│   └── metrics/
│
├── config/
│
└── observability/
    ├── logging/
    ├── metrics/
    ├── events/
    └── audit/
```

The exact directory structure may be adapted to the existing repository.

Do not blindly reorganize an existing project.

First inspect the repository and preserve useful existing structure.

---

# 7. DOMAIN MODEL

The system must have explicit domain objects.

At minimum:

```text
MarketTick
Candle
OrderBookSnapshot
MarketFeature
TradingSignal
TradeIntent
RiskDecision
OrderRequest
Order
OrderFill
Position
Balance
PortfolioSnapshot
PnLSnapshot
AIAnalysis
StrategyDecision
```

Objects must have explicit types.

Avoid passing unstructured dictionaries/objects through the entire system when a domain type is appropriate.

---

# 8. TRADE INTENT

A strategy or AI analysis must NOT directly send an exchange order.

The intermediate abstraction must be a TradeIntent.

Example conceptual structure:

```text
TradeIntent

symbol
side
entry
stopLoss
takeProfit
quantity
leverage
strategy
confidence
reason
timestamp
metadata
```

The exact schema should be determined during implementation.

Flow:

```text
Strategy
   ↓
TradeIntent
   ↓
Risk Engine
   ↓
approved / rejected
   ↓
Execution Engine
   ↓
Exchange Order
```

This separation is mandatory.

---

# 9. RISK ENGINE

The Risk Engine is the final authority before execution.

No strategy and no AI model can bypass it.

Risk checks should eventually include:

* maximum position size;
* maximum account exposure;
* maximum leverage;
* maximum number of simultaneous positions;
* maximum daily loss;
* maximum consecutive losses;
* maximum order size;
* minimum stop-loss distance;
* maximum allowed spread/slippage;
* duplicate trade protection;
* cooldown;
* symbol restrictions;
* trading-session restrictions;
* emergency kill switch;
* exchange/account state validation.

If Risk Engine says:

```text
REJECT
```

the order must not be sent.

---

# 10. AI LAYER

AI must be treated as an optional analytical component.

AI must never directly control exchange execution.

Architecture:

```text
Market State
     ↓
Context Builder
     ↓
Structured AI Input
     ↓
AI Provider
     ↓
Structured AI Output
     ↓
Signal/Strategy Layer
     ↓
Risk Engine
```

AI provider interface should be model-independent.

Conceptually:

```text
AIProvider

analyze(context): AIAnalysis
```

Possible implementations:

```text
DeepSeekFlashProvider
GrokProvider
FutureProvider
MockAIProvider
```

The exact model ID must come from configuration.

No provider-specific logic should leak into the rest of the application.

---

# 11. AI OUTPUT

AI output must be structured.

Do not depend on free-form text such as:

```text
"I think BTC may go up..."
```

Instead use a validated schema.

Conceptually:

```text
{
    action: "LONG" | "SHORT" | "FLAT",
    confidence: number,
    rationale: string,
    invalidation: string,
    suggested_entry: number | null,
    suggested_stop: number | null,
    suggested_target: number | null
}
```

The actual production schema must be finalized before implementing the AI provider.

Invalid AI output must result in:

```text
NO TRADE
```

rather than an exception that accidentally triggers an order.

---

# 12. MARKET DATA

Bybit should be accessed through a dedicated adapter.

The rest of the application must not depend directly on Bybit SDK objects.

Example:

```text
Application
    ↓
Exchange Interface
    ↓
Bybit Adapter
    ↓
Bybit API
```

This allows:

* test mocks;
* backtesting;
* future exchange support;
* isolated exchange-specific logic.

Market data should support both:

```text
REST
WebSocket
```

where appropriate.

WebSocket should be used for real-time market information where required.

REST should be used for snapshots, historical data, account state and reconciliation where appropriate.

---

# 13. ORDER EXECUTION

Execution must be stateful.

The system must track:

```text
requested
submitted
accepted
partially_filled
filled
cancel_requested
cancelled
rejected
failed
unknown
```

Unknown order state must be reconciled with the exchange.

Never assume that a failed network request means an order was not created.

This is critical.

---

# 14. IDEMPOTENCY

Order submission must be protected against duplicates.

If the application crashes after submitting an order but before receiving confirmation, restart/recovery logic must be able to determine whether the order exists.

Never blindly resubmit an order after an ambiguous network failure.

---

# 15. POSITION RECONCILIATION

On startup:

```text
Application
     ↓
Fetch exchange balances
     ↓
Fetch open positions
     ↓
Fetch open orders
     ↓
Compare with local state
     ↓
Reconcile
     ↓
Only then allow trading
```

If reconciliation fails:

```text
TRADING DISABLED
```

---

# 16. TRADING MODES

The application must support separate modes.

## BACKTEST

No network execution.

Historical data only.

## SIMULATION / PAPER

Real market data may be consumed.

Orders are simulated.

No real exchange orders.

## TESTNET

Real Bybit test environment.

No production funds.

## LIVE

Real exchange.

Must require explicit configuration.

The default mode must never be LIVE.

---

# 17. LIVE TRADING SAFETY

Live mode must require explicit activation.

Example conceptual configuration:

```text
TRADING_MODE=live
LIVE_TRADING_ENABLED=true
```

Both conditions should be required.

Additionally:

* startup confirmation;
* risk limits;
* kill switch;
* emergency shutdown;
* exchange environment verification.

Development tasks must never silently enable live trading.

---

# 18. SECRETS

Secrets must never be committed to git.

Examples:

```text
BYBIT_API_KEY
BYBIT_API_SECRET
DEEPSEEK_API_KEY
XAI_API_KEY
```

must come from environment variables or a secure secret mechanism.

Never print secret values.

Never put them into logs.

Never include them in AI prompts.

Never include `.env` contents in Task results.

Never commit `.env`.

---

# 19. CONFIGURATION

Configuration should be centralized.

Conceptually:

```text
ExchangeConfig
TradingConfig
RiskConfig
StrategyConfig
AIConfig
LoggingConfig
RuntimeConfig
```

Configuration must be validated at startup.

Invalid configuration should prevent trading from starting.

---

# 20. OBSERVABILITY

Every important decision must be traceable.

At minimum record:

```text
timestamp
symbol
market state
strategy
signal
AI analysis
risk decision
order request
exchange response
fills
position changes
PnL
errors
```

Use structured logs.

Avoid massive unstructured text logs.

---

# 21. AUDIT TRAIL

For every attempted trade, we should eventually be able to answer:

```text
Why did the system consider this trade?

Which strategy generated it?

What market data was available?

What did AI say?

What risk checks were applied?

Why was it accepted/rejected?

What order was submitted?

What did Bybit return?

What fills occurred?

What was the resulting position?

What was the PnL?
```

This is a core product requirement.

---

# 22. ERROR HANDLING

Errors must be classified.

At minimum:

```text
ValidationError
ConfigurationError
ExchangeError
NetworkError
AuthenticationError
RateLimitError
OrderError
RiskError
AIProviderError
DataError
ReconciliationError
```

Transient errors should be retryable where safe.

Non-idempotent operations must not be blindly retried.

---

# 23. RETRIES

Retry policies must be explicit.

Never implement:

```text
while error:
    retry()
```

without limits.

Every retry policy must define:

```text
max attempts
backoff
jitter
retryable errors
non-retryable errors
```

---

# 24. RATE LIMITING

Exchange API limits must be respected.

The exchange adapter should centralize:

* request throttling;
* retry behavior;
* rate-limit handling;
* API errors.

Do not scatter rate-limit logic across strategy code.

---

# 25. STRATEGY ARCHITECTURE

Strategies must be pluggable.

Conceptually:

```text
Strategy
   ↓
MarketContext
   ↓
StrategyDecision
```

A strategy should not know:

* API credentials;
* Bybit SDK internals;
* database internals;
* order execution internals.

Strategy responsibility:

```text
market data → decision
```

Execution is handled elsewhere.

---

# 26. MULTIPLE STRATEGIES

Eventually the system should support:

```text
Strategy A
Strategy B
Strategy C
```

without rewriting the execution system.

A strategy registry may be used.

Conceptually:

```text
StrategyRegistry

register(strategy)
get(name)
list()
```

---

# 27. BACKTEST ENGINE

Backtesting must use the same strategy/risk logic as production wherever practical.

Desired architecture:

```text
Historical Data
      ↓
Market Data Interface
      ↓
Strategy
      ↓
Risk Engine
      ↓
Simulated Execution
      ↓
Portfolio
      ↓
Metrics
```

The backtester should not have a completely different strategy implementation.

---

# 28. BACKTEST METRICS

Eventually calculate:

* total return;
* net PnL;
* gross profit;
* gross loss;
* win rate;
* average win;
* average loss;
* profit factor;
* maximum drawdown;
* Sharpe-like risk metrics where appropriate;
* number of trades;
* average trade;
* exposure;
* fees;
* slippage;
* liquidation events.

Do not optimize solely for total return.

---

# 29. FEES AND SLIPPAGE

Backtesting and simulation must account for:

```text
trading fees
slippage
spread
funding
```

where applicable.

Otherwise backtest results may be misleading.

---

# 30. DATA QUALITY

Market data must be validated.

Detect:

* missing candles;
* duplicate candles;
* invalid timestamps;
* impossible prices;
* negative/zero quantities where invalid;
* stale WebSocket data;
* gaps;
* inconsistent exchange state.

Invalid market data must not silently enter the strategy.

---

# 31. TIME

All internal timestamps should use a consistent timezone strategy.

Prefer UTC internally.

Convert to local timezone only at presentation boundaries.

---

# 32. TESTING

Every major module requires tests.

At minimum:

```text
unit tests
integration tests
exchange adapter tests
risk tests
strategy tests
AI schema tests
execution tests
reconciliation tests
backtest tests
```

Critical risk logic requires extensive edge-case tests.

---

# 33. TEST PYRAMID

Prefer:

```text
          E2E
         /   \
     Integration
       /       \
     Unit      Unit
```

Most business logic should be covered by fast unit tests.

External API calls should be isolated behind adapters.

---

# 34. MOCKING

Tests must not require real Bybit credentials.

Tests must not require real DeepSeek API access.

Tests must not place real orders.

Use mocks/fakes for external services.

---

# 35. SECURITY

Security requirements:

* secrets outside git;
* no secrets in logs;
* no secrets in AI context;
* least-privilege API keys;
* read-only keys where possible for data-only components;
* separate testnet/live credentials;
* explicit live mode;
* input validation;
* output validation;
* audit logging.

---

# 36. AI SECURITY

AI-generated output is untrusted input.

Never allow AI output to bypass:

```text
schema validation
risk validation
execution validation
```

AI may suggest.

The deterministic trading system decides whether execution is permitted.

---

# 37. AI CONTEXT BUILDER

The runtime AI should receive a controlled context.

Example:

```text
Market:
- symbol
- timeframe
- price
- OHLCV
- volume
- indicators
- volatility
- order-book information where appropriate

Portfolio:
- balance
- open positions
- current exposure

Strategy:
- active strategy
- current state

Risk:
- allowed risk
- position limits
```

Do not send arbitrary files or environment variables to the AI.

---

# 38. PROMPT VERSIONING

AI prompts must be versioned.

Example:

```text
prompt_version = "market-analysis-v1"
```

Every AI decision should record the prompt version.

This allows later analysis of model behavior.

---

# 39. MODEL INDEPENDENCE

The application must not assume that DeepSeek is permanent.

Provider interface:

```text
AIProvider
```

Possible implementations:

```text
DeepSeek
Grok
Mock
FutureProvider
```

Switching model should primarily require configuration, not rewriting business logic.

---

# 40. DATABASE / STORAGE

The storage solution should be selected based on actual project requirements.

Do not introduce a large database prematurely.

Separate:

```text
market data
trade state
audit data
metrics
```

The architecture should permit replacing the storage backend later.

---

# 41. EVENT-DRIVEN DESIGN

Where useful, internal events may be used.

Examples:

```text
MarketDataReceived
CandleClosed
SignalGenerated
TradeIntentCreated
RiskApproved
RiskRejected
OrderSubmitted
OrderFilled
PositionOpened
PositionClosed
PnLUpdated
EmergencyStopActivated
```

Do not introduce an event bus merely for architectural fashion.

Use it where it materially improves decoupling and observability.

---

# 42. APPLICATION LIFECYCLE

Expected lifecycle:

```text
START
  ↓
Load configuration
  ↓
Validate configuration
  ↓
Initialize dependencies
  ↓
Connect exchange
  ↓
Synchronize account
  ↓
Reconcile positions/orders
  ↓
Initialize market data
  ↓
Initialize strategies
  ↓
Initialize AI provider
  ↓
RUN
  ↓
Monitor
  ↓
Shutdown gracefully
```

If a critical initialization step fails:

```text
SAFE STOP
```

---

# 43. GRACEFUL SHUTDOWN

On shutdown:

1. stop accepting new trades;
2. stop strategy generation;
3. finish safe in-flight operations;
4. persist state;
5. disconnect WebSocket;
6. close resources;
7. record shutdown reason.

Do not automatically close positions merely because the process stops unless this behavior is explicitly designed and tested.

---

# 44. EMERGENCY STOP

There must be a deterministic emergency stop.

When activated:

```text
new entries = disabled
```

The exact behavior for existing positions must be configurable and explicitly tested.

Emergency stop must not depend on AI.

---

# 45. DEVELOPMENT PHASES

Development order:

## Phase 0 — Repository audit

Understand:

* current code;
* existing modules;
* dependencies;
* configuration;
* tests;
* Bybit integration;
* existing strategies;
* existing AI code.

Do not rewrite.

---

## Phase 1 — Domain foundation

Implement/validate:

* domain types;
* configuration;
* errors;
* interfaces;
* core abstractions.

---

## Phase 2 — Market data

Implement:

* Bybit adapter;
* WebSocket;
* REST;
* normalization;
* validation;
* market state.

---

## Phase 3 — Strategy layer

Implement:

* strategy interface;
* market context;
* strategy registry;
* first strategy.

---

## Phase 4 — Risk Engine

Implement:

* risk limits;
* position sizing;
* trade validation;
* kill switch;
* exposure controls.

This phase is critical.

---

## Phase 5 — Simulation

Implement:

* simulated execution;
* paper trading;
* portfolio tracking;
* PnL.

---

## Phase 6 — AI provider

Implement:

* AIProvider interface;
* DeepSeek provider;
* context builder;
* structured output;
* schema validation;
* prompt versioning.

---

## Phase 7 — Backtesting

Implement:

* historical data;
* simulator;
* metrics;
* fees;
* slippage.

---

## Phase 8 — Testnet

Connect to Bybit testnet.

No production credentials.

---

## Phase 9 — Reconciliation and recovery

Test:

* restart;
* network failure;
* API timeout;
* duplicate order prevention;
* partial fills;
* unknown order state.

---

## Phase 10 — Live safety layer

Only after all previous phases pass.

Implement:

* explicit live activation;
* production credential separation;
* final risk limits;
* emergency controls;
* audit verification.

---

# 46. LIVE TRADING GATE

Live trading must have an explicit checklist.

Before enabling live:

```text
[ ] unit tests pass
[ ] integration tests pass
[ ] backtest works
[ ] paper trading works
[ ] testnet works
[ ] reconciliation works
[ ] restart recovery tested
[ ] duplicate order protection tested
[ ] risk limits tested
[ ] kill switch tested
[ ] logging verified
[ ] secrets verified
[ ] production credentials verified
[ ] LIVE flag explicitly enabled
```

Until every required condition is satisfied:

```text
LIVE TRADING = FORBIDDEN
```

---

# 47. CODE QUALITY

Prefer:

* small modules;
* explicit interfaces;
* strong typing;
* dependency injection where useful;
* deterministic business logic;
* clear naming;
* small functions;
* explicit error handling.

Avoid:

* giant files;
* global mutable state;
* hidden side effects;
* duplicated exchange logic;
* strategy code placing orders directly;
* AI code placing orders directly;
* hard-coded credentials;
* hard-coded trading parameters.

---

# 48. ARCHITECTURAL RULE

The dependency direction should generally be:

```text
UI / CLI
   ↓
Application
   ↓
Domain
   ↑
Infrastructure adapters
```

Business logic must not depend directly on external providers.

---

# 49. FIRST IMPLEMENTATION TASK

Before writing production code, Grok must perform a repository audit.

The first task for DeepSeek should therefore NOT be:

"build the trading bot."

Instead:

```text
AUDIT THE EXISTING REPOSITORY.
```

DeepSeek must inspect the repository and report:

1. current architecture;
2. current files/modules;
3. existing Bybit integration;
4. existing market-data functionality;
5. existing strategies;
6. existing AI integration;
7. current configuration;
8. current tests;
9. architectural gaps;
10. technical debt;
11. conflicts with this Master Specification;
12. recommended implementation sequence.

The audit must not make destructive changes.

---

# 50. FIRST DELIVERABLE

Create:

```text
docs/ARCHITECTURE_AUDIT.md
```

containing:

```text
1. Existing architecture
2. Existing components
3. What already works
4. What is incomplete
5. What should be preserved
6. What should be refactored
7. Missing components
8. Security concerns
9. Testing gaps
10. Proposed implementation roadmap
```

No live trading.

No real order placement.

No modification of `.env`.

No production credential access.

---

# 51. SUPERVISOR RULES

Grok must enforce the following:

### Rule 1

Never let DeepSeek implement an undefined requirement.

### Rule 2

Never allow DeepSeek to silently change architecture.

### Rule 3

Every implementation task has acceptance criteria.

### Rule 4

Every implementation task has tests.

### Rule 5

Every completed task is reviewed before the next task.

### Rule 6

Rejected work receives a correction task.

### Rule 7

Do not proceed while critical tests fail.

### Rule 8

Do not enable live trading during development.

### Rule 9

Never expose secrets to the coding subagent unnecessarily.

### Rule 10

Prefer incremental changes over rewrites.

---

# 52. TASK CONTRACT

Every task sent by Grok to DeepSeek should follow this structure:

```text
TASK ID:
TITLE:

OBJECTIVE:

CONTEXT:

FILES / MODULES:

REQUIREMENTS:

NON-GOALS:

CONSTRAINTS:

ACCEPTANCE CRITERIA:

TEST REQUIREMENTS:

EXPECTED OUTPUT:

DO NOT:
```

Example:

```text
TASK ID: ARCH-001

TITLE:
Audit existing repository architecture.

OBJECTIVE:
Understand the current implementation before modifying production code.

CONTEXT:
The project is a modular Bybit cryptocurrency trading bot.

REQUIREMENTS:
Inspect the existing repository and compare it with MASTER_SPEC.md.

NON-GOALS:
Do not rewrite code.
Do not modify .env.
Do not place orders.

ACCEPTANCE CRITERIA:
docs/ARCHITECTURE_AUDIT.md exists and accurately describes
the current repository and architectural gaps.

TEST REQUIREMENTS:
No production tests are required for this documentation-only task.

EXPECTED OUTPUT:
Architecture audit document plus concise summary.

DO NOT:
Do not invent functionality that does not exist.
Do not claim something works unless verified.
```

---

# 53. REVIEW CONTRACT

After DeepSeek completes a task, Grok must review:

```text
1. Does implementation satisfy the task?
2. Does it satisfy MASTER_SPEC.md?
3. Did it modify unrelated files?
4. Are tests present?
5. Do tests pass?
6. Are edge cases covered?
7. Are security requirements preserved?
8. Did it introduce architectural debt?
9. Could this break existing functionality?
10. Is the implementation ready for the next task?
```

Possible outcomes:

```text
ACCEPT
```

or

```text
REJECT
```

If rejected:

```text
REJECTION REASON
↓
CORRECTION TASK
↓
DeepSeek
↓
Review again
```

---

# 54. ITERATION LIMIT

Autonomous correction loops must have a hard limit.

Default:

```text
MAX_ITERATIONS = 5
```

If a task cannot pass review after five iterations:

```text
STOP
REPORT BLOCKER
REQUEST ARCHITECTURAL DECISION
```

Do not burn tokens indefinitely.

---

# 55. GIT POLICY

Before each significant task:

```text
git status
```

After each task:

```text
git diff
git status
```

The supervisor should know what changed.

Never commit secrets.

Never automatically push to remote.

---

# 56. DOCUMENTATION

Important architectural decisions should be documented.

Use:

```text
docs/
```

for:

* architecture;
* decisions;
* audits;
* operational procedures;
* strategy documentation;
* AI behavior documentation.

---

# 57. DEFINITION OF DONE

A task is DONE only when:

```text
[ ] requirements implemented
[ ] tests added/updated
[ ] tests pass
[ ] no unrelated changes
[ ] security requirements preserved
[ ] architecture preserved
[ ] documentation updated where needed
[ ] diff reviewed
```

"Code was written" is not equivalent to DONE.

---

# 58. FINAL SYSTEM OBJECTIVE

The final system should conceptually look like:

```text
                       ┌────────────────────┐
                       │      GROK 4.3      │
                       │ Architect/Reviewer │
                       └─────────┬──────────┘
                                 │
                              Tasks
                                 │
                                 ▼
                       ┌────────────────────┐
                       │ DEEPSEEK V4.1      │
                       │ FLASH              │
                       │ Developer          │
                       └─────────┬──────────┘
                                 │
                              Code
                                 │
                                 ▼
                       ┌────────────────────┐
                       │   Trading Bot      │
                       └─────────┬──────────┘
                                 │
              ┌──────────────────┼──────────────────┐
              │                  │                  │
              ▼                  ▼                  ▼
          Bybit Data          Strategy             AI
              │                  │                  │
              └──────────────────┼──────────────────┘
                                 ▼
                         Signal / TradeIntent
                                 │
                                 ▼
                           Risk Engine
                                 │
                         ┌───────┴───────┐
                         │               │
                      REJECT           APPROVE
                         │               │
                         ▼               ▼
                       STOP          Execution
                                         │
                                         ▼
                                      Bybit
                                         │
                                         ▼
                               Orders / Positions
                                         │
                                         ▼
                                   PnL / Audit
```

The fundamental safety rule is:

```text
AI suggests.
Strategy decides.
Risk validates.
Execution executes.
Exchange confirms.
```

No AI component gets a direct path from natural-language output to an exchange order.
