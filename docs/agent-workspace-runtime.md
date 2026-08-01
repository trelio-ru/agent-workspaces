# Agent Workspace Runtime

## Содержание

- Выбор scope
- Контекст и файлы
- Agent Run
- Task-scoped результат
- Blocker и продолжение
- Restore и cleanup

## Выбор scope

Локальный Trelio-блок `AGENTS.md` задаёт границы поиска, но не выбирает
writable workspace автоматически.

- `task` – результат принадлежит одной задаче;
- `dossier` – долговременный именованный предмет без одной owning task;
- `project` – материал относится ко всему проекту, а не к одному предмету;
- `company` – действительно межпроектный контекст, безопасный для всех
  участников компании.

Если дана canonical task URL или exact coordinates, агент читает задачу
напрямую. Иначе он отправляет одним `search_tasks` 5–12 отдельных лексических
вариантов, проверяет до трёх кандидатов через `get_task` и не выбирает по одному
похожему заголовку.

Company dossier требует конкретной причины и явного подтверждения широкой
видимости. Связанный участник задачи может читать dossier, но не получает
write/Run/link-management права owner scope.

## Контекст и файлы

У Run один writable workspace. Parent company/project и выбранные related
workspace materialize-ятся как pinned read-only context. Каждый target и файл
повторно проходят ACL.

Agent может найти prior context через `search_agent_workspace_files`, прочитать
точный hit и прикрепить workspace через `attach_agent_workspace_context`.
Прямо связанные task/dossier scopes разрешаются отдельно. Контекст не
подмешивается в writable tree.

Крупные и binary файлы writable workspace materialize-ятся полностью. В
read-only context они остаются пятистрочными object pointers до exact
`trelio-workspace context fetch --path <path>`. Bulk hydration запрещена.
Проверенные bytes кэшируются по SHA-256 и копируются без mutable hardlink.

Рекомендуемая структура:

- `sources/` – исходники;
- `work/` – промежуточные материалы;
- `artifacts/` – итоговые результаты;
- `derived/` – OCR и другие извлечённые представления;
- `worklog/` – отдельная человекочитаемая запись каждого содержательного Run.

## Agent Run

1. Trelio создаёт Run с pinned base head, ACL, model policy и immutable
   instruction snapshots.
2. Bridge открывает локальный Git root и защищённые runtime control files.
3. Агент читает `agent-instructions.md`, `user-profile.md`, optional
   `run-checkpoint.json`, затем `WORKSPACE_CONTEXT.md` и `WORKLOG.md`.
4. Значимый прогресс сохраняется checkpoint без chain-of-thought, raw tool
   output и секретов.
5. Перед submit агент проверяет каждый changed path и создаёт handoff с итогом,
   evidence, материалами, вопросами и одним следующим действием.
6. Bridge отправляет candidate delta. Trelio принимает его атомарно, только
   пока current accepted head совпадает с pinned base head.

`WORKSPACE_OUTDATED` не обходится force push: агент начинает новый Run от
current head и осознанно переносит inspected changes. Restore создаёт новую
accepted revision со старым деревом, не переписывая историю.

## Task-scoped результат

Task handoff содержит semantic outcome:

- `work_completed` – обычное выполнение: переход в `review`, а при отсутствии
  такого kind – в `done`;
- `review_passed` – успешная проверка уже review-задачи;
- `direct_completion` – только по явному разрешению/правилу или для задачи,
  которую тот же пользователь поставил сам себе;
- `no_status_change` – частичный/информационный результат, failed review или
  открытые вопросы.

Accepted Run создаёт группируемый системный комментарий из immutable handoff.
Manual task comment не является условием submit.

Для смысловой дельты агент использует один revisioned proposal. MCP App даёт
редактируемый текст и кнопку «Опубликовать»; text-only клиент публикует только
после явной команды. После accepted можно предложить только важные итоговые и
действительно полезные промежуточные файлы. Пользователь может убрать любой;
attachments создаются при публикации, а не при render.

## Blocker и продолжение

Перед вопросом, без которого нельзя продолжить, bridge сначала готовит и
загружает validated draft, включая external objects, затем создаёт blocker с
exact summary/question/next action и `draftHead`. Только после успешной записи
агент задаёт вопрос.

Другой компьютер может claim-нуть тот же Run и получить draft плюс read-only
`context/run-checkpoint.json`. Полная переписка не переносится. Dirty или
diverged локальное дерево никогда не перезаписывается автоматически.

## Restore и cleanup

`trelio-workspace clean --dry-run` показывает exact terminal roots и
reclaimable bytes. Удаляются только retention-expired, backend-confirmed и
локально чистые Runs. Active, unknown и dirty roots сохраняются; backend outage
делает auto-prune no-op.

Object cache очищается по возрасту/LRU/лимиту, signed runtime packages – только
целыми проверенными digest-каталогами. Успешный submit лишь помечает Run
eligible, но не удаляет его сразу.
