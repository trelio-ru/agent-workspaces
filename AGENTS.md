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
- Local credentials, sessions, profiles и policy живут вне workspace, plugin
  cache и runtime package в стабильном `skill/company/member/connection`
  namespace.

## Работа с plugin-кодом

- При изменении `plugins/trelio-agent-workspaces/**` полностью прочитай
  соответствующий `SKILL.md` и только относящиеся к сценарию references.
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
  только одна status proposal карточка exact task+member.
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
- Secret передаётся только exact executable через scoped one-use delivery и не
  попадает в model-visible output, argv, ambient environment, workspace,
  comments, checkpoints, handoff или logs.
- Signed runtime запускается только после authenticated exact-release resolve,
  проверки signature/package/files/paths и с host-authored allowlist окружения.
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

- Для изменённого bundled skill запусти его tests, `validate-skill` при наличии
  и `skill-creator/scripts/quick_validate.py`.
- Для manifest используй штатный `plugin-creator` validator. Для
  bridge/host/hooks/MCP запускай релевантные generic regressions на Node.js 22+
  на поддерживаемых платформах.
- `BRIDGE_VERSION`, Codex manifest, Claude manifest, marketplace entry и exact
  version assertions должны оставаться синхронны.
- Stable plugin version и tag `vX.Y.Z` выпускаются вместе. Не меняй version, не
  создавай tag/GitHub Release и не публикуй production без явной команды на
  релиз.
- Перед коммитом выполни `git diff --check`, проверь staged scope и отсутствие
  секретов/generated cache. Коммиты, descriptions и release notes пиши
  по-русски.
