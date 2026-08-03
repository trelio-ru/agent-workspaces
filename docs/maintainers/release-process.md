# Release process

## Когда нужен plugin release

Release нужен для bundled MCP/bootstrap skills/bridge/host/manifest. Backend-
managed Markdown, Remote MCP declaration или immutable internal runtime release
могут публиковаться отдельно, пока bundled plugin contract не меняется.

Не перезаписывать опубликованный immutable runtime/version. Новый behavior –
новый patch.

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
4. Полные Node regressions bridge/Remote MCP/runtime policy/messaging.
5. Python tests Email/Telegram и изменённых platform runtimes.
6. `git diff --check` и audit staged scope.
7. Проверка version synchronization test.
8. Для изменённых agent instructions – forward scenarios без live side effects.

Security tests должны проверять semantic invariant/tool/error code, а не только
длинную конкретную формулировку, если wording намеренно сокращён.

## Release ordering

1. Закоммитить и push main.
2. Создать annotated/lightweight tag в соответствии с существующим repo flow и
   push exact tag.
3. Создать GitHub Release с title `vX.Y.Z`.
4. Проверить published marketplace exact version/code.
5. Сразу после проверки marketplace отдельным backend CAS установить live
   `latestVersion=X.Y.Z` и `minimumVersion=X.Y.Z`. Обычный plugin release не
   завершён, пока backend minimum остаётся на предыдущей версии. Отдельный
   прежний minimum разрешён только по прямому решению о staged rollout.
6. Прочитать live policy обратно и проверить оба exact значения. В итоговом
   сообщении о релизе явно указать подтверждённый backend `minimumVersion`, а
   не только факт запуска CAS-команды.

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
