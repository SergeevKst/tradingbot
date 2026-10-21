# ТЗ для Codex: индекс кодовой базы Graphify и навигация для агентов

**Проект:** `SergeevKst/tradingbot` (Bybit Trading Bot)
**Ветка:** `experiment/graphify-flash`
**BASE_SHA:** `55480f79e762b3e1d881fe372155210db2c60e58` (`main`, «Stage 3: live Bybit adapters, AI analysis layer, backtest harness»)
**Исполнитель:** Codex CLI, модель `gpt-5.6-terra` (зафиксирована для эксперимента; менять нельзя)
**Язык артефактов:** русский (идентификаторы, команды, имена файлов и код — английский)

Документ самодостаточен: всё, что нужно для выполнения, изложено здесь. Если чего-то не хватает — фиксируй вопрос в отчёте и действуй по разделу «Условия отказа».

---

## 1. Цель

Сделать так, чтобы будущая сессия Codex (и любого агента) могла ориентироваться в этом репозитории **без чтения всей кодовой базы**: через работающий индекс Graphify, тонкий адаптер-Skill для Codex и короткую навигационную документацию.

Задача — не «написать документацию», а **сделать навигацию воспроизводимой и проверяемой**: индекс пересобирается одной командой, свежесть определяется детерминированно, примеры навигации подтверждены реальным выводом.

---

## 2. Проверенное текущее состояние (факты, не гипотезы)

Всё ниже проверено на `BASE_SHA` в чистом клоне. Ссылки — на реальные файлы и строки.

### 2.1 Репозиторий

- 141 файл `.mjs` в `src/` (~22 900 строк), 40 тестовых файлов `test/*.test.mjs`, 23 `.md`.
- Слои: `src/config`, `src/domain`, `src/risk`, `src/execution`, `src/session`, `src/state`, `src/market`, `src/market-data`, `src/strategy`, `src/backtest`, `src/reconciliation`, `src/recovery`, `src/safety`, `src/telegram`, `src/providers`, `src/testnet`, `src/adapters/bybit`.
- Самые крупные модули: `src/telegram/bot.mjs` (2100), `src/execution/paper-execution-adapter.mjs` (926), `src/telegram/execute.mjs` (821), `src/session/paper-session.mjs` (623), `src/risk/risk-engine.mjs` (549).
- `package.json`: `"type": "module"`, Node `>=20.6`, скрипты `test`, `test:security`, `test:paper`, `paper:test`, `start`. Прод-зависимости: `bybit-official-trading-server`, `grammy`.

### 2.2 Graphify

- Установлен как **uv-tool** `graphifyy` 0.9.71, бинарь: `~/.local/bin/graphify` (вне репозитория, в `package.json` не упомянут).
- Команды, релевантные задаче (проверено `graphify --help`):
  `update <path>` (AST-only, без LLM и без сети), `query "<вопрос>"` (`--budget`, `--dfs`, `--graph`), `path "A" "B"`, `explain "X"`, `affected "X"` (обратный обход, `--depth`), `god-nodes`, `check-update <path>`, `cluster-only`, `extract` (LLM-извлечение — **в этой задаче не используется**).
- `graphify install --platform codex` существует, но пишет в глобальный конфиг пользователя, а не в репозиторий. **Не использовать**: артефакты должны жить в репозитории и быть воспроизводимыми на другой машине.
- Проверено на этом репозитории: `graphify update .` в чистом клоне отрабатывает за **~9 с**, результат — `graphify-out/`: `graph.json` (2,3 МБ, **1566 узлов, 4634 ребра, 66 сообществ**), `graph.html` (1,8 МБ), `GRAPH_REPORT.md` (21 КБ), `.graphify_labels.json`, `cache/`.
- `graphify-out/` в `.gitignore` (строка 10) — индекс **не коммитится**, что правильно, но означает: в свежем клоне индекса нет, и его нужно собрать до первого запроса.
- В `graph.json` **нет метаданных о коммите и времени сборки**: ключи верхнего уровня — только `directed`, `multigraph`, `graph`, `nodes`, `links`, `hyperedges`. Служебный маркер `graphify-out/.graphify_root` содержит единственный символ `.` и свежесть не отражает.

