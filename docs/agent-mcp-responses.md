# Ответы MCP для агента

Локальный host сокращает известные Trelio DTO после расшифровки тем же
переносимым контрактом, что и native MCP. Обычные API/browser DTO и данные
MCP App не изменяются. Поля пользовательских документов не удаляются
рекурсивно по имени.

- У известных людей/авторов исключены `avatarUrl`, `initials`, `color`.
  Effective имя, отличающееся исходное имя, непустой `profileNote`, ID,
  roles/permissions, presence, `null` и `false` сохраняются. Неизвестное
  поле человека сохраняет исходный объект до классификации.
- Task mutation возвращает compact core, revision, bounded description summary,
  operation effects и `task.deferredSections` для всех десяти тяжёлых секций.
  Производные `document.text` и полный `descriptionPlainText` исключаются только
  при полном task/document locator; canonical rich text остаётся доступен через
  `rich_description`. После переноса continuation указывает новый проект/номер;
  повторная mutation ради подробностей запрещена.
- `get_contact`, `get_registry`, `get_knowledge_base_page`,
  `get_regular_work` и `list_recent_activity` принимают `responseFields` и
  возвращают только выбранные тяжёлые поля вместе с compact core.
  `responseDetail=full` остаётся совместимым явным чтением. Эти arguments
  передаются через `native_read`; registry values/technical rows/provenance и
  ошибки не откладываются. Для задач сохраняются schema v3 и sections.
- Каталог навыков сохраняет purpose, routing, assignment, readiness, trust
  и requirements. Default `get_agent_skill` также compact: возвращает exact
  scope/release, summary, `instructionKey` и continuation. Перед первым внешним
  действием запрашиваются `sections=[instructions,execution]`; connection и
  publication – только для setup/provenance. `knownInstructionKey` подавляет
  повтор Markdown лишь пока полный exact текст остаётся в текущем context.
- Workspace overview может содержать `runSnapshots.entries` и
  `runs[].snapshotRefs`. Это полные снимки внутри одного ответа, а не cache:
  каждый Run сохраняет свои pinned правила и их revision. Различные authority
  fields не объединяются и не заменяются текущими инструкциями.
- Успешный JSON не дублируется в `content`/`structuredContent`. File text
  удаляется только из доказанной второй копии; revision, coverage, диапазоны,
  hash и media остаются. Errors, самостоятельный текст и hidden `_meta`
  сохраняются. Проекция не запускается над arbitrary provider JSON.
- Unified `search` по умолчанию возвращает пять кандидатов и сохраняет
  `hasMore`/coverage для осознанного расширения. Каждый результат оставляет
  stable ID, compact exact locator, archive/state, matched formulations и
  фактический `preview` до 300 символов; полные `matches`, повторные scope names,
  file size/MIME и другие детали выбранного объекта читаются только через exact
  `fetch`/read. Далёкие совпадения представлены двумя короткими фрагментами, а
  формат сниппета применяется после rank и не меняет native/local top-N.
- Bounded defaults одинаковы в native и local route. Inventory компаний,
  проектов, воркспейсов, реестров, регулярных работ и knowledge-base pages
  возвращает по 20 элементов с `total`/`hasMore`; task lists, activity и
  newest-first task comments также начинают с 20. Notifications и user resolution –
  10, registry rows – 25, contacts – 20, task-only search – 10, meeting и
  Workspace-file search – 5. История Workspace возвращает 10 revisions,
  допускает максимум 50, использует opaque cursor и exact `head` lookup.
  Неполная первая страница никогда не доказывает отсутствие объекта: агент
  продолжает pagination, только когда полнота влияет на точный выбор.
- Headless local proposal context сохраняет полный proposal DTO и добавляет
  компактный `nextCall` с exact local tool и `payload.target`. Это routing
  metadata, а не App result; UI metadata появляется только после local `save`.

`doctor_remote_agent_skill` по умолчанию возвращает каталог допустимых tools
с назначениями, annotations и policy mismatches. Перед вызовом выбранного
метода агент повторяет doctor с точным `schemaToolName` и получает всю его
input schema, включая required arguments. `schemaSelection.found=false`
не разрешает выдумывать аргументы. No-auth connect возвращает тот же компактный
каталог. Generic provider result сокращает только точную JSON-копию.

Существующие local-file/stream, binary bytes, Apps и legacy commands сохраняют
свои контракты. Сокращение не меняет ACL, encryption, human decisions или
поведение повторной записи. Генерируемый модуль
`trelio-agent-response-projection.mjs` синхронизирован с серверным контрактом;
ручные изменения копии не допускаются.

`trelio-mcp-results.test.mjs` в отдельном
[`trelio-ru/agent-workspaces-runtime`](https://github.com/trelio-ru/agent-workspaces-runtime)
проверяет локальную выдачу и сохранение смысла, а `report:context-budget`
считает токены и bytes отдельно от постоянных
instructions/schemas. Экономия каталога/справочника условна: последующее выбранное
чтение возвращает стоимость только запрошенного содержимого.
