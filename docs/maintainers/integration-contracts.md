# Integration contracts

## Содержание

- Skill-first routing
- Signed packages
- Remote MCP
- Credentials и browser-first input
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
5. Не обходить browser/Computer Use/direct HTTP/другим MCP/local script.
6. Fallback только explicit non-Trelio choice / no relevant skill / required
   connection not configured / operation unsupported, с точной причиной.
7. Unavailable catalog – control-plane failure, не отсутствие интеграции.
8. Native Trelio MCP/workspace operations – primary workflow, не fallback.

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
