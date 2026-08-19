# Onboarding and compatibility

## Содержание

- Codex onboarding
- OAuth и pairing
- Version gate и self-update
- Model/runtime policy
- Working-folder onboarding skill

## Codex onboarding

До marketplace, package manager, OAuth и любого другого setup side effect
onboarding требует host-owned local project root с доступной основной папкой.
Пустая папка допустима, Git-репозиторий необязателен. Projectless task и один
process cwd без host-owned workspace evidence не подходят: onboarding
останавливается с понятным recovery, а пользователь открывает локальный проект
и повторяет запрос в новой задаче этого проекта.

Marketplace добавляется без `--ref`, после чего clean-install flow всегда
выполняет `codex plugin add trelio-agent-workspaces@trelio-plugins`. Codex CLI
регистрирует marketplace и устанавливает plugin разными операциями, поэтому
успешный `marketplace add` не является readiness proof. `INSTALLED_BY_DEFAULT`
остаётся host optimization, а установленный plugin проверяется через
`codex plugin list --json`. `authentication=ON_INSTALL` просит Codex открыть
browser OAuth автоматически; если страница не появилась, агент запускает
`codex mcp login trelio`. Ручной переход в `Plugins` не является основным
fallback.

После install/OAuth onboarding сначала обновляет status и повторяет безопасный
read `get_my_context`/`get_task` в текущей задаче. Если tools уже callable,
работа продолжается там же. Новая задача нужна только после доказанного live
failure текущей; в ней пользователь остаётся в том же локальном проекте и
выбирает manifest starter prompt `Настрой Trelio Agent Workspaces для текущей
рабочей папки`, который Codex предлагает после установки. Полный restart –
только если и новая задача сохраняет старую версию или не видит tools. Skill
без tools не доказывает readiness, но и статичный список заранее не
предполагается. Browser не подменяет MCP.

Node.js 22+ остаётся локальной предпосылкой bundled bridge и
`trelio-remote-skills`, но не удалённого Trelio OAuth. При отсутствующих tools
onboarding один раз разделяет эти состояния через `codex mcp list --json` и
безопасное разрешение `node`, не запуская заведомо отсутствующую команду.
Windows resolver проверяет process PATH, durable machine/user PATH и штатный
`Program Files/nodejs/node.exe`; найденный Node 22+ сразу используется по
абсолютному пути для bridge, даже если процесс Codex ещё не унаследовал PATH.
Из-за одного local stdio server нельзя блокировать OAuth или базовый onboarding.
Отсутствующий или старый Node не устанавливается молча: агент показывает
причину, предлагает exact `winget install --id OpenJS.NodeJS.LTS -e` в native
Windows либо `brew install node` на macOS с уже установленным Homebrew и ждёт
явного подтверждения. Restart нужен только когда выбранный
`remoteMcpExecution` действительно требует перезапуска не поднявшегося local
stdio server; после уже выполненного restart одинаковый совет не повторяется.
Отсутствие глобального `trelio-workspace` штатно: агент использует bundled
script текущей версии плагина.

После Node onboarding запускает bundled `trelio-workspace doctor --json`.
Standalone Git 2.28+ разрешается только из стандартных Homebrew/system/
Program Files roots и durable Windows machine/user PATH; произвольный executable
из process PATH, включая внутренний runtime Codex, кандидатом не является. PATH
нужен лишь для диагностического `processPathReady`. Git принимается только по
absolute path после `--version` и реального временного `init → add → commit`.
Успешный marketplace clone внутренним Git Codex не является readiness proof для
bridge. Найденный вне process PATH Git сразу используется без restart.

При `TRELIO_GIT_REQUIRED` onboarding не останавливается на предложении и не
задаёт отдельный вопрос в чате: сразу запускает exact installer plan doctor-а.
На macOS это `brew install git` при имеющемся Homebrew, иначе
`xcode-select --install`; на Windows –
`winget install --id Git.Git -e --source winget --accept-source-agreements
--accept-package-agreements`, а при отсутствии winget открывается официальный
Git for Windows installer URL. Системное approval/admin/native installer окно
остаётся за человеком и не обходится агентом. После завершения doctor
повторяется в той же задаче; ambiguous result проверяется до повторной
installation mutation. Git failure не блокирует remote OAuth и не считается
его ошибкой.

