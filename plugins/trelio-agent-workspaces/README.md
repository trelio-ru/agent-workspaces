# Trelio Agent Workspaces

Официальный плагин Trelio для работы Codex и Claude с управляемыми рабочими
пространствами, задачами, встречами, досье и актуальными навыками компании.

Плагин подключает:

- Trelio MCP с личной OAuth 2.1-авторизацией;
- Agent Workspaces компании, проекта, досье и задачи с ACL и Git-версиями;
- локальный bridge для checkpoint, handoff и конфликтобезопасного submit;
- живой каталог навыков компании и проекта;
- подписанные локальные runtime-пакеты и декларативные Remote MCP;
- private-встречи с отдельным результатом и подтверждаемым планом переноса;
- Agent Secrets с одноразовой выдачей точному локальному executable;
- email, Telegram и MAX через локальные личные подключения;
- переносимые blocker-checkpoint и read-only контекст других workspace;
- управляемые правила компании, проекта и личный профиль пользователя.

Публичный репозиторий содержит клиентский дистрибутив. Backend и UI Trelio
остаются в основном монорепозитории.

## Установка в Codex

Добавьте официальный marketplace:

```bash
codex plugin marketplace add trelio-ru/agent-workspaces
```

Policy `INSTALLED_BY_DEFAULT` устанавливает плагин автоматически, поэтому
отдельная команда `codex plugin add` не нужна. Policy
`authentication=ON_INSTALL` просит Codex открыть страницу входа в Trelio.
Завершите личный OAuth в браузере и начните новую задачу, чтобы сессия заново
прочитала MCP tools.

Открывайте плагин в `Plugins` вручную только как fallback, если страница входа
не появилась автоматически. Полный restart нужен лишь когда новая задача всё
ещё не видит инструменты Trelio или использует старую версию плагина.

Затем выберите starter prompt:

```text
Настрой Trelio и доступные навыки для текущего проекта
```

Агент безопасно создаст или дополнит Trelio-блок в корневом `AGENTS.md`,
проверит OAuth и pairing локального bridge без тестового Run и предложит
настроить только выбранные навыки. Пароли, токены, коды входа и credential
files не запрашиваются в чате.

Локальному компоненту нужен Node.js 22 или новее. Если Codex его не видит,
onboarding отдельно объяснит причину и предложит установку через штатный
package manager; без явного подтверждения пользователя системное ПО не
устанавливается. Глобальная команда `trelio-workspace` не требуется: плагин
использует свой bundled script.

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
2. Для корпоративной интеграции он читает актуальный каталог назначенных
   навыков и загружает только релевантную инструкцию.
3. Trelio создаёт Run с закреплёнными правилами, личным профилем и base head.
4. Bridge materialize-ит единственный writable workspace и выбранный
   read-only контекст.
5. Агент выполняет работу, сохраняет checkpoints и готовит handoff.
6. Submit принимается атомарно, только пока base head актуален.

При первом `open` bridge создаёт короткую pairing-заявку. Агент передаёт её
уже авторизованному Trelio MCP и повторяет исходную команду. MCP token bridge
не получает: на устройстве сохраняется отдельная узкая device-session с
приватными правами. Если политика клиента требует подтверждения tool call,
клиент сам показывает единственную штатную кнопку.

Task-scoped accepted Run создаёт системный комментарий из immutable handoff.
Отдельно агент может показать редактируемое предложение обычного комментария
и выбранные итоговые файлы; публикация и attachments происходят только по
явному действию человека.

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
