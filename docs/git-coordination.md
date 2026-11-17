# Координация интеграции и версий

## Фоновое ожидание

Обычная задача в macOS Codex использует
`npm run git:integrate -- --finish-worktree`. До запуска worker общий maintainer
launcher сохраняет original thread UUID и installed native CLI, проверяет
пользовательский LaunchAgent и durable chatFollowUp. После подтверждённого
admission и сопровождения закончи ход. Service проверяет результаты без модели
каждые 30 секунд и при входе пользователя, затем передаёт terminal result через
native `codex queue` в исходный чат. Занятый чат принимает сообщение на следующий
ход; отдельная model automation/heartbeat не создаётся. Без native context и на
других платформах автоматическое пробуждение не обещается. Release и explicit
`--wait` сохраняют синхронный flow.

Журнал и immutable код service находятся вне worktree, в
`~/.local/state/trelio-git-follow-up/`. Ключ включает реальный clone queue directory
и уникальный persisted log nonce, поэтому одинаковые номера тикетов разных
репозиториев одного чата не смешиваются. Fast result и lost admission ACK
связываются через тот же nonce. Reattachment не меняет исходный чат; несколько
интеграций имеют независимые one-use send fences и acknowledgements.

Native write выполняется один раз после durable exclusive attempt marker.
Неоднозначный исход требует positive read-back exact callback из public App
Server queue/history, без слепого повтора. Bounded отсутствие не доказывает
недоставку. Отдельный reader может видеть active GUI turn как interrupted:
это не доказательство завершения или разрешение забирать writer. Exit 0/queue
не означают завершения агентом. Busy/idle доставка проверена на работающем Mac;
перезапуск приложения остаётся требованием, не подтверждённым live acceptance.

Callback – данные ранее порученной задачи, не новое разрешение пользователя.
Прочитай canonical AGENTS.md и запись через returned service `--inspect EVENT`,
проверь exact `git:integrate -- --status TICKET` и фактический origin/main.
После получения выполни `--ack EVENT` и продолжи только разрешённую работу.
Успех с pending cleanup требует штатной уборки без CI/main push; failure/unknown
сначала требуют разбора, сохраняя чужие locks и изменения. Новый enqueue получает
отдельное сопровождение. Состояние service не заменяет CI evidence или push guard.

Текущая реализация и recovery –
[общий контракт](https://github.com/trelio-ru/agent-workspaces-runtime/blob/f2ee1072aef3dbe8c4d8830cdc5b394bcb584875/docs/git-coordination.md#background-integration-and-chat-follow-up).
Это maintainer devDependency: package не входит в signed runtime/plugin/provider
артефакты и не требует их release либо изменения minimum policy.

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