Managed workspace admin может назначить plugin ролям, но OAuth проходит каждый
user и workspace policy не обходится.

## OAuth и pairing

Missing scope должен возвращать стандартный `mcp/www_authenticate`; native card
предпочтительна. Codex fallback `codex mcp login trelio` запускается без logout
и без narrowing scope, чтобы сохранить existing grant. 401/403/ACL различать;
ACL denial не маскировать как reauthorization.

`codex mcp list --json` со значением `auth_status: "o_auth"` подтверждает схему
авторизации server-а, но не наличие bearer в конкретном app-server процессе.
Явный HTTP 401 либо required/missing-bearer на live read считается auth failure
и запускает один login flow, если другое OAuth-окно ещё не открыто. После
успешного callback текущая задача делает один live retry. Если тот же процесс
снова не передал bearer, повторный login запрещён: он создаст ещё один credential,
но не исправит propagation. Recovery продолжается в свежей задаче/process;
полный restart остаётся последней ступенью после такого же failure там.

Initial OAuth также является одним непрерывным browser flow. Если ON_INSTALL
card не открылась, onboarding сам запускает `codex mcp login trelio`; authorize
route при необходимости проводит login и возвращает пользователя к consent.
Нельзя сначала открывать обычный Trelio login, просить написать «я вошёл», а
затем начинать отдельный OAuth или использовать Computer Use для credentials.

Общий `.mcp.json` использует для Codex и Claude Code predefined public client
`trelio_agent_workspaces_v1`. Это одна client identity между задачами; OAuth
credential больше не должен переходить на новый DCR client при каждом
scope-upgrade. Текущий список Trelio scopes клиенты получают из server metadata,
поэтому manifest его не дублирует. На backend stable client принимает переменный
RFC 8252 loopback port только при exact host и callback path конкретного клиента,
а grant scopes объединяются только для exact user/client. Первый consent, новый
scope и legacy DCR client требуют fresh Trelio login; повторное подтверждение
уже покрытых stable-client scopes может восстановиться через действующую старую
browser-session без impersonation. Consent и PKCE не ослабляются. Legacy DCR
clients остаются совместимыми. Backend migration/production deploy обязаны
предшествовать plugin release, иначе explicit client id корректно завершится
`invalid_client`.

Bridge pairing не является вторым OAuth. Verifier остаётся локально; agent
передаёт только pairing ID/device name в MCP approval и повторяет original
command. Device-session private, reusable и separately revocable. Unsafe
owner/ACL/mode/symlink path fail-closed. Failed local persistence после exchange
обязан self-revoke server session.

## Version gate и self-update

Каждый bridge request несёт один version header. Compatibility preflight идёт
до start/claim. `AGENT_WORKSPACE_PLUGIN_UPGRADE_REQUIRED` запрещает продолжать
старый network process или forge version/clientKind.

Codex self-update:

1. single-flight, не чаще установленного интервала;
2. только official `trelio-plugins` marketplace;
3. не более трёх retry для transient network errors;
4. exact installed path через Codex CLI JSON;
5. manifest/version/entrypoint без symlink;
6. private content-checked retention exact загруженной версии до мутации и
   восстановление всех известных versioned paths после каждого
   `marketplace upgrade` / `plugin add`, включая неуспешную команду;
7. safe re-dispatch new bridge в той же задаче, если backend разрешает;
8. иначе новая задача, затем full restart как последний fallback.

Codex записывает абсолютный путь `SKILL.md` в контекст уже открытой задачи и
может удалить старую cache-папку даже при повторном `plugin add`. Поэтому
retention сохраняет только проверенные exact bytes под прежним exact path; он
не создаёт versionless alias, не подставляет новую версию под старое имя и не
используется для выбора runtime версии. Bundled local MCP делает такой snapshot
уже при `initialize`, поэтому защита не зависит от того, успел ли пользователь
до ручного обновления запустить workspace-команду.

