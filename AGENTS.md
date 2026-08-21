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
- Runtime admission proof создаёт только approved hook. Агент не формирует, не
  копирует и не обходит proof другим MCP, HTTP, browser или script.
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
