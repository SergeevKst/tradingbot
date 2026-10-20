# Bybit Trading Bot

Торговый бот для Bybit (V5 API) + подключённый MCP-сервер, через который агент
(DSH) видит биржу нативно.

## Состояние

- ✅ Официальный MCP-сервер Bybit подключён к DSH и проверен живыми вызовами
- ✅ API-ключи проверены (mainnet, HMAC-SHA256)
- ✅ 348.05 USDT выведены из Earn в торговый аккаунт (UNIFIED), позиций нет
- ✅ ЭТАП 1: детерминированное ядро (config + risk + paper), 59 тестов зелёные
- ✅ ЭТАП 2: market data + paper execution + persistent state
- ✅ ЭТАП 3: strategy layer (interface + registry + MA crossover) и operational kill switch
- ✅ ЭТАП 4: risk engine hardening — exposure caps (per-symbol + total), max drawdown, kill switch на уровне движка
- ✅ ЭТАП 5: simulation hardening — pluggable fill model (partial fills), exit-slippage, portfolio/PnL domain snapshots, risk-before-execution, 332 теста зелёные
- ⏳ Бэктест, AI — следующие этапы

## ЭТАП 1 — безопасный фундамент

Никакого live-исполнения, никаких write-вызовов к бирже, никакого AI в контуре
принятия решений. Только детерминированное ядро.

```
src/
├── config/
│   ├── config-error.mjs   типизированная ошибка конфигурации
│   ├── parse.mjs          строгий парсинг env (числа/enum/boolean)
│   ├── trading-mode.mjs   BACKTEST | PAPER | LIVE, default PAPER
│   ├── risk.mjs           риск-лимиты + cross-field валидация
│   └── env.mjs            ЕДИНСТВЕННОЕ место чтения process.env
├── domain/
│   ├── side.mjs           LONG | SHORT (FLAT намеренно не side)
│   ├── reason-code.mjs    machine-readable коды отказа
│   ├── proposal.mjs       TradeProposal: закрытая схема
│   ├── account-state.mjs  снимок аккаунта
│   ├── market-state.mjs   снимок рынка (опционально)
│   └── risk-result.mjs    APPROVED / REJECTED
├── risk/
│   ├── position-sizing.mjs  чистая математика сайзинга
│   └── risk-engine.mjs      детерминированный арбитр риска
├── execution/
│   ├── paper-executor.mjs   симуляция, без Bybit-клиента
│   └── live-guard.mjs       live-исполнение запрещено by construction
├── util/logger.mjs        структурные логи с редакцией секретов
└── index.mjs              bootstrap (config → risk → paper)
test/
├── fixtures.mjs           чистые фабрики фикстур
├── risk-engine.test.mjs   15 требуемых тестов + edge cases
└── security.test.mjs      изоляция ядра, отсутствие write-путей
```

### Инварианты ядра

**FAIL CLOSED** — любое неизвестное состояние, исключение или нечитаемый вход
дают `approved: false`. Нет пути, где неизвестность превращается в одобрение.

**CONFIDENCE ИНЕРТНА** — `confidence` не влияет на размер позиции. 0.99 и 0.51
дают одинаковый сайзинг; тесты 12 и 13 это фиксируют.

**AI НЕ ОПРЕДЕЛЯЕТ РИСК** — внешний источник (человек, стратегия, позже AI)
предлагает только `side / entry / stop / take`. Допустимый риск и размер позиции
считает Risk Engine. Никакой prompt не может расширить hard limits.

### Сайзинг

```
riskAmountUsd       = equity * riskPerTradePct / 100
positionNotionalUsd = riskAmountUsd / stopLossDistanceFraction
```

Затем позиция ужимается по `maxLeverage`, exposure-лимитам (`maxSymbolExposurePct`
на символ и `maxTotalExposurePct` на весь аккаунт, как процент equity) и
доступному балансу. Если после ужатия ноториал оказывается ниже
`minPositionNotionalUsd` — отказ, а не «пыль».

Дополнительные жёсткие гейты: `maxDailyLossPct` (дневной убыток),
`maxDrawdownPct` (просадка от peak equity), лимиты числа позиций/сделок и
kill switch (статический флаг конфига + runtime-состояние, которое передаётся в
движок явно). Любой из них — отказ, без обходных путей.

### Команды

```bash
npm start                    # bootstrap ядра (PAPER по умолчанию)
npm test                     # 332 теста
npm run test:security        # только проверки изоляции
```

```bash
TRADING_MODE=PAPER npm start      # по умолчанию
TRADING_MODE=BACKTEST npm start   # движка бэктеста ещё нет — ничего не запускает
TRADING_MODE=LIVE npm start       # отказ на старте, exit 1
TRADING_MODE=TURBO npm start      # отказ на старте, exit 1
```

