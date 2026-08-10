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
  transport fallback или автоматический повтор. Connections, sessions,
  consent и policy навыков независимы.
- Канонический Telegram Web skill и signed runtime находятся в
  `platform-skills/telegram-web/`. Runtime `1.0.4` использует отдельный Web K
  profile, visible owner login/consent и headless content-команды, а broad или
  недоказуемые операции возвращает как unsupported до решающего side effect.
  Login и logout owner handoff нельзя реализовывать одним долгим provider
  `waitForFunction`: короткие структурные polls остаются под 30-секундным
  renderer-stall fence, а полный видимый handoff – под exact `holdMs` и общий
  referenced lifecycle. Login завершается только после стабильного видимого
  authenticated surface, отсутствия exact visible `#auth-pages` и
  password/passcode handoff и canonical account identity proof; пароль/код
  runtime не читает и не вводит. До публичного login success headed Chrome
  должен graceful-завершиться, а тот же профиль под непрерывно удерживаемым
  profile lock – открыться новым headless process и доказать тот же private
  account digest; logged-out/locked/mismatch/forced teardown не разрешают
  success, auto-retry или transport fallback. Восстановленная canonical home
  page сначала проходит bounded structural readiness proof: обычная готовая
  content page не получает конкурирующий `goto`, но pre-content login/probe
  обязан сделать один fresh canonical reload, чтобы не доверять restored DOM.
  Probe bounded-poll-ит auth + identity до устойчивого результата и переводит native
  browser/provider ошибки в `TELEGRAM_WEB_PROBE_FAILED` только с фиксированной
  безопасной phase, не раскрывая raw error, URL, path, content или account
  digest; deliberate runtime errors сохраняют исходный code.
  Protected consent на macOS открывается только через exact machine-wide
  Chrome/Chromium/Edge, который уже выбран и повторно проверен текущей browser-
  сессией: generic/default URL handler и ChatGPT Browser для этого handoff
  запрещены. `Referrer-Policy: origin` сохраняет normal Chrome Origin, но не
  раскрывает one-use path; строгие Origin, Fetch Metadata, content-type и cookie
  проверки POST не ослабляются, а runtime не нажимает consent за владельца.
  Zero-exit opener не является delivery proof: exact landing GET должен
  завершиться за 30 секунд. После admitted landing malformed protected POST
  отдаёт явный HTTP error и terminal-завершает команду без десятиминутного lock.
  Awaited command/browser/consent/download deadline timers должны оставаться
  referenced до exact завершения или cleanup: `unref()` не может подменять
  гарантированный timeout преждевременным выходом Node process.
  Общий deterministic regression
  `platform-skills/telegram-web/tests/trelio-telegram-web.test.mjs` обязан
  выполняться в Linux/macOS CI вместе с plugin suites. Этот прогон не заменяет
  real Chrome/account qualification и не даёт права называть непроверенные
  Codex/Claude/OS lanes live-tested.
- Agent Secrets передаются только exact executable через одноразовый grant;
  личные external credentials хранятся локально вне Git/workspace/Trelio.
  `secret set` без format-флага сохраняет legacy scalar semantics, включая
  JSON-подобные bytes. Атомарный локальный import нескольких полей использует
  только explicit `--format fields-json`, передаёт backend-у `values` и не
  раскрывает parse input в ошибках; автоопределение JSON и разбиение одной
  учётной записи на отдельные secrets запрещены.
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
- Codex `SessionStart` с `source=startup` один раз добавляет в первый model call
  короткое напоминание проверить название текущего основного чата после сбора
  исходного контекста. Это non-blocking reminder, а не проверка результата:
  он не запускает второй model call, app-server, сеть или отдельный процесс и
  молчит на `resume`, `clear`, `compact`, в Claude Code и на последующих ходах.
  Уже понятное или пользовательское название не меняется, отсутствие прямого
  безопасного инструмента остаётся тихим no-op.
- MAX browser adapter по умолчанию блокирует server-side `READ_MESSAGE` и
  `READ_REACTION` при discovery, чтении, unread polling, download и любых
  действиях, которые не являются ответом. Read receipt разрешается только
  после проверенной отправки `send` или `reply`; ошибка отправки не должна
  менять unread-state. Пометка «непрочитано» постфактум не считается
  эквивалентом, потому что она не отзывает уже отправленный receipt.
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
  независимой параллельной ветки.
- Accepted task Run создаёт технический system handoff для аудита и агентов,
  после чего `propose_task_comment` готовит обычный комментарий для людей.
  Публикация и attachments остаются явным действием человека и не блокируют
  durable acceptance.

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
