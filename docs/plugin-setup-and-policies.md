# Установка, OAuth и управляемые политики

## Содержание

- Codex marketplace
- OAuth и новый контекст
- Локальные Node.js и Git
- Pairing локального bridge
- Claude Code и Claude Cowork
- Политика моделей
- Правила компании, проекта и пользователя

## Codex marketplace

Сначала создайте или откройте локальный проект Codex с доступной основной
папкой и начните задачу внутри него. Папка может быть пустой и не обязана быть
Git-репозиторием. Чат без локального проекта не начинает установку или OAuth:
привязку к Trelio нужно сохранить в выбранном root для следующих задач.

Официальный источник подключается без `--ref`, после чего плагин устанавливается
явно:

```bash
codex plugin marketplace add trelio-ru/agent-workspaces
codex plugin add trelio-agent-workspaces@trelio-plugins
```

Codex CLI добавляет marketplace и устанавливает plugin разными операциями.
`INSTALLED_BY_DEFAULT` может ускорить установку в host UI, но сообщение только
о добавленном marketplace не подтверждает её: основной CLI-flow всегда
выполняет `codex plugin add` и проверяет `codex plugin list --json`.
`authentication=ON_INSTALL` просит Codex автоматически открыть browser OAuth
Trelio. Если окно не появилось, агент в той же задаче запускает
`codex mcp login trelio`; ручной переход в `Plugins` не является основным
fallback.

Вход в Trelio и подтверждение доступа проходят в одном окне OAuth. Если
пользователь ещё не авторизован на сайте, это окно само проводит вход и
возвращает к подтверждению. Не нужно сначала входить на сайт отдельно,
возвращаться в чат или писать «я вошёл».

После OAuth агент сначала повторно проверяет инструменты в текущей задаче и
продолжает в ней, если они уже появились. Новая задача нужна только после
фактического неуспеха этой проверки; в ней пользователь остаётся в том же
локальном проекте и выбирает предложенный manifest-ом starter prompt `Настрой
Trelio Agent Workspaces для текущей рабочей папки`, а не перепечатывает его.
Полный restart нужен только если новая задача всё ещё не видит tools или
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
версию. Начиная с `1.6.20`, перед такими mutating-командами bridge сохраняет
exact загруженную immutable-версию в приватном retention-каталоге и после
команды восстанавливает её прежний versioned path. Поэтому уже открытая задача
не теряет свой `SKILL.md`, когда Codex очищает старую cache-папку; новые задачи
по-прежнему получают актуальную версию.

## OAuth и новый контекст

Каждый пользователь подтверждает OAuth лично. Администратор управляемой
ChatGPT/Codex workspace может импортировать marketplace и назначить плагин
ролям, но не может обойти workspace policy или consent.

Если Trelio tool возвращает `mcp/www_authenticate`, используйте нативную
карточку reauthorization. На старом Codex host fallback-команда –
`codex mcp login trelio`; logout и запрос только одного нового scope запрещены,
поскольку повторный grant должен сохранить уже выданные права.

Если skill виден, а MCP tools нет, это неполная установка, а не ACL задачи.
Нельзя подменять Trelio MCP browser-доступом. После настройки сначала повторно
проверьте tools в текущей задаче; новая нужна только если они не появились,
restart – только если проблема сохраняется и там.

## Локальные Node.js и Git

Bundled bridge запускается через Node.js 22+ и использует standalone Git 2.28+.
Это локальные prerequisites, независимые от remote Trelio OAuth. Успех
`marketplace add` не доказывает наличие Git: Codex plugin manager может
использовать собственный undocumented executable, который не наследует Node
bridge.

После разрешения Node onboarding выполняет:

```text
trelio-workspace doctor --json
```

Команда проверяет стандартные Homebrew/system/Program Files пути, durable
Windows machine/user PATH, exact version и временный `init → add → commit`.
Произвольный executable из process PATH, включая внутренний Git Codex, не
принимается; PATH сообщает только, виден ли уже выбранный standalone Git
текущему процессу. Все дальнейшие workspace-команды используют один проверенный
absolute Git path без shell. Найденный после установки Git не требует restart.

При `TRELIO_GIT_REQUIRED` onboarding сразу запускает exact план из doctor:

- macOS – `brew install git`, если Homebrew уже установлен, иначе
  `xcode-select --install`;
- Windows – `winget install --id Git.Git -e --source winget
  --accept-source-agreements --accept-package-agreements`; если App Installer
  отсутствует, открывается официальный Git for Windows installer.

Отдельного вопроса в чате нет. Обычное command approval, administrator prompt
или native installer окно ОС остаётся за пользователем. После завершения
onboarding повторяет doctor в той же задаче и только затем повторяет исходную
workspace-команду; неоднозначный результат installer-а не повторяется до этой
проверки.

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

В Claude Code пользователь сначала открывает терминал в постоянной рабочей
папке и запускает `claude` из неё. Пустая папка допустима, Git-репозиторий
необязателен. В Cowork задача должна получить доступ к выбранной папке до
установки плагина.

```text
/plugin marketplace add trelio-ru/agent-workspaces
/plugin install trelio-agent-workspaces@trelio-plugins
```

Claude обновляет marketplace своим plugin manager. После установки или
обновления выполните `/reload-plugins`, затем начните новую задачу или сессию с
доступом к той же папке и попросите: `Настрой Trelio Agent Workspaces для
текущей рабочей папки`. OAuth выполняется через exact Trelio server в `/mcp`
либо `claude mcp login trelio`; полный restart – последний fallback.

## Политика моделей

Компания может закрепить допустимые client/model/reasoning effort для всей
работы с Trelio, включая обычные задачи без Agent Run. Каждый non-recovery MCP
request содержит self-reported `runtimeAttestation` current model/effort, а
backend применяет policy фактической company. Discovery проверяет разрешённость
модели без minimum effort; context, mutation и Agent Workspace требуют оба
ограничения.

Agent Run закрепляет snapshot и initiating declaration; exact open command
передаёт её bridge в `--runtime-*`. Plugin не читает модель из env/transcript и
не регистрирует `PreToolUse` guard. Неизвестные модели и клиенты управляются
отдельными allow/deny правилами. Это cooperative `self_reported`, не
криптографическая аттестация. Нельзя копировать attestation другой модели или
редактировать `.trelio-run.json` для обхода.

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
`context/agent-instructions.md` защищены; `WORKSPACE_CONTEXT.md` нельзя
использовать как скрытый источник инструкций.