### Что НЕ реализовано (намеренно)

Стратегии, AI-промпты, автономный цикл, WebSocket-торговля, реальное
исполнение, управление плечом через API, БД, RAG. Это следующие этапы.

## ЭТАП 2 — market data + paper execution + persistent state

Слой рыночных данных, локальное PAPER-исполнение и переживающее перезапуск
состояние. Реальных ордеров по-прежнему нет: PAPER работает только с локальным
состоянием.

> **PAPER mode does not prove profitability.**
> Зелёные тесты подтверждают целостность механики, а не прибыльность стратегии.
> С ЭТАПА 3 есть детерминированная стратегия (MA crossover) и operational kill
> switch; без флага `--strategy` `paper:simulate` по-прежнему использует
> фиксированную заглушку для проверки конвейера.

### Архитектура

```
CONFIG  ->  DOMAIN  ->  RISK  ->  EXECUTION  ->  (exchange: только чтение)
                 \        |            /
                  MARKET  STATE  SESSION
```

Поток решения строго односторонний:

```
TradeProposal -> PaperAccountState -> открытые позиции -> daily state
              -> Risk Engine -> RiskDecision -> Paper Executor
```

Paper Executor **не решает**, можно ли открывать позицию. Он исполняет то, что
уже одобрил Risk Engine; его собственные отказы — только исполнение (нет bid/ask,
непредставимый размер, позиция уже открыта).

### Новые модули

```
src/market/
├── instrument-info.mjs        InstrumentInfo из биржи (tickSize/qtyStep — НЕ придуманы)
├── market-snapshot.mjs        нормализованный MarketSnapshot + свечи
├── normalize.mjs              normalizePrice/Quantity, validate*Step (детерминированно)
├── market-data-adapter.mjs    порт адаптера
├── static-market-data-adapter.mjs  офлайн-адаптер (тесты)
└── rest-market-data-adapter.mjs    публичные GET-эндпоинты Bybit, без ключей
src/state/
├── paper-position.mjs         позиция + детерминированный uPnL
├── paper-account.mjs          локальный счёт PAPER
├── fee-model.mjs              подключаемая модель комиссий
├── daily-state.mjs            дневные счётчики, явный UTC
├── journal.mjs                append-only JSONL-журнал
├── jsonl-file.mjs             ЕДИНСТВЕННЫЙ модуль, пишущий на диск
└── state-store.mjs            персистентность, fail-closed recovery
src/execution/
├── execution-adapter.mjs      порт + список запрещённых биржевых операций
├── fill-model.mjs             подключаемая модель наполнения (полное/частичное)
└── paper-execution-adapter.mjs  локальное исполнение, SL/TP, слиппедж
src/session/
└── paper-session.mjs          оркестратор: proposal -> risk -> executor -> persist
```

### Модель исполнения

Вход и выход всегда пересекают спред в невыгодную сторону:

```
LONG  entry -> ask     LONG  exit -> bid
SHORT entry -> bid     SHORT exit -> ask
```

Если нужной стороны книги нет — **отказ**, а не выдуманная цена из `lastPrice`.

Комиссии не зашиты в исполнитель: он спрашивает `FeeModel`. Значения по умолчанию
(`0.001`) — **синтетические заглушки**, а не тариф Bybit.

### SL/TP и неоднозначный случай

Триггеры считаются по reference-цене (mark, иначе last) с учётом bid/ask.

Один снапшот не может быть одновременно ниже стопа и выше тейка, поэтому
настоящая неоднозначность возникает только при **разрыве между двумя
наблюдениями**: цена прошла через оба уровня за один интервал. Порядок касания по
данным определить нельзя.

Решение — детерминированное и консервативное: **всегда считается, что первым
сработал стоп**. Случайный или «удачный» выбор запрещён. Факт разрешения
фиксируется в журнале полями `ambiguousTriggerResolvedTo: "STOP_LOSS"` и `note`.

Выход при этом исполняется по фактической стороне книги (bid/ask), а не по
уровню SL/TP — иначе гэп приносил бы незаслуженно хорошую цену.

### Дневное состояние

`tradesToday`, `dailyRealizedPnlUsd`, `dayStartEquityUsd` живут в отдельном слое и
подставляются в Risk Engine автоматически — вручную их передавать не нужно.

Timezone — **явно UTC**, время машины не используется: иначе два процесса в разных
зонах разошлись бы в том, когда сбрасывать лимиты. При переходе на новый UTC-день:
`tradesToday = 0`, `dailyRealizedPnlUsd = 0`, `dayStartEquityUsd = текущая equity`.