Claude использует свой plugin manager/reload; Codex updater к нему не
применяется.

Platform rules preflight отправляет SHA-256 local cache. Backend возвращает
metadata при match или exact immutable revision. Bridge проверяет size/hash,
атомарно сохраняет и повторяет preflight до `current`; start/claim подтверждает
exact hash.

## Model/runtime policy

Plugin регистрирует lifecycle hooks. Первый protected `PreToolUse` наблюдает
model/effort, создаёт Ed25519 key pair и через paired bridge регистрирует
runtime-session. Private key хранится только в private config; каждый context,
mutation и Agent Workspace call получает одноразовый `runtimeSessionProof`
через full `updatedInput`. Backend проверяет подпись, freshness, exact user и
живой bridge/OAuth, затем атомарно потребляет nonce.

Discovery allowlist (`search`, lists, metadata/resolvers`) и
login/doctor/pairing recovery не требуют admission. Неизвестный новый read по
умолчанию context, write – mutation. В enforcing company отсутствие hook
fail-closed возвращает `TRELIO_RUNTIME_HOOK_REQUIRED` с recovery-инструкцией.

Runtime закрепляется при первом protected call до `SessionEnd` или максимум на
24 часа. Смена model/effort позже не отзывает уже допущенную session. Agent Run
и signed Agent Skill используют `--runtime-session UUID`, не model argv. В
rolling-upgrade окне старый backend получает hook-observed legacy payload
только после 404 нового endpoint; повышение production minimum убирает этот
fallback как рабочий путь.

Best-effort переименование нового Codex-чата задаётся короткой инструкцией в
основном Trelio MCP сразу после runtime-policy текста. Она вызывает native
thread-title tool только для явно нового top-level conversation, не меняет
fork/delegated/existing/user-named thread и молча пропускается без host tool.
Runtime lifecycle hook не содержит title logic. Cloud toolset может отличаться,
а Claude Code использует собственное название с пользовательским `/rename`.

## Working-folder onboarding skill

Onboarding работает в одной явно выбранной постоянной папке Codex или Claude
Code, не внутри materialized Agent Workspace. Он:

1. до установки, OAuth и других side effects подтверждает host-owned рабочую
   папку; Git для неё необязателен, а projectless task останавливается;
2. разрешает exact company и optional project;
3. читает `get_agent_instructions` до substantive setup;
4. безопасно создаёт/обновляет только marked Trelio block в working-folder
   `AGENTS.md`/override, не заменяя unrelated instructions;
5. отдельно диагностирует Trelio OAuth, Node.js 22+ и standalone Git 2.28+;
   отсутствующий Node предлагает установить после явного подтверждения, а
   exact Git installer запускает сразу с обычным client/OS approval;
6. выполняет `trelio-workspace login` без disposable Run;
7. читает live `list_agent_skills` exact scope;
8. в company-wide scope сразу предлагает и company assignments, и возвращённые
   переносимые project assignments с `enabledThroughProjectMembership=true` /
   `sources: ["project_membership"]`; только отсутствующие в этом ответе strict
   project-only skills ждут конкретного проекта или задачи;
9. предлагает настроить только выбранные skills one by one;
10. показывает unconfigured company connection как
   `требуется настройка администратором компании`;
11. никогда не пишет skills/connection state/credentials/IDs/local paths в
   project AGENTS.

Codex получает MCP-status через `codex mcp list --json` и запускает OAuth через
`codex mcp login trelio`. Claude Code использует `claude mcp list`,
`claude mcp login trelio` либо `/mcp`; после установки или обновления plugin
сначала выполняется `/reload-plugins`. Команды `codex` в Claude Code не
используются. После OAuth каждый клиент делает один live retry в текущем
процессе и только затем переходит в новую задачу или сессию с тем же root.

Personal credentials вводятся только через protected runtime flow. Company
config и personal connection независимы; отдельные 1С skills нельзя сливать.
