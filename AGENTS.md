# AGENTS.md

## Назначение репозитория

Этот публичный репозиторий – единственный канонический источник устанавливаемого
клиентского плагина `Trelio Agent Workspaces` для Codex и Claude.

В публичный контур входят только:

- marketplace manifests и client metadata;
- `plugins/trelio-agent-workspaces/**` с bridge/host, hooks, MCP registration,
  bundled bootstrap/control-plane skills, tests и пользовательской документацией;
- публичные инструкции по установке, использованию и безопасности;
- plugin CI.

Provider-specific runtimes, их исходники и тесты, backend-код, внутренние
maintainer/release-инструкции и production publication tooling ведутся в
закрытом backend/provider repository. Не возвращай их, `platform-skills/**`,
provider-tag workflow или внутренние release playbooks в этот репозиторий.

## Общие правила

- Подробно комментируй нетривиальный код, особенно security/transport решения,
  причина которых не очевидна из синтаксиса.
- Не добавляй токены, credentials, cookies, локальные sessions, содержимое
  workspace и другие секреты в Git, fixtures, логи или release notes.
- Не ослабляй ACL, exact confirmation, idempotency/CAS, bounds, attestation и
  secret boundaries ради упрощения текста или кода.
- После неоднозначной mutation сначала установи live state; blind retry
  запрещён.
- Не удаляй compatibility/legacy path без доказательства, что он больше не
  нужен поддерживаемым клиентам и rollback.
- Server-returned пути и команды трактуй буквально. Не сканируй plugin cache,
  не выбирай другую установленную версию и не подменяй exact executable.
- Сохраняй чужие изменения в рабочем дереве и отделяй scope текущей задачи.

## Обязательный Git-workflow

- Канонический checkout регистрируется один раз через
  `npm run git:configure-main` и постоянно остаётся чистым worktree с
  checked-out `main`. Обычные task-правки и commits в нём запрещены; tracked
  hooks блокируют прямой commit в `main`, raw push в `origin/main` и отдельный
  push стабильного plugin tag.
- Перед нетривиальной правкой выполни `git fetch --prune origin`, проверь
  `git status -sb` и `git rev-list --left-right --count HEAD...@{upstream}`.
  Новую задачу начинай от свежего `origin/main` в отдельной ветке и отдельном
  physical worktree через `npm run git:new-worktree -- codex/<task-slug>`.
  Не редактируй канонический checkout вручную.
- Обычная завершённая правка получает commit в task-ветке и интегрируется
  только через `npm run git:push-main`. Guard принимает лишь clean source,
  fast-forward от свежего `origin/main`, делает exact remote read-back и затем
  fast-forward канонического локального `main`. `git push origin main`,
  `git push origin HEAD:main` и эквивалентные raw refspec запрещены.
- После подтверждённой интеграции задача не завершена, пока из чистого
  канонического `main` не выполнен
  `npm run git:finish-worktree -- <absolute-task-worktree>`. Helper удаляет
  только clean `codex/*` worktree и exact local branch, уже достижимую из
  свежего `origin/main`; squash/rebase merge требует отдельного
  `--merged-pr <number-or-url>`. `git:new-worktree` fail-closed блокирует новую
  задачу, если обычный merged worktree оставлен.
- Непосредственно перед guarded push выполни `npm run check:worktree` и не
  пушь при непустом status. Если canonical либо source содержит чужие tracked
  или untracked изменения, сохрани их и остановись до выяснения scope.
- Stable plugin tag публикуется атомарно с соответствующим `main` только через
  `npm run git:push-main -- --tag vX.Y.Z`. Это не заменяет явную команду
  пользователя на plugin release и остальные release-проверки.
- `.gitignore` намеренно скрывает только системные метаданные, dependency cache
  и generated Python bytecode. `platform-skills/**` целиком не игнорируется:
  попытка вернуть provider source в публичный репозиторий должна оставаться
  видимой в `git status` и блокировать guarded flow.

## Архитектурная граница

- Trelio MCP – control plane; bundled bridge – локальный Git data plane.
- Plugin является консервативным generic host. В нём остаются bridge/host,
  lifecycle hooks, runtime admission/pairing, bootstrap/control-plane skills,
  общие security/credential/browser primitives, manifests и assets.
- Bundled skill может настраивать Trelio, читать каталог и вести Workspace/Run,
  но не реализует команды конкретного внешнего provider.
- Внешние provider integrations доставляются независимо backend-managed
  instruction, declarative Remote MCP либо immutable signed package. Provider
  change сам по себе не меняет plugin version или global compatibility policy.