### 2.3 Текущая интеграция с агентами

- `.kilo/plugins/graphify.js` (26 строк) — плагин Kilo/OpenCode: подмешивает в первую bash-команду напоминание, если существует `graphify-out/graph.json`. API плагинов Kilo, **для Codex не применим**.
- `.kilo/kilo.json` содержит **абсолютный путь чужой машины**: `file:///Users/konstantinsergeev/Documents/AI%20projects/tradingbot/.kilo/plugins/graphify.js`. Плагин в этом клоне не подхватится.
- `.kilo/agents/{deepseek-developer,trading-supervisor}.md`, `.kilo/skills/ponytail*` — инструкции другого агента, к Codex отношения не имеют.
- `AGENTS.md` (18 строк): раздел `graphify` (строки 1–12) описывает правила использования графа, раздел `trading safety` (14–18) запрещает ослаблять безопасность ради минимального диффа. **`AGENTS.md` уже читается Codex** — это единственная существующая точка интеграции.
- Каталога `.agents/` в репозитории **нет**.
- `docs/ARCHITECTURE_AUDIT.md:30` фиксирует старый прогон («610 узлов, 1247 рёбер, 31 сообщество» от `999c4ff`), `:237` — что `graphify-out/` устарел и вынесен в `.gitignore`. `.autopilot/ARCHITECTURE.md:28` — ещё более старые цифры (347/939/11 от 2026-09-28). `.autopilot/CURRENT_STATE.md:14` — «Graphify 0.9.71 установлен, карта локальная, `--code-only`, 0 LLM-токенов».
- Вывод: **описания Graphify в репозитории расходятся с текущим состоянием**; ни один сохранённый отчёт не соответствует `BASE_SHA`.

### 2.4 Базовый прогон тестов (эталон для сравнения)

`npm test` на `BASE_SHA` (`node --test "test/**/*.test.mjs"`, без `npm install` — зависимостей для тестов не требуется):

```
# tests 554
# pass 550
# fail 3
# skipped 1
```

Падающие тесты (существовали до задачи, **чинить их не нужно**):

1. `test/telegram-guard.test.mjs` — падает весь файл;
2. `test/telegram-ideas.test.mjs:143` — `S-5: buildScoutPrompt strips instrument from symbols in user payload`;
3. `test/telegram-monitor.test.mjs:55` — `buildMonitorPrompt/buildStopcheckPrompt versions and payload keys`.

**Критерий:** после твоих изменений набор падающих тестов должен совпадать с этим списком. Любой новый провал — регрессия.

---

## 3. Что именно требуется сделать

### 3.1 Проверить и, при необходимости, починить Graphify

1. Убедись, что `graphify --version` = 0.9.71 и `graphify update .` в репозитории отрабатывает (ожидаемо ~10 с, >1000 узлов).
2. Проверь, что индекс **не** содержит секретов и мусора: в графе не должно быть `.env`, ключей, `node_modules`, `data/`, `graphify-out/` самого себя. Проверяемые точки: `graphify-out/graph.json` (`source_file`), вывод `graphify query`.
3. Если `graphify update` падает или даёт пустой граф — чини **минимально** и только в рамках репозитория (конфиг, `.gitignore`, обёртка-скрипт). Заменять Graphify другим инструментом, ставить новые зависимости или использовать LLM-извлечение (`graphify extract`) **запрещено** — при такой необходимости остановись и опиши проблему в отчёте.

### 3.2 Адаптер Skill для Codex

Codex читает репозиторные скиллы из `.agents/skills/<name>/SKILL.md` (поддержка `SKILL.md` и `.agents/skills` есть в бинаре 0.163.0). Требуется:

