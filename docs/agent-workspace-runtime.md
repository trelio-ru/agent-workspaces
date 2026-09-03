# Agent Workspace Runtime

## Содержание

- Выбор scope
- Локальные вложения
- Контекст и файлы
- Read-only inspection без Run
- Agent Run
- Task-scoped результат
- Blocker и продолжение
- Restore и cleanup

## Выбор scope

Локальный Trelio-блок `AGENTS.md` задаёт company/control-plane binding и место
для новых локальных roots, но не выбирает identity writable Workspace
автоматически. Workspace-контекст ищется без project-фильтра, потому что
полезные связи могут быть межпроектными.

Папка онбординга – отдельная обычная non-Git точка входа. Она не связывает
репозиторий с Trelio: контекст приходит из правил компании и выбранного проекта,
точной задачи или воркспейса. Строго пустую Git-оболочку,
которую успел создать host, onboarding отделяет recoverable-переименованием
`.git` и сообщает путь резервной копии. При любом коммите, remote, ref,
tracked/staged-файле, parent worktree или неоднозначном состоянии настройка не
меняет репозиторий и требует отдельную папку без Git. Standalone Git нужен
bridge для его временных и Run-репозиториев, а не самой папке онбординга.

Production bridge использует `https://trelio.ru` как canonical control plane.
После compatibility он делает один authenticated content-free routing lookup по
exact company slug либо Workspace UUID. Ответ переводит data requests на
`https://e2ee.trelio.ru` только для live state `encrypted`; plain, transition и
failed state не меняют origin. Выбранный alternate сохраняется в private Run
metadata и применяется ко всем последующим Workspace/company-context/payload
операциям, тогда как OAuth, pairing, compatibility и Agent Secrets остаются на
canonical origin. Любой другой hostname или URL с path/query/credentials
отклоняется до отправки bearer token.

- у каждой задачи не больше одного канонического воркспейса;
- долговременный именованный воркспейс имеет primary owner – один проект или
  компанию – и может дополнительно связываться с любым числом проектов и задач
  той же компании;
- один Run всегда записывает ровно в один воркспейс; остальные выбранные
  воркспейсы закрепляются только как read-only context.

Project-wide материал по умолчанию сохраняется в воркспейсе проекта. Материал,
который действительно нужен нескольким проектам, можно связать с каждым из них,
не меняя primary project и закрепляемые правила. Company owner выбирается только
для контекста, безопасного для всех активных участников компании.

Если дана canonical task URL или exact coordinates, агент читает задачу
напрямую. Иначе он отправляет одним каноническим `search` до пяти отдельных
лексических вариантов в exact company scope. Один ответ объединяет проекты,
активные и архивные задачи, task comments, именованные воркспейсы и accepted
Workspace files с exact metadata. Агент читает relevant документы, проверяет
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
scope обычные `fetch`, `get_workspace`, `get_project_meta` и
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
Run. Schema v1/v2 не поддерживаются: совместимая пара plugin/backend обязана
использовать schema v3 и `get_task_sections`, а version
mismatch завершается обновлением вместо fallback к монолитному payload.

ACL воркспейса – union primary owner и явных project/task links. Exact read
проекта или задачи даёт read воркспейса, exact edit – write/Run; project
observer остаётся read-only. Каждый активный участник компании читает
company-owned воркспейс, а write/Run через owner scope остаётся у owner/admin.
Derived access никогда не даёт transfer/link/reshare права и не раскрывает
primary project. Registry/contact/meeting связи semantic и сами доступ не
расширяют. Company workspace требует конкретной причины и явного подтверждения
широкой видимости.

## Локальные вложения

Task attachment с доступным локальным файлом не кодируется в base64 для MCP.
Только для exact выбранного пользователем или созданного агентом файла агент
передаёт bundled local action абсолютный `localFilePath`, bridge создаёт
owner-private snapshot, вычисляет размер/SHA-256, получает session по metadata и
делает отдельный binary PUT. Потерянный control-ответ восстанавливается read-only
по idempotency key: одноразовый runtime proof повторно не отправляется. Путь
остаётся на устройстве. Для encrypted company
тот же snapshot сначала превращается в signed `TRELIOE1`; plaintext, имя и MIME
не достигают backend. Потерянный transport-ответ повторяет exact staged bytes и
reserved attachment ID, поэтому не создаёт дубликат. Inline-image transport
остаётся отдельным bounded compatibility flow.

## Контекст и файлы

У Run один writable Workspace. Только явно выбранные related workspaces
materialize-ятся как pinned read-only context. Каждый target и файл повторно
проходят ACL.

Agent сначала читает явные task/workspace связи, затем при необходимости одним
unified `search` с несколькими формулировками ищет prior context во всех
доступных проектах exact компании. Он читает точные Workspace hits и передаёт
до 20 materially relevant workspace IDs в
`prepare_agent_workspace_run.relatedWorkspaceIds`. Workspace-only уточнение
может использовать `search_agent_workspace_files`. Tool проверяет все цели и
закрепляет их до создания Run. Lower-level `attach_agent_workspace_context`
нужен только для продолжения уже открытого Run. Прямо связанные scopes
разрешаются отдельно. Контекст не подмешивается в writable tree.

