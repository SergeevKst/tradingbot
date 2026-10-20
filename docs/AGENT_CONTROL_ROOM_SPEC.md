# BUILD AGENT CONTROL ROOM

Ты работаешь как Principal Engineer / Software Architect и Autonomous Development Supervisor.

Проект уже прошёл:

* MASTER_SPEC;
* Architecture Audit;
* Final System Review;
* Post-Review Hardening;
* Testnet Readiness Gate.

Теперь необходимо разработать **Agent Control Room** — визуальную систему наблюдения за работой Kilo subagents и trading pipeline.

## SOURCE OF TRUTH

Первым делом самостоятельно прочитай:

`docs/AGENT_CONTROL_ROOM_SPEC.md`

Также изучи:

* `docs/MASTER_SPEC.md`
* `docs/ARCHITECTURE_AUDIT.md`
* `docs/FINAL_SYSTEM_REVIEW.md`
* `docs/TESTNET_READINESS.md`
* текущий source code;
* tests;
* Kilo agent configuration;
* Git state.

`AGENT_CONTROL_ROOM_SPEC.md` является главным источником требований именно для Control Room.

---

# ОСНОВНАЯ ЗАДАЧА

Реализуй Control Room полностью.

Не ограничивайся frontend.

Не создавай декоративный dashboard.

Система должна отображать **реальные события**.

Главный принцип:

```text
REAL AGENT EVENT
        ↓
EVENT BUS
        ↓
NORMALIZATION
        ↓
REALTIME TRANSPORT
        ↓
CONTROL ROOM UI
```

Никаких fake events для демонстрации production behaviour.

---

# ДВА PIPELINE

Control Room должен визуализировать два независимых процесса.

## DEVELOPMENT

```text
Grok 4.3
   ↓
Task
   ↓
DeepSeek V4.1 Flash
   ↓
Implementation
   ↓
Tests
   ↓
Result
   ↓
Grok Review
   ↓
ACCEPT / CORRECT
   ↓
Next Task
```

## TRADING

```text
Market Data
   ↓
Features
   ↓
Strategy
   ↓
AI Analysis
   ↓
TradeIntent
   ↓
Risk Engine
   ↓
Execution
   ↓
Exchange
   ↓
Reconciliation
```

Они должны быть визуально различимы.

---

# UI

Создай современный dark crypto-control-room интерфейс.

Основной экран должен содержать:

```text
┌──────────────────────────────────────────────────────────────┐
│ SYSTEM STATUS        PAPER / TESTNET       LIVE: LOCKED      │
├───────────────────────┬──────────────────────────────────────┤
│ GROK SUPERVISOR       │ DEEPSEEK DEVELOPER                  │
│                       │                                      │
│ current task          │ current task                        │
│ status                │ status                               │
│ reasoning summary     │ implementation                       │
│ review status         │ tests                                │
│                       │ files                                │
├───────────────────────┴──────────────────────────────────────┤
│                    DEVELOPMENT PIPELINE                       │
│ GROK → TASK → DEEPSEEK → TEST → REVIEW → NEXT               │
├──────────────────────────────────────────────────────────────┤
│                     TRADING PIPELINE                          │
│ MARKET → FEATURES → STRATEGY → AI → RISK → EXECUTION         │
├──────────────────────────────────────────────────────────────┤
│                       EVENT STREAM                             │
│ timestamp | source | event | status | correlation             │
└──────────────────────────────────────────────────────────────┘
```

UI должен быть realtime.

---

# AGENT VIEW

Для каждого агента отображай:

* agent name;
* provider;
* model;
* status;
* current task;
* task ID;
* parent task;
* start time;
* duration;
* current phase;
* result;
* review state.

Например:

```text
GROK 4.3
SUPERVISOR

● REVIEWING

TASK-042
Feature Engine hardening

DeepSeek → implementation
Tests → 18/18
Review → pending
```

И:

```text
DEEPSEEK V4.1 FLASH
DEVELOPER

● IMPLEMENTING

TASK-042.2
Add feature validation

Files changed: 4
Tests: running
```

