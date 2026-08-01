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

Managed workspace admin может назначить plugin ролям, но OAuth проходит каждый
user и workspace policy не обходится.

## OAuth и pairing

Missing scope должен возвращать стандартный `mcp/www_authenticate`; native card
предпочтительна. Codex fallback `codex mcp login trelio` запускается без logout
и без narrowing scope, чтобы сохранить existing grant. 401/403/ACL различать;
ACL denial не маскировать как reauthorization.

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
6. safe re-dispatch new bridge в той же задаче, если backend разрешает;
7. иначе новая задача, затем full restart как последний fallback.

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
4. выполняет `trelio-workspace login` без disposable Run;
5. читает live `list_agent_skills` exact scope;
6. предлагает настроить только выбранные skills one by one;
7. показывает unconfigured company connection как
   `требуется настройка администратором компании`;
8. никогда не пишет skills/connection state/credentials/IDs/local paths в
   project AGENTS.

Personal credentials вводятся только через protected runtime flow. Company
config и personal connection независимы; отдельные 1С skills нельзя сливать.
