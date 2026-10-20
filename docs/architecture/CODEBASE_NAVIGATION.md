# Навигация по кодовой базе с Graphify

## Старт будущей сессии

Сначала прочитайте `AGENTS.md`, убедитесь, что вы на нужной ветке, и проверьте
состояние рабочей копии (`git status --short`). Затем проверьте локальный индекс:

```sh
graphify check-update .
git rev-parse HEAD
```

Контрольный маркер задания — `BASE_SHA`
`55480f79e762b3e1d881fe372155210db2c60e58`. Первичная сборка для этой
интеграции была выполнена из рабочего состояния с `HEAD`
`bb89aea5ea0d4709c1a80ba55785c8aa24ec4024` (поверх указанной базы).
Сравнивайте текущий commit с этим маркером и результатом `check-update`: смена
commit сама по себе не доказывает семантическую устарелость, но требует проверить
изменённые файлы. После изменений кода обновляйте индекс.

## Поиск без лишнего контекста

Для вопроса о подсистеме начните с компактного запроса:

```sh
graphify query "Где реализована проверка риска позиции?" --budget 1200
graphify explain "risk-engine.mjs"
graphify god-nodes --top 10
```

`query` находит стартовые узлы и ближайший контекст, `explain` показывает файл,
символы и рёбра узла, а `god-nodes` помогает начать архитектурное исследование
с наиболее связанных компонентов. Не начинайте с чтения всего репозитория или
`GRAPH_REPORT.md`; отчёт нужен для широкого обзора, когда узкий запрос не дал
ответа.

## Свежесть и пересборка

Если `graphify check-update .` сигнализирует обновление, если были изменены
исходники или если результат противоречит рабочему дереву, выполните:

```sh
graphify update .
```

Это AST-only пересборка, не требующая LLM или API-ключей. Артефакты появляются в
`graphify-out/` и остаются вне Git: как минимум `graph.json`, `GRAPH_REPORT.md`,
`graph.html`, `manifest.json`, метаданные меток и кэш. Не добавляйте туда секреты,
`.env`, `node_modules` или временные данные.

## Влияние и тесты

Найдите обратные зависимости так:

```sh
graphify affected "risk-engine.mjs" --depth 2
graphify path "risk-engine.test.mjs" "risk-engine.mjs"
```

`affected` даёт кандидатов на вызывающие модули и тесты, а `path` объясняет
конкретную цепочку. Путь направленный: если он не найден, проверьте порядок
узлов — тест обычно импортирует модуль, а не наоборот. Для каждого кандидата
откройте исходный модуль и тест, прежде чем объявлять тест достаточным.

## Когда нужен исходный код

Граф — средство отбора файлов, не замена ревью. Всегда читайте исходник перед
изменением поведения, подтверждением контракта, анализом fail-closed ветки,
динамического импорта или направления вызова. Это обязательно для Risk Engine
(`src/risk/`), стратегий (`src/strategy/`), исполнения (`src/execution/`),
конфигурации (`src/config/`), журнала и состояния (`src/state/`), а также
логирования. В этих границах нельзя ослаблять валидацию, аудит или контроль
риска; особенно осторожно проверяйте, что AI не определяет риск, а неопределённые
состояния отклоняются.

## Проверенные примеры навигации

Ниже результаты проверки индекса, собранного Graphify 0.9.71. Все результаты
сверены непосредственным чтением указанных файлов; экономия токенов не измерялась.

### 1. Risk Engine и его тест

- Запрос: `graphify explain "risk-engine.mjs"`, затем
  `graphify affected "risk-engine.mjs" --depth 2` и
  `graphify path "risk-engine.test.mjs" "risk-engine.mjs"`.
- Результат: `src/risk/risk-engine.mjs` (42 связи),
  `test/risk-engine.test.mjs`, `src/session/paper-session.mjs`,
  `src/backtest/engine.mjs`, `src/risk/kill-switch.mjs`.
- Зависимости: путь теста — один переход `imports_from` к Risk Engine; обратный
  обход также нашёл `kill-switch.test.mjs` и `risk-exposure.test.mjs`.
- Сверка: `test/risk-engine.test.mjs` действительно импортирует
  `evaluateTrade` из Risk Engine; `risk-engine.mjs` импортирует sizing и
  kill switch, а публичный `evaluateTrade` оборачивает вычисление fail-closed.

### 2. Контракт исполнения и PAPER-реализация

- Запрос: `graphify explain "execution-adapter.mjs"`, затем
  `graphify affected "execution-adapter.mjs" --depth 2` и
  `graphify path "paper-execution-adapter.mjs" "execution-adapter.mjs"`.
- Результат: `src/execution/execution-adapter.mjs`,
  `src/execution/paper-execution-adapter.mjs`,
  `src/execution/testnet-execution-adapter.mjs`, `src/session/testnet-session.mjs`
  и `test/testnet-integration.test.mjs`.
- Зависимости: путь PAPER-адаптера — один `imports_from` к контракту;
  обратный обход добавил экспортный индекс и создателей адаптеров.
- Сверка: PAPER-адаптер действительно импортирует `assertExecutionAdapter`, а
  контракт перечисляет запрещённые операции биржи и требует
  `canPlaceRealOrders === false`.

### 3. Конфигурация и изоляция окружения

- Запрос: `graphify explain "env.mjs"`, затем
  `graphify affected "env.mjs" --depth 2` и
  `graphify path "risk-engine.mjs" "env.mjs"`.
- Результат: `src/config/env.mjs`, `test/security.test.mjs`,
  `test/risk-engine.test.mjs`, `src/config/schema.mjs`, `src/util/logger.mjs`;
  путь Risk Engine проходит через `logger.mjs` к `env.mjs` (два перехода).
- Зависимости: обратный обход выявил тесты конфигурации и безопасности, а также
  импортирующие конфигурацию модули.
- Сверка: `env.mjs` документирует себя единственным местом чтения
  `process.env` и содержит отказ для LIVE-конфигурации; `security.test.mjs`
  читает исходники для контроля архитектурной изоляции.

## Практическая последовательность

Сузьте вопрос через `query`, уточните файл через `explain`, найдите воздействие
через `affected` и цепочки через `path`, после чего прочитайте только выбранные
исходники и тесты. Повторяйте `graphify update .` после изменений кода, а не
полагайтесь на старый снимок.