---

# EVENT STREAM

Все события должны иметь normalized schema.

Минимально:

```text
id
timestamp
source
agent
event_type
task_id
parent_task_id
correlation_id
status
summary
metadata
```

Не передавай в UI:

* API keys;
* secrets;
* `.env`;
* private credentials;
* sensitive raw prompts;
* sensitive provider responses.

Добавь secret redaction layer.

---

# EVENT TYPES

Предусмотри как минимум:

```text
AGENT_STARTED
AGENT_STOPPED

TASK_CREATED
TASK_STARTED
TASK_DELEGATED
TASK_COMPLETED
TASK_FAILED

IMPLEMENTATION_STARTED
IMPLEMENTATION_COMPLETED

TEST_STARTED
TEST_PASSED
TEST_FAILED

REVIEW_STARTED
REVIEW_ACCEPTED
REVIEW_REJECTED

CORRECTION_STARTED
CORRECTION_COMPLETED

STRATEGY_SIGNAL
AI_ANALYSIS_STARTED
AI_ANALYSIS_COMPLETED

TRADE_INTENT_CREATED

RISK_CHECK_STARTED
RISK_APPROVED
RISK_REJECTED

EXECUTION_STARTED
EXECUTION_COMPLETED
EXECUTION_FAILED

ORDER_CREATED
ORDER_FILLED
ORDER_REJECTED

RECONCILIATION_STARTED
RECONCILIATION_COMPLETED

SYSTEM_WARNING
SYSTEM_ERROR
```

Не добавляй события, которых реально невозможно получить.

---

# REALTIME

Используй подходящий transport для текущего stack:

* WebSocket;
* SSE;
* или другой обоснованный realtime механизм.

Выбери архитектурно подходящий вариант самостоятельно.

UI не должен постоянно polling'ить весь backend, если нормальный event stream можно реализовать.

---

# EVENT STORAGE

Предусмотри историю событий.

Минимальная реализация может использовать append-only event log.

Например:

```text
.autopilot/
    events/
        agent-events.jsonl
        trading-events.jsonl
```

Но расположение выбери на основании текущей архитектуры проекта.

Не создавай вторую независимую систему state management без необходимости.

---

# CORRELATION

Очень важно иметь возможность открыть один workflow и увидеть всю цепочку.

Например:

```text
TASK-042
   │
   ├── Grok
   │
   ├── DeepSeek
   │
   ├── implementation
   │
   ├── tests
   │
   ├── Grok review
   │
   └── correction
```

Для trading:

```text
SIGNAL-827
   │
   ├── Strategy
   ├── AI
   ├── TradeIntent
   ├── Risk
   ├── Execution
   ├── Order
   └── Reconciliation
```

---

# TERMINAL UI

Если текущий stack позволяет без чрезмерного усложнения, реализуй также terminal view.

Он должен показывать:

```text
┌───────────────────────┬────────────────────────┐
│ GROK                  │ DEEPSEEK               │
│                       │                        │
│ TASK-042              │ TASK-042.2             │
│ REVIEWING             │ IMPLEMENTING           │
│                       │                        │
│ ✓ architecture        │ ✓ feature code         │
│ ✓ requirements        │ ◉ tests                │
│ ◉ final review        │                        │
└───────────────────────┴────────────────────────┘

EVENT STREAM
22:41:03 GROK      TASK_STARTED
22:41:05 GROK      TASK_DELEGATED
22:41:06 DEEPSEEK  IMPLEMENTATION_STARTED
22:41:19 DEEPSEEK  TEST_PASSED
22:41:21 GROK      REVIEW_STARTED
```

Если полноценный terminal UI неоправданно усложняет проект, сначала реализуй Web Control Room и подготовь event API так, чтобы terminal client можно было добавить позже.

---

# TRADING SAFETY

Control Room является observability layer.

Он НЕ должен становиться новым execution layer.

UI не имеет права:

* bypass Risk;
* создавать raw orders;
* менять Risk limits;
* выдавать AI execution authority;
* включать LIVE;
* обходить safety gates.

