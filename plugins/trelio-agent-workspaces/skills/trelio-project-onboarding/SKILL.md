---
name: trelio-project-onboarding
description: Настройка Trelio Agent Workspaces в одной постоянной локальной папке Codex или Claude Code с изоляцией служебного Git, привязкой компании/проекта в AGENTS.md и импортом CLAUDE.md. Проверка OAuth, bridge, Node/Git и pairing в macOS/Windows, актуального каталога при доступном удалённом содержимом и локального маршрута зашифрованной компании без раскрытия credentials. Используй после установки/авторизации плагина, по просьбе подключить Trelio в рабочей папке, создать её привязку/импорт или настроить доступные навыки.
---

<a id="trelio-working-folder-onboarding"></a>

# Настройка рабочей папки Trelio

По умолчанию общайся по-русски; явный выбор другого языка сохраняй. Ограничение
объясняй кратко: причина и следующий шаг. Точные команды, поля, ссылки и коды
ошибок не переводи.

Настрой одну постоянную папку, выбранную клиентом, без пробного Agent Run. Это
папка управляющего контекста, а не Git-привязка. Классификацию корня, служебного
Git, instruction-файлов, `.gitignore`, managed blocks и CAS выполняет локальный
runtime. Не воспроизводи эти проверки shell-командами и не собирай файлы вручную.

Защищённые вызовы получают одноразовый `runtimeSessionProof` только от
подтверждённого hook. Не создавай и не копируй runtime-поля. Если сам Trelio
вернул `TRELIO_RUNTIME_HOOK_REQUIRED`, это доказывает только отсутствие proof;
сохрани точный code/reason. Если просмотр
определения не подтверждён, попроси один раз проверить Hooks в настройках
плагина или `/hooks`; при подтверждённом доверии используй `trelio-diagnostics`
для exact definition/matcher и хронологии владеющего процесса, не повторяй этот
совет. Ошибка `PreToolUse` доказывает, что hook запускался. Не автоматизируй
доверие. Runtime upgrade исправляет stable loader; только
`AGENT_WORKSPACE_PLUGIN_UPGRADE_REQUIRED` требует официальный plugin update.

<a id="confirm-the-working-folder-first"></a>

## Выбери и проверь папку

1. Получи одну существующую постоянную папку из контекста клиента:
   - Codex – основная папка открытого локального проекта;
   - Claude Code – `CLAUDE_PROJECT_DIR`, эквивалентный MCP root или папка, из
     которой пользователь запустил текущую сессию.
   Не поднимайся к Git root, не выбирай home, cache, временный каталог, соседний
   репозиторий или cwd задачи без локального проекта. Не создавай папку наугад.
2. Если папка не определена, остановись без изменений: `Рабочая папка не
   найдена. Настройка не начата.` Предложи открыть нужный локальный проект или
   перезапустить Claude из нужной папки и повторить запрос в новой задаче/сессии.
3. До Trelio discovery вызови `diagnose_trelio_installation`:

   ```json
   {
     "clientKind":"codex|claude-code",
     "intent":"folder_onboarding",
     "folderOnboarding":{"folderPath":"absolute-client-selected-path"}
   }
   ```

   Это единственная каноническая классификация папки. Не читай и не меняй `.git`,
   refs, objects, hooks, config или содержимое `workspaces/` самостоятельно.
4. `inspection.status=ready` разрешает продолжение. При
   `instruction_target_required` объясни, что активный `AGENTS.override.md`
   перекрывает `AGENTS.md`, и спроси: обновить override или пользователь сначала
   удалит/переименует его. Передай выбранный `instructionTarget` в следующий план.
5. Любой blocked/error означает остановку без Trelio-привязки. Покажи точную
   причину и действие runtime. Для Git-репозитория предложи отдельную обычную
   папку проекта без Git. Не удаляй/переименовывай `.git`, не меняй ACL и не
   советуй очистить историю. `TRELIO_GIT_REQUIRED` ведёт к prerequisite-flow ниже;
   после исправления повтори тот же read-only folder plan.

<a id="check-prerequisites"></a>

## Проверь компоненты и доступ

