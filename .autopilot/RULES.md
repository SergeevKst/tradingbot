# RULES

Подтверждено из `README.md`, `.env.example` и ограничений этого bootstrap.

- Режим по умолчанию: `PAPER`. `LIVE` и неизвестный режим отказывают на старте.
- `ALLOW_LIVE_TRADING` не включает live: ядро live-исполнение запрещает.
- FAIL CLOSED: неизвестное состояние не становится одобрением.
- `confidence` не влияет на размер позиции.
- Внешний источник, включая будущий AI, не расширяет hard risk limits.
- Лимиты из env — hard limits. Промпт их не расширяет.
- PAPER не доказывает прибыльность. Комиссии в config — синтетические заглушки, не тариф Bybit.
- Ядро не вызывает `loadExchangeCredentials()`. Ключи нужны только скриптам в `scripts/`.
- В `src/` нет write-вызовов биржи из списка в `execution-adapter.mjs`.
- Не читать и не менять `.env`. Не коммитить секреты.
- Не делать Bybit write-операции и не подключать live trading без отдельного явного этапа.
- Не менять `src/`, `scripts/` и `package.json` в bootstrap-задачах.
- Не делать `git push` и commit без явной просьбы.
- Ponytail найден, но прямой Kilo adapter не подтверждён. Skill стоит как generic instruction. Для этой системы correctness и safety важнее минимализма: не удалять security, validation, error handling, financial correctness, risk controls, tests, auditability.
- Headroom не включать, пока нет подтверждённой стабильной Kilo-интеграции.
