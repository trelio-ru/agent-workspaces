# Agent Workspace Runtime

## Содержание

- Выбор scope
- Контекст и файлы
- Read-only inspection без Run
- Agent Run
- Task-scoped результат
- Blocker и продолжение
- Restore и cleanup

## Выбор scope

Локальный Trelio-блок `AGENTS.md` задаёт company/control-plane binding, но не
выбирает writable Workspace автоматически. Workspace-контекст ищется без
project-фильтра, потому что полезные связи могут быть межпроектными.

- `task` – результат принадлежит одной задаче;
- `dossier` – долговременный именованный предмет без одной owning task;

Project/company не являются material Workspace: это scope правил, ACL и owner
досье. Project-wide материал сохраняется в project dossier, а действительно
межпроектный и безопасный для всех участников – в явно подтверждённый company
dossier.

Если дана canonical task URL или exact coordinates, агент читает задачу
напрямую. Иначе он отправляет одним каноническим `search` до пяти отдельных
лексических вариантов в exact company scope. Один ответ объединяет проекты,
активные и архивные задачи, task comments и accepted task/dossier Workspace
files с exact scope metadata. Агент читает relevant документы, проверяет
одну вероятную задачу через `get_task`, а 2-20 уже известных exact-задач –
одним `get_tasks`; повторять `get_task` для такого набора нельзя. Агент не
выбирает цель по одному похожему заголовку.
`search_tasks` и `search_agent_workspace_files` нужны только для task-only или
Workspace-only уточнения, а не как обязательная последовательность.

Если backend вернул structured `MCP_SEARCH_TIMEOUT`, соединение с Trelio уже
состоялось: это ограничение времени read-only SQL, а не HTTP 504, OAuth или
Hooks. Агент не повторяет тот же широкий поиск три раза. Допустим один более
узкий retry с exact `companySlugs`, максимум двумя сильнейшими отдельными
формулировками и `projectSlugs` только для уже известной task-only границы. Если
scope нельзя сузить честно либо timeout повторился, агент просит недостающий
company/project discriminator. Bare HTTP 504 остаётся transport failure.

Правила компании и проекта не входят в поисковый ranking. После выбора exact
scope обычные `fetch`, `get_dossier`, `get_project_meta` и
`get_task_create_meta` возвращают envelope `effectiveInstructions`. Task reads
используют schema v3: уникальные инструкции находятся один раз в
`effectiveInstructions.layers`, а каждый элемент `tasks[]` задаёт собственный
точный порядок через `instructionScope.orderedLayerKeys`. Агент применяет только
привязанные слои и не переносит project/company/profile rules между задачами;
compact core читается из `structuredContent`, а `task.deferredSections`
направляет один выборочный `get_task_sections` к нужным comments, checklists,
attachments, controls или другим тяжёлым данным. Supplemental read не повторяет
authority/core, а компактный `content` не дублирует payload. Статус `loaded` применяется сразу, без отдельного
`get_agent_instructions`; `requires_scope` запускает стандартный consent и
повторное чтение правил. Внутри уже подготовленного Run более новая revision из
exact read не заменяет pinned `agent-instructions.md` и `user-profile.md` этого
Run. Schema v1/v2 не поддерживаются plugin `1.14.2`: совместимая пара
plugin/backend обязана использовать schema v3 и `get_task_sections`, а version
mismatch завершается обновлением вместо fallback к монолитному payload.

Company dossier требует конкретной причины и явного подтверждения широкой
видимости. Связанный участник задачи может читать dossier, но не получает
write/Run/link-management права owner scope.

## Контекст и файлы

У Run один writable task/dossier Workspace. Только явно выбранные related
task/dossier Workspace materialize-ятся как pinned read-only context. Каждый
target и файл повторно проходят ACL. Старый Run может сохранять immutable
legacy parent company/project snapshots, но новый Run их не наследует.

Agent сначала читает явные task/dossier связи, затем при необходимости одним
unified `search` с несколькими формулировками ищет prior context во всех
доступных проектах exact компании. Он читает точные Workspace hits и передаёт
до 20 materially relevant workspace IDs в
`prepare_agent_workspace_run.relatedWorkspaceIds`. Workspace-only уточнение
может использовать `search_agent_workspace_files`. Tool проверяет все цели и
закрепляет их до создания Run. Legacy `attach_agent_workspace_context` остаётся
для продолжения уже открытого старым клиентом Run. Прямо связанные
task/dossier scopes разрешаются отдельно. Контекст не подмешивается в writable
tree.

Если exact задача и одно досье образуют долговременный общий предмет, Worker
сам создаёт task/dossier link без формального подтверждения: нужны минимум два
независимых устойчивых идентификатора, отсутствие конкурирующего кандидата и
пригодность всего принятого содержимого для аудитории `task_full`. Связь
намеренно открывает этим текущим и будущим участникам read-only доступ ко всему
досье, в том числе из другого проекта, но не owner-project/write/Run/link права.
После mutation агент сообщает текущему пользователю объекты, evidence и access
effect без автоматического task comment. Несколько кандидатов, один признак,
временная релевантность или сомнение в whole-dossier disclosure требуют вопроса;
weak hit игнорируется, а partial fit получает более узкий контекст.

