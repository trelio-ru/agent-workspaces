# Agent Secrets

Полностью прочитай файл до поиска, создания, настройки, checkout, fill,
reveal или сохранения зависимости от Agent Secret.

`list_agent_secrets` используй только для безопасных metadata. Без доступа
вызови `request_agent_secret_access`; не проси пароль, token, private key,
TOTP seed или company encryption key в чате. Значения не попадают в prompt,
обычный MCP output, argv, общее environment, Workspace, Git, комментарии,
checkpoint, handoff и логи.

<a id="storage-contract"></a>

## Хранение

Режим следует точному состоянию шифрования компании, а не выбору пользователя:

- plain: `storageMode=trelio`. Trelio Vault шифрует bundle на диске серверным
  keyring и открывает только внутри разрешённого reveal/checkout;
- encrypted: `storageMode=company_e2ee`. Браузер/paired bridge шифрует
  значение company scope key до отправки. Trelio хранит подписанный ciphertext
  и не может его расшифровать.

У Agent Secret нет режима `local_device`, политики хранения компании,
локального secret-файла, transfer или adoption команды. Если пользователь
хочет credential только локально, не создавай/настраивай Agent Secret и не
отправляй значение в Trelio. Когда это существенно, объясни: credential вне
Agent Secret не использует Trelio ACL, reveal, одноразовые grants,
доступ с нескольких устройств или выполнение Workspace без присутствия пользователя.

До создания вызови `list_agent_secrets` точной области для поиска существующей
карточки и чтения `allowAgentSaveChatSecrets`. Не проси выбирать storage mode
и не передавай его в `create_agent_secret_placeholder`. MCP placeholder
доступен лишь plain-компании. Для encrypted, кроме случая уже присланного
значения ниже, пользователь создаёт карточку в защищённом браузерном UI Trelio:
имя, описание, подписи полей и будущее значение шифруются локально.

<a id="configure-a-value"></a>

## Настрой значение

По возможности используй защищённую браузерную форму Trelio. Если значение
уже есть у доверенного локального producer/файла, активный Run может передать
его прямо bridge без видимого модели транспорта:

- файл: `continue_trelio_workspace_action` с `operation=secret_set_file`,
  точным открытым `workingDirectory` и только `secretId`, абсолютным
  `filePath`, необязательным `format=fields-json`;
- producer/stdin: прочитай `setup-and-recovery.md` и используй ограниченный
  process-only secret-input. Не помещай output producer в MCP call;
- несколько полей: один JSON object с точными string/null и явным `fields-json`.

Без format-флага похожие на JSON bytes остаются одним scalar для совместимости.
Не разделяй один логический credential с несколькими полями на отдельные Agent Secrets
ради отказа от `--format fields-json`.

`secret set` проверяет plugin и получает write context без значений до
чтения stdin/file. В plain принятое значение шифрует backend. В encrypted
нужно готовое устройство шифрования: bridge в памяти строит подписанный
`agent_secret.value` и отправляет только ciphertext. Сервер не может
объединить encrypted fields, поэтому каждая ротация E2EE – полная замена:
включи все обязательные поля; пропущенные/пустые/null необязательные удаляются.
Bridge никогда не пишет Agent Secret values в private config или Workspace.

<a id="already-shared-chat-values"></a>

## Значение уже прислано в чат

В обоих режимах используй локальный
`trelio-remote-skills.continue_trelio_local_action` с
`nativeTool=save_known_agent_secret`, только если выполнены все условия:

- `allowAgentSaveChatSecrets=true` для точной компании;
- точное значение уже прислано в текущей переписке и пользователь прямо
  попросил сохранить его постоянно. Передача, просьба войти или использовать
  не являются согласием на хранение;
- цель – существующий secret с `manage` либо новая карточка точной области,
  где пользователь может создавать секреты; подходящий Run активен;
- передаются точный `expectedCurrentVersion`, стабильный `clientRequestId`
  и буквальный `userExplicitlyRequestedPersistentStorage=true`.

Просьбы сохранить, в том числе вместе со значением, достаточно: не проси
повторного подтверждения или ручного ввода. Сообщи, что исходный plaintext
остаётся в чате и может остаться в tool history клиента. Передавай только
чувствительным input локального инструмента, не повторяй и не копируй в другое место.

Передай точные `companySlug`, `nativeTool` и `arguments`:

