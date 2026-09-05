# Trelio Agent Workspaces

Официальный плагин Trelio для работы Codex и Claude с управляемыми
воркспейсами, задачами, встречами и актуальными навыками компании.

Плагин подключает:

- Trelio MCP с личной OAuth 2.1-авторизацией;
- отдельную value-free диагностику plugin, hooks, MCP/OAuth, Node.js, Git,
  pairing и runtime sessions;
- один канонический воркспейс задачи и именованные воркспейсы с ACL,
  Git-версиями и явными связями с несколькими проектами/задачами;
- локальный bridge с `pause` для переносимого blocker, `cancel` для защищённого
  отказа от exact Run и `finish` для единого handoff/heartbeat/submit;
- локальную расшифровку Agent Workspaces зашифрованной компании без передачи
  ключа или Git-содержимого backend-у;
- полный локальный поиск по доступному контексту зашифрованной компании через
  incremental encrypted mirror без отправки query и snippets backend-у;
- живой каталог навыков компании и проекта;
- guarded plan/apply для создания и публикации приватных навыков владельцем или
  администратором компании;
- подписанные локальные runtime-пакеты и декларативные Remote MCP;
- private-встречи с отдельным результатом и подтверждаемым планом переноса;
- Agent Secrets с одноразовой выдачей точному локальному executable;
- installation-managed credentials с явной server-owned one-use либо
  time-bound policy без локального кеша value;
- backend-managed интеграции с независимыми от плагина runtime-релизами;
- переносимые blocker-checkpoint и read-only контекст других workspace;
- управляемые правила компании, проекта и личный профиль пользователя;
- company policy модели и уровня рассуждений во всей работе с Trelio.

Публичный репозиторий содержит клиентский дистрибутив. Backend и UI Trelio
остаются в основном монорепозитории. Состав, инструкции и возможности
конкретных интеграций приходят из текущего каталога Trelio и не фиксируются в
плагине.

## Локальные Workspace

Для каждого воркспейса bridge использует одну постоянную папку. Для
нового Workspace, открытого из прошедшей onboarding папки с управляемым Trelio-
блоком, структура находится внутри неё:

```text
<папка-онбординга>/workspaces/<workspace-id>/
├── workspace/          # видимые редактируемые файлы
├── context/            # защищённый pinned-контекст текущего Run
└── .trelio-run.json    # private metadata bridge
```

Bridge ищет current или legacy managed binding в текущей папке и её предках,
поэтому команда может быть запущена из вложенной shell-директории. Произвольный
`cwd` без управляемого binding не становится местом хранения: такой ручной
сценарий сохраняет fallback
`~/Trelio Workspaces/<workspace-id>/`. Уже материализованный или явно заданный
через `--dir` root остаётся на прежнем месте и переиспользуется из private
registry; автоматического переноса локальных данных нет.

Следующие Agent Run работают в том же root: перед открытием bridge сверяет live
`acceptedHead` и статус предыдущего Run с Trelio, проверяет чистоту локального
Git и только затем синхронизирует tracked-файлы. Локальные изменения никогда не
перезаписываются автоматически, а без доступного server state новый writable
Run не открывается. В одной папке одновременно работает один локальный Run.

Служебные `.trelio-run.json` и `context/` находятся уровнем выше рабочей папки;
исходники, промежуточные и итоговые файлы агента остаются в видимом
`workspace/`, а не в корне папки онбординга. Чистая локальная копия
удаляется только после 30 дней без локальной или server Run-активности,
terminal-подтверждения backend и повторной проверки Git; серверная
accepted-история при этом сохраняется.

## Локальный контекст компании

Trelio сам возвращает для выбранной компании authoritative `contentProvider`.
Обычная компания продолжает использовать native MCP. Для зашифрованной exact
route ведёт к пяти компактным model-visible local tools: чтение/поиск,
обычные действия, headless proposal context, proposal render и история
Workspace. Агент не решает сам, какой
provider выбрать, а local host повторно проверяет live state. Служебные tools
кнопок proposal видны только MCP App и не попадают в обычный контекст модели.

