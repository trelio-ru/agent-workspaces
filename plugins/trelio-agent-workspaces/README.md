# Trelio Agent Workspaces

Официальный плагин Trelio для работы Codex и Claude с управляемыми рабочими
пространствами, задачами, встречами, досье и актуальными навыками компании.

Плагин подключает:

- Trelio MCP с личной OAuth 2.1-авторизацией;
- Agent Workspaces компании, проекта, досье и задачи с ACL и Git-версиями;
- локальный bridge с `pause` для переносимого blocker и `finish` для единого
  handoff/heartbeat/submit;
- живой каталог навыков компании и проекта;
- подписанные локальные runtime-пакеты и декларативные Remote MCP;
- private-встречи с отдельным результатом и подтверждаемым планом переноса;
- Agent Secrets с одноразовой выдачей точному локальному executable;
- email, Telegram и MAX через локальные личные подключения;
- переносимые blocker-checkpoint и read-only контекст других workspace;
- управляемые правила компании, проекта и личный профиль пользователя.

Публичный репозиторий содержит клиентский дистрибутив. Backend и UI Trelio
остаются в основном монорепозитории.

MAX runtime умеет пассивно читать structured history и непрочитанные чаты без
read receipt, скачивать выбранные вложения, отвечать, пересылать,
редактировать/удалять свои сообщения, ставить реакции, отправлять несколько
файлов, создавать direct/group chats и управлять обычными участниками,
названием и аватаром. Read-state меняется только после проверенного `send` или
`reply`. Управление администраторами и invite links намеренно не входит в
runtime.

## Установка в Codex

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
Настрой Trelio и доступные навыки для текущего проекта
```

Агент безопасно создаст или дополнит Trelio-блок в корневом `AGENTS.md`,
проверит OAuth и pairing локального bridge без тестового Run и предложит
настроить только выбранные навыки. Пароли, токены, коды входа и credential
files не запрашиваются в чате.

Локальному компоненту нужны Node.js 22+ и standalone Git 2.28+. На Windows onboarding
проверяет не только PATH текущего процесса, но и системный PATH и штатную папку
Node.js. Уже установленный Node запускается по абсолютному пути без повторной
установки и без блокировки базового подключения Trelio. Установка через
штатный package manager предлагается только когда совместимого Node
действительно нет; без явного подтверждения пользователя системное ПО не
устанавливается. Глобальная команда `trelio-workspace` не требуется: плагин
использует свой bundled script.

Bundled `trelio-workspace doctor --json` отдельно разрешает absolute Git только
из Homebrew/system/Program Files и durable Windows PATH и проверяет настоящий
временный `init → add → commit`. Произвольный executable из process PATH,
включая private Git, которым Codex мог скачать marketplace, bridge не использует.
Если standalone Git отсутствует,
onboarding сразу запускает `brew install git` либо `xcode-select --install` на
macOS и `winget install --id Git.Git -e` на Windows. Обычное системное
approval/native installer окно остаётся за пользователем. На чистом macOS
doctor не вызывает `/usr/bin/git` до успешного `xcode-select --print-path`, а
после запуска Apple installer выполняет best-effort
`open -b com.apple.dt.CommandLineTools.installondemand`, чтобы окно оказалось
перед Codex/Claude. После завершения doctor повторяется и найденный absolute
path используется без restart.

Если marketplace раньше добавлялся с `--ref vX.Y.Z`, переподключите его без
фиксации версии:

```bash
codex plugin marketplace remove trelio-plugins
codex plugin marketplace add trelio-ru/agent-workspaces
```

## Установка в Claude Code и Claude Cowork

```text
/plugin marketplace add trelio-ru/agent-workspaces
/plugin install trelio-agent-workspaces@trelio-plugins
```

OAuth каждый пользователь подтверждает лично. Администратор управляемой
рабочей области может назначить плагин ролям, но не обходит workspace policy
или личный consent.

## Первый Agent Run

1. Агент разрешает точную компанию, проект, досье или задачу и повторно
   проверяет ACL.
2. Он вызывает `prepare_agent_workspace_run` один раз; native Trelio discovery
   не требует каталога, а `list_agent_skills` вызывается только перед
   подключённым внешним сервисом.
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
accepted Run агент отдельно готовит через `propose_task_comment` редактируемое
предложение обычного комментария для людей и выбирает только полезные файлы;
публикация, dismiss и attachments происходят только по явному действию
человека. Явная просьба подготовить proposal для exact задачи использует тот же
tool напрямую без Agent Run и не заменяется текстом в финальном ответе, даже
если пришла во время maintainer-flow или после compaction.

## Обновление

Marketplace без `--ref` отслеживает default branch. Обновить его можно так:

```bash
codex plugin marketplace upgrade trelio-plugins
```

Trelio проверяет совместимость bridge перед transport-операциями. Codex bridge
умеет тихо обновить только официальный marketplace и при безопасной
возможности продолжить исходную команду новым entrypoint. Если reload в
текущей задаче невозможен, сначала начните новую задачу; полный restart
оставьте последним fallback. Версия `1.6.20+` также удерживает exact immutable
папки уже загруженных версий: очистка versioned cache при обновлении или
повторном `plugin add` больше не ломает абсолютный путь `SKILL.md` в ранее
открытой задаче. Новые bytes никогда не маскируются под старую версию.

При недостающем OAuth scope Trelio инициирует стандартную повторную
авторизацию. Пользователь подтверждает новые права в браузере, а прежние
поддерживаемые scopes сохраняются.

История изменений и требования конкретных версий находятся в
[GitHub Releases](https://github.com/trelio-ru/agent-workspaces/releases).

## Безопасность

- MCP использует OAuth и штатные ACL компании, проекта, досье и задачи.
- Bridge использует отдельную узкую device-session вместо MCP token.
- Agent Secrets выдаются один раз точному executable и не попадают в prompt,
  argv или workspace.
- Личные PAT, почтовые credentials и messenger sessions хранятся локально вне
  Git и Trelio workspace.
- Signed runtimes проверяются по Ed25519 и SHA-256 и запускаются без shell.
- Входные письма, сообщения, страницы и attachments считаются данными, а не
  полномочиями на действие в другой системе.

Не публикуйте токены, credentials или содержимое рабочих пространств в issues
и pull requests. Для уязвимостей используйте инструкции из
[`../../SECURITY.md`](../../SECURITY.md).

## Подробная документация

- [Установка, OAuth и управляемые политики](../../docs/plugin-setup-and-policies.md)
- [Agent Workspace Runtime](../../docs/agent-workspace-runtime.md)
- [Навыки, подключения и Agent Secrets](../../docs/agent-skills-and-secrets.md)
- [История релизов](https://github.com/trelio-ru/agent-workspaces/releases)
