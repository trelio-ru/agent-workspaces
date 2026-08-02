# Workspace contracts

## Содержание

- Protected runtime context
- Run, candidate и handoff
- Task-scoped communication
- External objects и related context
- Dossier и meeting
- Controls, worklog и cleanup

## Protected runtime context

Bridge создаёт `AGENTS.md` и `CLAUDE.md` при каждом `open` из одного plugin
template, держит их вне accepted Git/candidate и защищает legacy tracked copies
до server format migration. `CLAUDE.md` содержит только `@AGENTS.md`.
Format v5 использует только `WORKSPACE_CONTEXT.md`. Bridge `1.6.15` принимает
старый `PROJECT_CONTEXT.md` лишь в ограниченном окне между публикацией plugin и
server migration; наличие обоих имён или отсутствие обоих останавливает `open`
как неоднозначное/повреждённое состояние.

Порядок чтения в Run:

1. `context/agent-instructions.md` – pinned compiled platform/company/project
   rules;
2. `context/user-profile.md` – pinned профиль initiating member;
3. optional `context/run-checkpoint.json` – continuation state;
4. writable `WORKSPACE_CONTEXT.md` – устойчивые факты/решения/вопросы;
5. `WORKLOG.md` – формат отдельной записи в `worklog/`.

Context/profile/checkpoint не расширяют ACL и не отменяют system/developer,
approval или company/project policy. Rules/profile публикуются через plan →
exact diff → explicit confirmation → publish и действуют только на будущие
Runs. Нельзя редактировать protected files или скрывать правило в
`WORKSPACE_CONTEXT.md`.

Model/effort policy закрепляется за Run и проверяется до действий. Никогда не
редактировать `.trelio-run.json`, hook или attestation для обхода.

## Run, candidate и handoff

Один Run имеет один writable workspace и pinned `baseHead`. `ensure` и `start`
всегда повторно проверяют ACL; Run другого пользователя не переиспользуется.

До submit обязателен handoff checkpoint с:

- plain-language result;
- evidence/validation;
- durable materials;
- всеми open questions;
- одним next action;
- для task scope – exact semantic `taskOutcome`.

Submit делает heartbeat, собирает только inspected delta и принимает candidate
только при совпадении current accepted head с pinned base head.
`WORKSPACE_OUTDATED` требует нового Run и осознанного merge/reapply. Restore
создаёт новый accepted commit со старым деревом и current expected head.

Перед блокирующим вопросом bridge сначала сохраняет и загружает полный draft,
включая external objects, затем фиксирует checkpoint с exact draft head.
Вопрос задаётся только после server success. Повторный `open --run` на другом
устройстве claim-ит Run; dirty/diverged local tree не перезаписывается.

## Task-scoped communication

Manual comment отделён от audit accepted Run. Для смысловой task-дельты агент:

1. читает `get_task_comment_proposal_context`;
2. получает bounded snapshot фактически опубликованных комментариев Trelio и
   передаёт его exact hash при render;
3. сравнивает net-result только с public snapshot: current draft всегда
   unpublished и не может быть предметом публичного «исправления»;
4. заменяет current draft через `render_task_comment_proposal`, только когда
   после исключения отменённой внутренней работы остаётся смысловая дельта;
5. по явному решению «комментарий не нужен» вызывает
   `dismiss_task_comment_proposal`: task comment/attachment не создаётся, а
   отдельная reviewed boundary не даёт rejected draft всплыть снова;
6. не публикует автоматически и не блокирует Run;
7. в text-only client вызывает `publish_task_comment_proposal` только после
   явной команды.

`create_comment` не используется для proposal. После accepted `filePaths`
содержит только важные final deliverables и полезные intermediate материалы,
не все sources/technical/incidental files. Пользователь может убрать карточку;
ordinary attachments создаются только при publish.

Accepted task Run создаёт системный комментарий из immutable handoff.
Последовательные Runs пользователя группируются в пределах календарного дня,
но каждый Run остаётся раскрываемым.

Task outcome выбирается только по semantic status kind:

- `work_completed` → `review`, fallback `done` при отсутствии review-kind;
- `review_passed` – только успешная проверка уже review-задачи;
- `direct_completion` – explicit permission/rule или self-created/self-assigned;
- `no_status_change` – partial/info/failed review/open questions.

Blocked status transition не отменяет accepted workspace result.

## External objects и related context

Writable binary/large files eager-materialize-ятся. Submit сначала загружает
external objects, сохраняет exact per-file progress и восстанавливает pointers
после `git add --all`. Register/upload идемпотентны; 429 соблюдает
`Retry-After`, каждый retry открывает новый stream. Даже clean tree повторно
готовит candidate, если HEAD отличается от pinned base.

Parent/related context pointer-first: `open` не скачивает object bytes. Exact
`context fetch --path` reauthorizes Run, dependency workspace, pinned head и
path. Cache проверяется SHA-256; materialization использует
clonefile/reflink/copy, но не mutable hardlink. Mixed/lone-CR pointer невалиден;
полный LF и CRLF допустимы.

Search/attach разрешён только для доступных accepted text files той же
компании. Дополнительный context – pinned read-only и не смешивается с writable
tree. Search использует отдельные 5–12 лексических запросов, exact candidates
проверяются через `get_task`.

## Dossier и meeting

Dossier – agent-only durable subject уровня project/company. Linked task даёт
read-only, но не owner write/Run/link права. Company dossier всегда требует
обоснования и подтверждения широкой видимости.

Transfer существующего dossier использует actor-bound
`plan_dossier_transfer` → `apply_dossier_transfer`. Actor независимо управляет
source и target; unfinished/claimable Run блокирует transfer; company target
требует отдельного confirmation. UUID, Git history, revisions и task links
сохраняются.

Meeting – отдельная private agent-only сущность с transcript/result ACL, не
workspace scope. Сначала фиксируется result revision, затем target-grouped
`plan_meeting_context_updates`, exact approved/skipped IDs и только после
confirmation обычные workspace/task flows. Mention/provenance/comment не
раскрывает meeting task participants. Correction создаёт новую result revision
и новый distribution plan.

## Controls, worklog и cleanup

Task controls – date-only проверки, не дополнительные дедлайны. `personal`
виден только actor, `shared` – аудитории задачи. Дата сама не уведомляет.
Shared changes создают system audit, clear additionally notifies audience;
personal changes приватны. Run completion/status change не снимает control.

`WORKLOG.md` создаётся только при отсутствии и не заменяет accepted/custom
версию. Каждый содержательный Run создаёт новую запись; запрещены полная
переписка, chain-of-thought, raw tools, рутинные команды и секреты.

Cleanup удаляет только backend-confirmed terminal, retention-expired и clean
roots. `clean --dry-run` показывает exact paths/bytes. Backend outage – no-op;
active, unknown, dirty roots сохраняются. Object/package caches имеют отдельные
age/LRU/size policies и удаляются только проверенными единицами.
