<a id="agent-run-recovery-and-history"></a>

# Восстановление и история Agent Run

Полностью прочитай файл при ошибке выбора папки/Run/storage/lease/base-head, перехвате Run на
другом устройстве, явной отмене, восстановлении, запросе истории или локальной
очистки. Обычные open/checkpoint/finish описаны в `agent-run.md`.

## Выбор папки при нескольких локальных roots

`TRELIO_WORKSPACE_DIRECTORY_REQUIRED` означает неоднозначность локальных
копий, а не сбой OAuth или установки. `details.candidates` содержит точные
корни `directory` и их локальные `runId`; `omittedCandidateCount` сообщает
о сокращённом списке. Список не доказывает чистоту Git и завершение Run.
Повтори прежний `open`, добавив выбранный корень над `workspace/` как
`parameters.directory`. Не используй `parameters.dir`: `--dir` – CLI-флаг.
Сохрани Workspace/Run/runtime arguments и рабочую папку клиента.

Для нового Run bridge сам переиспользует ровно один канонический root
`<binding>/workspaces/<workspace-id>`, когда `workingDirectory` находится в
exact managed working-folder binding. Эта автоматизация не выбирает recovery-
копию или duplicate exact Run. Если ошибка всё же возвращена, безопасного
однозначного канонического выбора нет – используй правила ниже.

Используй уже подтверждённую папку текущей работы; при нескольких равноправных
копиях уточни выбор. Не выбирай первую по порядку, не придумывай recovery-папку
и не удаляй roots или registry. Обычный preflight проверит live Run и Git до
записи. Ошибка preflight не разрешает обход или отмену Run.

## Локальная дельта завершённого Run

`TRELIO_WORKSPACE_LOCAL_RECOVERY_REQUIRED` означает, что persistent root хранит
изменения уже terminal Run и не может быть заменён целевым Run. Используй exact
`details.suggestedDirectory` как `parameters.directory` повторного `open` с теми
же `workspaceId`, `runId` и runtime arguments. Source root и перечисленные в
`details.changes` файлы не перемещай и не очищай автоматически.

После успешного открытия сравни base/accepted целевого Run с bounded source
дельтой, перенеси только нужные пользовательские материалы, выполни проверки и
сразу сохрани новый root через `checkpoint`, `pause` либо `finish`. Системный
untracked `.DS_Store`, `Thumbs.db` или `desktop.ini` размером не больше 1 МиБ
bridge исключает сам; tracked-файл, каталог, symlink и большой одноимённый файл
остаются dirty. Этот local recovery общий для plain и encrypted компаний:
plaintext fallback не появляется, а последующее сохранение использует штатный
transport целевого Run.

## Заблокирована миграция старой локальной структуры

`TRELIO_WORKSPACE_LAYOUT_MIGRATION_BLOCKED` означает, что старый
`<workspace-id>/<run-id>/` container содержит top-level записи, которые нельзя
автоматически считать служебными. Назови пользователю exact
`details.rootDirectory`, каждую видимую запись из `details.blockingEntries` и её
`reasonCode`, а также прямо скажи, что при
`automaticChangesPerformed=false` bridge ничего не перемещал и не удалял. Не
заменяй это общей фразой «старая структура локальной папки» и не выводи
фактический root из `workingDirectory`: bridge мог выбрать прежний global или
registered root раньше folder binding.

Обычный файл `.DS_Store`, `Thumbs.db` или `desktop.ini` размером не больше 1 МиБ
bridge исключает сам и оставляет на месте. Одноимённые каталог, symlink, special
file или большой файл, а также любая неизвестная запись остаются fail-closed.
Не удаляй и не переноси их автоматически: предложи человеку проверить exact
путь и выбрать судьбу пользовательских данных. Эта ошибка возникает до создания
нового Run и не является сбоем OAuth, pairing или Hooks.

## Действие требует открытого активного Run

`TRELIO_WORKSPACE_ACTIVE_RUN_REQUIRED` означает, что Run-bound действие
запущено не из materialized writable Run. Это не доказательство старой
локальной структуры и не повод запускать диагностику OAuth/plugin. Следуй
`details.reasonCode`:

- `READ_ONLY_INSPECTION` – текущая папка создана
  `prepare_agent_workspace_read`; отсутствие `.trelio-run.json` в ней штатно;
- `RUN_METADATA_NOT_FOUND` – рядом с рабочей папкой нет metadata открытого Run;
- `RUN_METADATA_INVALID` или `RUN_ID_MISSING` – найденная metadata не может
  подтвердить active Run.

