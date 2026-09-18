<a id="local-company-context-provider"></a>

# Локальный контекст компании

Читай этот reference только когда native ответ выбрал
`providerSelection.provider=local_company_context` или точная задача вернула
такой `proposalProvider`. Plain-объект без этого поля использует native Trelio.
Никогда не выводи local route из `encryptionState`, названия компании, прежней
сессии или ошибки другого provider.

## Выполни exact route

1. Вызови server/tool/operation из текущего `providerSelection` без
   переименования и без предварительного native read. Новый non-UI маршрут
   приходит как один `trelio-remote-skills.continue_trelio_local_action` с
   готовыми `schemaVersion`, `route` и `parameters`; старые отдельные tool names
   остаются только compatibility route уже возвращённых ответов.
2. Если selection содержит `nativeArgumentsTarget=parameters.arguments`, скопируй
   туда exact input исходного native вызова и больше ничего не перестраивай.
   Для local upload вместо binary/base64 добавь только разрешённый
   `parameters.localFilePath`. Не добавляй runtimeSessionProof,
   crypto-настройки, mirror paths, keys или собственный fallback.
3. Если результат содержит `nextCall`, он является каноническим продолжением:
   выбери нужный результат, скопируй только поля из `copyFromSelectedResult` по
   указанным dotted paths внутрь готовых `arguments` и вызови указанный tool.
   Не восстанавливай этот маршрут по памяти. В частности, search ведёт к exact
   fetch, а Workspace-file search – к чтению файла на возвращённом accepted head.
4. Если provider ответил `native_trelio`, прекрати local route и продолжи exact
   native operation. `setup_required`, `access_pending`, `no_access`,
   `needs_reconnect` и provider error не разрешают другой connector, browser,
   самодельный HTTP или plaintext cache.

Первое local чтение само выполняет bounded sync; ручного sync для модели нет.
Ранжирование, generations, encryption, TTL, mutation invalidation и binary
delivery принадлежат runtime. Не описывай их как шаги и не меняй его private
files. Read-only materialization не является Agent Run и не разрешает edit,
checkpoint или submit.

## Сохрани authority и accepted-head fence

`effectiveInstructions.layers` и `orderedLayerKeys` разрешай как в native
schema-v3. Передавай `knownInstructionLayerKeys`/`nextReadArguments` только пока
полный неизменившийся Markdown exact layers остаётся в текущем model context.
После compaction, новой сессии, смены области или сомнения опусти keys: один hash
не заменяет authority.

Для записи task/named Workspace используй обычный
`prepare_agent_workspace_run` и exact bridge actions. Local search/read не создаёт
Run, lease или company-wide lock. Workspace file читай только по тройке
`workspaceId`, `workspaceHead`, `filePath`, которую вернул runtime; новый head не
подставляй.

Историю/restore/cancel продолжай через exact dispatcher action из
`providerSelection`. Выбирай revision только из свежего list; manifest читается
до selected-file patch. Restore требует текущий/целевой heads, содержательную
причину и server-prepared runtime session; неоднозначный mutation сначала
проверяется точным read-back. Не повторяй restore/cancel вслепую.

## Proposals остаются независимым решением

Используй exact `proposalProvider` задачи и его `nextCall`:

- context read – server-returned dispatcher action с exact native input; runtime
  сам выводит kind и цель, после чего следуй его `nextCall`;
- save/render – `render_trelio_local_proposal` с live revision/snapshot и той же
  целью;
- несколько карточек – один `kind=bundle` с исходным порядком blocks;
- publish/apply/dismiss – только после App action или явного решения пользователя
  по exact proposal. Run finish и render не являются подтверждением.

Не вызывай native proposal renderer после local selection. Комментарий, статус,
checklist и control остаются отдельными семантическими решениями; draft не
является опубликованной историей. При stale/conflict перечитай context и сохрани
ручной текст пользователя. Если App недоступен, покажи гидратированный draft и
запроси то же явное решение – не превращай proposal в прямое изменение.

## Actions и файлы

Обычную mutation выполняй только через exact dispatcher action из
`providerSelection`. Для task/knowledge-base upload передай
`parameters.localFilePath` выбранного локального файла и native arguments без
base64/size/hash; runtime сам проверяет и доставляет bytes. Перед повтором
неоднозначной mutation перечитай live object тем же provider.

Original attachment/accepted file с `delivery=local-file` исследуй по локальному
пути из `structuredContent`. Не возвращай binary через MCP и не сохраняй его вне
разрешённого Workspace без необходимости. Важные постоянные материалы переноси
только обычным Agent Run.

## Fail closed

Не проси unlock/recovery key или credential в chat, MCP arguments, shell, env,
stdin, clipboard либо Workspace. Local unlock/setup выполняет bridge. При
`access_pending` дождись разрешения exact устройства владельцем. Не используй
server search, browser scraping, соседний connector или plaintext fallback.

Перед итогом выполни
[workspace context review](workspace-context-review.md): exact rules → сравнение
с текущим результатом → saved/accepted evidence, `no_new_context`,
`not_authorized` либо точная блокировка.