1. Вызови `diagnose_trelio_installation` один раз с точным `clientKind` и
   `intent=onboarding`. Следуй `requiredActions` по порядку:
   - `INSTALL_NODE_RUNTIME` – объясни блокировку и получи явное подтверждение
     перед установкой Node.js LTS ≥22;
   - `INSTALL_STANDALONE_GIT` – выполни exact `installationPlan` с обычным
     системным одобрением;
   - `REPAIR_LOADED_PLUGIN_SHELL` – используй официальный менеджер клиента, не
     сбрасывая OAuth, pairing и runtime sessions;
   - `REVIEW_CODEX_DIRECT_ROUTING` – покажи table/key, добавляемые namespaces и
     `planHash`; после отдельного подтверждения вызови exact apply. Stale plan
     перечитай. После успеха полностью перезапусти Codex/ChatGPT, вернись в этот
     же чат и повтори защищённое чтение. Новый чат того же проекта нужен только
     если проверка здесь снова не прошла;
   - `REPAIR_CODEX_DIRECT_ROUTING_MANUALLY` – сохрани exact reason/message и
     покажи только нужное ручное объединение, не переписывая неоднозначный TOML;
   - `START_BRIDGE_PAIRING` / `CONTINUE_BRIDGE_PAIRING` – выполни возвращённый
     typed login action. При pairing request сразу передай exact `pairingId` и
     `deviceName` в `approve_agent_workspace_bridge_pairing`, не показывая code.
2. Если diagnostic tool не запустился, используй только bootstrap fallback:
   точный plugin/MCP inventory клиента и exact загруженный
   `trelio-host-runtime-loader.mjs bridge doctor --json` через соседний launcher.
   Не сканируй caches и не ищи глобальный `trelio-workspace`. В Codex сохрани
   отдельную plan/apply границу routing; в Claude старый shell обнови официально
   и выполни `/reload-plugins`.
3. Проверь OAuth свежим `list_companies`. Конфигурация/`Connected` не доказывает
   bearer. Только при явном 401/required/missing-bearer выполни один login exact
   сервера клиента: Codex – `codex mcp login trelio`, Claude Code –
   `claude mcp login plugin:trelio-agent-workspaces:trelio`. После browser flow
   повтори safe read один раз. Если старая Claude session всё ещё не видит tools,
   запусти новую `claude` из той же папки. Timeout,
   DNS, reset и 5xx повтори безопасно до трёх раз и не трактуй как потерю входа.
4. Выбери компанию только по свежему результату:
   - явный slug – полное совпадение;
   - display name – единственное точное совпадение;
   - без selector – автоматически лишь единственную компанию;
   - при нескольких вариантах покажи `display name (slug)` и спроси.
   Имя папки/repository и fuzzy similarity не являются evidence. Проект добавляй
   только при явном намерении ограничить всю папку.
5. Для `plain` и точного `encrypted` прочитай `get_agent_instructions` в выбранной
   области. Для encrypted сначала заверши local setup ниже и следуй точному
   `providerSelection`; method не переименовывай. `encrypting`, `decrypting`,
   `failed` и неизвестный non-plain блокируют content без plaintext fallback.

<a id="apply-the-folder-plan"></a>

## Примени host-side план папки

После выбора компании/проекта и успешного чтения правил снова вызови
`diagnose_trelio_installation` с `intent=folder_onboarding`. Передай тот же exact
`folderPath`, выбранный `instructionTarget`, `company:{name,slug}` и, если нужен,
`project:{name,slug}`.

- Покажи пользователю `plan.preview.managedBlock` и краткий список
  `plan.changes`. Не редактируй preview и не добавляй свои файлы.
- Исходная просьба настроить папку и уже сделанный выбор области разрешают эту
  обратимую запись; второй формальный вопрос не нужен. Решение между override и
  base-файлом остаётся отдельным выбором пользователя.
- При `ready_to_apply` выполни возвращённый `plan.apply` через
  `continue_trelio_workspace_action` без изменения operation/parameters.
  `folder_onboarding_apply` выполняется внутри trusted host: не превращай его в
  shell, patch или собственную запись файлов.
- `already_configured` не требует apply. При stale/CAS conflict перечитай план,
  покажи новый diff и не повторяй старое действие.
- Только успешный apply доказывает, что обычные инструкции сохранены, активный
  файл выбран, `CLAUDE.md` импортирует его, а разрешённый служебный Git сохранён
  с проверенным исключением `workspaces/`. Не называй эти свойства доказанными
  по preview или exit code другого инструмента.

Не записывай credentials, IDs, runtime state и абсолютный путь в инструкции.
Их канонический текст принадлежит runtime, не этому skill.

