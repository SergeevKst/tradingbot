# Bybit Trading Bot

Торговый бот для Bybit (V5 API) + подключённый MCP-сервер, через который агент
(DSH) видит биржу нативно.

## Состояние

- ✅ Официальный MCP-сервер Bybit подключён к DSH и проверен живыми вызовами
- ✅ API-ключи проверены (mainnet, HMAC-SHA256)
- ✅ 348.05 USDT выведены из Earn в торговый аккаунт (UNIFIED), позиций нет
- ✅ ЭТАП 1: детерминированное ядро (config + risk + paper), 59 тестов зелёные
- ⏳ Стратегии, market data, бэктест, AI — следующие этапы

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

Затем позиция ужимается по `maxLeverage` и доступному балансу. Если после ужатия
ноторн оказывается ниже `minPositionNotionalUsd` — отказ, а не «пыль».

### Команды

```bash
npm start                    # bootstrap ядра (PAPER по умолчанию)
npm test                     # 59 тестов
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

Ключ, выданный для проекта, имеет права `ContractTrade / SpotTrade / Wallet
transfer / Options / Derivatives / Earn`, `readOnly = 0` и **IP-whitelist не
задан** (`ips: ["*"]`). Вывод средств (Withdraw) недоступен — это единственное,
что защищает счёт. Рекомендации:

1. Создать **отдельный ключ под бота** с IP-whitelist и без права Transfer.
2. Для разработки использовать **testnet**-ключи (`BYBIT_TESTNET=true`) —
   текущие ключи testnet не обслуживают (`retCode 10003`).
3. Ключи, отправленные в чат, считаются скомпрометированными — после настройки
   имеет смысл их перевыпустить.

Баланс аккаунта сейчас практически нулевой (~$0.03: 0.68 NIGHT, 0.008 XRP,
пыль BTC/USDT) — для живой торговли счёт нужно пополнить.
