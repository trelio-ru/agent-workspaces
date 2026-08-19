# AGENTS.md

## Назначение репозитория

Этот публичный репозиторий – единственный канонический источник клиентского
дистрибутива `Trelio Agent Workspaces` для Codex и Claude. Backend/UI находятся
в основном Trelio-монорепозитории; копии plugin-кода там быть не должно.

## Общие правила

- Подробно комментируй нетривиальный код и особенно security/transport
  решения, причина которых не очевидна из синтаксиса.
- Не добавляй токены, credentials, cookies, локальные sessions, содержимое
  workspace и другие секреты в Git, тестовые fixtures, логи или release notes.
- Сохраняй пользовательский результат и следующий шаг в центре workflow; SHA,
  UUID, lease/fencing и bridge-команды допустимы только для диагностики.
- Не ослабляй ACL, approval, exact confirmation, idempotency/CAS и secret
  boundaries ради упрощения текста или кода.
- Не удаляй compatibility/legacy path без отдельного доказательства, что он
  больше не нужен поддерживаемым клиентам и rollback.
- Все пути и команды в server-returned contracts трактуй буквально. Не сканируй
  plugin cache и не выбирай другую установленную версию.

## Обязательная маршрутизация перед изменениями

Прочитай каждый подходящий документ полностью до первой правки. Если область
работы расширилась, прочитай следующий документ перед продолжением.

- Bridge, Run lifecycle, protected context, external objects, checkpoints,
  handoff, task outcome, proposal, dossier, meeting, restore или cleanup:
  [`docs/maintainers/workspace-contracts.md`](docs/maintainers/workspace-contracts.md).
- Agent Skill routing, signed runtime, Remote MCP, Agent Secrets, Email,
  Telegram, MAX или browser-first credentials:
  [`docs/maintainers/integration-contracts.md`](docs/maintainers/integration-contracts.md).
- Codex/Claude onboarding, OAuth, pairing, managed workspace, model policy,
  plugin self-update или version compatibility:
  [`docs/maintainers/onboarding-and-compatibility.md`](docs/maintainers/onboarding-and-compatibility.md).
- Manifest/version/tag/GitHub Release или публикация plugin/skill runtime:
  [`docs/maintainers/release-process.md`](docs/maintainers/release-process.md).
- Любой `skills/**/SKILL.md`: полностью прочитай сам навык и все references,
  которые относятся к изменяемому сценарию. Сохраняй progressive disclosure:
  main skill содержит trigger/routing и always-on границы, детали – в одном
  уровне `references/` с явным условием обязательного чтения.
- `platform-skills/1c-edo/**`: дополнительно прочитай
  [`platform-skills/1c-edo/SKILL.md`](platform-skills/1c-edo/SKILL.md).
- `platform-skills/1c-vkus/**`: дополнительно прочитай
  [`platform-skills/1c-vkus/SKILL.md`](platform-skills/1c-vkus/SKILL.md).
- `platform-skills/1c-vkus-kadry/**`: дополнительно прочитай
  [`platform-skills/1c-vkus-kadry/SKILL.md`](platform-skills/1c-vkus-kadry/SKILL.md).

## Стабильные runtime-инварианты

- Trelio MCP – control plane; bundled bridge – локальный Git data plane.
- Общий `.mcp.json` задаёт для Codex и Claude Code predefined public client
  `trelio_agent_workspaces_v1`. Scopes клиенты получают из OAuth metadata
  Trelio, поэтому не дублируй их в manifest: полный текущий набор выдаёт сервер,
  а дальнейший insufficient-scope flow расширяет exact user/client grant.
  Первый consent, новый scope и legacy DCR client требуют fresh Trelio login.
  Stable client может повторно подтвердить только уже покрытые exact
  user/client grant scopes через действующую старую browser-session без
  impersonation; consent и PKCE сохраняются. Backend разрешает ephemeral port
  только на exact callback path соответствующего клиента. Backend migration с
  seeded client должна попасть в production раньше plugin release.
- Runtime `AGENTS.md`, `CLAUDE.md`, `.trelio/**` и read-only context защищены и
  не входят в accepted candidate.