- `secretId` существующей карточки либо `newSecret` с `scopeType`,
  `scopeId`, `name`, необязательными `publicDescription`, `templateType`
  и `fields` с точными `key/label/type/required`;
- `runId`, точный `expectedCurrentVersion` (ноль при создании),
  стабильный `clientRequestId`, `userExplicitlyRequestedPersistentStorage=true`;
- ровно одно из `value` (одно поле) или `values` (именованные string/null).

В обоих режимах это полная замена bundle: все обязательные поля; пропущенные,
пустые или null необязательные очищаются. Plugin выполняет preflight без
значений и локально шифрует E2EE metadata/values до одной атомарной записи.
Не создавай внутренний `localWrite`, не используй общий uploader и не
превращай chat values в shell/stdin/file/clipboard.

Загруженный local tool должен объявлять `save_known_agent_secret`.
Старый общий local-action tool не даёт эту capability: обнови plugin обычным
путём совместимости либо используй защищённую форму.

При неопределённом результате прочитай текущие безопасные metadata и повтори
точный input с тем же request ID; не создавай новый ID ради обхода конфликта.
Отозванные policy/ACL, старая версия, истёкший Run и ожидающий device access
останавливают сохранение. При необходимости штатный pairing/device setup,
никогда ключ компании через чат. Без opt-in/capability используй защищённую
форму. Старый прямой remote `save_known_agent_secret` принимает лишь значения
существующих plain-карточек и не является основным путём. Не проси новое
значение специально ради доступности исключения чата.

<a id="executable-checkout"></a>

## Checkout для executable

Если свежая инструкция signed runtime объявляет setup-команду с автоматической
доставкой company connection field, исполни её exact `runtimeExecution` напрямую.
Такой setup не требует Run: не проси ссылку на задачу и не создавай Run ради входа.
Bridge сам выполняет live проверку; отказ устраняй по его коду без чтения ключа.

Для остальных executable, которым нужно значение, вызови
`prepare_agent_secret_checkout` для точных текущего Run, executable и полей,
затем исполни единственный `bridge.action` через точные local server/tool
и открытый `workingDirectory`. В `parameters.arguments` добавляй только
намеченные child arguments; не меняй executable/grant.
Bridge расходует grant через разрешённые stdin, scoped env или private
temporary-file. В encrypted сервер возвращает лишь ciphertext с проверкой ACL;
bridge валидирует company/scope/secret/version, расшифровывает в памяти,
выбирает только разрешённые поля и локально вычисляет текущий TOTP.
Не заменяй executable shell, logger, `env`, `printenv`, `cat` или другой
программой раскрытия значений.

Installation-managed credential – отдельный provider contract, не Agent Secret.
Следуй точному `prepare_agent_skill_managed_credential_checkout`:
лишь `reusePolicy.mode=time_bound` разрешает повтор неизменённого
`bridge.argvPrefix` в том же Run/release до серверного `expiresAt`.
Не распространяй lease на Agent Secret, TOTP, browser-fill или recovery/setup
credential и не кешируй значение локально.

<a id="browser-authentication"></a>

## Авторизация в браузере

До checkout/fill используй auth probe выбранного runtime без содержимого,
если доступен. Если текущая сессия уже авторизована, продолжай её без запроса/
consume Agent Secret. Отдельный profile хранит session provider; не очищай
его ради нового login. Недоступный/неоднозначный probe не доказывает logout
и не разрешает читать поля.

Не передавай именованное secret field в literal-text действие
Browser/Chrome/Computer Use. Сначала обычным разрешённым browser tool открой
точную страницу login во встроенном браузере клиента. Исследуй лишь пустую
форму, определи поля и login/next до grant. Отказ host/tool/site обязателен:
native helper не может его обходить.

Вызови `prepare_agent_secret_browser_fill` с текущим Run и упорядоченными steps:

- username/password одной страницы – один step;
- точные HTTPS URL и одно видимое поддерживаемое поле верхнего уровня на selector;
- native AX/UIA требует точные `#id` или `[id="..."]` полей и любого
  `submitSelector`; не угадывай и не назначай ID;
- если финальная login-кнопка не имеет поддерживаемого ID (например, только
  `button[type="submit"]`), опусти финальный `submitSelector` и используй
  `browser=embedded`. После успеха fill нажми определённую на пустой форме
  кнопку обычным browser tool в той же вкладке без snapshot/чтения полей.
  Embedded-only связывает отдельный клик с подготовленной вкладкой, не
  заполняя молча другой Chrome profile;
