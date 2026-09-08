<a id="local-company-context-provider"></a>

# Локальный контекст компании

Читай только после выбора `local_company_context` через native
`providerSelection` или `proposalProvider` точной задачи. Plain-задачи
опускают это поле и не требуют чтения. Сам не выводи ни один маршрут.
Если local tool вернул `provider=native_trelio`, останови этот путь
и продолжи обычным native tool текущей операции.

<a id="the-first-local-read-performs-one-bounded-sync"></a>

## Первое локальное чтение выполняет ограниченную синхронизацию

Вызови `trelio-remote-skills.continue_trelio_local_context` с точной
возвращённой операцией: `search`, `list`, `get_task`, `fetch`,
`search_workspace_files` или `get_workspace_file`. Первый вызов через mirror
в каждом MCP host-процессе автоматически синхронизирует компанию;
ручного sync для агента нет.

Host скачивает только канонические проекции, отфильтрованные ACL, разрешает
E2EE markers на устройстве, открывает принятые Workspace bundles в приватном
временном хранилище и публикует одну зашифрованную generation mirror.
Расшифрованные данные, запросы, snippets, пути и ключи не отправляются в Trelio.

Sync переиспользует неизменные revisions/accepted heads, гидратирует
изменённые markers ограниченными batch всего mirror. Короткий writer lock
компании защищает атомарную публикацию; читатели сохраняют прежнюю неизменную
generation. Конкуренты могут ждать, но не удаляют mirror, не расширяют scope
и не создают plaintext fallback. Обновление lock и захват устаревшего lock
ограничены и проверяют владельца.

После sync чтения mirror локальны для процесса; новый host синхронизируется
заново. Host повторяет сборку при смене generation. Не выдумывай refresh
перед каждым запросом.

Каждая локальная запись, proposal save/action, restore/cancel и принятый
encrypted `finish` публикуют приватный случайный маркер без содержимого.
Каждый MCP host проверяет его до доверия RAM; изменение запускает обычный
ограниченный sync при следующем чтении. Ручной sync/polling не нужен.
Маркер лишь предотвращает старое чтение; конкурирующие чаты по-прежнему
разрешаются server idempotency, revisions, heads, leases и fencing tokens.

На диске generations зашифрованы. В памяти процесса открыты максимум одна
текущая generation компании и её ленивый лексический индекс с жёстким TTL
600 секунд даже в простое. Позднее чтение заново открывает зашифрованную
generation без нового сетевого sync.

<a id="search-locally-and-reveal-only-selected-results"></a>

## Ищи локально, раскрывай выбранные результаты

Для `search` передай 1–5 верных формулировок и ограниченное число результатов:

```json
{
  "operation":"search",
  "companySlug":"exact-company-slug",
  "queries":["первая формулировка","независимый синоним"],
  "limit":20
}
```

Поиск охватывает проекты; номера/названия/описания/чек-листы задач, видимые
активные control notes, custom fields, имена вложений, manual comments;
Workspace, страницы, контакты, реестры, встречи и принятый текст. Статус,
исполнитель, участники исключены. Архив помечен/read-only; необязательные
области требуют scopes. `context-search-v2`: точные refs > сильнейшее совпадение поля > независимые запросы >
качество поля/лексики > авторитет при реальном равенстве > стабильный ключ.
У типа сущности нет фиксированного приоритета. Ранжирование локально;
fetch только нужного набора.

`list` – лишь для явного inventory или задачи с известным проектом без номера:
документированный resource, необязательные project/offset, `limit<=100`.
`get_task` – точный project slug и положительный номер. Он возвращает
правила/профиль и разрешает точный старый slug до шифрования/переименования,
возвращая только текущий канонический.

Результат поиска принятого Workspace содержит точную native-цель
`prepare_agent_workspace_read`; её чтение остаётся read-only.
Для записи task/named Workspace используются обычные
`prepare_agent_workspace_run` и bridge с теми же per-Workspace leases,
fencing tokens, checkpoints, submit, acceptance и optimistic head.
Не создавай Run lock всей компании: соседние задачи независимы.

Если native `search_agent_workspace_files` выбрал этот provider, повтори
запросы через `operation=search_workspace_files`. Host сначала фильтрует
принятый текст Workspace, затем bounded top-N, чтобы обычная задача/Workspace
не вытеснили нужный файл. `operation=get_workspace_file` принимает точные
`workspaceId`, `workspaceHead`, `filePath` результата и сохраняет native
accepted-head fence. Эти маршруты не начинают Run и не раскрывают backend
исторические Git bytes.

<a id="continue-workspace-history-locally"></a>

## Продолжи историю Workspace локально

При `continue_trelio_local_workspace` сохрани точные компанию/операцию:

- `list_revisions`: `workspaceId`; выбирай только head этого актуального ответа.
- `get_revision_diff`: прежние native arguments внутри `arguments`.
  Сначала опусти `filePath`; поздний patch path берётся из manifest.
- `read_revision_file`: прежние arguments с путём manifest. Binary pointers
  возвращают metadata; используй принятый derived/OCR текст.
