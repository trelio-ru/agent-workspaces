<a id="agent-procedures"></a>

# Процедуры агентов

Полностью прочитай файл до поиска, исполнения, создания или изменения Agent
Procedure. Процедура – project-scoped Markdown-инструкция для повторяемой
работы, а не расписание, очередь или отдельный runtime.

## Найди и исполни опубликованную процедуру

Когда запрос правдоподобно покрывает повторяемый процесс или подключённый
сервис, один раз вызови `search_agent_guidance` с точной компанией, проектом,
кратким пересказом задачи и полезными hints. Ответ объединяет `kind=procedure`
и `kind=skill`; отдельного skill-only поиска нет.

Для выбранного `kind=procedure` вызови exact `get_agent_procedure`. Исполняй
только возвращённую immutable published revision. Draft, история и discussion
не являются инструкциями и в agent read не входят. Выполняй шаги в текущей
задаче пользователя или в явно открытом Agent Run; сама процедура ничего не
запускает в фоне.

`requiredSkills` и `secretBindings` – зависимости, а не встроенные копии.
Перед первым внешним действием загрузи каждый exact skill через
`get_agent_skill` и дополнительно прочитай `external-services.md`. Значение
Agent Secret не проси и не передавай в prompt/MCP: используй exact Secret ID и
binding key только через protected flow из `agent-secrets.md`. Недоступная
зависимость – явный blocker, а не разрешение заменить её другой.

## Создай или измени draft

Агентский authoring всегда двухшаговый:

1. Вызови `plan_agent_procedure_change` с `create_draft`, `update_draft` или
   `request_review`. Для draft передай полную replacement-версию Markdown,
   search terms, exact skill IDs и exact Agent Secret IDs без значений.
2. Покажи пользователю точный preview и `planHash`. До отдельного явного
   подтверждения ничего не применяй.
3. После подтверждения вызови `apply_agent_procedure_change` с неизменёнными
   `plan` и `planHash`. При неоднозначном transport-результате не строй новый
   plan с новым `clientRequestId`, пока не установлен исход предыдущей попытки.

Apply создаёт только draft либо request for review. Агент никогда не публикует,
не архивирует, не восстанавливает процедуру и не принимает модераторское
решение. Подтверждение draft-плана пользователем не означает публикацию:
модератор отдельно проверяет exact revision в Trelio и может отредактировать её
перед публикацией; история сохраняет исходного автора и всех редакторов.

Для encrypted company следуй только server-selected local context/action
route. Plaintext процедуры, query, snippets и значения секретов не отправляй
на backend и не заменяй локальный flow прямым native вызовом.
