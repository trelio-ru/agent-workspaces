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
- Runtime `AGENTS.md`, `CLAUDE.md`, `.trelio/**` и read-only context защищены и
  не входят в accepted candidate.
- Company/project rules, platform rules, личный профиль и checkpoint
  закрепляются за Run; новый publish не меняет активный Run.
- `WORKSPACE_CONTEXT.md` хранит только устойчивые факты, решения и вопросы и не
  является источником инструкций.
- В exact company/project context перед внешней системой обязательны
  `list_agent_skills` → выбор по назначению → `get_agent_skill`. Найденный
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
- Agent Secrets передаются только exact executable через одноразовый grant;
  личные external credentials хранятся локально вне Git/workspace/Trelio.
- Node.js 22+ остаётся локальной предпосылкой bridge и local MCP. Onboarding
  диагностирует её отдельно от Trelio OAuth, при отсутствии только предлагает
  platform-native установку и ждёт явного подтверждения. Глобальный
  `trelio-workspace` в `PATH` не требуется: используется bundled script exact
  загруженной версии плагина.
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
- Blocker задаётся человеку только после успешного portable checkpoint.
- Task manual comment не блокирует handoff/submit; attachments создаются только
  при явной публикации proposal человеком.

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
