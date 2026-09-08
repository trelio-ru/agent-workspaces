<a id="task-proposal-bundles"></a>

# Наборы предложений для задач

Полностью прочитай файл перед возвратом двух и более карточек предложений.

<a id="return-one-host-result"></a>

## Верни один результат клиенту

До первой записи proposal определи полный состав ответа. При нескольких
интерактивных карточках прочитай reference каждого вида и вызови
`render_task_proposals` ровно один раз. В этом ответе не вызывай
`propose_task_comment`, `render_task_comment_proposal`,
`render_task_comment_proposals`, `render_task_status_proposal`,
`render_task_control_clear_proposal` или `render_task_checklist_proposal`:
клиент может показать только последний отдельный App-результат.

Для локального `proposalProvider`/выбранного сервером `providerSelection`
следуй `local-company-context.md`. Используй успешный combined review
и передай все упорядоченные блоки одним local render с `kind=bundle`,
`operation=save`. Иначе получи нужные headless contexts. У каждой карточки
остаётся отдельное позднее решение человека; не разбивай набор на single render.

После результата предпочитай один `get_task_review_context` на точную цель
лишь с нужными `proposalKinds`. Его `proposalContexts` и общие верхнеуровневые
controls/checklists заменяют соответствующие чтения свежего контекста ниже.
Сохраняй per-kind revision/snapshot и не перечитывай одиночные инструменты.
Для отдельного proposal или неподдерживаемого combined read используй:

- `get_task_comment_proposal_context` для `commentProposal`;
- `get_task_status_proposal_context` для `statusProposal`;
- `get_task_control_clear_proposal_context` для `controlClearProposal`;
- `get_task_checklist_proposal_context` для `checklistProposal`.

Точные optimistic revision, snapshot/hash, текущий статус, control ids,
checklist/item snapshots и остальные поля каждой цели относятся только к её
блоку. Run-цель использует точный `runId`; прямая – `companySlug`,
`projectSlug`, `taskNumber`. Не используй контекст одной задачи для соседней
карточки и не создавай две карточки одного вида для одной цели.

<a id="preserve-card-independence"></a>

## Сохрани независимость карточек

Сохраняй порядок, максимум 64 блока и 20 карточек. Соседний текст объединяй
в необязательные `text` blocks.

Ошибка domain/ACL/conflict/stale state может отклонить один подготовленный
блок, оставив остальные рабочими. Не скрывай успешные карточки из-за одного
сбоя и не заменяй ошибочную карточку немедленным изменением. Недостающее право
OAuth блокирует весь вызов и требует стандартного consent/recovery.

Каждая карточка сохраняет собственные publish/apply/dismiss и optimistic
state. Действие одной не разрешает и не решает другую. В текстовом клиенте
ссылайся на точные proposal id/revision и жди явного решения по карточке.
Одобрение набора не означает одобрения всех изменений внутри.

После неоднозначного транспортного сбоя сначала прочитай свежие proposal
contexts, чтобы установить, какие drafts сохранились, затем решай о повторе записи.