В production bridge сначала получает через канонический `https://trelio.ru`
content-free authenticated route для exact компании или Workspace. Только при
live state `encrypted` все последующие Workspace, local-context, proposal и
encrypted-payload запросы переходят на `https://e2ee.trelio.ru`; plain и
переходные состояния остаются на каноническом origin. Alternate URL принимается
только как exact HTTPS origin из встроенного allowlist, поэтому backend-ответ не
может перенаправить bearer token на произвольный host. OAuth, pairing,
compatibility и Agent Secrets всегда остаются на control plane.

В начале работы bridge синхронизирует весь доступный текущему пользователю
контекст компании: проекты, задачи, именованные воркспейсы и safe text из
принятых Workspace. Неизменившиеся task revisions и Workspace heads переиспользуются.
Зашифрованные marker-ы всех изменившихся документов разрешаются общими bounded
batch-запросами, поэтому число transport-вызовов не растёт линейно с числом задач.
Локальная копия хранится только в зашифрованных immutable generations; короткий
per-company writer lock атомарно переключает pointer, пока параллельный поиск
продолжает читать предыдущую полную generation. Run соседних задач не
блокируются и сохраняют обычные lease/fencing/CAS.
Если выборочный `get_task_sections` получает server read-fence о сменившейся
revision, host не закрепляет известную устаревшую generation в RAM: bounded
дожидается свежего pointer и ровно один раз повторяет только read-only запрос.
Повторный конфликт остаётся fail-closed и не скрывает реально меняющуюся задачу.

После автоматического sync поиск, bounded list, exact task read и fetch
выбранного результата выполняются локально. В Trelio не отправляются запрос,
snippets, расшифрованные пути и содержимое. В model context попадают только
выбранные результаты, а не всё зеркало. На диске generation всегда
зашифрована; одна расшифрованная generation и ленивый индекс живут только в
памяти MCP-процесса и автоматически освобождаются через 600 секунд.

После потенциальной записи, proposal save/final action, restore/cancel или
принятого encrypted `finish` host атомарно меняет только owner-private случайный
маркер без названий, содержимого, запросов и ключей. Каждый параллельный
MCP-процесс проверяет его перед использованием RAM-копии и при изменении сам
делает обычный bounded sync. Ручной sync и polling агенту не нужны; конфликты
по-прежнему решают server CAS, revisions, idempotency, lease и fencing token.

Ссылки на задачи, созданные до включения шифрования или переименования проекта,
остаются рабочими: обычный `fetch` и точный `get_task` разрешают старый project
slug по локальному зашифрованному mirror и возвращают текущий непрозрачный
маршрут; та же канонизация действует для comment/status/control/checklist
proposal flow. URL разбирается только как структурный locator и не зависит от
сохранённого в immutable mirror origin; абсолютная и root-relative формы не
выполняют сетевой переход по самой ссылке.

Comment/status/control/checklist proposals используют тот же context → editable
draft → отдельное publish/apply/dismiss решение. Headless
`get_trelio_local_proposal_context` не объявляет UI resource, поэтому служебное
чтение вообще не создаёт карточку; только `render_trelio_local_proposal`
прикрепляет App к готовому draft. Плагин шифрует текст и причины
до HTTP, backend применяет прежние ACL/revisions/locks, а final action требует
отдельного явного решения пользователя. Несколько карточек сохраняются одним
локальным bundle-вызовом в исходном порядке; конфликт одной карточки не скрывает
готовые соседние и не подтверждает их final actions. Локальный MCP возвращает
полноценный App result со `structuredContent` и exact v8 resource metadata, а
v5/v4/v3 остаются resource-level compatibility paths для сохранённых карточек.
Bundle использует sandboxed `srcdoc`-frames без `data:` frame permission;
защищённая review-карточка появляется только после `save` и вызывает только
app-only продолжения.

