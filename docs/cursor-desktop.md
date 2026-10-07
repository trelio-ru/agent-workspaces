# Cursor Desktop

Cursor использует native manifest
`plugins/trelio-agent-workspaces/.cursor-plugin/plugin.json`; корневой
`.cursor-plugin/marketplace.json` описывает этот же plugin для Cursor.
Codex и Claude продолжают читать свои прежние manifests и hooks.

## OAuth и политика

Remote `trelio` подключается к `https://trelio.ru/mcp` с
`auth.CLIENT_ID=trelio_cursor_agent_workspaces_v1`. Scopes не закреплены в
manifest: Cursor берёт их из текущей server metadata. Backend должен поддерживать
эту регистрацию до выпуска Cursor plugin. На старом backend первый вход
завершается `invalid_client`; менять общий клиент или обходить gate нельзя.

OAuth требует fresh Trelio login, явного согласия и PKCE S256; callback только
`http://localhost:8787/callback`. Consent явно сообщает, что модель не
проверяется. Каждый token получает scopes текущего запроса. Компания управляет
доступом переключателем «Cursor / Grok Bot», по умолчанию разрешённым; в режиме
enforce сохранённый запрет блокирует MCP и paired bridge.

Public client ID описывает согласованный OAuth-профиль, но не доказывает запуск
конкретного приложения. Другой native host может выбрать этот профиль при
явном согласии пользователя. Имя клиента, localhost и `clientKind` сами по
себе допуска не дают. Старые подключения Codex/Claude, их model policy,
OAuth grants/tokens и pairing сохраняются.

## Локальная работа

`trelio-remote-skills` использует `${CURSOR_PLUGIN_ROOT}` и прежний signed loader.
Native MCP запускает `node` из PATH на каждой OS с отдельным preload guard:
Node.js <22 отклоняется до loader, cache и network. Это не зависит от выбора
POSIX launcher либо `.cmd`; запуск Codex/Claude не меняется. Нужны доступные
Node.js >=22 и Git >=2.28.
Workspace, skills, secrets и encrypted context продолжают идти через exact
server-selected actions; pairing и crypto-device envelope независимы от OAuth.
Без managed folder binding bridge использует прежний fallback
`~/Trelio Workspaces/<workspace-id>/`.

Native manifest явно задаёт пустые hooks, чтобы Cursor не обнаружил общие
Codex/Claude definitions. Для этого профиля runtimeSessionProof не создаётся.
Загружаются общие worker, catalog, project-access и private-skill skills, а
отдельное Cursor rule задаёт OAuth recovery. Диагностика и автоматический folder
onboarding с enum Codex/Claude пока не поддерживают Cursor и в нём не объявлены.
Не подставляйте чужой clientKind.

## Установка и проверка

Официальная публикация в Cursor Marketplace требует отдельного review Cursor;
наличие manifest в Git не означает, что plugin уже перечислен в marketplace.
В Teams/Enterprise репозиторий можно добавить через Dashboard → Plugins & MCPs
→ Team Marketplaces → Import from Repo. Установка выполняется из Customize
в выбранной user/project scope.

Для локальной разработки Cursor поддерживает `~/.cursor/plugins/local`.
Разместите там каталог `plugins/trelio-agent-workspaces` целиком с его native
manifest. Не копируйте только MCP JSON без skills/rule и не подключайте тот же
remote server параллельно из общего Codex/Claude config.

После установки авторизуйте `trelio` штатной кнопкой Cursor, выберите exact
компанию и проверьте protected read. Затем проверьте bridge pairing, чтение
accepted Workspace и один Run. MCP Apps нужно проверить в фактической версии
Cursor; наличие поддержки в документации не подтверждает конкретную Trelio card.

Структура manifest, callback, PKCE, fresh consent, scopes, company deny, paired
HTTP и encrypted proposal paths проверяются автоматическими regressions. Live
Cursor UI/OAuth smoke выполняется отдельно в установленном клиенте; автоматические
тесты не подменяют его.

Контракты Cursor:
[Plugins](https://cursor.com/docs/reference/plugins),
[установка](https://cursor.com/docs/plugins),
[MCP/OAuth](https://cursor.com/docs/mcp).
