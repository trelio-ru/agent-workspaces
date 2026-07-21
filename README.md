# Trelio Agent Workspaces

Официальный публичный дистрибутив плагина Codex для работы с управляемыми
Agent Workspaces в Trelio на трёх уровнях: компания, проект и задача.

Плагин подключает:

- production MCP `https://trelio.ru/mcp` с OAuth 2.1;
- навык `trelio-workspace-worker` с регламентом Agent Run;
- локальный Git bridge для открытия workspace, checkpoint и передачи candidate
  revision на проверку.

## Установка

Добавьте зафиксированную версию marketplace:

```bash
codex plugin marketplace add trelio-ru/agent-workspaces --ref v1.1.0
```

Перезапустите Codex, откройте `Plugins`, выберите источник `Trelio` и установите
`Trelio Agent Workspaces`. При первом подключении Trelio запросит OAuth-доступ,
а локальный bridge сохранит credential в системном хранилище.

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