Обычные mutation/read-tools сохраняют свои native имена, схемы, ACL,
idempotency и CAS, но для encrypted company выполняются через один exact local
action route. Человеческий текст, rich text, имена файлов и другие защищённые
листья шифруются до HTTP; даты, UUID, workflow codes и другие необходимые
серверной проверке структурные значения остаются структурными. Ответ native
tool расшифровывается локально и сохраняет исходный MCP result envelope.
Производный task-document после расшифровки также полностью пересобирается из
локальной карточки: серверный текст не может надёжно восстановить защищённые
заголовок, описание, чек-листы, поля, вложения и комментарии после того, как
ciphertext marker уже был встроен в обычную строку.
Archived contacts и registry rows сохраняются в зашифрованной generation для
exact include-read, но обычный поиск их не индексирует. Для registry он строится
только по active non-technical rows и поисковым полям текущего definition;
immutable history, comments и служебная read/ACL metadata в индекс не попадают.
Task/contact rich text
передаётся как opaque JSON marker только через verified local-action runtime.
Task attachment с доступным локальным файлом передаётся через
`continue_trelio_local_action` и абсолютный `localFilePath` только для exact
выбранного пользователем или созданного агентом файла: путь остаётся на
устройстве, control plane получает только имя, тип, размер и SHA-256, а bridge
отправляет файл отдельным binary stream. Base64 не попадает в MCP/model context;
неоднозначный control-ответ проверяется отдельным idempotency-read без повторной
отправки одноразового runtime proof, а binary transport повторяет те же staged bytes.
В encrypted company файл перед отправкой локально превращается в signed
`TRELIOE1`, а filename/MIME – в связанный encrypted payload; backend проверяет
exact активное bridge-устройство и никогда не запускает plaintext/image pipeline
над ciphertext. Inline image пока сохраняет прежний bounded inline transport.
Параллельные чаты используют те же server locks и `clientRequestId`; новые
registry row получают стабильный секретный HMAC-locator, поэтому одинаковый
row key конфликтует/повторяется как одна строка, не раскрывая значение серверу.
Если предыдущая попытка успела сохранить только часть immutable encrypted
payload до business validation либо потери ответа, exact повтор локально
сверяет уже сохранённые значения, повторно отправляет только отсутствующую
часть batch и остаётся fail-closed при любом несовпадении plaintext intent.

Исполняемый навык компании явно помечается как не проверенный Trelio. До его
materialization и исполнения агент показывает publisher и причину публикации,
а plugin открывает защищённую локальную форму: только сам пользователь может
разрешить exact версию на exact устройстве. Для E2EE bridge заранее проверяет
и временно расшифровывает только signed ciphertext, чтобы форма показала
реальные capabilities. Каждая новая публикация требует нового согласия,
включая обновление инструкции при неизменном package.

## Управление приватными навыками

Агент может создать приватный навык компании или опубликовать его следующую
версию, если текущий пользователь – владелец либо администратор. Один общий
контур поддерживает instruction-only Markdown, декларативный Remote MCP и
исполняемый `.skillpkg`; следующая версия также может переиспользовать текущий
immutable package.

Планирование ничего не публикует. Local host показывает exact company, skill,
версию, изменения, предупреждения, endpoint/auth/tool policy либо interpreter,
capabilities и digest package. Apply принимает только тот же неистёкший
`planId` и `planHash` после отдельного подтверждения пользователя, использует
стабильный idempotency key и проверяет current release через CAS. Ответ содержит
точную ссылку на страницу навыка в Trelio. Новый навык устанавливается, но не
назначается компании или проектам автоматически.

Для encrypted-компании те же три варианта работают через локальное E2EE:
bridge получает company envelope, шифрует semantic metadata, инструкции,
Remote MCP declaration, manifest и `.skillpkg` bytes и передаёт backend-у
только подписанные markers/ciphertext. Расшифровка Remote MCP и runtime package
происходит локально перед проверкой и использованием.

Глобальный `platform_verified` runtime package остаётся обычным подписанным
артефактом, но его company connection config в encrypted-компании всё равно
приходит exact E2EE-marker. Bridge открывает этот config локально до проверки
runtime resolution; plaintext не возвращается backend-у, MCP или модели.

## Установка в Codex

Сначала создайте или откройте локальный проект в Codex и добавьте основную
папку. Лучше использовать отдельную пустую папку без `.git` и вне другого Git
worktree. Начните задачу внутри этого проекта: чат без локального проекта не
подходит, потому что Trelio-контекст некуда сохранить для следующих задач.

Добавьте официальный marketplace и явно установите плагин из него:

```bash
codex plugin marketplace add trelio-ru/agent-workspaces
codex plugin add trelio-agent-workspaces@trelio-plugins
```

