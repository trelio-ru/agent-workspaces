# Onboarding and compatibility

## Содержание

- Codex onboarding
- OAuth и pairing
- Version gate и self-update
- Model/runtime policy
- Project onboarding skill

## Codex onboarding

Marketplace добавляется без `--ref`; `INSTALLED_BY_DEFAULT` исключает отдельную
`codex plugin add`. `authentication=ON_INSTALL` просит Codex открыть browser
OAuth автоматически. `Plugins` – только fallback, если страница не появилась.

После install/OAuth нужна новая задача для refresh MCP tools. Полный restart
требуется только если новая задача сохраняет старую версию/нет tools. Skill без
tools не доказывает readiness; безопасный read `get_my_context`/`get_task` –
доказательство. Browser не подменяет MCP.

Node.js 22+ остаётся локальной предпосылкой bundled bridge и
`trelio-remote-skills`, но не удалённого Trelio OAuth. При отсутствующих tools
onboarding один раз разделяет эти состояния через `codex mcp list --json` и
безопасное разрешение `node`, не запуская заведомо отсутствующую команду.
Отсутствующий или старый Node не устанавливается молча: агент показывает
причину, предлагает exact `winget install --id OpenJS.NodeJS.LTS -e` в native
Windows либо `brew install node` на macOS с уже установленным Homebrew и ждёт
явного подтверждения. После изменения системного `PATH` нужен полный restart
Codex и новая задача. Отсутствие глобального `trelio-workspace` штатно: агент
использует bundled script текущей версии плагина.

Managed workspace admin может назначить plugin ролям, но OAuth проходит каждый
user и workspace policy не обходится.

## OAuth и pairing

Missing scope должен возвращать стандартный `mcp/www_authenticate`; native card
предпочтительна. Codex fallback `codex mcp login trelio` запускается без logout
и без narrowing scope, чтобы сохранить existing grant. 401/403/ACL различать;
ACL denial не маскировать как reauthorization.

Общий `.mcp.json` использует для Codex и Claude Code predefined public client
`trelio_agent_workspaces_v1`. Это одна client identity между задачами; OAuth
credential больше не должен переходить на новый DCR client при каждом
scope-upgrade. Текущий список Trelio scopes клиенты получают из server metadata,
поэтому manifest его не дублирует. На backend stable client принимает переменный
RFC 8252 loopback port только при exact host и callback path конкретного клиента,
а grant scopes объединяются только для exact user/client. Fresh Trelio login,
consent и PKCE не ослабляются. Legacy DCR clients остаются совместимыми. Backend
migration/production deploy обязаны предшествовать plugin release, иначе explicit
client id корректно завершится `invalid_client`.

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

Bridge start/claim сообщает client/model/effort как `local_observed`. Company
policy закрепляется за Run; PreToolUse guard проверяет её перед действиями.
Unknown client/model управляется explicit allow/deny. `CLAUDE_PLUGIN_ROOT` не
доказывает client kind. Guard нельзя обходить editing runtime files.

## Project onboarding skill

Onboarding работает в обычном Codex project, не внутри materialized Agent
Workspace. Он:

1. разрешает exact company и optional project;
2. читает `get_agent_instructions` до substantive setup;
3. безопасно создаёт/обновляет только marked Trelio block в project-root
   `AGENTS.md`/override, не заменяя unrelated instructions;
4. отдельно диагностирует Trelio OAuth и Node.js 22+, а отсутствующий runtime
   только предлагает установить после явного подтверждения;
5. выполняет `trelio-workspace login` без disposable Run;
6. читает live `list_agent_skills` exact scope;
7. предлагает настроить только выбранные skills one by one;
8. показывает unconfigured company connection как
   `требуется настройка администратором компании`;
9. никогда не пишет skills/connection state/credentials/IDs/local paths в
   project AGENTS.

Personal credentials вводятся только через protected runtime flow. Company
config и personal connection независимы; отдельные 1С skills нельзя сливать.
