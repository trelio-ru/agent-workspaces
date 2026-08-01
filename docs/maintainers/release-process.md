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
5. Только после этого отдельным backend CAS поднять live latest/minimum policy.

При network ambiguity сначала read-back remote ref/release; side-effect нельзя
слепо повторять.

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