После установки явно разрешите hooks плагина. В Codex Desktop откройте
настройки `Trelio Agent Workspaces`, просмотрите текущую конфигурацию в разделе
Hooks и включите её. В Codex CLI откройте `/hooks`, выберите источник
`Trelio Agent Workspaces`, проверьте текущую конфигурацию и отметьте её
доверенной. Codex не доверяет
plugin-bundled hooks автоматически и пропускает новую либо изменённую definition
до такого review; bypass-флаг для онбординга не используется.

Codex CLI регистрирует marketplace и устанавливает plugin разными операциями,
поэтому сообщение об успешно добавленном источнике ещё не означает готовую
установку. Policy `INSTALLED_BY_DEFAULT` остаётся ускорением для host-ов,
которые применяют её автоматически, но чистый CLI-flow всегда выполняет
`codex plugin add` и проверяет результат через `codex plugin list --json`.
Policy `authentication=ON_INSTALL` просит Codex открыть страницу входа в
Trelio. Вход в Trelio при необходимости и подтверждение доступа проходят в
этом одном окне: возвращаться в чат между ними не нужно. Если окно не
открылось, выполните в той же задаче:

```bash
codex mcp login trelio
```

Завершите личный OAuth в браузере. Агент сначала продолжит настройку в текущей
задаче; новая нужна только если инструменты в ней фактически не появились.

Ручное открытие `Plugins` ради OAuth не является основным fallback. Полный
restart нужен лишь когда новая задача всё ещё не видит инструменты Trelio или
использует старую версию плагина.

Затем выберите предложенный плагином starter prompt – перепечатывать его
вручную не нужно:

```text
Настрой Trelio Agent Workspaces для текущей рабочей папки
```

Агент сначала подтвердит основную папку и остановится без установки или OAuth,
если задача открыта без неё. Это должна быть отдельная обычная папка контекста
без Git: Trelio-контекст приходит из правил компании и проекта, задачи, воркспейса
или их Agent Workspace, а не из связи с репозиторием. Строго пустую
Git-оболочку хоста onboarding безопасно переименует в уникальную резервную
копию и сообщит её путь; существующий или неоднозначный репозиторий не меняет и
просит открыть отдельную папку без Git. Затем он безопасно создаст или дополнит
Trelio-блок в корневом `AGENTS.md` и обычный `CLAUDE.md` с импортом
`@AGENTS.md`, сохранив посторонние инструкции. Блок требует проверять Trelio до
ответа или внешнего поиска и повторно использовать ещё актуальный контекст.
После этого onboarding проверит OAuth и pairing локального bridge без тестового
Run и предложит настроить только выбранные навыки. Для exact
`encrypted` он сразу настроит local encryption device и потребует успешный
локальный `TRELIOE1` self-test; Run для этого не создаётся. Пароли,
токены, коды входа и credential files не запрашиваются в чате.

Локальному компоненту нужны Node.js 22+ и standalone Git 2.28+. Это prerequisite
bridge для его временных и Run-репозиториев, а не требование превратить папку
онбординга в Git-репозиторий. В Codex bundled
launcher сначала использует Node из host-owned runtime hints или штатного
runtime Codex, даже если команда `node` отсутствует в PATH либо Codex не смог
создать PATH aliases. Затем он проверяет системную установку; на Windows также
учитываются durable PATH и Program Files. Уже найденный Node запускается по
абсолютному пути без повторной установки и без блокировки базового подключения
Trelio. Установка через штатный package manager предлагается только когда ни
bundled, ни системного совместимого Node действительно нет; без явного
подтверждения пользователя системное ПО не устанавливается. Глобальная команда
`trelio-workspace` не требуется: плагин использует свой bundled script.

Agent Workspaces поэтому запускается на desktop macOS/Windows/Linux, а не в
мобильном браузере. Сам web-интерфейс зашифрованной компании поддерживает
актуальные Chrome, Edge, Firefox и Safari на desktop, Android и iOS при наличии
HTTPS, Web Crypto, IndexedDB и WebAssembly.