- Provider-specific ID, команды, parser, DOM/API fixtures, login exceptions и
  capability matrices не добавляются в plugin instructions, README или tests.
  Generic regression использует synthetic integration identity и проверяет
  только host protocol/security semantics.
- Remote MCP schema v1 сохраняет exact allowlist. Schema v2
  `toolPolicy.mode=all_read_only` допустима только с `authentication.type=none`
  и требует host `>=1.13.3`: перед doctor и каждым call host заново читает
  bounded `tools/list`, допускает tool только при валидном уникальном имени,
  отсутствии write-like имени и exact annotations `readOnlyHint=true`,
  `destructiveHint=false`. Остальные tools игнорируются по одному; если
  безопасных нет, операция fail closed. V1 fingerprint и поведение не менять.
- Company owner/admin управляет private Agent Skills только через четыре
  локальных plan/apply tool `trelio-remote-skills` и capability
  `agent-skill:manage`. Create устанавливает, но не назначает навык; apply
  всегда требует отдельного подтверждения exact plan hash и возвращает
  server-built settings URL. Markdown, Remote MCP и `.skillpkg` поддерживаются
  одним контуром. В encrypted-компании bridge шифрует semantic metadata,
  declaration, manifest и package bytes локально; backend получает только
  markers/`TRELIOE1`, а host расшифровывает их локально перед исполнением.
- Local credentials, sessions, profiles и policy живут вне workspace, plugin
  cache и runtime package в стабильном `skill/company/member/connection`
  namespace.

## Работа с plugin-кодом

- При изменении `plugins/trelio-agent-workspaces/**` полностью прочитай
  соответствующий `SKILL.md` и только относящиеся к сценарию references.
- Working-folder onboarding разрешает company scope только по exact slug из
  live `list_companies`, по единственному exact display-name match либо при
  единственной доступной компании без явного selector. Имя/путь папки,
  repository name, соседние файлы и fuzzy similarity не являются company
  evidence. Недоступный explicit slug и несколько кандидатов блокируют
  `get_agent_instructions` и запись локальной привязки до выбора пользователя.
- Plugin change допустим для общего security/fail-closed defect,
  несовместимости Codex/Claude/MCP/OAuth/hooks, дефекта generic host либо нового
  общего primitive, который нельзя безопасно доставить независимым runtime.
- Provider API/DOM, provider-команда, parser, dependency, instruction или тест
  одного provider не являются основанием менять plugin.
- Generic routing обязан считать один успешный `get_agent_skill` свежим для
  связанной непрерывной последовательности текущего пользовательского хода с
  теми же company/project, skill, implementation и intent. Нельзя требовать
  повтор перед каждым runtime/Remote MCP subcommand: host всё равно делает
  live resolve каждого действия. Новое чтение требуется в следующем
  пользовательском ходе, после смены exact route, после снятия ранее
  возвращённого setup/access blocker либо один раз на
  `AGENT_SKILL_RELEASE_CHANGED`.
- Один известный exact task читается через `get_task`, а 2-20 distinct exact
  targets – одним `get_tasks`; последовательные `get_task` для уже известного
  набора запрещены. Task-read schema v3 хранит уникальные Markdown-слои один
  раз в `effectiveInstructions.layers`, а каждый `tasks[]` item применяет только
  собственный exact `instructionScope.orderedLayerKeys` в указанном порядке.
  Каждый item содержит одну structured compact `task`, без производного
  `document.text`; тяжёлые данные перечислены в `task.deferredSections` и
  выбираются одним `get_task_sections` только для exact нужного subset.
  Supplemental read не повторяет authority, core, connections или dossiers,
  а `content` остаётся компактным summary. Company/project/personal layer
  нельзя переносить на непривязанную задачу. Schema v1/v2 больше не являются
  поддерживаемым task-read ABI: их получение означает version mismatch и
  требует обновления плагина/backend, а не client-side fallback.
  Manual comments в encrypted mirror являются полным search subset, но не
  полным discussion history: без authoritative `commentsPagination.total`
  compact `deferredSections.comments.itemCount` обязан быть `null`, а не длиной
  этого subset.
- Новый task control по умолчанию `shared`, когда он фиксирует объективную
  контрольную точку задачи; `personal` допустим только для явно частной проверки.
  Update сохраняет текущую visibility без прямой команды изменить аудиторию, а
  недоступный по ACL `shared` нельзя молча заменять скрытым `personal`.
