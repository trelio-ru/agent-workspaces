# Координация интеграции и версий

После commit запустить `npm run git:integrate`. Общая FIFO всех linked worktree
занимается до fresh fetch/rebase, публикации task branch/PR, финального exact
hosted CI и guarded main push/read-back. Не менять ожидающие HEAD/files.
Source tags hook-компонента `codex-hooks-source-vX.Y.Z` используют ту же очередь
и atomic transport, как stable plugin tags.
Для разрешённого релиза: `npm run git:integrate -- --tag <exact-tag>`.
Версия проверяется до CI; занятая версия останавливает кандидата без перезаписи.
Подготовить source/manifest version до enqueue. Артефакт, подпись, activation/CAS
и production read-back сохраняют отдельные правила владельца репозитория.

`--status` показывает очередь; `--recover <ticket>` снимает только exact ticket
своего host после смерти owner и всей isolated process group. Возраст не даёт
права забрать очередь; живые grandchildren после SIGKILL остаются блокировкой.
Failed CI/rebase сохраняет работу. Внешний clone не входит в локальную очередь:
remote advance останавливает push, без автоматического rebase/retest.
Canonical hook проверяет live ancestry, exact worktree/branch/SHA/tag и verified
state; boolean, raw push и старый wrapper допуска не дают.

Единственная реализация – maintainer devDependency `@trelio/git-coordinator`
из exact Git commit `trelio-ru/agent-workspaces-runtime`, закреплённого lockfile.
После checkout выполнить `npm ci --ignore-scripts`; node_modules не делить.
Репозиторий владеет своими policy, CI adapter, hooks и transport. Общий код не
копируется, пакет не включается в plugin/runtime/provider artifacts и не меняет
их version/minimum policy. Обновление infrastructure не означает выпуск продукта.

Обычный FF main использует exact PR evidence и не запускает тот же gate заново.
Канонический pre-push продолжает проверять каждый protected push. Tag jobs
сохраняют собственные прежние release-проверки и publication/read-back.
