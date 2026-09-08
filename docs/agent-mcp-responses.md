# Ответы MCP для агента

Локальный host сокращает известные Trelio DTO после расшифровки тем же
переносимым контрактом, что и native MCP. Обычные API/browser DTO и данные
MCP App не изменяются. Поля пользовательских документов не удаляются
рекурсивно по имени.

- У известных людей/авторов исключены `avatarUrl`, `initials`, `color`.
  Effective имя, отличающееся исходное имя, непустой `profileNote`, ID,
  roles/permissions, presence, `null` и `false` сохраняются. Неизвестное
  поле человека сохраняет исходный объект до классификации.
- Mutation возвращает актуальное состояние, revisions, эффекты, replayed,
  comments/checklists/controls и followUp. Производный `document.text`
  исключается только при полном task/document locator. Большой справочник
  может заменяться `deferredData` с именами полей и точным read-only вызовом.
  После переноса задачи read hint указывает новый проект/номер; повторная
  mutation ради подробностей запрещена. Короткие справочники остаются,
  когда дополнительный hint увеличил бы ответ.
- У `get_contact`, `get_registry`, `get_knowledge_base_page`,
  `get_project_meta`, `get_task_create_meta`, `list_recent_activity` и
  `list_agent_skills` параметр `responseDetail=full` возвращает полный DTO.
  Эти arguments передаются без изменений через `native_read`. Для задач
  сохраняется schema v3 и `get_task_sections`, без монолитного fallback.
  Registry values/technical rows/provenance и ошибки не откладываются.
- Каталог навыков сохраняет purpose, routing, assignment, readiness, trust
  и requirements; полный Markdown/manifest/connection schema читается через
  exact `get_agent_skill` перед использованием.
- Workspace overview может содержать `runSnapshots.entries` и
  `runs[].snapshotRefs`. Это полные снимки внутри одного ответа, а не cache:
  каждый Run сохраняет свои pinned правила и их revision. Различные authority
  fields не объединяются и не заменяются текущими инструкциями.
- Успешный JSON не дублируется в `content`/`structuredContent`. File text
  удаляется только из доказанной второй копии; revision, coverage, диапазоны,
  hash и media остаются. Errors, самостоятельный текст и hidden `_meta`
  сохраняются. Проекция не запускается над arbitrary provider JSON.

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

`trelio-mcp-results.test.mjs` проверяет локальную выдачу и сохранение смысла,
а `report:context-budget` считает токены и bytes отдельно от постоянных
instructions/schemas. Экономия каталога/справочника условна: последующее полное
чтение возвращает стоимость его содержимого.
