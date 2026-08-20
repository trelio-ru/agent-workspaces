# Release process

## Когда нужен plugin release

Release нужен только для bundled MCP/bootstrap/control-plane skills,
bridge/host, hooks, manifest, общей security-инфраструктуры или presentation
assets самого plugin. Backend-managed Markdown, Remote MCP declaration и
immutable internal runtime release публикуются отдельно, пока generic host
contract не меняется.

Provider-specific runtime source не должен находиться внутри
`plugins/trelio-agent-workspaces/**`: его каноническое место –
`platform-skills/<skill-id>/`, отдельный runtime-каталог вне plugin bundle либо
другой канонический репозиторий. Существующий `plugin-script` – временное
compatibility exception, а не основание добавлять новый provider runtime в
plugin. Перед его очередным изменением сначала планировать signed-package
миграцию; срочное bundled исправление требует отдельного host-bound обоснования
и следующего шага миграции.

В этом repository independent contour состоит из собственного `SKILL.md`,
`release.json`, `scripts/`, `tests/`, workflow
`platform-skill-runtimes.yml` и детерминированного builder
`platform-skills/tools/build-runtime-package.mjs`. `release.state=planned`
фиксирует подготовленную, но ещё не опубликованную версию. Backend signing и
current pointer остаются отдельным publication step; package builder не имеет
signing key и не меняет live state.

Не выпускать plugin и не менять `BRIDGE_VERSION` только потому, что изменились
instruction, команды, adapter, зависимости или tests одного backend-managed
навыка. Такой change получает собственные skill/runtime SemVer и подписанный
artifact. Его `minimumHostVersion` остаётся на самой старой реально совместимой
версии host; совпадение с текущей plugin version не считается доказательством
новой зависимости.

## Plugin release admission gate

Plugin – отдельный консервативный release contour. До изменения файлов plugin
автор обязан зафиксировать хотя бы одно допустимое основание:

- security vulnerability или нарушение fail-closed invariant в общей
  bridge/host/hooks/credential/package-verification инфраструктуре;
- несовместимое изменение Codex/Claude plugin platform, MCP, OAuth, hooks или
  onboarding, которое невозможно адаптировать на backend;
- дефект generic host, затрагивающий безопасный запуск независимо от provider;
- новый общий host/security primitive, который нужен нескольким навыкам или
  классу будущих навыков и не может быть доставлен как Remote MCP либо signed
  runtime без ослабления security boundary.

Не являются допустимым основанием: изменение provider API/DOM, новая команда
или parser, новая бизнес-политика, instruction/prompt, provider dependency,
provider-specific browser automation, тесты одного навыка и срочность такого
изменения. Всё это выпускается в контуре конкретного skill/runtime.

Plugin release proposal обязан содержать:

1. выбранное основание admission и точный generic contract, который меняется;
2. почему backend instruction, Remote MCP или signed artifact недостаточны;
3. regression для нового host/security поведения;
4. совместимость со старым host и обоснование сохранения либо повышения
   `minimumVersion`;
5. rollout/rollback plan; для переходного `plugin-script` также owner и
   следующий проверяемый шаг удаления из plugin.

Если эти пункты заполнить нельзя, plugin path закрыт: изменение переносится в
независимый skill/runtime contour. Независимость должна обеспечиваться не только
расположением файлов, но и CI: provider-only change не создаёт plugin tag,
artifact или marketplace release и не запускает plugin test workflow. Plugin
использует tag namespace `vX.Y.Z`; provider runtime tags, если они нужны в этом
repository, обязаны использовать отдельный skill-specific namespace.

Provider tag имеет форму `skill-<skill-id>-v<skill-version>`. Он запускает
только platform-skill workflow и сохраняет exact `.skillpkg` для backend
publication; plugin tag `vX.Y.Z`, marketplace artifact и plugin policy при этом
не создаются и не меняются.

Не перезаписывать опубликованный immutable runtime/version. Версию выбирать по
SemVer: backward-compatible новая публичная команда или orchestration contract
требуют minor, совместимое исправление существующего поведения – patch,
несовместимый контракт – major.

## Version synchronization

Одна strict semver version должна совпадать в:

- `scripts/trelio-workspace.mjs` (`BRIDGE_VERSION`);
- `.codex-plugin/plugin.json`;
- `.claude-plugin/plugin.json`;
- root `.claude-plugin/marketplace.json` entry;
- exact version assertions в regressions.

Stable manifest version и Git tag выпускаются вместе. Tag/title – строго
`vX.Y.Z` без suffix и marketing subtitle.

