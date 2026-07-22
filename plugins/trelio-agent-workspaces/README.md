# Trelio Agent Workspaces

Официальный плагин для работы Codex и Claude с управляемыми пространствами
Trelio уровня компании, проекта и задачи, а также с актуальными навыками,
которые компания или отдельный проект включили для агентов.

## Установка

Добавьте GitHub-репозиторий как Codex marketplace:

```bash
codex plugin marketplace add trelio-ru/agent-workspaces --ref v1.3.1
```

Затем перезапустите ChatGPT desktop, откройте `Plugins`, выберите источник
`Trelio` и завершите OAuth-доступ в `Trelio Agent Workspaces`. Marketplace
устанавливает плагин автоматически благодаря policy `INSTALLED_BY_DEFAULT`.
После OAuth полностью перезапустите Codex и начните новую задачу, чтобы сессия
перечитала MCP-инструменты. При первом локальном открытии workspace bridge
отдельно запустит OAuth PKCE и сохранит credential в macOS Keychain.

В управляемой рабочей области администратор импортирует marketplace один раз и
назначает плагин нужным ролям. Каждый пользователь всё равно проходит OAuth
лично. Автоматическая установка не расширяет доступ вопреки policy рабочей
области.

Для разработки можно подключить текущий checkout публичного репозитория:

```bash
codex plugin marketplace add /absolute/path/to/agent-workspaces
```

Marketplace описан в `.agents/plugins/marketplace.json`; plugin manifest – в
`.codex-plugin/plugin.json`.

Для Claude Code / Claude Cowork добавьте тот же GitHub-репозиторий как
marketplace и установите `trelio-agent-workspaces`:

```text
/plugin marketplace add trelio-ru/agent-workspaces
/plugin install trelio-agent-workspaces@trelio-plugins
```

Claude manifest находится в `.claude-plugin/plugin.json`, а marketplace – в
корневом `.claude-plugin/marketplace.json`. После обновления marketplace клиент
получает новую версию плагина штатным механизмом Claude.

## Поиск задач и связанный контекст

До выбора writable workspace агент сначала ищет существующую задачу в области,
разрешённой локальным `AGENTS.md` или запросом пользователя. Поиск Trelio
обычный, не семантический: агент формирует 5–12 коротких синонимов, сокращений и
вариантов названия и передаёт их отдельными элементами одного вызова
`search_tasks`. Backend ищет каждый вариант независимо, повторно проверяет MCP
policy и task ACL, дедуплицирует задачи и ставит выше совпавшие с несколькими
вариантами. Склеивать все слова в одну длинную строку нельзя.

Найденный кандидат проверяется через `get_task`; похожего названия без второго
независимого признака недостаточно. После подтверждения агент использует task
workspace. Project workspace предназначен для общих материалов проекта, а
company workspace – только для материалов всей компании.

Агент может сам искать принятые text-файлы во всех workspace, которые доступны
пользователю, и читать точный найденный head. Для известной связанной задачи,
проекта или компании он может получить workspace напрямую по scope. Обычные
ACL перепроверяются на каждом результате; связь между задачами не открывает
доступ к закрытой задаче или её файлам.

Выбранный workspace прикрепляется к активному Run как pinned read-only
`related` context. Bridge материализует его рядом с parent context:

```text
context/index.json
context/company/
context/project/
context/related/<workspace-uuid>/
```

Если агент прикрепил контекст после локального `open`, достаточно выполнить:

```bash
trelio-workspace context attach --workspace <uuid>
trelio-workspace context sync
```

Первая команда использует актуальные lease/fencing из локального Run,
прикрепляет workspace и сразу синхронизирует его. `context sync` отдельно
догружает уже прикреплённые через MCP revision. Bridge атомарно заменяет
локальные read-only snapshots. Единственный каталог `workspace/` остаётся
writable и только он попадает в candidate.

Простые связи задач не требуют общего кейса. Агент описывает смысл прямой
связи свободной подписью, а направленность задаёт отдельно. Рабочий кейс
используется только для одного предмета, представленного несколькими задачами.

## Живой каталог навыков

Bootstrap-навык `trelio-skill-catalog` получает через Trelio MCP текущий список
навыков компании и конкретного проекта. Корпоративные и проектные назначения
складываются; отключение назначения не удаляет и не запрещает личный навык
пользователя. Инструкции загружаются непосредственно перед применением и не
фиксируются в Agent Run, поэтому новая опубликованная версия доступна при
следующем чтении каталога.

Первый навык – электронная почта через обычные IMAP/SMTP. Плагин включает
dependency-free CLI `scripts/trelio-email.py` для Python 3.11+: поиск, чтение,
список и сохранение выбранных вложений, диагностику и подтверждаемую отправку.
Gmail API не нужен. Для Gmail, Mail.ru, Яндекса и некоторых корпоративных
серверов может понадобиться пароль приложения и отдельное разрешение IMAP/SMTP.
Для Gmail CLI сразу показывает официальную прямую ссылку
[`https://myaccount.google.com/apppasswords`](https://myaccount.google.com/apppasswords),
подставляет `imap.gmail.com` / `smtp.gmail.com` и удаляет пробелы из показанного
Google 16-символьного пароля до его сохранения.

Первичная настройка выполняется интерактивно, чтобы пароль не попадал в shell
history:

```bash
python3 scripts/trelio-email.py configure --account work
python3 scripts/trelio-email.py doctor --account work
```

По умолчанию пароль вводится не в терминале: на macOS открывается системный
hidden-answer dialog, на Windows – модальное системное окно с masked-полем.
Если GUI недоступен в headless-среде, CLI сообщает об этом и использует скрытый
terminal fallback. Режим можно явно выбрать через
`--password-input window|terminal|auto`.

На macOS пароль сохраняется в Keychain. На других системах используется файл
`~/.config/trelio/email/secrets/<account>.password` с закрытыми правами; его
можно заменить переменной окружения `TRELIO_EMAIL_PASSWORD_<ACCOUNT>`.

## Agent Secrets

Trelio хранит значения Agent Secrets зашифрованно и выдаёт локальному bridge
только одноразовые grants конкретного Agent Run. Сам Trelio не запускает
внешние команды. Значение не возвращается в MCP и не попадает в workspace.

После `prepare_agent_secret_checkout` bridge запускается так:

```bash
trelio-workspace secret exec --grant <uuid> -- <executable> [args...]
```

Агент может записать значение, которое уже выдаёт локальная программа или
защищённый файл, напрямую в vault без MCP tool argument:

```bash
producer-command | trelio-workspace secret set --secret <uuid>
trelio-workspace secret set --secret <uuid> --file /secure/local/path
```

Команда работает только внутри активного materialized Run. Не передавайте
literal value параметром командной строки и не создавайте ради него файл в
workspace.

Для `file` delivery путь доступен локальной программе в
`TRELIO_SECRET_FILE`; временный файл имеет права `0600` и удаляется после
завершения процесса. Для новых OAuth scopes выполните `trelio-workspace login`
повторно.

## Что видит оператор

Для task-scoped работы агент сам публикует содержательный комментарий в задаче,
а перед записью сохраняет handoff с итогом, подтверждениями, подготовленными
материалами, открытыми вопросами и следующим действием. После проверок Trelio
принимает revision автоматически, только если pinned `baseHead` всё ещё
актуален. При конфликте агент начинает новый Run от текущей версии и переносит
изменения осознанно. UUID, полный Git SHA, lease/fencing и bridge-команды
остаются диагностическими деталями и не подменяют рабочий отчёт.
