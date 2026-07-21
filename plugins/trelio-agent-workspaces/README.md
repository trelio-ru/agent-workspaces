# Trelio Agent Workspaces

Официальный плагин для работы Codex с управляемыми
пространствами Trelio уровня компании, проекта и задачи.

## Установка

Добавьте GitHub-репозиторий как Codex marketplace:

```bash
codex plugin marketplace add trelio-ru/agent-workspaces --ref v1.1.0
```

Затем перезапустите ChatGPT desktop, откройте `Plugins`, выберите источник
`Trelio` и установите `Trelio Agent Workspaces`. После установки MCP запросит
OAuth-доступ Trelio. При первом локальном открытии workspace bridge отдельно
запустит OAuth PKCE и сохранит credential в macOS Keychain.

Для разработки можно подключить текущий checkout публичного репозитория:

```bash
codex plugin marketplace add /absolute/path/to/agent-workspaces
```

Marketplace описан в `.agents/plugins/marketplace.json`; plugin manifest – в
`.codex-plugin/plugin.json`.

## Что видит оператор

Для task-scoped работы агент сам публикует содержательный комментарий в задаче,
а перед review сохраняет handoff с итогом, подтверждениями, подготовленными
материалами, открытыми вопросами и требуемым действием человека. UUID, полный
Git SHA, lease/fencing и bridge-команды остаются диагностическими деталями и не
подменяют рабочий отчёт.