### Журнал

Append-only JSONL, по одному событию на строку. События:
`SIGNAL_RECEIVED`, `RISK_ACCEPTED`, `RISK_REJECTED`, `ORDER_SUBMITTED`,
`ORDER_FILLED`, `POSITION_OPENED`, `POSITION_UPDATED`, `STOP_LOSS_FILLED`,
`TAKE_PROFIT_FILLED`, `POSITION_CLOSED`.

Записи строго упорядочены (очередь, а не параллельные дозаписи) — журнал должен
восстанавливать последовательность сделки, а не противоречить себе. Ключи в
`metadata`, похожие на секреты, редактируются перед записью.

### Восстановление состояния

Состояние переживает перезапуск процесса. Различаются два случая:

1. **Файла нет** — действительно новый счёт, используется стартовая equity.
2. **Файл есть, но нечитаем/невалиден** — история неизвестна. Это **жёсткий
   отказ**: система не стартует и не создаёт новый счёт поверх повреждённого.

Молчаливый сброс до 340 USD запрещён: он стёр бы реализованные убытки и заново
открыл все дневные лимиты. Повреждённый файл не удаляется — оператор разбирается
явно. Дополнительно проверяется согласованность счётчиков между блоками account и
daily, а также отсутствие двух позиций по одному символу.

### Ограничения этого этапа

- Одна нетто-позиция на символ. Второй вход в тот же символ отклоняется; разворот
  требует явного закрытия. Запрета на повторную торговлю символом в течение дня
  намеренно **нет**.
- Комиссия — фиксированная ставка из config, не реальный тариф биржи.
- Funding, частичные исполнения, ликвидации не моделируются.
- Только UTC, только `linear` (USDT perpetual), только REST (без WebSocket).
- Плечо и margin mode на бирже не применяются: в PAPER они только рассчитываются.
- Лимиты «работают» настолько, насколько честно локальное состояние; сверки с
  биржей нет, потому что реальных ордеров нет.

### Команды этапа 2

```bash
npm test                      # все тесты
npm run test:paper            # только тесты PAPER-слоя
npm run paper:test            # самопроверка конвейера (офлайн, без сети)
npm run paper:state           # локальный счёт, позиции, хвост журнала
npm run paper:simulate        # полный цикл на живых публичных данных
npm run paper:simulate -- --side SHORT
npm run paper:simulate -- --strategy deterministic-ma-crossover
npm run paper:simulate -- --close
npm run paper:reset -- --confirm-reset   # удаление счёта (нужен флаг!)
```

`paper:reset` без `--confirm-reset` отказывает и ничего не удаляет. Проверка
продублирована внутри state store — обойти её из другого кода нельзя.

## Структура (MCP и скрипты)

```
.env                       секреты (chmod 600, в .gitignore)
.env.example               шаблон без секретов
mcp/tools.allow.json       allowlist инструментов MCP (38 из 382)
mcp/bybit-mcp-proxy.mjs    stdio-прокси: фильтрует tools/list, всё остальное — прозрачно
scripts/verify_bybit_key.mjs    проверка ключей и прав (mainnet + testnet)
scripts/test_mcp_proxy.mjs      проверка фильтрации + живые вызовы через прокси
scripts/list_tools.mjs          список инструментов и их цена в токенах
scripts/inspect_accounts.mjs    read-only обзор всех счетов и Earn-позиций
scripts/earn_to_trading.mjs     выкуп из Earn и перевод в UNIFIED (dry-run по умолчанию)
scripts/paper_state.mjs         локальный PAPER-счёт + позиции + хвост журнала (только чтение)
scripts/paper_reset.mjs         удаление PAPER-состояния (требует --confirm-reset)
scripts/paper_simulate.mjs      полный цикл PAPER на живых публичных данных
scripts/paper_test.mjs          самопроверка инвариантов PAPER без сети
data/paper/                     состояние и журнал PAPER (в .gitignore)
```

## MCP: как это устроено