Используй уже выбранную точную задачу/Workspace. Вызови
`prepare_agent_workspace_run` (с exact `runId`, если он уже задан текущим
workflow), исполни returned `open`, возьми выданный writable directory и
повтори исходное действие один раз. Не превращай read-only inspection в
writable каталог и не создавай новый Run при наличии exact recoverable Run.
Если цель ещё не определена точно, сначала вернись к `scope-and-context.md`.
`automaticChangesPerformed=false` означает, что bridge ничего не переносил и
не удалял; эта ошибка не содержит `rootDirectory` или `blockingEntries`.

<a id="blockers-restore-concurrency-and-cleanup"></a>

## Блокировки, восстановление, конкуренция и очистка

- При `COMPANY_STORAGE_BALANCE_REQUIRED` останови изменение. Не повторяй его,
  не отменяй Run и не создавай другой. Объясни: баланс компании блокирует новую
  запись в хранилище; локальные файлы и текущий Run сохранены. После пополнения
  уполномоченным лицом повтори то же действие `checkpoint`, `pause`, `finish`
  или `submit`. Не превращай эту блокировку передачи в `waiting_for_human`:
  checkpoint ожидания человека допустим только после надёжного сохранения draft.
- Отменяй открытый Run, только если пользователь явно отказался от него.
  Вызови `cancel_agent_workspace_run` с конкретной причиной для аудита. При
  local `providerSelection` продолжи exact dispatcher action с `route=workspace`;
  host защищает причину локально. Временная блокировка или ошибка
  команды не означают отмену.
- Последующее точное `open` для того же Workspace и Run может забрать ожидающий
  Run на другом компьютере, развернуть серверный draft и показать
  `run-checkpoint.json`. История чата не переносится. Старое локальное дерево
  с правками или расхождением не перезаписывается: используй новый каталог
  либо осознанно объедини изменения.
- Обычный `prepare_agent_workspace_run` также выбирает последний собственный
  непустой серверный draft с актуальной базой. Открытие возвращённого действия
  забирает этот Run и блокирует старую lease. `startNewRun=true` используй
  только для намеренно независимой параллельной ветки.
- `TRELIO_WORKSPACE_RUN_RECLAIMED`: host claim-нул exact Run; повтори save один раз.
- `TRELIO_WORKSPACE_RUN_RECLAIM_REQUIRED`: возьми IDs из structured error,
  вызови `prepare_agent_workspace_run` с exact `runId`, returned open и один retry.
  Без `startNewRun=true`; не завершай ответ до accepted/blocker.
- `TRELIO_WORKSPACE_RUN_FENCED`/`STALE_FENCING_TOKEN`: без фонового takeover – Run может быть жив на другом host.
  Claim только осознанно; terminal `RUN_NOT_CLAIMABLE` не обходи.
- При `WORKSPACE_OUTDATED` сохрани отклонённый candidate, начни новый Run от
  текущего принятого head, сравни параллельные изменения и объедини/перенеси
  свои без принудительной перезаписи канонической истории.
- Для отмены принятых изменений прочитай список ревизий, выбери точный head
  и восстанови его с актуальным `expectedHead` и содержательной причиной.
  Если native-вызов выбирает local dispatcher с `route=workspace`, используй
  exact returned action для list/restore. Diff и файлы принятых Run читаются
  через его операции history. Restore добавляет потомка и отклоняет конфликт;
  не изобретай доступ к зашифрованным данным через Git/HTTP.
- Не удаляй корни Workspace вручную. Сначала выполни `clean` с явным
  `dryRun=true`: план включает только неиспользуемые 30 дней, завершённые на
  backend, локально чистые и не открывающиеся сейчас корни, а также объём cache.
  Для сохранённых текущих roots команда выводит стабильную причину:
  `run_status_unknown`, `run_not_terminal`, `workspace_has_open_run`,
  `retention_period_active`, `workspace_open_locked`, `unmanaged_root_entry`
  или `workspace_dirty`. Открытыми считаются `running`, `waiting_for_human` и
  совместимый `review`: `expired` sibling не блокирует terminal root, но root
  собственного `expired` Run сохраняется для claim. Обычный небольшой
  `.DS_Store`, `Thumbs.db` или `desktop.ini` в корне не считается unmanaged;
  каталог, symlink или файл больше 1 МиБ с таким именем остаётся блокировкой.
  Последующий явный `dryRun=false` удаляет только этот локальный план, никогда
  серверную ревизию. При недоступном backend ничего не удаляется; активные,
  неизвестные и изменённые корни сохраняются. Автоматическая best-effort
  проверка после `open`, успешного `finish` или локального `cancel_run` не чаще
  раза в сутки не заменяет этот явный dry-run и не удаляет legacy-каталоги без
  текущей `.trelio-run.json` metadata.