Bundled `trelio-workspace doctor --json` отдельно разрешает absolute Git только
из Homebrew/system/Program Files и durable Windows PATH и проверяет настоящий
временный `init → add → commit`. Произвольный executable из process PATH,
включая private Git, которым Codex мог скачать marketplace, bridge не использует.
Doctor также проверяет exact загруженную версию обоих manifests, стабильный
hook contract, Node.js 22+, локальное pairing-состояние и только агрегированные
счётчики runtime sessions. Он не выводит tokens, pairing IDs, session IDs или
private keys. Значение `plugin.hooks.approvalStatus=client_managed_unknown`
означает, что целостность definition подтверждена, но его одобрение нужно
проверять в самом клиенте.
Если standalone Git отсутствует,
onboarding сразу запускает `brew install git` либо `xcode-select --install` на
macOS и `winget install --id Git.Git -e` на Windows. Обычное системное
approval/native installer окно остаётся за пользователем, после чего doctor
повторяется и найденный absolute path используется без restart.

Политика модели компании действует и без Agent Run. При первом protected MCP
call approved hook закрепляет наблюдаемые model/effort в paired runtime-session
и затем добавляет одноразовый proof автоматически. Discovery/recovery остаются
доступны без допуска. Agent Run сохраняет pinned policy/runtime snapshot; смена
runtime позже не отзывает уже допущенную client session.

Hook запускает `PreToolUse` только для Trelio MCP, защищает параллельную первую
регистрацию локальной блокировкой и удаляет private key до bounded сетевого
cleanup на `SessionEnd`. Lifecycle matcher остаётся wildcard: новые client event
sources обрабатываются скриптом без изменения `hooks.json`. Сам hook не зависит
от bare `node`: на macOS/Linux он использует bundled `launch-trelio-node`, а на
Windows отдельный quote-free `commandWindows` передаёт запуск bundled `.cmd`
launcher. Изменение hook definition может потребовать одно новое одобрение в
клиенте; дальнейшие behavior-only исправления – нет.

Если marketplace раньше добавлялся с `--ref vX.Y.Z`, переподключите его без
фиксации версии:

```bash
codex plugin marketplace remove trelio-plugins
codex plugin marketplace add trelio-ru/agent-workspaces
```

## Установка в Claude Code и Claude Cowork

В Claude Code сначала откройте терминал в постоянной рабочей папке и запустите
`claude` из неё. Используйте отдельную обычную папку без `.git` и вне другого
Git worktree. В Cowork создайте задачу с доступом к выбранной папке.

```text
/plugin marketplace add trelio-ru/agent-workspaces
/plugin install trelio-agent-workspaces@trelio-plugins
```

Выполните `/reload-plugins`. Для OAuth выберите в `/mcp` сервер
`plugin:trelio-agent-workspaces:trelio` либо выполните в терминале:

```bash
claude mcp login plugin:trelio-agent-workspaces:trelio
```

После авторизации начните новую сессию `claude` из той же папки и попросите:
`Настрой Trelio Agent Workspaces для текущей рабочей папки`. Если
`claude mcp list` уже показывает Trelio как `Connected`, а старая сессия не
видит `list_companies`, login повторять не нужно – этой сессии недоступен
обновлённый набор инструментов.

Plugin bundle хранит MCP-регистрацию Codex и Claude раздельно. Поэтому Claude
разрешает bundled launcher через `${CLAUDE_PLUGIN_ROOT}` независимо от текущей
рабочей папки, а Codex продолжает использовать собственные относительные пути
и timeout/env allowlist. Если `claude mcp list` показывает URL `trelio` без
`type` либо `ENOENT` для literal `./scripts/launch-trelio-node`, обновите plugin
и выполните `/reload-plugins`; OAuth и pairing сбрасывать не нужно.

OAuth каждый пользователь подтверждает лично. Администратор управляемой
рабочей области может назначить плагин ролям, но не обходит workspace policy
или личный consent.

## Чтение принятого Workspace без Run

Для чистого чтения воркспейса агент вызывает
`prepare_agent_workspace_read` и запускает возвращённую команду
`trelio-workspace inspect --workspace ...`. Bridge materialize-ит exact
accepted head и текущие instruction/profile snapshots в private read-only
каталоге. В encrypted-компании bundle скачивается как `TRELIOE1` и
расшифровывается локально. Операция не создаёт Run, lease, checkpoint, status
proposal или иной Trelio mutation, поэтому пользователь не должен вручную
открывать задачу и запускать Run только ради чтения.