- создать `.agents/skills/graphify/SKILL.md` — **минимальный адаптер, не копия** оригинального скилла Graphify (≤120 строк);
- YAML-frontmatter: `name: graphify`, `description`, остальные поля — по фактическим требованиям Codex; если хук-проверка Codex отвергает поле — убери его, а не подгоняй формат наугад;
- в теле — только практические правила: когда вызывать граф, как проверить свежесть, как пересобрать, как искать модуль/символ, как смотреть зависимости и затронутые тесты, когда читать исходники напрямую, как не принять устаревший индекс за актуальный.

### 3.3 Воспроизводимый индекс со свежестью

Индекс остаётся **локальным** (`graphify-out/` в `.gitignore`) — большие артефакты в Git не коммитить. Но у него должен появиться надёжный маркер свежести, связанный с Git, потому что сам `graph.json` его не содержит.

Требования:

1. Добавить узкую обёртку `scripts/graphify_index.mjs` (Node ESM, без новых npm-зависимостей), режимы:
   - `node scripts/graphify_index.mjs build` — запускает `graphify update .` и записывает `graphify-out/INDEX_META.json`: `base_sha` (`git rev-parse HEAD`), `built_at` (ISO-8601 UTC), `graphify_version`, `node_count`, `edge_count`, `community_count`, `dirty_tree` (bool);
   - `node scripts/graphify_index.mjs check` — код возврата `0`, если индекс соответствует текущему `HEAD` и рабочее дерево не изменило индексируемые файлы; иначе `1` и внятное сообщение, что пересобрать;
   - `node scripts/graphify_index.mjs show` — печатает мету (необязательный, но полезный режим).
2. `INDEX_META.json` живёт внутри `graphify-out/` (уже в `.gitignore`). Не коммитить.
3. Никакого сетевого доступа, никаких LLM-вызовов, только чтение Git и файлов.
4. Добавить тест `test/graphify-index.test.mjs` на чистых функциях (парсинг меты, сравнение SHA, классификация «свежо/устарело») — без запуска самого `graphify` и без сети. Тест должен проходить на любой машине без Graphify.

### 3.4 Навигационная документация (русский)

Создать `docs/architecture/CODEBASE_NAVIGATION.md`, ответив ровно на 8 вопросов:

1. С чего начинать сессию Codex в этом репозитории (порядок: `AGENTS.md` → Skill → индекс → точечное чтение кода).
2. Как искать нужный модуль через Graphify (`query`, `path`, `explain`, `affected`, `god-nodes`) — с примерами реальных команд.
3. Как проверить свежесть индекса (`scripts/graphify_index.mjs check`, `base_sha` против `HEAD`).
4. Как обновить индекс (`build`), сколько это занимает, что попадает в `graphify-out/`.
5. Как определить затронутые зависимости и тесты (`affected`, соответствие `src/**.mjs` ↔ `test/**.test.mjs`).
6. Когда обязательно читать исходники напрямую (точные значения, инварианты риска, деньги/размеры позиций, ветвление, которого нет в графе).
7. Как не раздувать контекст (`--budget`, `--graph`, отказ от чтения `GRAPH_REPORT.md` без нужды, запрет `cat` целых крупных файлов).
8. Какие части торговой системы требуют особой осторожности: `src/risk/**`, `src/execution/**` (включая `live-guard.mjs`), `src/session/**`, `src/state/**` (персистентность и восстановление), `src/reconciliation/**`, kill switch, `src/config/**` (единственное место чтения `process.env`).

### 3.5 Минимальная правка `AGENTS.md`

Сейчас `AGENTS.md` уже описывает Graphify, но ссылается на путь `graphify-out/` так, будто индекс существует, и молчит о маркере свежести и Skill для Codex. Разрешено добавить/поправить **не более 6 строк**: указатель на `.agents/skills/graphify/SKILL.md`, на `docs/architecture/CODEBASE_NAVIGATION.md` и на `scripts/graphify_index.mjs check`. Не переписывать `AGENTS.md` целиком, не превращать его в свалку.

### 3.6 Доказательства работоспособности (обязательно)

