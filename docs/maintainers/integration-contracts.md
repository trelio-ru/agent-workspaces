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

0. Generic-запрос на подключение или использование внешней интеграции сначала
   разрешает Trelio company context и проверяет каталог. До этого нельзя
   устанавливать, авторизовывать или вызывать пересекающийся native/plugin
   connector. При нескольких компаниях нужно спросить exact company, а не
   сканировать чужие каталоги. При отсутствии подходящего навыка применяется
   обычный personal-connector fallback.
1. В resolved company/project context перед connected service/external system
   вызвать `list_agent_skills`. Native Trelio reads, task discovery и Agent
   Workspace control plane не требуют catalog gate.
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

Telegram имеет формальный двухтранспортный routing поверх общего purpose
выбора. Если назначен только один из `telegram-mtproto` / `telegram-web`,
используется он. Если назначены оба, lower numeric priority выбирает
`telegram-mtproto` primary `100` перед `telegram-web` secondary `200` независимо
от порядка catalog rows. Secondary допустим только после exact
`not_configured`, `no_access`, `needs_reconnect` или `unsupported_operation`
primary. Недоступность catalog/control plane, timeout, transient/unknown error
и ambiguous mutation outcome не являются fallback: сначала устанавливается
live-результат либо пользователь решает, нужен ли повтор. Assignments,
connections, local sessions, consent и policy двух навыков независимы.

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
Host не передаёт signed runtime ambient shell/workspace environment: до
`spawn` он строит явный allowlist OS path, locale, proxy и Trelio config/cache
roots, удаляя dynamic-loader/interpreter hooks, ambient credentials и stale
`TRELIO_SKILL_*`. Затем exact skill/company/member/connection identity и
normalized config добавляются только из свежего authenticated resolve. Сам
runtime повторно санитизирует environment каждого browser/opener/bootstrap
child process. Secret bindings не содержат secret value/id; plaintext приходит
только через одноразовый checkout.

Host-authored `PATH` состоит из директории exact `process.execPath` и fixed OS
roots, а не из ambient first-hit. `interpreter=python` разрешает canonical
fixed Python 3.10+ вне workspace/temp/plugin cache и запускает entrypoint через
`-I -B`: user site/`.pth` и ambient Python hooks выключены, но signed runtime
root явно добавлен для sibling imports. `executable` получает тот же safe PATH
и `PYTHONNOUSERSITE` / `PYTHONSAFEPATH` как defense для signed shebang.

Это fixed-path/startup-isolation, а не отдельная OS security boundary. Host
отклоняет group/world-writable executable и world-writable canonical ancestor
chain, но user-owned installation (например Homebrew или nvm), включая обычный
group-writable Homebrew Cellar, локальный browser, plugin/runtime cache, профили
и credential storage остаются machine trust roots. Активный процесс под тем же
OS user может читать или менять доступные этому пользователю файлы и память;
защита от такого противника требует запуска в отдельном OS account/system
sandbox всего Node/Python/browser stack. Нельзя описывать одну canonical-
проверку Python как защиту от same-user malware.

Consumed Agent Secret не возвращается через ambient parent environment. Когда
grant закреплён за logical executable `trelio-workspace` и exact command
`skill run`, текущий bridge без nested re-exec передаёт только одно server-
returned env/file/stdin значение ровно одному заново resolved signed runtime.
Grant binding не может переопределить `TRELIO_SKILL_*`, config/cache roots или
другой host-owned context; file delivery удаляется в исходном `finally`.

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

Telegram MTProto `api_hash` остаётся company Agent Secret в Trelio, но не
checkout-ится перед каждой командой. Первый exact runtime invocation с
`TRELIO_TELEGRAM_API_HASH` атомарно сохраняет нормализованное значение в
`credentials/api_hash` внутри того же private
skill/company/member/connection namespace; каталог и runtime никогда не
возвращают его модели. При наличии валидного regular файла текущего OS owner с
mode `0600` runtime использует local copy без нового checkout. При отсутствии
файла `doctor` показывает `apiHashCached=false`, после чего разрешён ровно один
обычный checkout текущего Agent Run; явно доставленное новое значение заменяет
старую копию. Каталожный `get_agent_skill` и live runtime resolve остаются
обязательными: cache убирает повторную secret delivery, но не проверку текущих
assignment, connection и release.

Agent Secret поддерживает per-container immutable storage mode. `trelio`
хранит safe schema отдельно от encrypted immutable JSON bundle;
`local_device` хранит на сервере только schema/version/field keys и attestation
exact paired session, а private JSON остаётся в
`workspace-bridge/agent-secrets/<origin-hash>/<member>/<secret>/` вне
workspace/Git. One-use grant связан с exact version/field set/Run/executable и,
для local mode, attestation/session; multi-field stdin/private temp получает
JSON, env требует exact mapping, а TOTP delivery получает derived code, не
seed. Нельзя использовать shell/logger/env/printenv/cat для раскрытия.

Company-level `storagePolicy` управляет только созданием новых карточек и
возвращается `list_agent_secrets` для exact scope. MCP creation всегда требует
явный `storageMode`: `prefer_trelio` выбирает Trelio без прямого local-запроса,
`contextual` выбирает local только для personal/interactive/single-device,
Trelio для shared/multi-device/unattended и спрашивает при неоднозначности,
`local_only` разрешает только local и проверяется backend. Политика не меняет
immutable mode существующих карточек.

