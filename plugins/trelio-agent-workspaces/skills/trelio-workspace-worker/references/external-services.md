<a id="connected-services-and-agent-skills"></a>

# Подключённые сервисы и Agent Skills

Полностью прочитай файл до использования подключённого сервиса, внешней
системы, назначенного Agent Skill, Remote MCP или подписанного runtime.
Native-чтения Trelio, discovery и управляющие операции Workspace этой проверки
каталога не требуют.

<a id="select-the-current-skill"></a>

## Выбери текущий навык

1. В точной компании/проекте вызови `search_agent_skills` с задачей и краткими
   hints; `list_agent_skills` оставь для явной инвентаризации.
2. До первого внешнего действия сессии один раз вызови `get_agent_skill`.
   Переиспользуй полный текст и точную execution declaration между ходами
   до 12 часов при неизменных company/project, skill, implementation и intent.
   Перечитай при новой сессии, потере/compaction текста, через 12 часов,
   смене маршрута/контекста, снятии setup/access blocker или один раз при
   `AGENT_SKILL_RELEASE_CHANGED`. Не читай перед каждой подкомандой.
   Admission cache принадлежит доверенному host; не меняй и не продлевай его.
3. Допуск host действует максимум 12 часов без продления. Отзыв вступает
   в силу при обновлении; проверка package и Remote MCP policy обязательны.
4. Используй точные `runtimeExecution`/`remoteMcpExecution` выбранного навыка.
   Не обходи рабочий маршрут браузером, Computer Use, HTTP, другим MCP или скриптом.

При `setup_required`, `no_access` или `needs_reconnect` навыка/company/
personal connection сообщи о текущей недоступности, назови необходимое действие
и останови запрос данных. Вне формального `integrationRouting` другой
источник допустим лишь после объяснения блокировки и явного выбора пользователя.
Недоступность каталога/control plane, timeout, временная/неизвестная ошибка
не доказывают отсутствие навыка или доступа.

<a id="follow-formal-routing-exactly"></a>

## Соблюдай точную маршрутизацию

При `integrationRouting` используй только текущие поля; не выводи маршрут
из skill IDs, названий, порядка, прежнего использования или имени инструмента.

- В `family` используй единственный включённый элемент либо точные
  `role`, `primarySkillId`, `selectionRule`, `priority`.
- Переходи лишь к точному `fallbackSkillId` после установленной выбранной
  реализацией причины из её `fallbackWhen`.
- Не переноси assignment, connection, credential, local session или policy
  между навыками.
- Отсутствующие/повреждённые/несогласованные metadata, недоступность control
  plane, timeout, временная/неизвестная ошибка и
  `ambiguousMutationFallback: forbidden` не разрешают fallback или автоповтор.
  Сначала установи реальный результат либо спроси пользователя.

При `AGENT_SKILL_RELEASE_CHANGED` перечитай выбранный навык один раз до
повтора; не форсируй старый релиз.

<a id="execute-the-typed-local-action"></a>

## Исполни структурированное локальное действие

Для подписанного runtime вызови точные server/tool из
`runtimeExecution.localAction` с возвращёнными аргументами. В
`parameters.arguments` добавляй лишь разрешённые текущими инструкциями
аргументы навыка. Не меняй identity, release, runtime-session и другие поля.
Локальный dispatcher выбирает bridge загруженного плагина и Node без shell/PATH.

Для старого `runtimeExecution.command` прочитай `setup-and-recovery.md`
и используй ограниченную совместимость. Не ищи PATH и не сканируй cache.