## Первый Agent Run

1. Агент разрешает точную компанию, проект, воркспейс или задачу и повторно
   проверяет ACL.
2. Он вызывает `prepare_agent_workspace_run` один раз; native Trelio discovery
   не требует каталога, а `search_agent_skills` вызывается только перед
   подключённым внешним сервисом. Полный `list_agent_skills` нужен только для
   явной инвентаризации.
3. Trelio обеспечивает workspace и создаёт Run с закреплёнными правилами,
   личным профилем, related context и base head.
4. Bridge materialize-ит единственный writable workspace и выбранный
   read-only контекст.
5. Dirty blocker сохраняется одной `pause`, а финальный результат – одной
   `finish`, которая проверяет полный candidate delta вместе с уже сохранённым
   draft checkpoint, создаёт handoff и отправляет candidate без фиктивной правки.
6. Candidate принимается атомарно, только пока base head актуален.

В encrypted-компании exact draft того же head/scope/device принимается новой
подписью без повторной отправки полного ciphertext snapshot. Если TLS/transport
оборвался до полного ответа, bridge сохраняет Run и immutable запрос, 10–12
минут не открывает новых соединений и затем повторяет его ровно один раз.
Явные HTTP-ошибки и пользовательская отмена в этот retry-контур не входят.
До rollout нового backend неизвестный ему draft-promotion route безопасно
возвращается к обычной полной encrypted-загрузке.

`COMPANY_STORAGE_BALANCE_REQUIRED` также не повторяется автоматически. Bridge
оставляет локальные файлы и текущий Agent Run для продолжения и прямо просит
после пополнения баланса повторить ту же `checkpoint`, `pause`, `finish` или
`submit` команду. Отменять Run, начинать новый или создавать ложный human
blocker не нужно.

Явно брошенный Run отменяется после native route через
`continue_trelio_local_workspace` / `cancel_run`. В encrypted-компании reason
шифруется локально; backend получает только подписанную ссылку и всё равно
повторно проверяет автора/approver и terminal state. Тот же provider-neutral
tool перечисляет revisions и восстанавливает выбранную encrypted revision новым
локальным Run с current-head CAS; `filesChanged` берётся из фактической Git-
дельты, включая удаления, а при изменениях только в сохраняемых control paths
остаётся пустым. Старое дерево не раскрывается backend-у.

Тот же server-selected route локально обслуживает
`get_workspace_revision_diff` и `read_workspace_revision_file`: bridge получает
только structural Run coordinates и два opaque encrypted bundle, расшифровывает
их во временном private Git-каталоге, возвращает bounded manifest/patch либо
UTF-8 chunk и сразу удаляет plaintext. Protected control paths остаются
недоступны, а backend не получает путь, patch, содержимое файла или ключ.

При первом `open` bridge создаёт короткую pairing-заявку. Агент передаёт её
уже авторизованному Trelio MCP и повторяет исходную команду. MCP token bridge
не получает: на устройстве сохраняется отдельная узкая device-session с
приватными правами. Если политика клиента требует подтверждения tool call,
клиент сам показывает единственную штатную кнопку.

Task-scoped accepted Run создаёт системный комментарий из immutable handoff.
Это технический аудит и контекст для агентов. После каждого содержательного
accepted Run агент отдельно готовит редактируемое предложение обычного
комментария для людей и выбирает только полезные файлы. Create-only
`propose_task_comment` используется для первого private draft; известный draft
либо `UNPUBLISHED_DRAFT_REQUIRES_CONTEXT` переводят flow на context/render без
повтора compact tool. Каждый replacement заново формулируется как
самостоятельный cumulative update только из authoring basis: опубликованных
manual comments и отдельной хронологии ещё непроговорённых accepted Run.
`currentDraft.bodyText` в authoring context отсутствует, поздний Run заменяет
конфликтующий ранний, а запомненный draft и system handoff не являются публичной
предысторией. Публикация, dismiss и attachments происходят только по явному
действию человека. Явная просьба подготовить proposal для exact задачи
использует тот же native flow напрямую без Agent Run и не заменяется текстом в
финальном ответе, даже если пришла во время maintainer-flow или после
compaction.