- Company/project rules, platform rules, личный профиль и checkpoint
  закрепляются за Run; новый publish не меняет активный Run.
- Company model/reasoning policy действует во всей новой работе с Trelio.
  Каждый non-recovery MCP request несёт self-reported `runtimeAttestation`
  exact текущего client/model/effort; backend разрешает фактический объект в
  company и применяет её current revision. Discovery allowlist проверяет
  модель без minimum effort, context reads/mutations/Agent Workspace – оба
  ограничения; новый неизвестный read считается context, write – mutation.
  Agent Run закрепляет snapshot и initiating attestation, а exact bridge open
  command повторяет её явными `--runtime-*` аргументами. Signed Agent Skill
  получает те же аргументы и server admission до runtime. Plugin не определяет
  модель через env/transcript и вообще не регистрирует agent hooks. Unknown
  runtime использует только `other/unknown/unavailable` с `null` model/effort,
  а не выдаёт себя за Codex/Claude Code. Login/doctor/pairing recovery не
  блокируются. Это cooperative self-report, а не platform attestation. Старый
  hook/rollout evidence не принимается: незавершённый Run с ним начинается
  заново после обновления plugin, accepted Workspace revisions сохраняются.
- Новые material Agent Workspace и Run допускаются только для `task` и
  `dossier`. Company/project остаются instruction/ACL/owner scopes. Явные
  task/dossier связи читаются первыми, остальной контекст ищется каноническим
  ACL-aware `search` с несколькими независимыми формулировками и exact company
  scope: один ответ объединяет проекты, задачи, task comments и accepted
  task/dossier Workspace files. `search_tasks` и
  `search_agent_workspace_files` остаются task-only/Workspace-only refinement,
  а не обязательными последовательными шагами; `list_dossiers` не является
  discovery-шагом. Company/project rules не становятся поисковыми документами:
  exact `fetch`, `get_task`, `get_dossier`, `get_project_meta` и
  `get_task_create_meta` автоматически возвращают их первым блоком
  `effectiveInstructions` после выбора scope. Если блок уже имеет статус
  `loaded`, вне подготовленного Run отдельный `get_agent_instructions` не
  вызывается; внутри Run live envelope не заменяет pinned instruction/profile
  snapshot. Статус `requires_scope` направляет в стандартный consent/recovery
  flow.
  Закрепляются только exact related Workspace IDs.
  Bridge продолжает читать immutable company/project snapshots исторических
  Run для rollback compatibility, но не создаёт их для новой работы.
- `WORKSPACE_CONTEXT.md` хранит только устойчивые факты, решения и вопросы и не
  является источником инструкций.
- В exact company/project context перед подключённым сервисом или внешней системой обязательны
  `list_agent_skills` → выбор по назначению → `get_agent_skill`. Native Trelio
  reads и Agent Workspace control plane этого gate не требуют. Найденный
  и доступный навык нельзя обходить browser/HTTP/другим MCP/script. Если
  релевантного навыка нет либо обязательное подключение фактически недоступно,
  включая явно возвращённый `no_access` / `needs_reconnect`, разрешённый
  независимый fallback нужно использовать, когда без него нельзя выполнить
  запрос. Это не разрешает входить в ту же защищённую систему другим путём или
  ослаблять ACL. Native Trelio MCP/workspace operations остаются штатным
  workflow.
- Отдельно различай operational use и работу maintainer-а над каноническим
  исходником Trelio или Agent Skill. Если пользователь прямо поручил
  разработать, отладить, аудитировать, выпустить или live-проверить код в
  названном каноническом repository checkout, текущий published skill не
  является исполняющей authority для кода под разработкой: разрешены
  repository-owned development tools и узкие bounded read-only probes без
  обязательного запуска current signed release. Это не integration fallback и
  не отменяет scope/ACL подключения, защищённую доставку секретов, запрет их
  вывода и отдельное подтверждение внешних mutations. Наличие checkout само по
  себе не включает maintainer mode; обычное действие от имени компании снова
  проходит catalog/get/runtime routing.