- `restore_revision`: Workspace, текущий/целевой heads, содержательная
  plaintext-причина и возвращённая runtime session. Host шифрует причину,
  сохраняет controls, нормализует legacy context и отправляет нового потомка.
  `filesChanged` вычисляется из реальной delta; неоднозначный prepare получает
  один точный marker read-back, не предположительный второй Run.
- `cancel_run`: `runId` и конкретная причина, которую защищает host.
  Только transport/5xx или malformed success допускают ограниченный повтор
  с тем же маркером.

Plaintext истории находится во временном Git-корне, удаляемом до возврата;
controls скрыты. Не воспроизводи шаги bridge и не повторяй неподтверждённый restore.

<a id="use-the-same-proposal-lifecycle"></a>

## Сохрани обычный жизненный цикл proposals

Используй точный `proposalProvider` задачи, сохрани `runId` её Run;
не делай preflight native proposal tool. Маршруты:

- `get_trelio_local_proposal_context`: headless `kind` и `payload.target`,
  где либо `runId`, либо `projectSlug` и `taskNumber`.
- `render_trelio_local_proposal`, `operation=save`: та же цель, plaintext
  draft/reasons и точные revision/snapshot из контекста. Host отправляет
  только локально зашифрованный подписанный ciphertext.

Кнопки App используют скрытые tools. Текстовый `operation=action` требует
решение и точные `proposalId`, `expectedRevision`, `action`,
`confirmed=true`, открытые IDs. Публикация комментария передаёт проверенный
`bodyText` и сверяет сохранённый гидратированный текст.
Завершение Run и render не являются подтверждением.

Виды: `comment`, `status`, `control_clear`, `checklist`. Соблюдай смысловые
правила обычных references: неопубликованные drafts не публичная история,
комментарий и готовность всей задачи независимы, checklist/control решаются
по точным пунктам. Context/save/action используют те же server ACL, advisory
locks, optimistic revisions, public-comment snapshot hashes и идемпотентные
apply/dismiss/publication, что native Trelio.

v8 App хранит скрытую от модели capability на три часа с привязкой к revision.
Успешное решение закрывает лишь запись этой карточки; чтение текущего состояния
проверяет provider/ACL до исходного expiry без продления. Повторно открытая
карточка показывает завершённое состояние. Сохранённые v5 используют старые App tools.

Для нескольких карточек, когда native `render_task_proposals` или совместимый
`render_task_comment_proposals` выбрали local route, вызови один
`render_trelio_local_proposal` с `kind=bundle`, `operation=save`,
`payload.blocks` из намеченного native bundle. Прямые task blocks должны
принадлежать одной точной компании; Run blocks сервер сверяет с ней.
Host сохраняет порядок, canonicalize-ит старые project slugs, шифрует карточки
по их обычным процедурам и возвращает единый bundle с независимыми конфликтами.
Context reads и итоговые publish/apply/dismiss отдельны для каждой карточки.
При неоднозначном transport перечитай все затронутые contexts до повтора;
не отправляй весь bundle вслепую.

`reviewUrl` открывает точную задачу. Если MCP App не поддерживается, покажи
гидратированное редактируемое предложение и спроси то же явное решение
publish/apply/dismiss. Не превращай proposal молча в прямое изменение.

<a id="continue-ordinary-actions"></a>

## Продолжи обычные действия

Передавай native arguments один раз. Для `upload_attachment`/
`upload_knowledge_base_attachment` используй абсолютный `localFilePath`
лишь точного выбранного пользователем/созданного агентом файла; опускай
base64/size/hash. Page upload требует точный `pageSlug`, company owner/admin
и сохраняет текущую статью. Вставь возвращённый URL обычным revision-checked
обновлением страницы. Host приватно передаёт потоком, шифруя при необходимости.
При неоднозначности перечитай вложения до повторного ключа.
Архивные строки требуют точные include flags.

Для encrypted `download_attachment` прочитай `delivery=local-file` path
и metadata из `structuredContent`, исследуй лишь нужное содержимое файла.
Host создаёт приватную копию владельца до 24 MiB вне mirror/Git с size/SHA-256
и `expiresAt`. При живом host очистка через час, иначе при следующем локальном
скачивании. Постоянные материалы сохраняй лишь в разрешённом Workspace.
Не кодируй и не возвращай скачанные bytes через MCP.
Успех хранит полные данные один раз в `structuredContent`; текстовый `content`
– краткий указатель. Скрытые App metadata и каждое решение человека независимы.

<a id="fail-closed"></a>

## При нарушении условий остановись

Локальные unlock и развёртывание выполняет bridge. Не проси ключ шифрования
в chat, MCP arguments, shell input, environment, stdin, clipboard или Workspace.
При `access_pending` останови содержательную работу до разрешения показанного
устройства владельцем. Не подменяй server search, plaintext cache, browser
scraping, другим connector или самодельным HTTP.

Mirror generations на диске зашифрованы company scope key. Открытые Workspace
файлы существуют лишь в приватных временных каталогах владельца и удаляются
до возврата поискового документа в память. Не меняй mirror и `.trelio/**`.
Открытая generation/индекс никогда не сохраняются и истекают через 600 секунд.
Read-only snapshot не является Run: его нельзя менять, checkpoint или submit.