## Required validation

1. `validate-skill` и `quick_validate.py` для каждого изменённого skill.
2. `plugin-creator/scripts/validate_plugin.py` для plugin root.
3. Node.js 22+ syntax checks изменённых `.mjs`.
4. Полные Node regressions bridge/Remote MCP/runtime policy для generic plugin.
5. Собственный package `--check` и Node/Python tests изменённых platform
   runtimes на macOS/Windows/Linux по их отдельному workflow.
6. `git diff --check` и audit staged scope.
7. Проверка version synchronization test.
8. Для изменённых agent instructions – forward scenarios без live side effects.

Security tests должны проверять semantic invariant/tool/error code, а не только
длинную конкретную формулировку, если wording намеренно сокращён.

## Release ordering

Исключение для изменения predefined OAuth client contract: additive backend
migration и совместимый backend deploy выполняются и проверяются до plugin
release. Старые plugin/DCR clients должны продолжать работать. Только после
read-back seeded client можно публиковать manifest, который ссылается на новый
`clientId`; иначе install fail-closed завершится `invalid_client`.

1. Закоммитить и push main.
2. Создать annotated/lightweight tag в соответствии с существующим repo flow и
   push exact tag.
3. Создать GitHub Release с title `vX.Y.Z`.
4. Проверить published marketplace exact version/code.
5. Сразу после проверки marketplace отдельным backend CAS установить live
   `latestVersion=X.Y.Z`. `minimumVersion` поднять до `X.Y.Z` только когда exact
   host/security change делает прежний host несовместимым; release-план обязан
   назвать этот change и regression. Для совместимого plugin release сохранить
   прежний minimum – это штатный rollout, а не исключение.
6. Прочитать live policy обратно и проверить оба exact значения. В итоговом
   сообщении о релизе явно указать подтверждённые `latestVersion` и
   `minimumVersion`, а при их различии – что прежний host остаётся
   поддерживаемым. Skill/runtime release global plugin policy не меняет.

При network ambiguity сначала read-back remote ref/release; side-effect нельзя
слепо повторять.

## Публикация internal runtime через Codex in-app Browser

Новый signed runtime публикуется в `/internal-admin/skills/` через встроенный
Browser Codex с уже авторизованной сессией администратора. Рабочая
последовательность:

1. Собрать `.skillpkg`, проверить его SHA-256 и держать по точному абсолютному
   локальному пути. В форме exact навыка заполнить новую версию, полную
   инструкцию, minimum host и краткое описание изменений; для нового пакета
   снять `Если новый файл не выбран, оставить текущий runtime`.
2. После свежего DOM snapshot разрешить exact `input[type="file"]` внутри
   article навыка. Сначала создать ожидание
   `tab.playwright.waitForEvent("filechooser")`, затем нажать input и передать
   chooser-у абсолютный путь через `setFiles(...)`.
3. Проверять выбор файла по непустому `input.value`: встроенный Browser
   возвращает значение вида
   `C:\\fakepath\\<точное-имя-пакета>.skillpkg`. Read-only DOM scope может
   вернуть `input.files` как `null` или пустой список даже после успешного
   выбора, поэтому `files.length`, `Array.from(files)` и `File.size` здесь не
   являются надёжной проверкой. Если `input.value` пуст или basename не
   совпадает, публикацию не запускать.
4. Перед submit ещё раз проверить version, instruction marker, minimum host,
   выключенный reuse, summary и basename пакета. После клика дождаться heading
   новой версии и сообщения `Версия навыка ... опубликована`.
5. Через `list_agent_skills` перечитать live skill и проверить skill/runtime
   version, новый release ID, package SHA-256, size, minimum host и manifest.
   Затем непосредственно перед smoke-командой вызвать `get_agent_skill` и
   запустить только возвращённый exact signed runtime. Для runtime с Agent
   Secret использовать новый одноразовый checkout текущего активного Run.

Обычная настройка Chrome extension `Allow access to file URLs` не относится к
этому flow: публикация выполняется в отдельном профиле Codex in-app Browser, а
локальный файл передаётся поддерживаемым file chooser API.

## Release notes

Notes на русском языке и только в таком порядке:

```markdown
## Что вошло в релиз

...

## Миграции и env

...

## Что проверить после деплоя

...

## Rollback

...
```

В `Миграции и env` указывать compatibility, OAuth scopes, system requirements
и update path. Rollback не должен предлагать forge version или permanently
pinned marketplace: tag pin допустим только как краткая диагностика, пока live
minimum совместим.