- Generic-запрос на подключение внешней интеграции сначала разрешает Trelio
  company context и проверяет `list_agent_skills`. До этой проверки нельзя
  устанавливать, авторизовывать или вызывать пересекающийся native/plugin
  connector; при нескольких компаниях нужно спросить exact company, а не
  сканировать все каталоги. Если подходящего навыка нет, пользовательский навык
  или коннектор разрешён обычным fallback-контрактом.
- Company-wide onboarding вызывает `list_agent_skills` только с exact
  `companySlug` и не сканирует проекты. Этот ответ уже включает переносимые
  project assignments текущего участника с
  `enabledThroughProjectMembership=true` / source `project_membership`; их
  нужно предлагать сразу вместе с company assignments. До конкретного проекта
  откладываются только strict project-only skills, отсутствующие в
  company-wide ответе. Нельзя считать возвращённый переносимый навык
  project-only только из-за `enabledAtCompany=false`.
- Telegram catalog routing использует formal `integrationRouting`: один
  назначенный `telegram-mtproto` / `telegram-web` используется самостоятельно,
  а при двух MTProto primary `100` предшествует Web secondary `200`. Secondary
  разрешён только после exact `not_configured`, `no_access`,
  `needs_reconnect` или `unsupported_operation` primary. Catalog/control-plane
  outage, timeout, transient/unknown error и ambiguous mutation не разрешают
  transport fallback или автоматический повтор. Connections, sessions и policy
  навыков независимы.
- Текущий Telegram Web adapter находится в bundled plugin script
  `plugins/trelio-agent-workspaces/scripts/trelio-telegram-web.mjs` и следует
  компактному MAX-паттерну: один private profile на exact
  company/member/connection, `confirm` / `autonomous` / `read-only`, exact
  title либо canonical Web K PeerId, bounded output, dry-run + approval hash
  для structural/destructive mutations и запрет blind retry после ambiguous
  результата. Отдельного annual/per-chat consent registry нет. `login` –
  owner handoff с точной подсказкой `После входа в Telegram Web закройте окно.`;
  сохранённую сессию доказывает только один fresh `probe` в новом process.
  Открытие exact диалога сохраняет обычную Telegram Web semantics и может
  отметить видимые сообщения прочитанными; runtime явно возвращает
  `readState.mode=ordinary-telegram-web` и не заявляет passive protection.
  Адаптер и его deterministic tests обязаны работать в local Codex и Claude
  Code на macOS/Windows/Linux; executable-изменение требует новой версии
  plugin. Прежний большой signed runtime сохранён в
  `platform-skills/telegram-web-legacy/`, исключён из CI и operational routing и
  не используется без отдельной maintainer-задачи.
- Agent Secrets передаются только exact executable через одноразовый grant;
  каждый контейнер неизменно выбирает `trelio` либо личный `local_device`.
  Перед созданием MCP читает company `storagePolicy` через
  `list_agent_secrets`: `prefer_trelio` выбирает Trelio без прямого local-
  запроса, `contextual` выбирает local только для личного интерактивного
  single-device сценария, Trelio для shared/multi-device/unattended и
  спрашивает при неоднозначности, `local_only` принудительно допускает только
  local. Изменение политики не меняет существующие карточки.
  Local mode хранит structured JSON только в private bridge config вне
  Git/workspace/Trelio; сервер получает safe schema/version/field keys и exact
  paired-session attestation, не value/hash. `secret set` делает preflight до
  чтения input и двухфазный prepare/write/confirm. На новый компьютер копируется
  только подкаталог `agent-secrets/`, без credentials/device-session; после
  отдельного pairing он переподтверждает current version только через активный
  Run командой `secret adopt`. Это заменяет server attestation и отзывает grants,
  но не обещает remote wipe старого offline-файла.
  Личные external credentials также хранятся локально вне Git/workspace/Trelio.
  `secret set` без format-флага сохраняет legacy scalar semantics, включая
  JSON-подобные bytes. Атомарный локальный import нескольких полей использует
  только explicit `--format fields-json`, передаёт backend-у `values` и не
  раскрывает parse input в ошибках; автоопределение JSON и разбиение одной
  учётной записи на отдельные secrets запрещены.
  Отдельный default-false company opt-in `allowAgentSaveChatSecrets` разрешает
  `save_known_agent_secret` только для exact значения, уже присланного в
  текущем conversation, после отдельной прямой команды пользователя сохранить
  именно его. Mere sharing/use не даёт storage consent. Tool допускает только
  `trelio`, `manage`, active applicable Run, exact version, stable idempotency
  key и literal confirmation; response/audit не возвращают value/digest, а
  request fingerprint хранится как keyed HMAC. Исходный chat и возможная tool
  history считаются exposed. Агент никогда не просит новое значение ради этого
  пути; `local_device`, argv, workspace, comments, checkpoint, handoff и logs
  исключения не получают.
  Узкое исключение по времени жизни – company-scoped Telegram MTProto
  `api_hash`: первый checkout exact runtime атомарно сохраняет его локально в
  private `skill/company/member/connection` namespace рядом с более
  чувствительной персональной session. Следующие команды используют эту копию
  и не запрашивают новый checkout, пока файл существует; значение по-прежнему
  не попадает в model/MCP/argv/stdout/workspace/log.
