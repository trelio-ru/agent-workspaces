# Установка, OAuth и управляемые политики

## Содержание

- Codex marketplace
- OAuth и новый контекст
- Pairing локального bridge
- Claude Code и Claude Cowork
- Политика моделей
- Правила компании, проекта и пользователя

## Codex marketplace

Официальный источник подключается без `--ref`:

```bash
codex plugin marketplace add trelio-ru/agent-workspaces
```

`INSTALLED_BY_DEFAULT` устанавливает плагин сразу. `authentication=ON_INSTALL`
просит Codex автоматически открыть browser OAuth Trelio. Ручной переход в
`Plugins -> Trelio Agent Workspaces` нужен только когда эта страница не
появилась.

После OAuth начните новую задачу: уже открытая сессия может не перечитать MCP
tools. Полный restart нужен только если новая задача всё ещё не видит tools или
использует старую plugin-version.

Источник, добавленный с `--ref`, остаётся на tag и перестанет проходить
обязательный version gate после следующего релиза. Переподключите его:

```bash
codex plugin marketplace remove trelio-plugins
codex plugin marketplace add trelio-ru/agent-workspaces
```

Обновление обычного источника:

```bash
codex plugin marketplace upgrade trelio-plugins
```

Начиная с `1.5.11`, bridge проверяет exact официальный marketplace и может
тихо обновить его в отдельном процессе. При hard gate он повторно проверяет
installed manifest/entrypoint и, когда это безопасно, продолжает исходную
команду новым bridge. Он не сканирует plugin cache и не выбирает произвольную
версию.

## OAuth и новый контекст

Каждый пользователь подтверждает OAuth лично. Администратор управляемой
ChatGPT/Codex workspace может импортировать marketplace и назначить плагин
ролям, но не может обойти workspace policy или consent.

Если Trelio tool возвращает `mcp/www_authenticate`, используйте нативную
карточку reauthorization. На старом Codex host fallback-команда –
`codex mcp login trelio`; logout и запрос только одного нового scope запрещены,
поскольку повторный grant должен сохранить уже выданные права.

Если skill виден, а MCP tools нет, это неполная установка, а не ACL задачи.
Нельзя подменять Trelio MCP browser-доступом. После настройки нужна новая
задача; restart – только если проблема сохраняется и там.

## Pairing локального bridge

Bridge не запускает второй OAuth. На новом устройстве он создаёт короткую
PKCE-подобную pairing-заявку, оставляя verifier локально. Агент вызывает
`approve_agent_workspace_bridge_pairing` с exact `pairingId` и `deviceName`,
после чего повторяет исходную команду. Код и verifier человеку не показываются.

Device-session хранится отдельно от MCP OAuth:

- macOS/Linux – `~/.config/trelio/workspace-bridge/credentials.json`, каталог
  `0700`, файл `0600`, owner/no-symlink checks и атомарная запись;
- Windows – `%LOCALAPPDATA%\Trelio\workspace-bridge\credentials.json` с exact
  ACL только текущего пользователя.

Системная Keychain не является рабочим хранилищем; legacy значение переносится
один раз. Если server exchange завершился, а локальная запись не удалась,
bridge вызывает authenticated self-revoke. Неуспешный cleanup показывается
явно.

Узкая session получает только workspace transport и уже разрешённые
secret-write/checkout действия. Права управления правилами и чтения secret
metadata остаются у основного MCP OAuth.

## Claude Code и Claude Cowork

```text
/plugin marketplace add trelio-ru/agent-workspaces
/plugin install trelio-agent-workspaces@trelio-plugins
```

Claude обновляет marketplace своим plugin manager. После обновления используйте
`/reload-plugins`, если команда доступна, иначе новую задачу; полный restart –
последний fallback.

## Политика моделей

Компания может закрепить допустимые client/model/reasoning effort для новых
Agent Runs. Bridge сообщает только локально наблюдаемые значения; это
`local_observed`, не криптографическая аттестация платформы.

Policy закрепляется за Run и повторно проверяется локальным `PreToolUse` guard
Codex/Claude Code. Неизвестные модели и клиенты, включая среду без надёжных
model+effort данных, управляются отдельным allow/deny правилом. Нельзя обходить
guard редактированием `.trelio-run.json`, hook или client metadata.

## Правила компании, проекта и пользователя

Company/project правила публикуются immutable revisions и применяются только к
новым Runs. Bridge materialize-ит закреплённый compiled snapshot в
`context/agent-instructions.md`. Server-managed platform rules проходят тот же
preflight с SHA-256 и также закрепляются за Run.

Личный профиль «Как агенту работать со мной» – отдельная versioned
company-scoped revision текущего пользователя. Он влияет на стиль и способ
взаимодействия, но не отменяет company/project rules, ACL, approval или safety.

Перед изменением агент различает `current_request`, `task`, `personal`,
`project` и `company`, показывает exact diff и scope и публикует только после
явного подтверждения. `AGENTS.md`, `CLAUDE.md`, `.trelio/**` и
`context/agent-instructions.md` защищены; `PROJECT_CONTEXT.md` нельзя
использовать как скрытый источник инструкций.