Используется **официальный** сервер Bybit —
[`bybit-exchange/trading-mcp`](https://github.com/bybit-exchange/trading-mcp),
npm-пакет `bybit-official-trading-server` (публикуется с адресов `@bybit.com`).
Он отдаёт **382 инструмента**, и их JSON-схемы стоят **~116k токенов в каждом
запросе к модели** — это сжигает контекст целиком.

Поэтому между DSH и официальным сервером стоит `mcp/bybit-mcp-proxy.mjs`:

```
DSH (dsh-mcp-client) → bybit-mcp-proxy.mjs → bybit-official-trading-server
                        фильтрует tools/list   вся реальная логика и подпись тут
```

Прокси переписывает **только** ответ `tools/list` (382 → 38 инструментов,
~15k токенов) и блокирует `tools/call` для неразрешённых имён. Все остальные
JSON-RPC сообщения идут байт-в-байт, поэтому реализация, авторизация и поведение
остаются официальными — мы ничего не переизобретаем.

Что открыто: market data, аккаунт/баланс, позиции, ордера (create/amend/cancel/
batch), история, preCheckOrder, DCP. Что закрыто наглухо: вывод средств,
переводы, займы, Earn, P2P, копитрейдинг, WebSocket-подписки.

Набор правится в `mcp/tools.allow.json` (glob-паттерны, `deny` сильнее `allow`).
После правки DSH перечитывает конфиг на лету.

## Проверка

```bash
npm test                  # весь набор (282 теста)
npm run test:paper        # только PAPER-слой (market/state/execution/session)
npm run test:security     # изоляция архитектуры
npm run paper:test        # самопроверка конвейера в форме команды (офлайн)
```

Биржевые (требуют `.env` и ключей):

```bash
npm run verify:key     # ключи + права + срок действия
npm run test:mcp       # фильтрация, блокировка запрещённых, живые вызовы
npm run inspect:accounts  # счета + Earn (только чтение)
npm run earn:move      # выкуп из Earn -> UNIFIED (dry-run; --execute для записи)
```

## Перевод из Earn

`scripts/earn_to_trading.mjs` сделан под необратимость выкупа:

1. выкупает **пробный 1 USDT** и проверяет, куда пришли деньги,
2. выкупает остаток с уже проверенными параметрами,
3. переводит всё из FUND в UNIFIED и печатает балансы до/после.

Каждый шаг перечитывает живые балансы, поэтому скрипт можно запускать повторно.
По умолчанию — dry-run; запись только с флагом `--execute`.

## Известные особенности

- **DCP выключен** (`dcpStatus: OFF`) — защиты от отмены ордеров при обрыве связи нет.
  Включение требует статуса institutional и согласования с аккаунт-менеджером.
- Аккаунт: `REGULAR_MARGIN`, `unifiedMarginStatus 5`, хедж-режим выключен.

Перезапуск MCP внутри DSH: правка `~/.dsh/profiles/web/cordis.patch.yml`
применяется через HMR без рестарта DSH.

## Безопасность

### Изоляция ключей (этап 2)

Торговое ядро **не читает** `BYBIT_API_KEY` / `BYBIT_API_SECRET` — эти имена
встречаются только в `src/config/env.mjs`, и то лишь внутри отдельной функции
`loadExchangeCredentials()`, которую ядро не вызывает. PAPER-режим работает
вообще без ключей: рыночные данные публичны, счёт локальный.

Доступ к ключам нужен только операционным скриптам в `scripts/`.

### Запрещённые операции

Эти вызовы отсутствуют в `src/` (проверяется тестами): `createOrder`,
`batchCreateOrders`, `amendOrder`, `cancelOrder`, `cancelAllOrders`,
`setLeverage`, `setMarginMode`, `setAutoAddMargin`, `setTradingStop`,
`switchPositionMode`. Они перечислены в `execution-adapter.mjs` как явный
список того, что слою исполнения недоступно.

Запись на диск разрешена ровно одному модулю — `src/state/jsonl-file.mjs`.

### Риски ключа

Ключ, выданный для проекта, имеет права `ContractTrade / SpotTrade / Wallet
transfer / Options / Derivatives / Earn`, `readOnly = 0` и **IP-whitelist не
задан** (`ips: ["*"]`). Вывод средств (Withdraw) недоступен — это единственное,
что защищает счёт. Рекомендации:

1. Создать **отдельный ключ под бота** с IP-whitelist и без права Transfer.
2. Для разработки использовать **testnet**-ключи (`BYBIT_TESTNET=true`) —
   текущие ключи testnet не обслуживают (`retCode 10003`).
3. Ключи, отправленные в чат, считаются скомпрометированными — после настройки
   имеет смысл их перевыпустить.

На этапе 2 ни один из этих рисков не реализуется: реальных ордеров нет, вывод
средств не используется, ключи ядром не читаются.

### Текущее состояние счёта

Проверено перед началом этапа 2: UNIFIED, `userID 432483817`, equity ≈ 348 USDT
(после вывода из Earn), `REGULAR_MARGIN`, hedge mode выключен, DCP `OFF`.

**Открытых ордеров и позиций на бирже — ноль.** Проверено через
`getOpenOrders` и `getPositionInfo`. Это важно: ядро этапов 1–2 действительно
офлайн и ничего не выставило.
