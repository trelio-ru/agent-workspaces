# Onboarding and compatibility

## Содержание

- Codex onboarding
- OAuth и pairing
- Version gate и self-update
- Model/runtime policy
- Project onboarding skill

## Codex onboarding

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
failure текущей; в ней пользователь выбирает manifest starter prompt `Настрой
Trelio и доступные навыки для текущего проекта`, который Codex предлагает после
установки. Полный restart – только если и новая задача сохраняет старую версию
или не видит tools. Skill без tools не доказывает readiness, но и статичный
список заранее не предполагается. Browser не подменяет MCP.

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
bridge. На macOS перед `/usr/bin/git` выполняется side-effect-free
`xcode-select --print-path`: при отсутствии developer tools xcrun stub не
запускается и самопроизвольно не открывает installer за окном клиента. Найденный
вне process PATH Git сразу используется без restart.

При `TRELIO_GIT_REQUIRED` onboarding не останавливается на предложении и не
задаёт отдельный вопрос в чате: сразу запускает exact installer plan doctor-а.
На macOS это `brew install git` при имеющемся Homebrew, иначе
`xcode-select --install` с последующим best-effort запуском возвращённого
`install.nativeWindowActivation` (`open -b
com.apple.dt.CommandLineTools.installondemand`), чтобы уже созданное Apple-окно
оказалось перед Codex/Claude. Activation не подтверждает установку за человека;
при её ошибке нельзя повторно запускать installer или параллельный
`softwareupdate`. На Windows –
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

Bridge admission, start/claim и signed skill run сообщают client/model/effort
как `local_observed`. Company policy применяется ко всей новой работе с Trelio,
а не только к Agent Run. Обычная задача закрепляет immutable snapshot при
первом защищённом действии exact компании; Run сохраняет server-pinned snapshot
и имеет приоритет. PreToolUse guard проверяет фактический runtime перед каждым
действием без отдельной команды агента.

В связанном проекте hook читает только marked Trelio block действующего
`AGENTS.md`; вне привязки exact company берётся из scoped Trelio MCP input.
Привязка задачи и policy snapshots хранятся в приватном bridge state по
hash-based session key. Пустой unbound tool call ничего не закрепляет, поэтому
созданная onboarding-ом привязка включается на следующем защищённом действии в
той же задаче; уже закреплённый company slug не заменяется. Raw transcript и
исходный session id не сохраняются.
После первого admission повторный network call не нужен; scoped действие для
другой exact компании закрепляет её отдельный snapshot. Unbound generic work и
Trelio discovery без exact company не получают произвольную policy.

Отсутствующая bridge-session fail-closed блокирует защищённую работу, но не
exact login/doctor/pairing recovery. Unknown client/model управляется explicit
allow/deny. `CLAUDE_PLUGIN_ROOT` не доказывает client kind. Guard нельзя
обходить editing runtime files, private admission state или client metadata.

## Project onboarding skill

Onboarding работает в обычном Codex project, не внутри materialized Agent
Workspace. Он:

1. разрешает exact company и optional project;
2. читает `get_agent_instructions` до substantive setup;
3. безопасно создаёт/обновляет только marked Trelio block в project-root
   `AGENTS.md`/override, не заменяя unrelated instructions;
4. отдельно диагностирует Trelio OAuth, Node.js 22+ и standalone Git 2.28+;
   отсутствующий Node предлагает установить после явного подтверждения, а
   exact Git installer запускает сразу с обычным client/OS approval;
5. выполняет `trelio-workspace login` без disposable Run;
6. читает live `list_agent_skills` exact scope;
7. в company-wide scope сразу предлагает и company assignments, и возвращённые
   переносимые project assignments с `enabledThroughProjectMembership=true` /
   `sources: ["project_membership"]`; только отсутствующие в этом ответе strict
   project-only skills ждут конкретного проекта или задачи;
8. предлагает настроить только выбранные skills one by one;
9. показывает unconfigured company connection как
   `требуется настройка администратором компании`;
10. никогда не пишет skills/connection state/credentials/IDs/local paths в
   project AGENTS.

Personal credentials вводятся только через protected runtime flow. Company
config и personal connection независимы; отдельные 1С skills нельзя сливать.
