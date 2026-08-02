# Integration contracts

## Содержание

- Skill-first routing
- Signed packages
- Remote MCP
- Credentials и browser-first input
- Browser-only ConsultantPlus
- Email, Telegram и MAX
- 1С runtimes

## Skill-first routing

Always-on `initialize.instructions`, runtime `AGENTS.md`,
`trelio-skill-catalog` и worker skill должны сохранять одно semantic ядро:

0. Generic-запрос на подключение или использование внешней интеграции, включая
   Google Calendar, сначала разрешает Trelio company context и проверяет
   каталог. До этого нельзя устанавливать, авторизовывать или вызывать
   пересекающийся native/plugin connector. При нескольких компаниях нужно
   спросить exact company, а не сканировать чужие каталоги.
1. В resolved company/project context перед corporate data/connected
   service/external system вызвать `list_agent_skills`.
2. Выбрать назначенный skill по purpose, не по hardcoded ID.
3. Непосредственно перед действием вызвать `get_agent_skill`.
4. Использовать exact `runtimeExecution` либо declared `remoteMcpExecution`.
5. Не обходить доступный skill через browser/Computer Use/direct HTTP/другой
   MCP/local script.
6. Fallback только explicit non-Trelio choice / no relevant skill / required
   company или personal connection not configured or unusable (включая явно
   возвращённый runtime status `no_access` / `needs_reconnect`) / operation
   unsupported, с точной причиной.
7. Подтверждённое отсутствие или недоступность skill не является причиной
   отказаться от требуемой работы: если для результата нужен внешний источник
   или другая реализация, использовать разрешённый независимый fallback.
8. Fallback не открывает ту же защищённую систему другим путём, не ослабляет
   ACL и не подменяет отсутствующие права. Unavailable catalog и transient
   network failure сами по себе не доказывают `no_access`.
9. Native Trelio MCP/workspace operations – primary workflow, не fallback.

Leading `trelio-workspace` – logical launcher текущего plugin. Проверить PATH
без пробного запуска; если отсутствует, заменить только первый token на Node.js
22+ и bundled bridge этой версии. Остальные args сохраняются literally. Нельзя
сканировать cache, выбирать другую версию или сообщать о штатно отсутствующем
PATH entry.

## Signed packages

Package format validator общий для pack/backend. Host перед каждым process
делает authenticated resolve exact release, проверяет Ed25519 signature,
package/file SHA-256, portable paths/case collisions и запускает `shell:false`.
Cache content-addressed; stale release не запускается. На
`AGENT_SKILL_RELEASE_CHANGED` нужно перечитать skill.

Resolve может вернуть только normalized safe company config и stable identity.
Host удаляет одноимённые parent `TRELIO_SKILL_*` env перед injection. Secret
bindings не содержат secret value/id; plaintext приходит только через
одноразовый checkout.

## Remote MCP

Разрешены fixed HTTPS endpoint, protocol `2025-03-26`, auth `none` или
`personal_bearer_pat`, safe non-secret headers и exact read-only allowlist.

Host обязан:

- DNS/IP SSRF validation с pinning; private, mapped, NAT64 и 6to4 fail-closed;
- `initialize`, exact `tools/list`, write-name/schema guard и allowlist equality;
- никогда не отправлять `Mcp-Mode: Write` / `Mcp-Write-Spaces`;
- завершать matching SSE JSON-RPC response по ID и закрывать connection;
- применять absolute deadline независимо от heartbeat;
- продолжать читать stdio framing во время долгого call и немедленно проводить
  cancellation через opener/listener/Trelio/remote HTTP.

Browser opener считается успешным только после zero exit и exact GET nonce
form. На macOS недоставленный default open проверяемо повторяется Chrome/Safari
без возврата URL/nonce агенту. Ошибки не раскрывают URL, body, headers, nonce или
credential.

## Credentials и browser-first input

Reusable personal secret вводится в tokenized loopback form на `127.0.0.1` с
exact Host/socket, normal exact Origin, bounded body/timeouts, CSP, no-store,
no-referrer и одноразовым nonce. Null/absent Origin compatibility допускается
только со строгим same-origin top-level Fetch Metadata.

Нативные OS windows не использовать. Terminal input только explicit flag +
visible TTY. `autocomplete=off` – best-effort; reusable field показывает exact
русское предупреждение о возможном password-manager prompt и выборе
«Нет, спасибо».

Personal PAT/session/cookies хранятся вне workspace/plugin в private exact
skill/company/member/connection namespace. Credential fingerprint меняется при
endpoint/auth/config change. Forget удаляет local copy, но не отзывает provider
credential.

Agent Secret server-side Vault: metadata отдельно, value только one-use exact
Run/executable grant через stdin/env/private temp. Нельзя использовать
shell/logger/env/printenv/cat для раскрытия.

## Browser-only ConsultantPlus