- ConsultantPlus показывает browser только для входа, CAPTCHA и другого exact
  действия пользователя. После подтверждённой авторизации Codex side panel
  сразу скрывается либо внешний browser перестаёт выводиться на передний план;
  search/read/export продолжаются в фоне в той же tab/profile/session, а для
  демонстрации прогресса browser повторно не открывается.
- Содержательный Agent Workspace analysis через ConsultantPlus обязан хранить
  узкий original export каждого materially использованного источника вместе с
  provenance; просмотренные, но не использованные документы не сохраняются, а
  commentary маркируется отдельно и не выдаётся за primary legal source.
  Source files не прикладываются к task comment автоматически.
- Signed Agent Skill process не наследует ambient shell/workspace environment.
  Host передаёт только явный allowlist OS path, locale, proxy и Trelio
  config/cache roots, затем добавляет exact live-resolved `TRELIO_SKILL_*`.
  Loader/interpreter hooks, ambient credentials и stale skill identity должны
  быть удалены до `spawn`; runtime дополнительно санитизирует окружение всех
  запускаемых browser/opener/bootstrap child processes. `PATH` строится host-ом
  из fixed OS roots и директории exact host Node, а Python runtime запускается
  через canonical fixed interpreter 3.10+ с `-I -B` и только signed runtime
  root в добавленном import path; ambient/user site не участвуют. Это защищает
  от подмены через ambient PATH/loader/module hooks, но не объявляет активный
  процесс под тем же OS user недоверенным: локальные Node/Python/browser,
  plugin cache, Agent Skill cache, профили и credential storage являются
  machine trust roots. Более сильная граница требует отдельного OS user или
  системного sandbox для всего runtime stack, а не только проверки Python.
- One-use Agent Secret grant для `trelio-workspace skill run` не превращать в
  ambient allowlist. После atomic consume bridge в том же процессе передаёт
  exact одно env/file/stdin значение одному live-resolved runtime и сразу
  очищает file delivery; grant не может менять `TRELIO_SKILL_*`, config/cache
  roots или другой host-owned context.
- Guided onboarding до любой проверки/установки plugin, package manager, OAuth
  или Trelio-вызова обязан разрешить одну постоянную рабочую папку из
  host-owned project context. Codex требует local project с доступной primary
  folder; Claude Code использует `CLAUDE_PROJECT_DIR`, MCP root либо exact
  launch directory. Пустая папка допустима, Git-репозиторий необязателен.
  Projectless task, process cwd без host evidence, home, temp, plugin cache и
  materialized Agent Workspace не подходят. При отсутствии exact root setup
  завершается до side effects с сообщением `Рабочая папка не найдена.
  Настройка не начата.` и одним client-specific recovery. Binding остаётся в
  выбранной папке и не поднимается к соседнему Git root. Codex использует
  `codex mcp ...`, Claude Code – `claude mcp ...` или `/mcp` и
  `/reload-plugins`; клиентские команды не смешиваются.