Если exact задача и один воркспейс образуют долговременный общий предмет, Worker
сам создаёт task/workspace link без формального подтверждения: нужны минимум два
независимых устойчивых идентификатора, отсутствие конкурирующего кандидата и
пригодность всего принятого содержимого для аудитории задачи. Связь намеренно
открывает текущим и будущим task readers доступ ко всему воркспейсу, а task
editors – write/Run; owner-project и link-management права не выдаются.
После mutation агент сообщает текущему пользователю объекты, evidence и access
effect без автоматического task comment. Несколько кандидатов, один признак,
временная релевантность или сомнение в whole-workspace disclosure требуют вопроса;
weak hit игнорируется, а partial fit получает более узкий контекст.

Крупные и binary файлы writable workspace materialize-ятся полностью. В
read-only context они остаются пятистрочными object pointers до exact
`trelio-workspace context fetch --path <path>`. Bulk hydration запрещена.
Проверенные bytes кэшируются по SHA-256 и копируются без mutable hardlink.

Writable-копия одного Workspace постоянно живёт в одном локальном
root. Для нового Workspace, открытого из прошедшей onboarding папки с
управляемым Trelio-блоком, root создаётся внутри этой папки:

```text
<папка-онбординга>/workspaces/<workspace-id>/
├── workspace/          # видимые рабочие файлы агента
├── context/            # защищённый pinned-контекст текущего Run
└── .trelio-run.json    # private metadata bridge
```

Binding ищется от текущего `cwd` вверх только по обычному bounded
`AGENTS.override.md` или `AGENTS.md` с каноническими managed-маркерами и
заголовком `## Trelio`; прежний managed-заголовок `## Контекст Trelio`
поддерживается для уже настроенных папок. Сам по себе произвольный `cwd` не
является основанием писать туда: вне onboarding-контекста остаётся fallback
`~/Trelio Workspaces/<workspace-id>/`. Уже существующий global, custom `--dir`
или зарегистрированный root переиспользуется на прежнем месте; bridge не
переносит и не копирует локальную рабочую историю автоматически. Новые
folder-local roots и созданный bridge каталог `workspaces/` получают owner-only
права; существующий `workspaces/` обязан быть обычным каталогом, а не symlink.

Следующие Run переиспользуют тот же `workspace/`, а не создают копию по
`run-id`. Перед `start` или `claim` bridge получает live server overview,
проверяет terminal status предыдущего локального Run и чистоту Git, сравнивает
локальный head с current `acceptedHead` и при необходимости синхронизирует
tracked tree. Dirty/diverged данные не перезаписываются; неизвестный server
status или недоступный backend не допускает новый writable Run. В одном
persistent root одновременно открывается только один локальный Run. Уже
начатый legacy Run из `<workspace-id>/<run-id>/workspace` продолжается на месте;
после его безопасного завершения новые Run переходят на общий root.

Корень onboarding-папки остаётся только control-plane entrypoint: агент не
создаёт рядом с `AGENTS.md` рабочие `tmp/`, `output/`, исходники или результаты.
После `open` он работает в напечатанном `workspace/` и использует внутренние
`sources/`, `work/`, `artifacts/`, `derived/` и `worklog/` по runtime-контракту.

Для запроса только на чтение `prepare_agent_workspace_read` возвращает exact
`trelio-workspace inspect` command. Она materialize-ит current accepted head и
актуальные `agent-instructions.md` / `user-profile.md` в private read-only
каталоге без Agent Run, lease, checkpoint или task mutation. Encrypted bundle
остаётся ciphertext на backend и открывается только локальным bridge. Агент
читает authority snapshots до accepted файлов, не редактирует inspection root
и не просит пользователя вручную запускать Run ради доступа к материалам.
Writable intent позже начинает отдельный обычный `prepare_agent_workspace_run`.

Company owner/admin history analytics сохраняет тот же plaintext boundary.
Native `get_workspace_revision_diff` и `read_workspace_revision_file` выбирают
`continue_trelio_local_workspace`; bridge загружает structural accepted-Run
descriptor и два opaque encrypted bundle, строит manifest/bounded patch либо
bounded UTF-8 chunk во временном private Git-каталоге и удаляет его до возврата.
Control paths не раскрываются, а backend не получает file path или bytes.

Рекомендуемая структура:

- `sources/` – исходники;
- `work/` – промежуточные материалы;
- `artifacts/` – итоговые результаты;
- `derived/` – OCR и другие извлечённые представления;
- `worklog/` – отдельная человекочитаемая запись каждого содержательного Run.

## Agent Run

1. Агент вызывает `prepare_agent_workspace_run` один раз для exact
   `workspaceId` либо canonical workspace точной задачи; Trelio создаёт Run с
   pinned base head, ACL, model policy, immutable
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

`trelio-workspace clean --dry-run` показывает exact persistent Workspace roots
и reclaimable bytes. Root становится кандидатом после 30 дней без локальной
или server Run-активности, только если связанный локальный Run terminal, в
Workspace нет другого открытого Run, Git чист и root сейчас не открывается.
Active, unknown и dirty roots сохраняются;
backend outage делает auto-prune no-op. Настройка
`workspaceRetentionDays` меняет срок в пределах 1–365 дней; старый
`terminalRunRetentionDays` читается как совместимый alias.

Object cache очищается по возрасту/LRU/лимиту, signed runtime packages – только
целыми проверенными digest-каталогами. Очистка удаляет лишь локальную копию;
accepted revision и история Run остаются на сервере Trelio.
