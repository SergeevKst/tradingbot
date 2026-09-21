# Bybit Trading Bot

Торговый бот для Bybit (V5 API) + подключённый MCP-сервер, через который агент
(DSH) видит биржу нативно.

## Состояние

- ✅ Официальный MCP-сервер Bybit подключён к DSH и проверен живыми вызовами
- ✅ API-ключи проверены (mainnet, HMAC-SHA256)
- ✅ 348.05 USDT выведены из Earn в торговый аккаунт (UNIFIED), позиций нет
- ⏳ Логика бота, стратегии, бэктест — впереди

## Структура

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
