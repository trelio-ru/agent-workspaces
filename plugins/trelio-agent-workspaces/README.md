# Trelio Agent Workspaces

Официальный плагин Trelio для работы Codex и Claude с управляемыми рабочими
пространствами, задачами, встречами, досье и актуальными навыками компании.

Плагин подключает:

- Trelio MCP с личной OAuth 2.1-авторизацией;
- отдельную value-free диагностику plugin, hooks, MCP/OAuth, Node.js, Git,
  pairing и runtime sessions;
- Agent Workspaces компании, проекта, досье и задачи с ACL и Git-версиями;
- локальный bridge с `pause` для переносимого blocker и `finish` для единого
  handoff/heartbeat/submit;
- локальную расшифровку Agent Workspaces зашифрованной компании без передачи
  ключа или Git-содержимого backend-у;
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

## Установка в Codex

Сначала создайте или откройте локальный проект в Codex и добавьте основную
папку. Подойдёт пустая папка – Git-репозиторий необязателен. Начните задачу
внутри этого проекта: чат без локального проекта не подходит, потому что
привязку к Trelio некуда сохранить для следующих задач.

Добавьте официальный marketplace и явно установите плагин из него:

```bash
codex plugin marketplace add trelio-ru/agent-workspaces
codex plugin add trelio-agent-workspaces@trelio-plugins
```

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

Ручное открытие `Plugins` не является основным OAuth fallback. Полный restart
нужен лишь когда новая задача всё ещё не видит инструменты Trelio или использует
старую версию плагина.

Затем выберите предложенный плагином starter prompt – перепечатывать его
вручную не нужно:

```text
Настрой Trelio Agent Workspaces для текущей рабочей папки
```

Агент сначала подтвердит основную папку и остановится без установки или OAuth,
если задача открыта без неё. Затем он безопасно создаст или дополнит
Trelio-блок в корневом `AGENTS.md`, проверит OAuth и pairing локального bridge
без тестового Run и предложит настроить только выбранные навыки. Пароли,
токены, коды входа и credential files не запрашиваются в чате.

Локальному компоненту нужны Node.js 22+ и standalone Git 2.28+. В Codex bundled
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

В v1.13 hook запускает `PreToolUse` только для Trelio MCP, защищает параллельную
первую регистрацию локальной блокировкой и удаляет private key до bounded
сетевого cleanup на `SessionEnd`. Lifecycle matcher остаётся wildcard: новые
client event sources обрабатываются скриптом без изменения `hooks.json`.
Поэтому переход с v1.12 может потребовать одно новое одобрение definition, а
дальнейшие behavior-only исправления – нет.

Если marketplace раньше добавлялся с `--ref vX.Y.Z`, переподключите его без
фиксации версии:

```bash
codex plugin marketplace remove trelio-plugins
codex plugin marketplace add trelio-ru/agent-workspaces
```

## Установка в Claude Code и Claude Cowork

В Claude Code сначала откройте терминал в постоянной рабочей папке и запустите
`claude` из неё. Папка может быть пустой и не обязана быть Git-репозиторием. В
Cowork создайте задачу с доступом к выбранной папке.

```text
/plugin marketplace add trelio-ru/agent-workspaces
/plugin install trelio-agent-workspaces@trelio-plugins
```

Выполните `/reload-plugins`, затем начните новую задачу или сессию с доступом к
той же папке и попросите: `Настрой Trelio Agent Workspaces для текущей рабочей
папки`. Если Trelio запросит авторизацию, откройте `/mcp`, выберите сервер
`trelio` и подтвердите OAuth в браузере.

OAuth каждый пользователь подтверждает лично. Администратор управляемой
рабочей области может назначить плагин ролям, но не обходит workspace policy
или личный consent.

## Первый Agent Run

1. Агент разрешает точную компанию, проект, досье или задачу и повторно
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
самостоятельный cumulative update из текущего результата и опубликованной
дискуссии: неопубликованный draft и system handoff не являются его публичной
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

В зашифрованной компании первый `open` показывает локальную форму
`127.0.0.1`: ключ шифрования вводит сам пользователь, и значение не уходит в
Trelio, MCP, командную строку или логи. Bridge создаёт отдельный ключ устройства
и сохраняет wrapped bundle и локальный unlock key в owner-only private config;
после этого повторный ввод на том же компьютере не нужен. Владелец компании
отдельно выдаёт этому device доступ в настройках шифрования. Git bundle
шифруется и расшифровывается локально, а поиск выполняется по materialized
рабочей копии локальным `rg`. Текущая версия опирается на файловые права
OS-account и не выдаёт private config за Keychain/DPAPI-хранилище.

- MCP использует OAuth и штатные ACL компании, проекта, досье и задачи.
- Bridge использует отдельную узкую device-session вместо MCP token.
- Agent Secrets выдаются один раз точному executable и не попадают в prompt,
  argv или workspace.
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