Любая trading action должна проходить существующую архитектуру:

```text
Strategy
→ TradeIntent
→ Risk
→ Execution
→ Exchange
```

---

# LIVE

LIVE должен оставаться заблокированным.

Control Room не должен предоставлять кнопку, которая обходила бы существующий LIVE gate.

Для Testnet можно отображать статус:

```text
TESTNET READY
```

но реальный execution должен оставаться под существующими safety controls.

---

# DEVELOPMENT WORKFLOW

Ты — supervisor.

Не выполняй всё самостоятельно вручную.

Для implementation tasks используй:

```text
Grok
  ↓
Task Contract
  ↓
DeepSeek
  ↓
Implementation
  ↓
Grok Review
  ↓
Tests
  ↓
Correction if required
```

После завершения одной задачи:

```text
DO NOT STOP
```

Сразу выбирай следующую incomplete task из `AGENT_CONTROL_ROOM_SPEC.md`.

Продолжай до полного Definition of Done.

---

# TESTING

Добавь:

* unit tests;
* event schema tests;
* event normalization tests;
* redaction tests;
* correlation tests;
* event ordering tests;
* reconnect tests;
* UI/backend integration tests;
* realtime transport tests;
* trading event tests;
* agent event tests.

Особенно протестируй:

```text
agent event
→ event bus
→ transport
→ UI
```

и:

```text
trading event
→ event bus
→ transport
→ UI
```

---

# НЕ ДЕЛАЙ FAKE SUCCESS

Запрещено создавать систему, которая визуально показывает:

```text
DeepSeek approved
Grok reviewed
Risk approved
Order executed
```

если эти события фактически не произошли.

Demo/mock mode допускается только как явно отдельный тестовый режим.

Он не должен маскироваться под production/Testnet.

---

# SECURITY

Проверь:

* XSS;
* unsafe rendering;
* log injection;
* secret leakage;
* path traversal;
* arbitrary command execution;
* unsafe API endpoints;
* unauthorized execution;
* WebSocket authentication/authorization;
* exposed internal agent data.

---

# DOCUMENTATION

Создай:

`docs/AGENT_CONTROL_ROOM.md`

Документируй:

* architecture;
* event schema;
* event flow;
* API;
* realtime transport;
* local development;
* terminal UI;
* Web UI;
* security;
* troubleshooting.

---

# FINAL ACCEPTANCE CRITERIA

Система считается завершённой только если:

1. Web Control Room работает.
2. Реальные Kilo agent events отображаются.
3. Grok и DeepSeek визуально различимы.
4. Task lifecycle отображается.
5. Review/correction lifecycle отображается.
6. Trading pipeline отображается.
7. Risk decision отображается.
8. Execution state отображается.
9. Correlation позволяет проследить workflow целиком.
10. Realtime updates работают.
11. Event history сохраняется.
12. Secrets redacted.
13. LIVE остаётся заблокирован.
14. UI не может bypass Risk.
15. Tests проходят.
16. Build/typecheck/lint проходят, если применимы.
17. Documentation создана.
18. Нет fake production events.
19. Git diff проверен.
20. Grok провёл финальный review собственной реализации.

---

# FINAL REPORT

Создай:

`docs/AGENT_CONTROL_ROOM_IMPLEMENTATION.md`

В отчёте:

* architecture;
* files changed;
* event model;
* UI;
* realtime;
* Kilo integration;
* trading integration;
* security;
* tests;
* remaining limitations;
* Definition of Done.

В конце:

```text
AGENT CONTROL ROOM: COMPLETE

Web UI: PASS
Realtime: PASS
Kilo events: PASS/PARTIAL
Grok view: PASS
DeepSeek view: PASS
Trading pipeline: PASS
Correlation: PASS
Security: PASS
Tests: PASS

LIVE: LOCKED
```

Не объявляй COMPLETE без фактической проверки.

Начинай с анализа `docs/AGENT_CONTROL_ROOM_SPEC.md`, затем самостоятельно декомпозируй реализацию и запускай полный autonomous development cycle.

**Не останавливайся после одной фазы.**
