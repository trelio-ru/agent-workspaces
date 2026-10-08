# Google Antigravity

Trelio подключается через native plugin с remote MCP `trelio` и local MCP
`trelio-remote-skills`. Общий подписанный host runtime работает локально; новая
установка не содержит его копию и получает проверенный package через прежний loader.

## Установка

Нужны Node.js 22+ и standalone Git 2.28+. Получите официальный репозиторий
`https://github.com/trelio-ru/agent-workspaces` через Git, затем выполните в нём:

```bash
node scripts/install-antigravity.mjs
```

Установщик материализует shell в
`~/.gemini/config/plugins/trelio-agent-workspaces`. Для workspace-level установки
передайте `--destination <workspace>/.agents/plugins/trelio-agent-workspaces`.
Путь должен оставаться постоянным: MCP registration содержит absolute paths.
Node executable определяется на компьютере во время установки. При переносе
каталога или удалении этой Node-установки повторите installer для нового пути.
CLI имеет отдельный native каталог; используйте `--destination` с
`~/.gemini/antigravity-cli/plugins/trelio-agent-workspaces` при необходимости,
не создавая две активные копии в одном клиенте.

После установки перезагрузите Antigravity и проверьте оба MCP в Customizations.
Для `trelio` завершите native OAuth: public client
`trelio_antigravity_agent_workspaces_v1`, exact callback
`https://antigravity.google/oauth-callback`, без client secret. Вход, consent
и перенос кода завершаются только пользователем в browser/application UI;
токены и коды не передаются агенту. Установщик не читает и не меняет OAuth stores
или общий `mcp_config.json`. Действующее подключение не требует повторного входа.

Изменённая либо сторонняя папка не заменяется. Upgrade разрешён только для
неизменённой managed установки: installer сверяет полный hash inventory,
повторяет проверку перед заменой и сохраняет прежний каталог для rollback.
Codex/Claude hooks и их onboarding skills в native discovery root не копируются.

## Допуск и проверка

Antigravity имеет собственное `antigravityAction` в company runtime policy.
Модель и effort неизвестны; такое подключение не подтверждает их. Запрет
`OAUTH_CLIENT_DENIED` требует решения администратора, а не имитации Cursor/Codex
или ручного proof. OAuth scopes, module/object ACL, bridge pairing и encryption
device grant остаются независимыми.

После OAuth прочитайте `list_companies`, выберите exact company и следуйте её
server-selected content route. Protected read и local MCP проверяются отдельно.
Диагностика принимает `clientKind=antigravity`, `intent=diagnostics`; она не
проверяет foreign hooks и не настраивает managed binding. Материалы сохраняются
только в выданной bridge папке. Не создавайте тестовые задачи/Workspace/Run.

## Shell boundary и rollout

Native root manifest и MCP registration нужны клиенту до загрузки runtime.
Именно поэтому это shell-owned compatibility change, который невозможно
доставить backend instruction или signed runtime. Loader/verifier ABI остаётся
прежним; minimum старых клиентов не повышается. Installer tests проверяют native
registration, прежний loader, отсутствие чужих hooks и сохранение human edits.

Backend с новой регистрацией должен быть развёрнут до публикации installer.
При rollback остановите новую установку; прежние Codex/Claude/Cursor manifests,
глобальная авторизация и runtime minimum сохраняют совместимость. Полный smoke
установленного Antigravity и наличие MCP Apps проверяются после rollout: source
и API tests не доказывают поведение конкретной версии клиента.

Источники: [native plugins](https://antigravity.google/docs/plugins),
[MCP/OAuth](https://antigravity.google/docs/mcp).
