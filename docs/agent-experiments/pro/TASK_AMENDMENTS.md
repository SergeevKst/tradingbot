# Поправки к заданию — эксперимент `PRO`

> Файл фиксирует отклонения от исходного задания, возникшие **до** старта
> исполнения, и любые уточнения в ходе работы. Исходная спецификация
> (`CODEX_TASK.md`) не переписывается молча.

## Поправка №1 — замена фиксированной модели Codex (до старта)

- **Причина:** зафиксированная в исходном задании модель `gpt-5.1-codex-mini`
  недоступна на аккаунте Codex (auth-режим `chatgpt`). Проверено двумя способами:
  1. `codex debug models` — в каталоге модели нет (доступны только:
     `gpt-6.1-sol`, `gpt-6-astra`, `gpt-6-sol`, `gpt-reserve`, `gpt-6-luna`,
     `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `codex-auto-review`);
  2. прямой запуск `codex exec -m gpt-5.1-codex-mini` вернул
     `400 invalid_request_error: The 'gpt-5.1-codex-mini' model is not supported
     when using Codex with a ChatGPT account.`
- **Решение:** по явному разрешению оператора бенчмарка (вопрос через Hermes,
  выбран вариант `gpt-5.6-terra`) для **обоих** экспериментов используется модель
  **`gpt-5.6-terra`**.
- **Проверка:** `codex exec -m gpt-5.6-terra -s read-only --json "Reply with
  exactly: OK"` вернул `OK` (exit 0). Модель также совпадает с дефолтом в
  `~/.codex/config.toml` (`model = "gpt-5.6-terra"`).
- **Зафиксированная версия CLI:** `codex-cli 0.163.0`.

## Прочие замечания (контекст, не поправки)

- BASE_SHA определён как `55480f79e762b3e1d881fe372155210db2c60e58` (голова
  `origin/main` и merge-base с веткой конкурирующего эксперимента
  `experiment/graphify-flash`).
- Работа ведётся в изолированном клоне; ветка `experiment/graphify-pro` создана от
  BASE_SHA. Клон и ветка не пересекаются с рабочей копией конкурирующего
  эксперимента.
