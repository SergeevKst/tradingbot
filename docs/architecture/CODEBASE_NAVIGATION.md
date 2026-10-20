# Навигация по кодовой базе

## 1. С чего начинать сессию

Порядок обязателен: `AGENTS.md` → `.agents/skills/graphify/SKILL.md` →
проверка локального индекса → точечное чтение кода. Предварительное условие:
установленный uv-tool `graphify` версии 0.9.71 доступен как
`~/.local/bin/graphify`; он не является зависимостью `package.json`.

## 2. Поиск модуля через Graphify

```bash
graphify query "where is position sizing computed" --budget 800
graphify explain "src/risk/risk-engine.mjs"
graphify path "A" "B"
graphify affected "src/domain/proposal.mjs" --depth 2
graphify god-nodes
```

`query` начинает поиск, `explain` раскрывает узел, `path` показывает связь,
`affected` делает обратный обход, `god-nodes` выявляет наиболее связанные узлы.
Имена должны быть однозначны: в текущем индексе `TradeProposal` неоднозначен,
поэтому для контракта используется путь `src/domain/proposal.mjs`.

## 3. Проверка свежести индекса

```bash
node scripts/graphify_index.mjs check
```

Код `0` означает совпадение `base_sha` из `graphify-out/INDEX_META.json` с
`git rev-parse HEAD` и digest входов. Код `1` требует пересборки. Digest
включает содержимое и mtime индексируемых файлов: любое `touch` делает индекс
устаревшим, даже без изменения текста.

## 4. Обновление индекса

```bash
node scripts/graphify_index.mjs build
```

Обёртка запускает AST-only `graphify update .`; обычно это около 10 секунд.
В игнорируемом Git каталоге `graphify-out/` создаются `graph.json`,
`graph.html`, `GRAPH_REPORT.md`, cache и `INDEX_META.json`. Их не коммитируют.

## 5. Затронутые зависимости и тесты

Используйте `affected` для кандидатов, затем подтверждайте imports в коде и
тестах. Конкретное соответствие: `test/risk-engine.test.mjs` импортирует
`evaluateTrade` из `src/risk/risk-engine.mjs` на строке 10; также тестирует
`REASON_CODE` (строка 11) и использует fixtures `longProposal`, `shortProposal`,
`accountState`, `riskLimits` (строка 14).

## 6. Когда исходники обязательны

Читайте исходник для точных значений, инвариантов риска, денег и размеров
позиций, а также ветвлений, которых нет в графе. Нельзя выводить из графа
разрешение сделки или формулу размера позиции.

## 7. Как не раздувать контекст

Начинайте с малого `--budget`; `--graph` добавляйте только когда нужна форма
связей. Не читайте `GRAPH_REPORT.md` без необходимости и не открывайте целые
крупные файлы: читайте только подтверждающие диапазоны строк.

## 8. Участки, требующие особой осторожности

Особая осторожность нужна в `src/risk/**`, `src/execution/**` (включая
`live-guard.mjs`), `src/session/**`, `src/state/**` (персистентность и
восстановление), `src/reconciliation/**`, kill switch и `src/config/**`.
Только `src/config/**` читает `process.env`.

## Проверенные примеры навигации

1. `graphify explain "src/risk/risk-engine.mjs"` вернул
   `src/risk/risk-engine.mjs:L1`, `evaluateTrade()` (L58), входящий
   `test/risk-engine.test.mjs:L10` и зависимости `risk.mjs:L27`,
   `proposal.mjs:L30`, `kill-switch.mjs:L36`. Сверка: в
   `src/risk/risk-engine.mjs:27`, `:30`, `:36` находятся эти imports, а
   `evaluateTrade` экспортируется на `:58`.
2. `graphify affected "src/domain/proposal.mjs" --depth 2` вернул
   `risk-engine.mjs [imports_from] src/risk/risk-engine.mjs:L30`,
   `evaluateTradeUnsafe() [calls] ...:L101`,
   `risk-engine.test.mjs [imports_from] test/risk-engine.test.mjs:L10` и
   `risk-exposure.test.mjs:L13`. Сверка: `PROPOSAL_FIELDS` и
   `validateProposal` находятся в `src/domain/proposal.mjs:25` и `:145`;
   валидатор импортирован в `src/risk/risk-engine.mjs:30`.
3. `graphify query "test/risk-engine.test.mjs imports and symbols" --budget 1200`
   вернул `test/risk-engine.test.mjs`, `src/risk/risk-engine.mjs`,
   `REASON_CODE`, `DEFAULT_RISK_LIMITS` и `proposal.mjs`. Сверка: тест
   импортирует `evaluateTrade` на `test/risk-engine.test.mjs:10`,
   `REASON_CODE` на `:11` и fixtures на `:14`.