<a id="connect-the-local-component"></a>

## Подключи локальный компонент

Используй уже полученный onboarding diagnostic; второй doctor не запускай.
Готовность означает `node`, `git`, `plugin` и `connection` в состоянии ready.
`processPathReady=false` не блокирует bridge: runtime использует проверенный
absolute executable.

Pairing выполняй только typed action из diagnostic. Если plan недоступен,
fallback – `continue_trelio_workspace_action` с `schemaVersion=1`,
`operation=login`, `parameters={}`. При
`TRELIO_BRIDGE_PAIRING_REQUIRED` сразу вызови pairing approval с exact данными и
повтори исходный login один раз. Не создавай Run ради проверки.

Для exact `encrypted` затем выполни `operation=encryption_setup` с точным
`companySlug` и `json=true`. Ключ вводится только в защищённой форме
`127.0.0.1`; не переноси его в chat, MCP, argv, env, stdin, clipboard или
Workspace. Готовность требует `encryptionState=encrypted` и
`selfTest.status=passed`. При `access_pending` покажи fingerprint/settings URL и
жди разрешения владельца; затем повтори setup без Run. Не используй plaintext
fallback при ошибке envelope/scope/self-test.

<a id="offer-the-live-trelio-skills"></a>

## Предложи актуальные навыки Trelio

Это явная onboarding-инвентаризация. Для non-`plain` пропусти каталог целиком:
не выдавай блокировку за пустой список и не предлагай plaintext-интеграции.

1. Для plain вызови `list_agent_skills` один раз в точной области. Не сканируй
   другие проекты. Учитывай company и переносимые `project_membership`
   назначения; строго проектные навыки появятся при выборе точного проекта.
2. Для каждого включённого навыка проверь `readiness.company`. Явный
   `setup_required` – администраторская настройка без личного login. Остальные
   загрузи через `get_agent_skill` с `sections=[instructions,execution]`;
   `connection` добавь только для setup, `publication` – когда нужен provenance.
   Следуй [каталогу навыков](../trelio-skill-catalog/SKILL.md).
3. Выполни только объявленный безопасный doctor/auth probe без рабочих данных:
   Remote MCP – exact `doctor_remote_agent_skill`; runtime – его точный local
   action; Markdown без подключения – только если инструкция прямо говорит,
   что setup не нужен. Не запускай setup/login, OS unlock, installation, device
   consent, secret checkout и чтение внешних данных ради проверки.
4. Покажи `название – состояние – следующий шаг`: готов; личная/администраторская
   настройка; reconnect; нет доступа; нужна разблокировка/установка/согласие;
   либо не удалось проверить с причиной. Сетевой сбой повтори безопасно до трёх
   раз; явный отказ и setup не повторяй.
5. Предложи настроить только элементы с подтверждённым действием. Настрой каждый
   выбранный навык по его текущей инструкции; не смешивай connections/sessions.
   Полные instructions можно переиспользовать до 12 часов при неизменной области,
   реализации и намерении; после compaction, смены контекста, снятия blocker или
   `AGENT_SKILL_RELEASE_CHANGED` перечитай.

<a id="protect-personal-credentials"></a>

## Защищай credentials

- Не проси пароль, PAT, key, 2FA, cookie, session или credential-файл в chat,
  prompt, instructions, Workspace, argv или обычном env.
- Используй защищённый local flow навыка. Browser – основной ввод; видимый TTY –
  только объявленный runtime fallback. Не утверждай, что browser не сохранит
  значение автоматически.
- Значение компании вводит администратор в защищённой форме; личная session
  хранится только в private local каталоге интеграции участника.
- Подключение не разрешает отправку. Адресат и содержимое согласуются по контракту
  навыка; разрешение текущего разговора не становится постоянной настройкой.

<a id="finish"></a>

## Заверши настройку

Сообщи папку, компанию и необязательный проект; вид корня из apply result
(`ordinary` либо сохранённый `service_git`); готовность local component;
состояние каждого проверенного навыка и точный следующий шаг по незавершённым.

Для non-plain назови encryption state и факт пропуска каталога. Для encrypted
отдельно назови pairing/self-test. Не объявляй устройство готовым до полного
ready. Если файлы изменились, объясни: будущие задачи/сессии из этой папки
автоматически используют привязку; для активации нужна новая задача/сессия.
Не предлагай commit: host-side onboarding не превращает папку контекста в
пользовательский Git-проект.
