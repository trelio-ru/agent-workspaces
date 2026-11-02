# Координация интеграции и версий

## Фоновое ожидание

При ожидании очереди или CI использовать `npm run git:integrate -- --background`
(для уже разрешённого релиза добавить `--tag <exact-tag>`). Worker сам продолжает
FIFO; launcher возвращает JSON только после сохранённого admission. Повторный
запуск той же живой задачи переиспользует ticket. Пустая очередь не доказывает
успех: `npm run git:integrate -- --status <ticket>` читает активный ticket либо
сохранённый terminal result с исходным/rebased SHA и private log path.

Агент сохраняет один heartbeat этого же чата раз в 15 минут, точный ticket,
canonical/task paths и оставшиеся шаги. При активном ожидании он заканчивает
проверку без уведомления; после success проверяет remote и выполняет штатный
cleanup и остальные уже разрешённые действия. Ошибка/unknown сначала требуют
проверки фактического результата, без blind retry и удаления чужих locks.
После завершения heartbeat отключается; при необходимом решении человека –
приостанавливается. Без подтверждённого scheduler нельзя обещать возврат.
Подробный [общий flow](https://github.com/trelio-ru/agent-workspaces-runtime/blob/6cdbf5d2123711c7345ea1bda31ef0395b1d54d1/docs/git-coordination.md#background-integration-and-chat-follow-up)
поставляется с той же exact maintainer revision. Компьютер и Codex desktop app
должны оставаться включёнными; CI/transport и release authority не расширяются.

## Инварианты интеграции

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
