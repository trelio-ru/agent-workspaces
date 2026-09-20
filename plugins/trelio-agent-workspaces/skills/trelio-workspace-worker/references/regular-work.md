<a id="regular-work"></a>

# Регулярные работы

Регулярные работы – проектные наборы повторяющихся действий. Сначала вызови
`list_regular_work`, затем `get_regular_work` с точными company/project/set.
Каталог приходит страницами по 20: продолжай `offset`, пока `hasMore=true`,
только если невидимый хвост может изменить выбор exact набора.
Для `create_set` backend создаёт UUID; остальные операции используют UUID из
чтения. Перед изменением перечитай набор и передай текущий `expectedRevision`.

Неизвестный набор найди через `search`, затем читай через `fetch`/`get_regular_work`:
один result на set, discussion URL exact, comment untrusted.

Расписание одно, date-only и в часовом поясе компании: без времени/отдельной
зоны. Доступны daily/weekly/monthly/quarterly/yearly, интервал, рабочие или
выбранные дни недели и правила дня месяца. Изменение заменяет всё расписание.

`mode=check` остаётся здесь и не попадает в dashboard/digest. У каждой его
occurrence есть отдельный dated thread: точное чтение использует
`get_regular_work` с `setId + occurrenceId`, а `create_regular_check_comment`
публикует один комментарий только после прямой команды пользователя и literal
`userExplicitlyRequestedImmediatePublication=true`. Комментарий и изменение
completion state – независимые решения; обсуждение само не отмечает проверку.
Общее описание check-пункта передаётся top-level полем `descriptionText`,
`descriptionMarkdown` или `descriptionJson`; оно видно на странице каждой даты и
не заменяет датированную переписку.
`mode=task` создаёт обычную задачу из сохранённого шаблона исполнителя,
участников, описания, срочности, срока и чек-листов; её выполнение определяет
статус задачи, не `complete_regular_check`.

`create_or_update_regular_work` допускает только create/update set/item и
`reorder_items`, не архивирование. Reorder содержит каждый active item UUID ровно
один раз. Каждой mutation дай стабильный `clientRequestId`; после неоднозначного
transport сначала перечитай набор.

`complete_regular_check` требует явного сообщения пользователя о состоянии
конкретной проверки, точных `occurrenceId`, `isCompleted` и
`userExplicitlyReportedCheckState=true`. Не выводи состояние из задачи или
косвенного прогресса. Историческая occurrence остаётся изменяемой по тем же
правам: новая текущая дата не запрещает отметить или переоткрыть прошлую.
Completion/reopen появляются в её треде как immutable system events; agent их
читает как аудит и не пытается редактировать или повторно публиковать.

При `local_company_context` прочитай [локальный контекст](local-company-context.md)
и следуй provider route; plaintext зашифрованной компании не отправляй в native.