- Node.js 22+ остаётся локальной предпосылкой bridge и local MCP. Onboarding
  диагностирует её отдельно от Trelio OAuth. Windows resolver обязан проверять
  process PATH, durable machine/user PATH и штатный Program Files; найденный
  Node 22+ используется для bridge по абсолютному пути и не становится
  причиной повторной установки или цикла restart. Local stdio server не
  блокирует базовый OAuth/onboarding и требует restart только when selected
  `remoteMcpExecution` действительно без него недоступен. При реальном
  отсутствии Node агент только предлагает platform-native установку и ждёт
  явного подтверждения. Initial OAuth является одним browser flow: onboarding
  не открывает предварительный site login, не просит написать «я вошёл» и не
  запускает Computer Use для credentials. `auth_status: "o_auth"` описывает
  схему, а не наличие bearer в exact процессе. После OAuth агент сначала один
  раз live проверяет tools и продолжает текущую задачу; при повторном
  missing-bearer не запускает login-loop, а переходит в свежую задачу/process.
  Полный restart нужен только после failure там. Глобальный
  `trelio-workspace` в `PATH` не требуется: используется bundled script exact
  загруженной версии плагина.
- Standalone Git 2.28+ остаётся предпосылкой только локального Workspace data
  plane и не выводится из того, что Codex сумел клонировать marketplace своим
  private runtime. Bridge всегда разрешает и проверяет один absolute executable
  только из стандартных Homebrew/system/Program Files roots либо durable Windows
  machine/user PATH; произвольный Git из process PATH не является кандидатом, а
  PATH используется лишь для диагностического `processPathReady`. Все Git-команды
  идут через проверенный path без shell.
  `trelio-workspace doctor --json` обязан сделать настоящий временный
  `init → add → commit`, а не только прочитать version string. При
  `TRELIO_GIT_REQUIRED` onboarding сразу запускает возвращённый штатный
  installer: `brew install git` либо `xcode-select --install` на macOS,
  `winget install --id Git.Git -e` на Windows. Отдельного вопроса в чате перед
  этим нет, но обычные approval/admin/native installer окна клиента и ОС не
  обходятся и не подтверждаются агентом. После установки doctor повторяется в
  той же задаче, новый absolute path используется без restart; ambiguous
  installer result сначала проверяется doctor, а не повторяется вслепую.
- Plugin не содержит `hooks.json` и hook entrypoint. Основной Trelio MCP после
  runtime-policy текста даёт короткую Codex-only best-effort инструкцию: в явно
  новом верхнеуровневом чате после исходного контекста вызвать native title
  tool не более одного раза. Fork, delegated/existing conversation и
  пользовательское название не меняются; отсутствие tool – тихий no-op.
  Поскольку MCP не получает lifecycle event и thread id, это не строгая
  гарантия «ровно один раз» и не должно участвовать в security policy.
- MAX browser adapter по умолчанию блокирует server-side `READ_MESSAGE` и
  `READ_REACTION` при discovery, чтении, unread polling, download и любых
  действиях, которые не являются ответом. Read receipt разрешается только
  после проверенной отправки `send` или `reply`; ошибка отправки не должна
  менять unread-state. Пометка «непрочитано» постфактум не считается
  эквивалентом, потому что она не отзывает уже отправленный receipt.
- MAX `login` является только owner handoff и никогда сам не доказывает
  авторизацию. Каноническая подсказка пользователю: `После входа в MAX закройте
  окно.` Закрытие visible window штатно завершает handoff; прежняя ошибка
  закрытой page/context также не разрешает повторный login. После закрытия,
  bounded hold timeout или такой legacy-ошибки агент запускает ровно один fresh
  `probe` в новом browser process. Только этот probe подтверждает сохранённую
  local session; до его явного требования нового входа повторять `login`
  нельзя. Нельзя обещать, что runtime сам распознает вход и закроет окно, или
  просить держать окно открытым после успешного входа.
- MAX поддерживает создание direct/group chat, изменение названия/аватара и
  обычных участников, но намеренно не управляет администраторами и invite
  links. Структурные, destructive и cross-chat действия используют exact
  dry-run/approval hash; неоднозначную mutation нельзя повторять до live-read.
- Candidate принимается только при актуальном base head. Restore создаёт новую
  accepted revision, не переписывая историю.
- Blocker с содержательной локальной дельтой задаётся человеку только после
  успешного portable pause; чистый подготовительный вопрос не создаёт пустой
  Git draft.