## Обновление

Marketplace без `--ref` отслеживает default branch. Обновить его можно так:

```bash
codex plugin marketplace upgrade trelio-plugins
```

Trelio проверяет совместимость bridge перед transport-операциями. Codex bridge
умеет тихо обновить только официальный marketplace и при безопасной
возможности продолжить исходную команду новым entrypoint. Если reload в
текущей задаче невозможен, сначала начните новую задачу; полный restart
оставьте последним fallback. Bridge удерживает exact immutable папки уже
загруженных версий: очистка versioned cache при обновлении или повторном
`plugin add` не ломает абсолютный путь `SKILL.md` в ранее открытой задаче.
Новые bytes никогда не маскируются под старую версию.

При недостающем OAuth scope Trelio инициирует стандартную повторную
авторизацию. Пользователь подтверждает новые права в браузере, а прежние
поддерживаемые scopes сохраняются.

История изменений и требования конкретных версий находятся в
[GitHub Releases](https://github.com/trelio-ru/agent-workspaces/releases).

## Безопасность

В зашифрованной компании onboarding запускает `encryption setup`; при первой
настройке команда показывает локальную форму `127.0.0.1`. Ключ шифрования
вводит сам пользователь, и значение не уходит в Trelio, MCP, командную строку
или логи. Bridge создаёт отдельный ключ устройства, сохраняет wrapped bundle и
локальный unlock key в owner-only private config и проверяет production codec
локальным random canary; после этого повторный ввод на том же компьютере не
нужен. Владелец компании отдельно выдаёт этому device доступ в настройках
шифрования. `inspect` и `open` переиспользуют готовое устройство. Git bundle
шифруется и расшифровывается локально. Поиск exact Workspace доступен в его
materialized копии, а company-wide discovery идёт по incremental encrypted local
mirror: задачи, воркспейсы, база знаний, контакты, реестры и встречи попадают туда
только после обычных ACL и source OAuth scope, без remote query. Первый local
read нового MCP host запускает этот sync автоматически. При `finish`
bridge также создаёт подписанную
browser-проекцию: открытый индекс содержит только случайные UUID и ciphertext
ranges, а paths, имена, MIME и каждый файл остаются в отдельных `TRELIOE1`.
Web UI лениво открывает manifest при раскрытии раздела и получает только
выбранный файл; общий ZIP собирается локально после явного клика. Текущая версия
опирается на файловые права OS-account и не выдаёт private config за
Keychain/DPAPI-хранилище.

- MCP использует OAuth и штатные ACL компании, проекта, воркспейса и задачи.
- Bridge использует отдельную узкую device-session вместо MCP token.
- Agent Secrets выдаются один раз точному executable и не попадают в prompt,
  argv или workspace; в encrypted-компании bridge локально открывает
  ACL-gated company ciphertext, который сервер расшифровать не может.
- Только явно помеченный backend-ом стабильный installation-managed credential
  может повторно использовать exact grant в том же Run/release до `expiresAt`;
  plugin не расширяет этот срок и не сохраняет value.
- Личные integration credentials и sessions хранятся локально вне Git и
  Trelio workspace.
- Signed runtimes проверяются по Ed25519 и SHA-256 и запускаются без shell.
- Подпись company runtime гарантирует целостность доставки, но не означает
  проверку кода Trelio; непроверенный runtime запускается только после
  отдельного локального согласия пользователя на текущую публикацию.
- Внешние сообщения, страницы и attachments считаются данными, а не
  полномочиями на действие в другой системе.

Не публикуйте токены, credentials или содержимое рабочих пространств в issues
и pull requests. Для уязвимостей используйте инструкции из
[`../../SECURITY.md`](../../SECURITY.md).

## Подробная документация

- [Установка, OAuth и управляемые политики](../../docs/plugin-setup-and-policies.md)
- [Agent Workspace Runtime](../../docs/agent-workspace-runtime.md)
- [Навыки, подключения и Agent Secrets](../../docs/agent-skills-and-secrets.md)
- [История релизов](https://github.com/trelio-ru/agent-workspaces/releases)