Три реальных примера навигации по этому репозиторию. Для каждого: запрос → возвращённые файлы/символы → зависимости → **сверка с фактическим исходником** (файл + номер строки).

Минимально покрыть:

1. поиск модуля и точки входа Risk Engine (`src/risk/risk-engine.mjs`) и его зависимостей;
2. обратный обход: что затронуто при изменении контракта `TradeProposal` (`src/domain/proposal.mjs`) — включая тесты;
3. навигация от теста к модулю: какой модуль проверяет `test/risk-engine.test.mjs` и какие символы он использует.

Плюс продемонстрировать цикл свежести: `check` до сборки → `build` → `check` после сборки, с реальными кодами возврата.

**Запрещено** заявлять экономию токенов без измерения. Если измерений нет — пиши `NOT AVAILABLE`.

---

## 4. Границы изменений

### Разрешено менять/создавать

```
.agents/skills/graphify/SKILL.md
docs/architecture/CODEBASE_NAVIGATION.md
scripts/graphify_index.mjs
test/graphify-index.test.mjs
AGENTS.md                (не более 6 строк)
.gitignore               (только если нужно, с обоснованием)
docs/agent-experiments/flash/CODEX_EXECUTION_LOG.md   (отчёт, см. §6)
```

### Запрещено

- любые изменения в `src/**` (включая `src/risk/**`, `src/execution/**`, `src/strategy/**`, `src/config/**`, `src/state/**`, `src/session/**`);
- изменения `test/**`, кроме добавления `test/graphify-index.test.mjs`;
- изменения `package.json`, `package-lock.json`, `pnpm-lock.yaml`;
- коммит `graphify-out/` и любых крупных артефактов;
- `.env`, `.env.*`, ключи, токены, секреты — чтение, печать, коммит;
- запуск live-торговли, вызовы Bybit с ключами, `npm run verify:key`, `npm run test:mcp`, `npm run inspect:accounts`, `npm run earn:move`, `npm run paper:simulate`;
- `graphify extract` и любое LLM-извлечение (тратит токены и не нужно);
- `git push`, `git reset --hard`, `git commit --amend`, force-операции, правка `main`;
- установка npm/pip/uv-пакетов, `graphify install --platform *`, правка `~/.codex/**`;
- `--dangerously-bypass-approvals-and-sandbox`, `--yolo`.

### Инварианты, которые нельзя нарушить

- FAIL CLOSED в Risk Engine; `confidence` не влияет на размер позиции; AI не определяет риск.
- Live-исполнение запрещено by construction (`src/execution/live-guard.mjs`).
- Запись на диск в ядре — только `src/state/jsonl-file.mjs`.
- Торговое поведение и логика риск-менеджмента остаются байт-в-байт неизменными.

---

## 5. Порядок выполнения

1. Прочитай `AGENTS.md`, этот документ, `README.md` (разделы про этапы и инварианты).
2. Проверь Graphify: `graphify --version`, `graphify update .`, наличие `graphify-out/graph.json`, число узлов. Зафиксируй цифры в отчёте.
3. Собери индекс через новую обёртку (после её написания) и убедись, что `check` возвращает 0.
4. Напиши `.agents/skills/graphify/SKILL.md` (адаптер, ≤120 строк).
5. Напиши `docs/architecture/CODEBASE_NAVIGATION.md` (8 разделов, русский).
6. Внеси минимальную правку в `AGENTS.md` (≤6 строк).
7. Добавь `test/graphify-index.test.mjs` и прогони его отдельно.
8. Выполни три примера навигации, сохрани фактические выводы команд.
9. Прогони `npm test` и `npm run test:security`, сравни с эталоном §2.4.
10. Проверь `git status` и `git diff --stat`: **ни один файл вне §4** не должен быть изменён.
11. Заполни `docs/agent-experiments/flash/CODEX_EXECUTION_LOG.md` (§6).
12. Сделай один коммит (или несколько логичных) в ветке `experiment/graphify-flash`. Сообщение коммита — английский, формат Conventional Commits, например `docs(graphify): add codex navigation skill and reproducible index`. **Не пушь.**

