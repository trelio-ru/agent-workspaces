# Trelio Agent Workspaces

Официальный публичный дистрибутив плагина Codex и Claude для работы с
управляемыми Agent Workspaces и живыми навыками Trelio.

Плагин подключает:

- production MCP `https://trelio.ru/mcp` с OAuth 2.1;
- навык `trelio-workspace-worker` с регламентом Agent Run;
- bootstrap-навык `trelio-skill-catalog`, который загружает текущие назначения
  компании и проекта через MCP без фиксации версии в Run;
- локальный Git bridge для открытия workspace, checkpoint и передачи candidate
  revision на проверку;
- переносимый TLS IMAP/SMTP CLI для первого навыка электронной почты без Gmail API.

При настройке Gmail CLI показывает прямую официальную страницу
[`myaccount.google.com/apppasswords`](https://myaccount.google.com/apppasswords),
удаляет визуальные пробелы из 16-символьного пароля приложения и открывает
скрытое системное окно ввода на macOS или Windows. Терминальный ввод остаётся
только fallback для headless-среды.

Этот репозиторий является единственным каноническим источником плагина. В
основном Trelio-монорепозитории находятся backend и UI Agent Workspaces, но не
дублируемая копия клиентского дистрибутива.

## Работа с оператором

Плагин ведёт человека через результат, а не через технические детали Agent Run.
Перед проверкой агент обязан:

- опубликовать в task-scoped задаче содержательный комментарий о результате;
- сохранить handoff с итогом, подтверждениями, материалами, вопросами и
  конкретным действием оператора;
- назвать человеку результат и требуемое решение, не подменяя их SHA, UUID или
  сообщением о том, что полезный текст находится «внутри candidate».

## Установка

Добавьте зафиксированную версию marketplace:

```bash
codex plugin marketplace add trelio-ru/agent-workspaces --ref v1.2.0
```

Перезапустите Codex, откройте `Plugins`, выберите источник `Trelio` и установите
`Trelio Agent Workspaces`. При первом подключении Trelio запросит OAuth-доступ,
а локальный bridge сохранит credential в системном хранилище.

Для Claude Code / Claude Cowork используйте marketplace этого же репозитория:

```text
/plugin marketplace add trelio-ru/agent-workspaces
/plugin install trelio-agent-workspaces@trelio-plugins
```

Назначения навыков в Trelio аддитивны: компания может включить навык всем,
проект – добавить свой. Отключение не удаляет личные навыки пользователя и не
является запретом. Обновлённая Markdown-инструкция навыка приходит при
следующем MCP-чтении, поэтому для неё не требуется новый Agent Run или ручная
синхронизация пользовательской папки.

## Безопасность

Публичный репозиторий содержит только клиентский дистрибутив. Публикация MCP URL
не открывает данные Trelio: каждый запрос проходит OAuth, scopes и обычные
проверки доступа компании, проекта и задачи.

Не добавляйте токены, локальные credentials и содержимое рабочих workspace в
issues или pull requests. Для уязвимостей используйте приватное сообщение через
GitHub Security Advisory.

## Версионирование

Версия плагина и публичный Git tag выпускаются вместе. Для production-установок
используйте `--ref vX.Y.Z`, чтобы обновление дистрибутива не происходило
неожиданно.

Подробности находятся в
[`plugins/trelio-agent-workspaces/README.md`](plugins/trelio-agent-workspaces/README.md).
