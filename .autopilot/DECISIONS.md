# DECISIONS

## 2026-09-28 — trading-supervisor

Пользователь задал primary-агента `trading-supervisor` на `xai/grok-4.7`.

Он планирует, делегирует, проверяет и принимает или отклоняет. Production code пишет только `deepseek-developer`. Этого агента ещё нет. Пока его нет, supervisor останавливается и не пишет `src/` сам.

Целевой контур, которого в коде ещё нет: Market Data -> Context Builder -> AI Analyst -> Trade Proposal -> AI Review -> Deterministic Risk Engine -> Execution. Текущая архитектура по-прежнему CONFIG -> DOMAIN -> RISK -> EXECUTION. AI не является Risk Engine. До отдельного разрешения только PAPER.

## 2026-09-30 — STRAT-001 Strategy Layer

Добавлен слой стратегий (`src/strategy/`): `Strategy` (`evaluate(MarketContext) -> TradeProposal | null`), `MarketContext` (symbol, candles, instrument, минимальные индикаторы SMA/ATR), `StrategyRegistry` (`register/get/tryGet/list`) и первая детерминированная стратегия `deterministic-ma-crossover` (без AI, без сети, без часов).

`paper-session.mjs` получил аддитивный метод `submitFromStrategy({ market, strategyId? })`: он строит контекст, запускает стратегию из реестра и передаёт её предложение в неизменённый risk -> execution путь. `null` от стратегии = no-signal, ничего не рискуется; исключение стратегии трактуется как no-signal (fail closed). Risk Engine остаётся единственным gate; risk/execution/live-guard не менялись. Тесты: `test/strategy/strategy.test.mjs` (6 шт.), `npm test` 182/182.
