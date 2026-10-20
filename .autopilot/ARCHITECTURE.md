# ARCHITECTURE

Подтверждено из `README.md` и дерева `src/`. Исходники в этом bootstrap не менялись.

Поток односторонний:

`CONFIG -> DOMAIN -> RISK -> EXECUTION`

Рядом: `MARKET`, `STATE`, `SESSION`.

`TradeProposal` предлагает только side / entry / stop / take. Размер и допуск считает Risk Engine. Paper Executor не решает, можно ли открывать позицию.

Модули:

- `src/config/` — единственное чтение `process.env` (`env.mjs`)
- `src/domain/` — закрытые схемы proposal / account / market / risk result
- `src/risk/` — сайзинг и детерминированный арбитр
- `src/execution/` — paper executor, live-guard, список запрещённых биржевых операций
- `src/market/` — снимки, нормализация шагов, публичный REST-адаптер и офлайн-адаптер
- `src/state/` — локальный PAPER-счёт, дневные счётчики UTC, append-only JSONL
- `src/session/paper-session.mjs` — proposal -> risk -> executor -> persist
- `mcp/` — allowlist и stdio-прокси официального Bybit MCP
- `scripts/` — операционные проверки и PAPER-команды, не ядро
- `test/` — тесты ядра и PAPER-слоя

Запись на диск в ядре разрешена одному модулю: `src/state/jsonl-file.mjs`.

Graphify AST-карта (2026-09-28, без LLM): 347 узлов, 939 рёбер, 11 сообществ. Самый связанный узел: `ConfigError`. Циклов импорта не найдено.