- Structured `MCP_SEARCH_TIMEOUT` является подтверждённым backend-ом
  превышением бюджета read-only поиска, а не transport 504. Bundled discovery
  и diagnostics не применяют к нему три одинаковых network retry: допустим один
  строго более узкий повтор с exact company scope, максимум двумя независимыми
  формулировками и только уже известной project boundary, затем остановка. Bare
  HTTP 504 сохраняет обычный bounded network-retry contract. Regression живёт
  в generic plugin suite, а compact runtime instructions обязаны сохранять тот
  же invariant.
- После exact read одной задачи и одного досье Worker самостоятельно создаёт
  долговременную task/dossier связь без формального подтверждения, только если
  совпадение подтверждено минимум двумя независимыми идентификаторами, нет
  конкурирующей цели и всё досье подходит аудитории `task_full`. После mutation
  он сообщает пользователю причину и read-only access effect. Несколько
  кандидатов, один признак, временная релевантность или сомнение в раскрытии
  всего досье требуют вопроса; weak hit игнорируется, partial fit получает более
  узкий контекст.
- Meeting transcript flow не заканчивается после `create_meeting`: агент читает
  server-returned `workflowStage` / `requiredNextAction` / `mayFinish`, сам
  фиксирует `agent_checked` итог и проверяет актуальный контекст. До первого
  решения пользователя он явно называет current meeting access и один раз
  неблокирующе предлагает назвать дополнительных читателей; viewer можно
  дать только уже подтверждённому exact participant, а имя внутри transcript не
  является подтверждением. Optional предложение добавить доступ не блокирует
  итог. Empty distribution plan допустим только как явный
  `completed_no_context_updates` с `noContextUpdatesSummary`. Meeting plan
  содержит только context updates и task creation; comment/status/checklist/
  control-clear идут через native proposal-flow, прочие task mutations требуют
  отдельного exact подтверждения. До первой proposal-write агент
  инвентаризирует весь post-meeting action set; terminal meeting stage закрывает
  только meeting-distribution branch и не завершает отдельные proposals или
  mutations.
- Завершение task-scoped Run всегда включает отдельную оценку готовности всей
  задачи перед финальным ответом. Отсутствующий необязательный срок,
  исполнитель, контроль или будущая профилактика сами по себе не являются
  незавершённостью: если требования задачи и transition policy выполнены,
  агент обязан подготовить отдельный status proposal, не подменяя его вопросом
  про пустое metadata-поле либо comment proposal.
- Начало task-scoped Run имеет отдельный one-shot intent `work_started`: сразу
  после успешного bridge `open` агент один раз читает server
  `workStartProposal` и только при `state=eligible` показывает exact semantic
  `queue -> active` карточку, не ожидая решения перед продолжением. Durable
  marker уже показанного start, pending и dismiss в той же status epoch
  подавляют повторы даже после замены completion-карточкой; checkpoint,
  очередной tool, новый ход или новый Run не являются новым поводом.
  `whole_task_ready` после
  завершения заменяет pending start draft, поэтому одновременно существует
  только одна status proposal карточка exact task+member. Suppressed или
  ineligible start-decision остаётся внутренним control-plane результатом: если
  карточка не создана, status-related error отсутствует и от пользователя не
  требуется действие, агент молча продолжает работу и не объясняет отсутствие
  proposal в progress update или финальном ответе.
- Compact `propose_task_comment` является create-only маршрутом первого
  известного private draft exact задачи. Если в текущей переписке уже был
  proposal или backend возвращает `UNPUBLISHED_DRAFT_REQUIRES_CONTEXT`, агент
  обязан один раз прочитать `get_task_comment_proposal_context` и заменить
  draft через `render_task_comment_proposal`. Новый текст заново синтезируется
  как самостоятельный cumulative human update из актуального результата и
  `publicCommentsSnapshot`; `currentDraft` нельзя склеивать, исправлять или
  считать предыдущей публичной репликой.
- Runtime admission proof создаёт только approved hook. Агент не формирует, не
  копирует и не обходит proof другим MCP, HTTP, browser или script.
- `hooks/hooks.json` является стабильной client-trust границей: lifecycle
  matchers остаются wildcard, а `PreToolUse` охватывает только все формы имени
  Trelio MCP. Behavior-only recovery и lifecycle-улучшения вноси в
  `trelio-runtime-session.mjs`; definition меняй только при реальной
  несовместимости host contract, потому что новый hash требует повторного
  review пользователя.
- Bundled doctor диагностирует только exact загруженный plugin и выводит
  value-free статусы. Он не сканирует cache, не раскрывает token, pairing/session
  ID или private key и не объявляет Hooks включёнными: client approval остаётся
  `client_managed_unknown` до отдельного client/live-read подтверждения.