Local write делает безопасный preflight до чтения input, затем idempotent
prepare, atomic private-file replace и idempotent confirm. Значение и digest не
отправляются Trelio. На новый компьютер переносится только подкаталог
`agent-secrets/`, без credentials/device-session; после отдельного pairing он
переподтверждается только внутри активного Run через `secret adopt`. Source
attestation должна соответствовать current origin/member/secret/version. Новое
подтверждение заменяет старое, но remote revoke/delete не обещает удалить
offline bytes.

Bridge `secret set` без format-флага остаётся legacy scalar transport и не
пытается распознать JSON по содержимому. Атомарная локальная запись нескольких
именованных полей требует exact `--format fields-json`: stdin/file содержит
один JSON-объект с 1–50 нормализуемыми field keys и только string/null values,
а bridge отправляет backend-у `values`, не `value`. Ошибки парсинга не включают
исходные bytes. Нельзя автоматически трактовать JSON-подобный scalar как bundle
или разносить одну связанную учётную запись по отдельным secret records ради
обхода transport.

Browser fill имеет только автоматический режим. MCP закрепляет grant за exact
Run, bundled bridge и ordered steps с exact URL hash/origin и bounded mapping
каждого fieldKey к selector; plaintext path/query в БД и audit не хранится.
Один grant всегда создаёт один Target/window/tab/profile: все поля страницы
заполняются общим preflight, а следующая страница продолжает тот же browser
session. Ноль или несколько совпадений, hidden/read-only/disabled field, iframe
и незакреплённая смена URL/origin fail-closed завершают весь flow без второго
окна или fallback. Universal browser tool, clipboard, secret values в argv,
stdout и read-back запрещены.

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

Видимый browser surface является только временным handoff для входа,
переавторизации, CAPTCHA, passkey/OTP, принятия условий и других обязательных
действий пользователя. После проверки authenticated search/document page
агент сразу скрывает или сворачивает Codex Browser side panel либо перестаёт
выводить внешний browser на передний план, не закрывая exact tab/profile/session.
Обычные search/navigation/bounded DOM/export/download verification продолжаются
в фоне в той же сессии. Повторно показывать browser только для exact действия
пользователя и снова убирать после его успешного завершения; показ прогресса
сам по себе не является причиной держать или открывать browser.

Для анализа агент читает bounded DOM. При необходимости сохранить exact source
он без отдельного подтверждения экспортирует узкий fragment: DOCX по умолчанию,
PDF для layout-sensitive forms, Unicode text как fallback. Bulk scrape и обход
paywall запрещены. `no_access`, `needs_reconnect` или unsupported surface/
operation разрешают только независимый legal-source fallback с точной причиной;
он не может повторно входить в тот же protected ConsultantPlus другим путём.

Каждый substantive Agent Workspace result, основанный на ConsultantPlus,
обязан содержать durable source files всех документов и exact fragments,
которые materially поддерживают вывод, рекомендацию, дату, цитату или сравнение
редакций. Сохраняется минимальный полный original provider export; exploratory
results, просмотренные, но не использованные документы, лишние главы и bulk
corpus не сохраняются. Material ConsultantPlus commentary сохраняется отдельно
и маркируется как commentary, а не primary legal source. При невозможности
exact export используется самый узкий доступный export либо Unicode fallback с
явной фиксацией ограничения. Эти материалы остаются в authorized Workspace и
не становятся task-comment attachments без обычного proposal/access flow.

## Email, Telegram и MAX

Email – TLS IMAP/SMTP. Gmail app password link официальный, visual spaces из
16-character password удаляются перед storage. Policy `confirm` / `autonomous`
/ `read-only`; company может запретить autonomous, но не включить его.

Telegram login – browser-first code или in-memory QR; phone/code/2FA/session/
api_hash не попадают в MCP/argv/workspace/log. `api_hash` после первого
one-use checkout хранится локально private рядом с MTProto session и повторно
не запрашивается, пока cache-файл существует. 2FA hint bounded и HTML-escaped.
Read/search возвращают bounded author/date/link entities, model-bound
attachment metadata и one-level reply context без `inputPeer`, `access_hash`,
file reference и другого capability-bearing peer material. Нормализованный
safe-integer opaque `peerId` допустим только как
exact routing/disambiguation identifier, не содержит access hash и для Saved
Messages заменяется semantic identifier; raw current-account user ID также не
возвращается как author PeerId в обычном чате, вместо него используется
semantic `self`. Account-specific public result и
mutation preview Telegram Web всегда показывают canonical `accountSlot` 1–4,
не раскрывая raw account user ID/digest. `export` и совместимый alias
`daily-export` читают точный
полуоткрытый период `since <= message.date < until`: naive границы получают
явную IANA timezone (`Europe/Moscow` по умолчанию), а `until` передаётся
Telethon как server-side history cursor. Массовое чтение требует exact
повторяемых `--chat` либо bounded `--all-dialogs`, фильтра broad chat type,
per-chat/scan/global-message/JSON-byte limits и явных incomplete reasons для
каждого достигнутого ограничения. Именно в MTProto export вложения остаются
только метаданными, а структурированные ссылки включаются opt-in. Telegram Web
`read` / `search`, напротив, всегда возвращают bounded `linkEntities` и
bounded безопасные attachment metadata в общем message artifact. Перед обычным исходящим сообщением или
file-caption читать последние 5–10 содержательных реплик exact dialog и reply
target; сохранять tone/ты-вы, explicit instruction имеет приоритет. Узкое
исключение – captionless document в собственные Saved Messages, включая
release E2E: для него нельзя читать несвязанную self-history только ради этого
tone-правила.

Title-only Telegram Web discovery удаляет control/bidi символы из bounded
display title и показывает title, opaque PeerId как отдельный code literal и
`accountSlot` раздельно; display sanitizer никогда не преобразует сам PeerId.

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