- промежуточным native steps нужен поддерживаемый `submitSelector`.
  Если поле/промежуточная кнопка без ID, выбери объявленный Chrome flow до
  доставки; не ослабляй selectors и не разделяй credential одной страницы.

Исполни ровно один `bridge.action` через объявленные local server/tool и
точный `workingDirectory`. По умолчанию `browser=auto` до одноразового
consume подготавливает уже открытый embedded Codex/Claude в macOS/Windows
и автоматически заполняет прямыми native setters. E2EE расшифровывается
только в памяти bridge. Значения не попадают в tool arguments, clipboard,
argv, общее environment, output и чтение полей обратно.

Chrome – автоматический запасной путь только до checkout при недоступных
native platform/client/compiler/Accessibility permission/application tree/
selector/steps. 404 старого backend для value-free context использует
существующий Chrome consume на том же host. `browser=embedded` требует
встроенную поверхность; `browser=chrome` явно выбирает Chrome.
Неверные app identity/URL, отсутствующие, неоднозначные, скрытые/read-only
поля и transport/auth failures останавливают операцию. После consume или
частичного fill не меняй браузер, не запрашивай другой grant и не повторяй
значение вслепую.

`client_unsupported` означает отсутствие поддерживаемой hook-verified identity
клиента у Run, не отсутствие встроенного браузера у установленного приложения.
Используй диагностику с точной причиной. Не включай model restrictions как
обход и не создавай runtime metadata/proofs. После исправления backend
продолжи/открой Run через возвращённое action и свежий proof подтверждённого
hook до нового fill; старые grants не исправляются на месте.

macOS требует системный Swift compiler (Command Line Tools) и разрешение
Accessibility пользователя; Windows – системный .NET Framework WPF/UIA.
Bridge собирает helper приватно без скачивания, повышения прав или выдачи
разрешений. Отсутствующие компоненты дают безопасную причину fallback,
не разрешение автоматически менять права ОС.

Успех означает заполнение/явный submit, не доказанный login. Не делай
snapshot и не читай заполненные поля. Без финального submitSelector нажми
кнопку, найденную до заполнения, затем проверь лишь нечувствительное состояние
авторизации. Сохраняй session/profile между шагами. Не создавай отдельные
grants login/password одной страницы и не проси фокусировать поле.
Native session values намеренно доставляются разрешённому сайту; это не
защита от browser telemetry или другого процесса того же пользователя ОС.

Самостоятельный вход пользователя – отдельная безопасная передача управления.
При его прямом выборе либо `browser_unavailable` dedicated fill предложи
одну видимую поверхность и дождись завершения. Встроенный Browser Codex
отдельный: не считай, что он наследует менеджер паролей системного Chrome.
Системные Chrome/Edge могут использовать собственный. Не вводи, не вставляй,
не исследуй, не снимай screenshot и не читай credentials за пользователя.
После входа проверь только нечувствительное авторизованное состояние.

<a id="protected-reveal"></a>

## Защищённый просмотр значения

Если пользователь прямо просит показать сохранённое значение, направь
к защищённому reveal точной карточки Trelio. Проверь безопасное `canReveal`;
при отсутствии запроси `reveal`. Если metadata содержат `publicUrl`,
дай точный URL без значений, но не открывай/исследуй через Browser/Chrome/Computer Use.

Пользователь заново авторизуется, выбирает одно/несколько полей и сам нажимает
копирование. В encrypted браузер локально открывает ciphertext ключом
компании; Trelio не читает значение. Предупреди: ОС/менеджер clipboard могут
сохранить копию после попытки очистки Trelio. Не повторяй plaintext в чате.

<a id="durable-workspace-dependency"></a>

## Постоянная зависимость Workspace

Только когда выбранный secret стал реальной постоянной зависимостью,
запиши безопасную ссылку в `WORKSPACE_CONTEXT.md`:

```markdown
- Agent Secret: `Актуальное безопасное имя` (`secretId: 00000000-0000-4000-8000-000000000000`) — точная цель.
```

`secretId` канонический. При повторном обращении обнови имя через
`list_agent_secrets`. Не храни value, version, checkout grant, setup URL,
runtime arguments и найденные, но не использованные секреты.

Для старого backend с одной secret-командой используй ограниченную
совместимость `setup-and-recovery.md`. Не ищи PATH и не сканируй cache.
