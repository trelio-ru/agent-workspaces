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

Один Run имеет один writable task/dossier Workspace и pinned `baseHead`.
Company/project остаются instruction/ACL/owner scopes и не принимаются как
новые material Workspace. Compact MCP tool
`prepare_agent_workspace_run` сначала ищет последний собственный непустой
portable draft на актуальном `acceptedHead`; его `open` claim-ит тот же Run и
fence-ит прежнюю lease. `startNewRun=true` остаётся явным escape hatch для
намеренной независимой параллельной ветки. Если продолжения нет, compact tool
выполняет прежние `ensure` и `start`, до создания Run проверяет и закрепляет
optional related context и возвращает exact `open`, draft checkpoint и compact
`pause` / `finish` commands. Низкоуровневые tools сохраняются для compatibility
и recovery. Все шаги повторно проверяют ACL; Run другого пользователя не
переиспользуется.

До submit обязателен handoff checkpoint с:

- plain-language result;
- evidence/validation;
- durable materials;
- всеми open questions;
- одним next action;
- для task scope – exact semantic `taskOutcome`.

`trelio-workspace finish` вычисляет полный changed-path manifest candidate
относительно pinned base, включая уже закоммиченный и загруженный draft
checkpoint, создаёт handoff и вызывает submit в одной model-facing операции.
Чистый, но непустой saved draft можно завершить без искусственной финальной
правки; candidate head exact base остаётся запрещён. Submit сам делает
heartbeat, собирает только validated delta и принимает candidate только при
совпадении current accepted head с pinned base head.
`WORKSPACE_OUTDATED` требует нового Run и осознанного merge/reapply. Restore
создаёт новый accepted commit со старым деревом и current expected head.

Перед блокирующим вопросом с содержательной локальной дельтой `pause` сначала
сохраняет и загружает полный draft, включая external objects, затем фиксирует
checkpoint с exact draft head. Чистый подготовительный вопрос задаётся без
пустого Git draft. Повторный `open --run` на другом устройстве claim-ит Run;
dirty/diverged local tree не перезаписывается.

Обычный `checkpoint --type draft` тоже переносим: bridge коммитит завершённую
смысловую дельту, проверяет и загружает её через draft endpoint и закрепляет
checkpoint за exact head, не переводя Run в `waiting_for_human`. Агент делает
его после каждого содержательного изменения и до ожидания, границы
реплики/сессии, compaction или передачи работы. Полузаписанное дерево не
становится ни draft milestone, ни канонической accepted revision. Если
сохранённый checkpoint уже содержит готовый итог, `finish` использует его
candidate delta и не требует ещё одного изменения только ради dirty status.

## Task communication

Явная просьба предложить, подготовить или сделать черновик комментария к exact
задаче является самостоятельным native Trelio flow. Она не наследует текущий
maintainer/integration/Run route, в том числе когда приходит дополнительной
репликой во время работы или после compaction. Direct proposal использует exact
`companySlug + projectSlug + taskNumber` и не требует Agent Run. До финального
ответа запрос должен завершиться proposal tool result либо точным blocker;
цитата или обычный текст в ответе не являются proposal.

Manual comment отделён от audit accepted Run. System handoff остаётся
техническим аудитом и agent-readable контекстом. После каждого содержательного
accepted task Run агент один раз вызывает `propose_task_comment`: tool сам
читает fresh public snapshot/state revision и сохраняет обычный человеческий
first-person proposal. Тот же one-call tool работает напрямую по exact task.
Для nuanced correction или нового mention сохраняется legacy read → render
flow с exact hash. Proposal не публикуется автоматически и не блокирует durable
acceptance; text-only publish/dismiss требует явной команды. Указание «только
предложи, не публикуй» подтверждает proposal route, а не разрешает заменить его
обычным copywriting-блоком.

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

Related context и immutable parent context уже существующего legacy Run
pointer-first: `open` не скачивает object bytes. Exact
`context fetch --path` reauthorizes Run, dependency workspace, pinned head и
path. Cache проверяется SHA-256; materialization использует
clonefile/reflink/copy, но не mutable hardlink. Mixed/lone-CR pointer невалиден;
полный LF и CRLF допустимы.

Attach разрешён только для доступных active task/dossier Workspace той же
компании. Дополнительный context – pinned read-only и не смешивается с writable
tree. Workspace discovery сначала использует явные task/dossier связи, затем
один канонический ACL-aware `search` с максимум пятью независимыми
формулировками и exact company scope. Он одним результатом объединяет проекты,
задачи, task comments и accepted task/dossier Workspace files; exact scope
metadata позволяет перейти к dossier/workspace без `list_dossiers`.
Специализированные `search_tasks` и `search_agent_workspace_files` остаются
refinement/compatibility tools для task-only или Workspace-only
неоднозначности, а не последовательными обязательными этапами. Exact task
candidate по-прежнему проверяется через `get_task`; project filter не
применяется к общему context discovery.

## Dossier и meeting

Dossier – agent-only durable subject уровня project/company. Linked task даёт
read-only, но не owner write/Run/link права. Company dossier всегда требует
обоснования и подтверждения широкой видимости. Dossier Workspace не имеет
material parent Workspace; owner metadata отдельно задаёт ACL.

Transfer существующего dossier использует actor-bound
`plan_dossier_transfer` → `apply_dossier_transfer`. Actor независимо управляет
source и target; unfinished/claimable Run блокирует transfer; company target
требует отдельного confirmation. UUID, Git history, revisions и task links
сохраняются.

Meeting – отдельная private agent-only сущность с transcript/result ACL, не
workspace scope. Сначала фиксируется result revision, затем target-grouped
`plan_meeting_context_updates`, exact approved/skipped IDs и только после
confirmation обычные task/dossier Workspace flows. Project допустим только как
цель `create_task`; project/company context update сначала получает exact
досье. Mention/provenance/comment не
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