- Bundled JavaScript entrypoints и локальный `trelio-remote-skills` запускаются
  только через парные `scripts/launch-trelio-node` / `.cmd`: launcher требует
  Node.js 22+, сначала использует host-owned подсказки и bundled runtime Codex,
  затем системный Node. Возвращать в `.mcp.json` bare `node`, машинный absolute
  path или менять `hooks.json` ради PATH-совместимости нельзя.
- Agent Secret, TOTP, browser-fill и recovery/setup credential передаются
  только exact executable через scoped one-use delivery. Стабильный
  installation-managed API key/client secret может повторно использоваться
  лишь когда backend явно вернул `time_bound` policy, в том же Run/release и
  до exact `expiresAt`; plugin сам не расширяет policy и не кеширует value.
  Любой credential не попадает в model-visible output, argv, ambient
  environment, workspace, comments, checkpoints, handoff или logs.
- Для зашифрованной компании bridge получает ключ шифрования только через
  одноразовую loopback-форму `127.0.0.1`, создаёт отдельную device identity и
  сохраняет её wrapped private bundle вместе с локальным unlock key только в
  owner-only private config. Ключ шифрования нельзя просить в chat/prompt,
  передавать через MCP/HTTP, argv, environment, stdin, clipboard или писать в
  Workspace. Повторные setup/inspect/Run обязаны использовать remembered device
  без нового ввода; access pending завершается явным owner-grant blocker-ом без
  plaintext fallback.
- Folder onboarding всегда сверяет компанию по metadata-only `list_companies`,
  сохраняет exact явно указанный slug и не подменяет его похожим именем либо
  названием папки. Для любого non-`plain` `encryptionState` он не вызывает
  remote `get_agent_instructions`/`list_agent_skills`. Для exact `encrypted`
  после binding/pairing он обязан выполнить отдельный `encryption setup` через
  bridge и считать доступ готовым только после открытого owner envelope и
  локального `TRELIOE1` self-test; transitional state блокирует content work.
  Успешный `login` сам по себе не доказывает encryption readiness.
- Encrypted Agent Workspace materialize-ится и индексируется только локальным
  bridge. Сервер получает полный opaque `TRELIOE1` Git bundle и подписанную
  browser-проекцию: её clear index содержит только UUID, ciphertext ranges и
  digests, а paths/MIME/file bytes находятся в отдельных `TRELIOE1` containers.
  Accepted candidate без проекции запрещён. Локальный bridge перед upload
  заново проверяет bounds, paths, file types, protected control files и
  очевидные private-key/credential patterns. Server bundle/search/object path
  fallback для encrypted workspace запрещён.
- `list_companies.contentProvider` и structured `providerSelection` – только
  backend-selected routes. Agent не выводит provider из metadata: plain остаётся
  native, а детали exact local context/proposal route загружаются только из lazy
  worker reference после такого ответа. Always-visible schemas provider-neutral.
- Encrypted routing принимает только explicit capabilities: current content read,
  exact local action, proposal, local Workspace list/restore/cancel либо logical
  bridge checkpoint. Local action повторно запускает исходный native handler с
  прежними schema/scope/ACL/idempotency/CAS только после проверки bridge session,
  runtime proof и field-bound payload markers; неизвестный method fail-closed и
  не маскируется generic local search.
  Server read-fence `get_task_sections` автоматически выбрасывает только
  доказанно устаревшую RAM generation, bounded дожидается свежего mirror и ровно
  один раз повторяет read-only запрос; повторный конфликт остаётся fail-closed.
  Workspace-only query имеет exact company scope; current-head file и revision
  metadata читаются локально, audited restore проходит local Run, а прямые
  server-side historical Git diff/read не получают plaintext fallback.
- Combined encrypted proposal bundle выбирает provider до per-card preparation,
  canonicalize-ит historical project aliases локально и отклоняет mixed-company
  payload до первого save; confirmed card error не блокирует независимых siblings.
  Encrypted comment publish replay принимает новый randomized marker только
  через verified bridge и возвращает success лишь после local plaintext
  comparison с фактически сохранённым hydrated comment.
  Local MCP возвращает полный MCP App result и exact v3 resource metadata,
  включая `data:` frame CSP; app-only context/action aliases скрыты от модели.
- Чистое чтение уже принятого task/dossier Workspace использует
  `prepare_agent_workspace_read` и локальный `trelio-workspace inspect` без
  создания Run, lease, checkpoint или task mutation. Bridge materialize-ит
  exact accepted head и текущие instruction/profile snapshots в private
  read-only state; агент не просит пользователя вручную запускать Run только
  ради чтения и не превращает inspection-каталог в writable workspace.
- Signed runtime запускается только после authenticated exact-release resolve,
  проверки signature/package/files/paths и с host-authored allowlist окружения.