- Обычный `checkpoint --type draft` после каждого завершённого смыслового
  изменения загружает проверенный delta и закрепляет exact `draft_head`.
  Compact prepare по умолчанию продолжает последний собственный непустой draft
  на актуальном accepted head; `startNewRun=true` допустим только для намеренной
  независимой параллельной ветки. `finish` проверяет полный candidate delta
  относительно pinned base, поэтому чистый непустой draft завершается без
  искусственной правки; candidate head exact base остаётся запрещён.
- Accepted task Run создаёт технический system handoff для аудита и агентов,
  после чего `propose_task_comment` готовит обычный комментарий для людей.
  Публикация и attachments остаются явным действием человека и не блокируют
  durable acceptance. Ни accepted Run, ни `taskOutcome` не меняют статус:
  outcome только рекомендует semantic target. Если вся задача готова, агент
  отдельно вызывает `render_task_status_proposal`; partial work не создаёт
  status proposal, но всё равно получает comment proposal.
- Immediate status mutation через `update_task_status`, task patch, batch patch
  или `move_task_to_project` разрешена только после прямой однозначной команды
  человека изменить exact задачу на exact статус сейчас и требует literal
  `userExplicitlyRequestedImmediateStatusChange=true`. Завершение поручения,
  accepted Run, вывод агента и условное «когда закончишь» этого права не дают.
  `apply_task_status_proposal` / `dismiss_task_status_proposal` вызываются только
  после действия пользователя в отдельной MCP App-карточке либо явного решения
  по exact proposal.
- Явная просьба предложить или подготовить комментарий к exact задаче всегда
  является отдельным native Trelio flow, включая follow-up во время maintainer
  work, другого сценария или после compaction. Direct proposal использует exact
  task locator без обязательного Agent Run. До финального ответа должен быть
  получен proposal tool result либо назван точный blocker; цитата или обычный
  текст не заменяют редактируемую proposal-карточку.

## Проверки

- После изменения skill запусти `validate-skill <skill-directory>` и
  `skill-creator/scripts/quick_validate.py`.
- После изменения plugin manifest запусти штатный `plugin-creator` validator.
- После изменения bridge/host проверь синтаксис Node.js 22+ и релевантные
  regressions. Не заменяй реальный Git/network/security regression моковой
  проверкой строки.
- После изменения Python runtime запусти его unit tests; не коммить
  `__pycache__`.
- Перед коммитом запусти `git diff --check` и убедись, что staged scope не
  захватывает чужие изменения.
- Коммиты, descriptions и release notes пиши по-русски.

## Версии

- Bridge constant, Codex manifest, Claude manifest и Claude marketplace entry
  обязаны иметь одну версию; synchronization защищён тестом.
- Codex manifest показывает канонический трёхполосный знак Trelio из
  `plugins/trelio-agent-workspaces/assets/`: компактная SVG-иконка наследует
  цвет интерфейса, а `logo` / `logoDark` сохраняют контраст в обеих темах.
  Пути ассетов и фирменный `brandColor` закреплены version regression.
- Stable version и Git tag выпускаются вместе. Не меняй версию и не создавай
  tag без явной команды на релиз.
- Codex фиксирует абсолютные versioned-пути bundled skills в контексте задачи.
  Перед любым self-update bridge обязан сохранить exact bytes текущей
  загруженной версии в private retention, а после каждой mutating-команды
  `marketplace upgrade` / `plugin add`, включая ошибочную, восстановить все
  известные immutable пути. Нельзя подставлять новую версию под старый путь,
  использовать symlink `current` или выбирать другую cache-версию.
- Обычные изменения backend-managed instruction/runtime конкретного внутреннего
  навыка не требуют plugin release, пока не меняется bundled plugin host или
  bootstrap skill.
- После публикации нового plugin сначала проверь официальный marketplace, а
  затем в рамках того же release-flow сразу подними live `latestVersion` и
  `minimumVersion` Trelio до новой версии. Обычный релиз не считается
  завершённым, пока read-back backend policy не подтвердил оба exact значения.
  В итоговом сообщении явно укажи подтверждённый `minimumVersion`; отдельный
  прежний minimum допустим только при прямом решении о staged rollout.