Крупные и binary файлы writable workspace materialize-ятся полностью. В
read-only context они остаются пятистрочными object pointers до exact
`trelio-workspace context fetch --path <path>`. Bulk hydration запрещена.
Проверенные bytes кэшируются по SHA-256 и копируются без mutable hardlink.

Для запроса только на чтение `prepare_agent_workspace_read` возвращает exact
`trelio-workspace inspect` command. Она materialize-ит current accepted head и
актуальные `agent-instructions.md` / `user-profile.md` в private read-only
каталоге без Agent Run, lease, checkpoint или task mutation. Encrypted bundle
остаётся ciphertext на backend и открывается только локальным bridge. Агент
читает authority snapshots до accepted файлов, не редактирует inspection root
и не просит пользователя вручную запускать Run ради доступа к материалам.
Writable intent позже начинает отдельный обычный `prepare_agent_workspace_run`.

Рекомендуемая структура:

- `sources/` – исходники;
- `work/` – промежуточные материалы;
- `artifacts/` – итоговые результаты;
- `derived/` – OCR и другие извлечённые представления;
- `worklog/` – отдельная человекочитаемая запись каждого содержательного Run.

## Agent Run

1. Агент вызывает `prepare_agent_workspace_run` один раз для exact task или
   dossier; Trelio обеспечивает Workspace и создаёт Run с pinned base head, ACL, model policy, immutable
   instruction snapshots и related context. Native Trelio discovery не требует
   `search_agent_skills` или `list_agent_skills`; catalog search нужен только
   перед подключённым внешним сервисом, а full list – для явной инвентаризации.
2. Bridge открывает локальный Git root и защищённые runtime control files.
3. Агент читает `agent-instructions.md`, `user-profile.md`, optional
   `run-checkpoint.json`, затем `WORKSPACE_CONTEXT.md` и `WORKLOG.md`.
4. Дополнительный checkpoint создаётся только для реально полезной точки
   продолжения. Dirty blocker сохраняется одной `trelio-workspace pause`; чистый
   подготовительный вопрос не создаёт пустой draft.
5. Агент завершает работу одной `trelio-workspace finish`: bridge проверяет и
   печатает changed paths, создаёт handoff с итогом, evidence, материалами,
   вопросами и одним следующим действием, продлевает lease и отправляет
   candidate.
6. Trelio принимает candidate атомарно, только пока current accepted head
   совпадает с pinned base head.

`WORKSPACE_OUTDATED` не обходится force push: агент начинает новый Run от
current head и осознанно переносит inspected changes. Restore создаёт новую
accepted revision со старым деревом, не переписывая историю.

## Task-scoped результат

Task handoff содержит semantic outcome:

- `work_completed` – вся задача готова; recommendation для `review`, а при
  отсутствии такого kind – для `done`;
- `review_passed` – recommendation для `done` после успешной проверки уже
  review-задачи;
- `direct_completion` – recommendation для `done` только по явному
  разрешению/правилу или для задачи, которую тот же пользователь поставил сам
  себе;
- `no_status_change` – safe default для частичного/информационного результата,
  failed review или открытых вопросов.

Accepted Run сохраняет outcome, но не меняет статус. Прямое поручение агенту
может быть лишь частью задачи, поэтому readiness оценивается отдельно по описанию,
чек-листам, вопросам и контексту задачи.

Accepted Run создаёт группируемый системный комментарий из immutable handoff –
это технический аудит и контекст для агентов. После каждого содержательного
accepted task Run агент отдельно вызывает `propose_task_comment` один раз и
готовит обычный комментарий для людей. Server сам читает свежий public-comments
snapshot и optimistic proposal revision. Для сложной коррекции, сравнения с
публичной дискуссией или нового mention сохраняется двухшаговый
context/render-flow.

MCP App даёт редактируемый текст и кнопку «Опубликовать»; text-only клиент
публикует только после явной команды. В proposal включаются только важные
итоговые и действительно полезные промежуточные файлы. Пользователь может
убрать любой; attachments создаются при публикации, а не при подготовке.

Если вся задача готова, агент независимо читает
`get_task_status_proposal_context` и вызывает `render_task_status_proposal` с
expected revision/current status и конкретной причиной. Пользователь отдельно
оставляет статус или применяет выбранный переход. Partial work не создаёт эту
карточку, но всё равно получает comment proposal. Immediate status tool
допустим только после прямой однозначной команды изменить exact задачу на exact
статус сейчас с literal `userExplicitlyRequestedImmediateStatusChange=true`;
accepted Run, вывод агента и условное «когда закончишь» этого права не дают.

## Blocker и продолжение

Перед вопросом, без которого нельзя продолжить dirty Run, `pause` сначала
готовит и загружает validated draft, включая external objects, затем создаёт
blocker с exact summary/question/next action и `draftHead`. Только после
успешной записи агент задаёт вопрос. Если изменений ещё нет, вопрос задаётся
сразу без искусственного checkpoint.

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