---

## 6. Отчётность

`docs/agent-experiments/flash/CODEX_EXECUTION_LOG.md`, по-русски, обязательные разделы:

- что проверено и каким выводом команды (с фактическим выводом, не пересказом);
- какие файлы созданы/изменены (`git diff --stat`);
- три примера навигации: запрос, вывод, сверка с исходником (файл:строка);
- цикл свежести: `check` → `build` → `check` с кодами возврата;
- результаты тестов: полные цифры `pass/fail/skipped` и список падающих;
- ограничения индекса (что Graphify не видит: динамические импорты, `.mjs`-вызовы через строки, конфиг-значения, runtime-поведение);
- что осталось нерешённым;
- явный список «не делал» (LLM-извлечение, установка пакетов, правки `src/**`).

---

## 7. Критерии приёмки

Задача считается выполненной, только если **все** пункты подтверждены командами:

1. `graphify update .` в чистом клоне отрабатывает без ошибок, `graphify-out/graph.json` содержит >1000 узлов.
2. `node scripts/graphify_index.mjs build` создаёт `graphify-out/INDEX_META.json` с `base_sha`, равным `git rev-parse HEAD`.
3. `node scripts/graphify_index.mjs check` → код `0` сразу после сборки; после `touch src/risk/risk-engine.mjs` (или изменения рабочего дерева) → код `1` с сообщением о пересборке.
4. `.agents/skills/graphify/SKILL.md` существует, ≤120 строк, содержит команды проверки свежести и пересборки.
5. `docs/architecture/CODEBASE_NAVIGATION.md` содержит все 8 разделов §3.4 и не менее трёх примеров команд Graphify.
6. Три примера навигации подтверждены фактическим выводом и сверены с исходниками.
7. `npm test`: `fail` ровно 3, список падающих совпадает с §2.4; `npm run test:security` без новых провалов.
8. `git diff --stat` в пределах §4; `graphify-out/` не в индексе Git (`git status --porcelain` его не показывает).
9. Ни в одном изменённом файле нет секретов, абсолютных путей чужой машины (`/Users/konstantinsergeev/Documents/...`) и ссылок на live-торговлю.
10. `docs/agent-experiments/flash/CODEX_EXECUTION_LOG.md` заполнен по §6.

---

## 8. Команды проверки

```bash
# индекс
graphify --version                       # ожидается 0.9.71
graphify update .                        # ~10 с, >1000 узлов
node scripts/graphify_index.mjs build
node scripts/graphify_index.mjs check    # код 0

# навигация
graphify query "where is position sizing computed" --budget 800
graphify path "TradeProposal" "risk-engine.mjs"
graphify explain "Risk Engine"
graphify affected "TradeProposal" --depth 2

# тесты
node --test test/graphify-index.test.mjs
npm test
npm run test:security

# границы изменений
git status --porcelain
git diff --stat 55480f79e762b3e1d881fe372155210db2c60e58..HEAD
```

---

## 9. Условия отказа и откат

Остановись, ничего не коммить и опиши блокер в отчёте, если:

- `graphify update .` не работает и починка требует новых зависимостей, сети или LLM;
- для прохождения критериев нужно менять `src/**`, `test/**` (кроме нового теста) или торговую логику;
- `AGENTS.md` или инварианты конфликтуют с требованиями этой задачи;
- требуется доступ к секретам, live-торговле или внешним сервисам.

Правила отката:

- любое неудачное изменение откатывай `git checkout -- <путь>` **только для файлов из §4**;
- не используй `git reset --hard`, `git clean -fdx`, `git push --force`;
- `graphify-out/` можно удалить целиком (`rm -rf graphify-out`) — это локальный артефакт, восстанавливается командой `build`;
- если не удалось выполнить ≥3 критериев приёмки — оставь ветку в консистентном состоянии (собираемый индекс + работающие тесты) и опиши, что именно не сделано.
