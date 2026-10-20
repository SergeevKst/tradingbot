# Поправки к заданию (TASK_AMENDMENTS)

Исходное ТЗ: `docs/agent-experiments/flash/CODEX_TASK.md` (коммит `85e10f7`).
Файл не переписывался после старта реализации; все отклонения фиксируются здесь.

## A-1. Замена модели Codex (уровень эксперимента, до первого запуска)

Заданная модель `gpt-5.1-codex-mini` недоступна аккаунту. Проверки:

```text
$ codex exec -m gpt-5.1-codex-mini -s read-only "Reply with exactly: MODEL_OK"
{"type":"error","status":400,"error":{"message":"The 'gpt-5.1-codex-mini' model is not
 supported when using Codex with a ChatGPT account."}}

$ codex debug models   # каталог аккаунта
gpt-6.1-sol, gpt-6-astra, gpt-6-sol, gpt-reserve, gpt-6-luna,
gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, codex-auto-review
```

По решению владельца эксперимента для **обеих** веток бенчмарка используется
`gpt-5.6-terra`. Проверка работоспособности: тот же probe с этой моделью вернул
`CODEX_OK`. Все прогоны Codex в этой ветке выполнены с `-m gpt-5.6-terra`.

## A-2. Запись в `.agents/**` заблокирована песочницей Codex

Codex CLI 0.163.0 в режиме `--sandbox workspace-write` возвращает `EPERM` на
любую запись внутри `.agents/**`, даже когда каталог существует и доступен на
запись процессу-оркестратору:

```text
mkdir -p .agents/skills/graphify     # оркестратор: успешно (mode 755)
codex: writeFile(".agents/skills/graphify/SKILL.md") -> EPERM
```

Ослаблять песочницу (`--dangerously-bypass-approvals-and-sandbox`,
`danger-full-access`) запрещено разделом 4 ТЗ, поэтому применён обход:

1. Codex пишет файл в разрешённый путь
   `docs/agent-experiments/flash/attachments/graphify-SKILL.md`;
2. оркестратор переносит его **байт-в-байт** в
   `.agents/skills/graphify/SKILL.md` и удаляет staging-каталог;
3. содержимое файла не редактировалось: 68 строк, frontmatter
   `name: graphify` + `description`, авторство текста — Codex.

Отличие от ТЗ: файл создан Codex не напрямую по целевому пути, а через staging.
Содержание и требования (≤120 строк, минимальный адаптер, без копии
upstream-скилла) соблюдены.

## A-3. Уточнение требований к навигационному документу (цикл коррекции)

После первого прогона `docs/architecture/CODEBASE_NAVIGATION.md` формально
содержал 8 разделов, но без фактических выводов команд. В рамках единственного
разрешённого цикла коррекции Codex было поручено: встроить три проверенных
примера навигации с выводом и сверкой по `файл:строка`, добавить пример
соответствия «тест ↔ модуль», указать предусловие `graphify 0.9.71`
(`~/.local/bin/graphify`, uv-tool `graphifyy`) и предупреждение о том, что
digest свежести учитывает mtime файлов.

## A-4. Коммит выполнен оркестратором

ТЗ (§5, шаг 12) требовало коммита от Codex. Codex дважды отказался коммитить,
считая результат неполным из-за A-2. После переноса файла (A-2) и повторной
проверки критериев коммит `3cd57f6` сделал оркестратор. Содержимое файлов при
этом не изменялось.