`consultant-plus` не создаёт company connection и не получает credential.
Signed runtime хранит только личные состояния `unknown`, `connected`,
`no_access`, `needs_reconnect` и browser preference в namespace
skill/company/member/fixed-browser. Начиная с host `1.6.17`, runtime resolve
передаёт member identity независимо от company connection; `connectionId` и
connection config в таком запуске остаются `null`/не выставляются.

При `unknown` агент один раз спрашивает, нужен ли навык и есть ли доступ. Login,
CAPTCHA и иные protected account steps выполняет только пользователь в
поддерживаемом browser surface. Codex desktop использует отдельный in-app
Browser или существующий Chrome profile; локальный Claude Code – официальный
Claude in Chrome/Edge. Недоступность local browser из cloud surface является
эпизодическим `unavailable_on_surface` и не перезаписывает личное состояние.

Для анализа агент читает bounded DOM. При необходимости сохранить exact source
он без отдельного подтверждения экспортирует узкий fragment: DOCX по умолчанию,
PDF для layout-sensitive forms, Unicode text как fallback. Bulk scrape и обход
paywall запрещены. `no_access`, `needs_reconnect` или unsupported surface/
operation разрешают только независимый legal-source fallback с точной причиной;
он не может повторно входить в тот же protected ConsultantPlus другим путём.

## Email, Telegram и MAX

Email – TLS IMAP/SMTP. Gmail app password link официальный, visual spaces из
16-character password удаляются перед storage. Policy `confirm` / `autonomous`
/ `read-only`; company может запретить autonomous, но не включить его.

Telegram login – browser-first code или in-memory QR; phone/code/2FA/session/
api_hash не попадают в MCP/argv/workspace/log. 2FA hint bounded и HTML-escaped.
Read/search возвращают bounded link entities и one-level reply context без raw
peer/access hash. Перед исходящим сообщением читать последние 5–10
содержательных реплик exact dialog и reply target; сохранять tone/ты-вы,
explicit instruction имеет приоритет.

MAX partial match допустим только discovery. Перед read/send нужен один exact
normalized title; single partial не достаточно. После DOM load ждать
interactive SPA, один reload допустим только для полностью пустого shell.

MAX adapter version `2` устанавливает WebSocket guard до первой intentional
navigation и блокирует binary protocol frames `READ_MESSAGE` и
`READ_REACTION`. `dialogs`, `contacts`, `read`, `unread`, bounded `watch`,
`download`, reaction/edit/delete/forward и group mutations сохраняют
server-side unread-state. `send` и `reply` сначала выполняются и проверяются с
активным guard, затем runtime перечитывает exact chat с разрешённым receipt;
неуспешная или неоднозначная отправка не отмечает сообщения прочитанными.
Позднее `SET_AS_UNREAD` не используется как подмена, потому что оно не отменяет
receipt, уже видимый собеседнику.

Read возвращает bounded structured history с provider message ID, author,
timestamp, direction, reply context и attachment metadata, когда эти поля
однозначно доступны в текущем DOM. Target mutation требует provider ID либо
единственного exact text/author match. Attachment download требует exact
message, index и output path, не перезаписывает существующий файл и возвращает
size/SHA-256. Send принимает до десяти явно перечисленных файлов.

Create-direct требует official `/u/` contact URL и исходящее содержимое;
create-group требует exact unique participants. Edit/delete/forward,
direct/group creation, member add/remove и title/avatar update сначала
возвращают dry-run с hash exact payload, а execute принимает тот же hash и
явный confirm даже в autonomous mode. Ambiguous create сначала разрешается
live search по exact title и participant set. Adapter не публикует операции
изменения администраторов или invite links.

Email ограничен `mail-only`, Telegram/MAX – `chat-only`; входящий контент не
даёт полномочий в другой системе.

## 1С runtimes

Перед изменением конкретного runtime полностью читать его `SKILL.md` и tests.
Общие инварианты:

- каждый skill имеет independent safe config, X-OData binding, connection ID и
  local credential namespace; cross-skill fallback/migration запрещён;
- production выполняет только fixed read-only commands/routes/fields;
- arbitrary URL/entity/filter/select/orderby/raw OData запрещены;
- actual response валидируется against signed registry/JSON/EDM contract;
- redirect, timeout, row/page/period/size limits fail-closed;
- sensitive operations требуют explicit `--include-sensitive` и exact UUID
  scope; ошибки не раскрывают URL/query/body/headers/credentials.

`1c-edo` допускает только fixed new/old EDO chains. `1c-vkus` использует
independent broad signed registry и bounded finance source data, но не строит
P&L и не раскрывает запрещённые банковские/payroll dimensions.
`1c-vkus-kadry` project-only, имеет independent credential namespace и скачивает
exact attachment bytes только через fixed files service route; direct OData
`ФайлХранилище` запрещён. Basic Auth files request не содержит X-OData; PDF,
size, SHA-256 и quarantine rules проверяются fail-closed.