- `company_unverified` runtime, загруженный owner/admin компании, не становится
  проверенным из-за backend Ed25519-подписи: подпись гарантирует только
  целостность доставки. До package URL/bytes bridge обязан объявить capability
  `x-trelio-agent-skill-device-consent: v1`, получить bounded challenge и
  открыть защищённую одноразовую форму на `127.0.0.1` с компанией, publisher,
  summary, обязательной причиной, diff, capabilities и hash-ами. Только прямой
  POST пользователя из формы создаёт grant exact
  user/device/publication/release/artifact/package/instruction; chat reply,
  CLI approval flag, browser automation и действие агента запрещены. Любой
  новый publication, включая unchanged package, instruction-only update,
  rollback или reactivation, требует нового disclosure и consent; cancel и
  timeout не скачивают package. Runtime resolve обязан вернуть explicit trust:
  отсутствие trust fail closed, а `platform_verified` publication не может
  ссылаться на `company_unverified` artifact. Обратная комбинация допустима
  только как company publication поверх ранее проверенных bytes и всё равно
  требует exact consent. Loopback decision резервируется атомарно только после
  bounded body + nonce validation: из параллельных accept/decline POST ровно
  один получает право на результат, остальные отклоняются до remote grant.
- User login, CAPTCHA, passkey, OTP и иные protected account steps выполняет
  сам пользователь в разрешённом browser handoff. Агент не вводит и не читает
  credential.

## Документация

- Общая установка и обновление: [`README.md`](README.md).
- Документация plugin bundle:
  [`plugins/trelio-agent-workspaces/README.md`](plugins/trelio-agent-workspaces/README.md).
- Публичные runtime и security contracts: [`docs/`](docs/).
- Политика раскрытия уязвимостей: [`SECURITY.md`](SECURITY.md).

Публичная документация объясняет пользователю доступный продуктовый контракт,
но не содержит внутренних production credentials, publication commands,
закрытых source paths или maintainer playbooks.

## Проверки и релизы

- Постоянный model-visible слой типового task-scoped Run измеряется командой
  `npm run report:context-budget`; JSON для объединённого backend-отчёта
  возвращает `npm run --silent report:context-budget -- --json`. Канонические
  метрики – UTF-8 bytes, а `estimatedTokensUtf8Div4` является только прозрачной
  сравнительной эвристикой. `context-budget.test.mjs` фиксирует regression
  ceilings отдельно для runtime `AGENTS.md`, worker `SKILL.md`, обязательных
  task Run references, варианта с proposal bundle, compact provider-neutral
  schemas и отдельных plain/encrypted company scenarios. Lazy
  `local-company-context.md` запрещено включать в plain required path. Эти потолки не являются
  целевыми размерами: осознанное увеличение требует объяснения, а оптимизация
  должна уменьшать фактический отчёт без удаления security-инвариантов.
  Runtime `AGENTS.md` хранит только неизменяемое safety/lifecycle-ядро, а
  `trelio-workspace-worker/SKILL.md` остаётся коротким router. Процедуры setup
  и recovery, внешних сервисов и Agent Secrets находятся в отдельных
  references и не добавляются в `TASK_RUN_REQUIRED_SKILL_PATHS`: агент обязан
  загружать их полностью только при соответствующем сценарии.
- Для изменённого bundled skill запусти его tests, `validate-skill` при наличии
  и `skill-creator/scripts/quick_validate.py`.
- Для manifest используй штатный `plugin-creator` validator. Для
  bridge/host/hooks/MCP запускай релевантные generic regressions на Node.js 22+
  на поддерживаемых платформах.
- Release CI фиксирует exact Node.js `22.23.2`: macOS cache для плавающего
  `node-version: 22` мог выбрать `22.23.1`, где native test runner повреждал
  serialized IPC stream и падал до assertion с `Unable to deserialize cloned
  data`. Generic test files запускаются отдельными прямыми `node <test-file>`,
  без parent `node --test`: сбой serialized child IPC остаётся редким и на
  `22.23.2` под нагрузкой. Linux, macOS и Windows jobs не должны расходиться по
  patch version.
- `BRIDGE_VERSION`, Codex manifest, Claude manifest, marketplace entry и exact
  version assertions должны оставаться синхронны.
- Stable plugin version и tag `vX.Y.Z` выпускаются вместе. Не меняй version, не
  создавай tag/GitHub Release и не публикуй production без явной команды на
  релиз.
- Перед коммитом выполни `git diff --check`, проверь staged scope и отсутствие
  секретов/generated cache. Коммиты, descriptions и release notes пиши
  по-русски.
