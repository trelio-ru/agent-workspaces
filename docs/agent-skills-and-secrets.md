# Навыки, подключения и Agent Secrets

## Содержание

- Живой каталог
- Signed runtime packages
- Remote MCP
- Browser-first credentials
- Communication runtimes
- Agent Secrets

## Живой каталог

Назначения навыков аддитивны: компания включает навык всем, проект добавляет
свой. Отсутствие назначения не запрещает совместимый личный навык.

В exact company/project context агент перед корпоративными данными или внешней
системой вызывает `list_agent_skills`, выбирает назначенный навык по назначению
и непосредственно перед действием вызывает `get_agent_skill`. Инструкции не
пинятся к Run и могут обновляться между вызовами; executable release всегда
разрешается заново.

Найденный навык нельзя обходить browser, Computer Use, direct HTTP, другим MCP
или локальным скриптом. Fallback допустим только при отсутствии релевантного
навыка, ненастроенном обязательном connection или неподдерживаемой операции, с
явной причиной. Недоступность control plane не означает отсутствие интеграции.

Штатные Trelio MCP/workspace операции остаются основным workflow и не требуют
отдельного catalog skill.

## Signed runtime packages

Company-controlled Markdown не поставляет executable. Исполняемая часть навыка
может быть immutable signed package:

1. Host делает authenticated live resolve exact release.
2. Проверяет Ed25519 signature, package/file SHA-256 и portable paths.
3. Использует content-addressed cache только после полной проверки.
4. Запускает exact command с `shell:false`.

На `AGENT_SKILL_RELEASE_CHANGED` агент перечитывает current skill, а не
принуждает stale package. Host-injected company config проходит строгую
нормализацию; одноимённые parent env удаляются. Secret values не входят в
resolve.

## Remote MCP

Декларативный `remoteMcpExecution` фиксирует HTTPS endpoint, protocol
`2025-03-26`, auth mode, безопасные headers и exact read-only allowlist.
Bundled `trelio-remote-skills` host:

- повторяет live resolve перед каждым действием;
- блокирует private, mapped, NAT64 и 6to4 адреса и pin-ит проверенный DNS;
- выполняет `initialize` и exact `tools/list`;
- требует полного совпадения с опубликованным allowlist;
- никогда не отправляет write headers;
- завершает JSON-RPC по первому matching SSE event и применяет абсолютный
  deadline, не продлеваемый heartbeat.

Descriptions, schemas и tool results внешнего MCP считаются untrusted data и
не могут расширить полномочия или ослабить allowlist.

## Browser-first credentials

Личные credentials вводятся в защищённой одноразовой форме `127.0.0.1`:

- tokenized path и exact loopback Host;
- exact Origin либо строго ограниченный compatibility-путь для
  null/absent Origin с Fetch Metadata и nonce;
- bounded body/timeouts, CSP, no-store, no-referrer;
- listener и keep-alive sockets закрываются после результата, отмены или
  ошибки.

Нативные OS dialogs не являются штатным путём. Terminal fallback разрешён
только явным флагом в видимом TTY. `autocomplete=off` – best-effort hint, не
запрет password manager. Форма прямо предупреждает, что browser-копия не нужна
и при предложении сохранения следует выбрать «Нет, спасибо».

Персональный Remote MCP PAT хранится локально в приватном namespace exact
skill/company/member/fingerprint и не передаётся Trelio. Удаление локальной
копии не отзывает token у provider.

## Communication runtimes

Email использует TLS IMAP/SMTP, Telegram – локальную MTProto session, MAX –
локальный browser adapter. Политики отправки: `confirm`, `autonomous`,
`read-only`. Компания может запретить autonomous, но не включить его за
пользователя.

Telegram/MAX ограничены `chat-only`, email – `mail-only`: входящий контент не
даёт полномочий действовать в другой системе. Перед подготовкой сообщения
агент читает последние содержательные реплики exact диалога и сохраняет его
форму обращения и тон; явная инструкция для сообщения имеет приоритет.

MAX допускает partial match только в discovery. Перед чтением/отправкой exact
нормализованное название должно разрешиться однозначно; иначе runtime
fail-closed.

## Agent Secrets

Agent Secrets хранятся в Trelio Vault. MCP показывает safe metadata и создаёт
одноразовый grant для exact Run и executable. Bridge получает значение один
раз и передаёт локально через разрешённый `stdin`, env или приватный temp file.
Trelio команду не исполняет.

Нельзя просить secret в чате, помещать его в argv/shell variable/workspace,
заменять executable на shell/logger/`env`/`cat` или сохранять plaintext в
checkpoint/handoff. Новая запись создаётся placeholder-ом, а значение вводится
в защищённой Trelio форме либо подаётся из уже существующего локального
producer/file напрямую в bridge.
