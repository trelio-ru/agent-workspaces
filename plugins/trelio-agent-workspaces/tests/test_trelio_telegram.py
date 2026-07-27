import asyncio
import http.client
import importlib.util
import json
import pathlib
import sys
import tempfile
import threading
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest import mock


SCRIPT_PATH = pathlib.Path(__file__).parents[1] / "scripts" / "trelio-telegram.py"
SPEC = importlib.util.spec_from_file_location("trelio_telegram", SCRIPT_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class TrelioTelegramTests(unittest.TestCase):
    def identity(self):
        return MODULE.Identity(
            company_id="11111111-1111-1111-1111-111111111111",
            member_id="22222222-2222-2222-2222-222222222222",
            connection_id="33333333-3333-3333-3333-333333333333",
        )

    def test_default_policy_requires_confirmation(self):
        with mock.patch.object(MODULE, "policy_path", return_value=pathlib.Path("/missing/policy.json")):
            self.assertEqual(MODULE.load_policy(self.identity()), {"sendMode": "confirm"})
            with self.assertRaisesRegex(MODULE.TelegramRuntimeError, "--confirm"):
                MODULE.assert_send_allowed(
                    self.identity(),
                    confirmed=False,
                    company_allows_autonomous=True,
                )

    def test_read_only_policy_blocks_confirmed_send(self):
        with mock.patch.object(MODULE, "load_policy", return_value={"sendMode": "read-only"}):
            with self.assertRaisesRegex(MODULE.TelegramRuntimeError, "read-only"):
                MODULE.assert_send_allowed(
                    self.identity(),
                    confirmed=True,
                    company_allows_autonomous=True,
                )

    def test_autonomous_policy_obeys_company_ceiling(self):
        with mock.patch.object(MODULE, "load_policy", return_value={"sendMode": "autonomous"}):
            self.assertEqual(
                MODULE.assert_send_allowed(
                    self.identity(),
                    confirmed=False,
                    company_allows_autonomous=True,
                ),
                "autonomous",
            )
            with self.assertRaisesRegex(MODULE.TelegramRuntimeError, "company connection"):
                MODULE.assert_send_allowed(
                    self.identity(),
                    confirmed=False,
                    company_allows_autonomous=False,
                )

    def test_local_root_uses_stable_identity_and_not_workspace(self):
        with tempfile.TemporaryDirectory() as temporary:
            with mock.patch.dict(MODULE.os.environ, {"TRELIO_CONFIG_HOME": temporary}):
                root = MODULE.connection_root(self.identity())
        self.assertIn("telegram-mtproto", str(root))
        self.assertIn(self.identity().company_id, str(root))
        self.assertNotIn(".trelio", str(root))

    def test_api_hash_is_accepted_only_from_environment(self):
        with mock.patch.dict(MODULE.os.environ, {}, clear=True):
            with self.assertRaisesRegex(MODULE.TelegramRuntimeError, "Agent Secret checkout"):
                MODULE.require_api_hash()
        with mock.patch.dict(
            MODULE.os.environ,
            {MODULE.API_HASH_ENV: "a" * 32},
            clear=True,
        ):
            self.assertEqual(MODULE.require_api_hash(), "a" * 32)

    def test_login_defaults_to_browser_method_choice(self):
        args = MODULE.build_parser().parse_args(
            [
                "--company-id",
                self.identity().company_id,
                "--member-id",
                self.identity().member_id,
                "--connection-id",
                self.identity().connection_id,
                "--api-id",
                "12345",
                "login",
            ]
        )
        with mock.patch.object(
            MODULE,
            "prompt_choice",
            return_value=MODULE.LOGIN_METHOD_QR,
        ) as prompt:
            method = MODULE.login_method_for_args(args)

        self.assertEqual(method, MODULE.LOGIN_METHOD_QR)
        prompt.assert_called_once()
        self.assertFalse(prompt.call_args.kwargs["terminal_prompts"])

    def test_browser_prompt_page_contains_same_page_qr_and_security_copy(self):
        page = MODULE.browser_prompt_app_page().decode("utf-8")

        self.assertIn("Trelio Telegram", page)
        self.assertIn('data.status === "qr"', page)
        self.assertIn("Подсказка Telegram:", page)
        self.assertIn("escapeHtml(data.hint)", page)
        self.assertIn("Telegram: Настройки", page)
        self.assertIn("Сканируйте QR только из приложения Telegram", page)
        self.assertIn('type="button" data-cancel="1"', page)
        self.assertNotIn("Vkus Telegram", page)

    def test_password_hint_is_normalized_and_bounded_for_local_display(self):
        hint = "  первая\n\tвторая  " + ("я" * 400)

        normalized = MODULE.normalize_telegram_password_hint(hint)

        self.assertTrue(normalized.startswith("первая вторая "))
        self.assertNotIn("\n", normalized)
        self.assertNotIn("\t", normalized)
        self.assertEqual(len(normalized), MODULE.MAX_PASSWORD_HINT_CHARS)
        self.assertEqual(MODULE.normalize_telegram_password_hint(None), "")

    def test_password_hint_read_failure_does_not_block_login(self):
        class GetPasswordRequest:
            pass

        client = mock.AsyncMock(side_effect=RuntimeError("raw Telegram diagnostic"))

        hint = asyncio.run(MODULE.telegram_password_hint(client, GetPasswordRequest))

        self.assertEqual(hint, "")
        client.assert_awaited_once()

    def test_password_hint_is_read_from_telegram_password_state(self):
        class GetPasswordRequest:
            pass

        client = mock.AsyncMock(
            return_value=SimpleNamespace(hint="  первая\n\tвторая  "),
        )

        hint = asyncio.run(MODULE.telegram_password_hint(client, GetPasswordRequest))

        self.assertEqual(hint, "первая вторая")
        self.assertIsInstance(client.await_args.args[0], GetPasswordRequest)

    def test_browser_hint_is_not_forwarded_to_terminal_fallback(self):
        with mock.patch.object(
            MODULE,
            "ensure_browser_prompt_session",
            side_effect=MODULE.BrowserPromptUnavailable("no browser"),
        ), mock.patch.object(
            MODULE,
            "prompt_value_terminal",
            return_value="password",
        ) as terminal_prompt:
            value = MODULE.prompt_value(
                "Пароль 2FA Telegram",
                hidden=True,
                browser_hint="локальная подсказка",
            )

        self.assertEqual(value, "password")
        self.assertNotIn("browser_hint", terminal_prompt.call_args.kwargs)
        self.assertNotIn("локальная подсказка", str(terminal_prompt.call_args))

    def test_code_login_passes_telegram_hint_only_to_browser_prompt(self):
        class SessionPasswordNeededError(Exception):
            pass

        class GetPasswordRequest:
            pass

        client = SimpleNamespace(
            send_code_request=mock.AsyncMock(
                return_value=SimpleNamespace(phone_code_hash="phone-code-hash"),
            ),
            sign_in=mock.AsyncMock(side_effect=[SessionPasswordNeededError(), None]),
        )
        args = SimpleNamespace(terminal_prompts=False)
        with mock.patch.object(
            MODULE,
            "prompt_value",
            side_effect=["+79990000000", "12345", "correct horse"],
        ) as prompt, mock.patch.object(
            MODULE,
            "telegram_password_hint",
            new=mock.AsyncMock(return_value="девичья фамилия"),
        ):
            asyncio.run(
                MODULE.authorize_with_code_login(
                    client,
                    args,
                    SessionPasswordNeededError,
                    GetPasswordRequest,
                )
            )

        password_prompt = prompt.call_args_list[2]
        self.assertEqual(password_prompt.args, ("Пароль 2FA Telegram",))
        self.assertEqual(password_prompt.kwargs["browser_hint"], "девичья фамилия")
        self.assertEqual(client.sign_in.await_count, 2)

    def test_qr_login_passes_telegram_hint_only_to_browser_prompt(self):
        class SessionPasswordNeededError(Exception):
            pass

        class GetPasswordRequest:
            pass

        qr_login = SimpleNamespace(
            expires=datetime.now(timezone.utc).replace(year=2099),
            url="tg://login?token=private",
            wait=mock.AsyncMock(side_effect=SessionPasswordNeededError()),
            recreate=mock.AsyncMock(),
        )
        client = SimpleNamespace(
            qr_login=mock.AsyncMock(return_value=qr_login),
            sign_in=mock.AsyncMock(),
        )
        args = SimpleNamespace(
            terminal_prompts=False,
            qr_timeout=30,
            qr_refresh_seconds=25,
            qr=False,
        )
        browser_session = SimpleNamespace(
            show_qr=mock.Mock(),
            clear_qr=mock.Mock(),
        )
        with mock.patch.object(MODULE, "import_qrcode", return_value=object()), mock.patch.object(
            MODULE,
            "qr_image_data_url",
            return_value="data:image/png;base64,private",
        ), mock.patch.object(
            MODULE,
            "ensure_browser_prompt_session",
            return_value=browser_session,
        ), mock.patch.object(
            MODULE,
            "BROWSER_PROMPT_SESSION",
            browser_session,
        ), mock.patch.object(
            MODULE,
            "prompt_value",
            return_value="correct horse",
        ) as prompt, mock.patch.object(
            MODULE,
            "telegram_password_hint",
            new=mock.AsyncMock(return_value="девичья фамилия"),
        ):
            asyncio.run(
                MODULE.authorize_with_qr_login(
                    client,
                    args,
                    SessionPasswordNeededError,
                    GetPasswordRequest,
                )
            )

        self.assertEqual(prompt.call_args.args, ("Пароль 2FA Telegram",))
        self.assertEqual(prompt.call_args.kwargs["browser_hint"], "девичья фамилия")
        client.sign_in.assert_awaited_once_with(password="correct horse")

    def test_macos_opener_uses_the_default_browser(self):
        completed = SimpleNamespace(returncode=0)
        with mock.patch.object(MODULE.sys, "platform", "darwin"), mock.patch.object(
            MODULE.subprocess,
            "run",
            return_value=completed,
        ) as run:
            MODULE.open_browser_url("http://127.0.0.1:1234/token/")

        self.assertEqual(
            run.call_args_list[0].args[0],
            ["/usr/bin/open", "http://127.0.0.1:1234/token/"],
        )

    def test_windows_opener_uses_the_default_browser(self):
        startfile = mock.Mock()
        with mock.patch.object(MODULE.sys, "platform", "win32"), mock.patch.object(
            MODULE.os,
            "startfile",
            startfile,
            create=True,
        ):
            MODULE.open_browser_url("http://127.0.0.1:1234/token/")
        startfile.assert_called_once_with("http://127.0.0.1:1234/token/")

    def test_loopback_prompt_requires_exact_origin_and_never_exposes_value_in_state(self):
        session = MODULE.BrowserPromptSession()
        session.opened = True
        received = []
        errors = []

        def ask():
            try:
                received.append(
                    session.ask(
                        "Код входа Telegram",
                        hidden=True,
                        hint="подсказка <локальная>",
                    )
                )
            except Exception as error:  # pragma: no cover - surfaced below.
                errors.append(error)

        worker = threading.Thread(target=ask)
        worker.start()
        try:
            with session.condition:
                ready = session.condition.wait_for(
                    lambda: session.current_prompt is not None,
                    timeout=2,
                )
                self.assertTrue(ready)
                prompt_id = session.current_prompt["id"]

            connection = http.client.HTTPConnection("127.0.0.1", session.port, timeout=2)
            connection.request("GET", f"{session.base_path}/state")
            state_response = connection.getresponse()
            state_payload = state_response.read().decode("utf-8")
            self.assertEqual(state_response.status, 200)
            self.assertNotIn("12345", state_payload)
            self.assertIn('"hidden": true', state_payload)
            self.assertIn("подсказка <локальная>", state_payload)
            connection.close()

            body = f"id={prompt_id}&value=12345"
            connection = http.client.HTTPConnection("127.0.0.1", session.port, timeout=2)
            connection.request(
                "POST",
                f"{session.base_path}/submit",
                body=body,
                headers={
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Origin": "https://attacker.example",
                },
            )
            rejected = connection.getresponse()
            rejected.read()
            self.assertEqual(rejected.status, 403)
            connection.close()

            connection = http.client.HTTPConnection("127.0.0.1", session.port, timeout=2)
            connection.request(
                "POST",
                f"{session.base_path}/submit",
                body=body,
                headers={
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Origin": session.origin,
                },
            )
            accepted = connection.getresponse()
            accepted.read()
            self.assertEqual(accepted.status, 200)
            connection.close()

            worker.join(timeout=2)
            self.assertFalse(worker.is_alive())
            self.assertEqual(errors, [])
            self.assertEqual(received, ["12345"])
            self.assertIsNone(session.response)
            self.assertIsNone(session.current_prompt)
        finally:
            session.close()

    def test_loopback_page_uses_no_store_csp_and_tokenized_path(self):
        session = MODULE.BrowserPromptSession()
        try:
            connection = http.client.HTTPConnection("127.0.0.1", session.port, timeout=2)
            connection.request("GET", f"{session.base_path}/")
            response = connection.getresponse()
            response.read()
            self.assertEqual(response.status, 200)
            self.assertEqual(response.getheader("Cache-Control"), "no-store")
            self.assertEqual(response.getheader("Referrer-Policy"), "no-referrer")
            self.assertIn("default-src 'none'", response.getheader("Content-Security-Policy"))
            connection.close()

            connection = http.client.HTTPConnection("127.0.0.1", session.port, timeout=2)
            connection.request("GET", "/state")
            rejected = connection.getresponse()
            rejected.read()
            self.assertEqual(rejected.status, 404)
            connection.close()
        finally:
            session.close()

    def test_login_hides_raw_telegram_rpc_diagnostics(self):
        client = SimpleNamespace(
            connect=mock.AsyncMock(),
            is_user_authorized=mock.AsyncMock(return_value=False),
            disconnect=mock.AsyncMock(),
        )
        args = SimpleNamespace(qr=False, code=True)
        with mock.patch.object(
            MODULE,
            "import_telethon",
            return_value=(object(), RuntimeError, object()),
        ), mock.patch.object(
            MODULE,
            "build_client",
            return_value=client,
        ), mock.patch.object(
            MODULE,
            "authorize_with_code_login",
            new=mock.AsyncMock(side_effect=RuntimeError("sensitive raw RPC detail")),
        ):
            with self.assertRaises(MODULE.TelegramRuntimeError) as raised:
                asyncio.run(MODULE.command_login_async(args, self.identity()))

        self.assertNotIn("sensitive raw RPC detail", str(raised.exception))
        self.assertIn("login", str(raised.exception))
        client.disconnect.assert_awaited_once()

    def test_public_entity_never_serializes_private_mtproto_fields(self):
        entity = SimpleNamespace(
            id=42017729,
            title="Рабочий чат",
            username="work_chat",
            phone="+79990000000",
            access_hash=123456789,
            peer=SimpleNamespace(user_id=42017729, access_hash=123456789),
            session="forbidden-session",
            api_hash="forbidden-api-hash",
        )

        payload = MODULE.public_entity(entity)
        serialized = json.dumps(payload)

        self.assertEqual(
            payload,
            {"id": 42017729, "title": "Рабочий чат", "username": "work_chat"},
        )
        for forbidden in ("phone", "access_hash", "peer", "session", "api_hash", "forbidden"):
            self.assertNotIn(forbidden, serialized)

    def test_link_entities_allowlist_and_utf16_offsets(self):
        class MessageEntityUrl:
            def __init__(self, offset, length):
                self.offset = offset
                self.length = length

        class MessageEntityTextUrl:
            def __init__(self, offset, length, url):
                self.offset = offset
                self.length = length
                self.url = url

        class MessageEntityBold:
            def __init__(self, offset, length):
                self.offset = offset
                self.length = length
                self.document_id = "must-not-leak"

        # Telegram offsets use UTF-16 code units, so the leading emoji counts
        # as two units and the URL begins at offset three.
        text = "😀 https://example.com источник"
        entities, truncated = MODULE.public_link_entities(
            text,
            [
                MessageEntityUrl(3, len("https://example.com")),
                MessageEntityTextUrl(23, len("источник"), "https://docs.example/source"),
                MessageEntityBold(23, len("источник")),
            ],
        )

        self.assertFalse(truncated)
        self.assertEqual(
            entities,
            [
                {
                    "type": "url",
                    "offset": 3,
                    "length": len("https://example.com"),
                    "text": "https://example.com",
                    "url": "https://example.com",
                    "textTruncated": False,
                    "urlTruncated": False,
                },
                {
                    "type": "text_url",
                    "offset": 23,
                    "length": len("источник"),
                    "text": "источник",
                    "url": "https://docs.example/source",
                    "textTruncated": False,
                    "urlTruncated": False,
                },
            ],
        )
        self.assertNotIn("document_id", json.dumps(entities))

    def test_link_entities_are_count_and_length_bounded(self):
        class MessageEntityTextUrl:
            def __init__(self, url):
                self.offset = 0
                self.length = 1
                self.url = url

        entities, truncated = MODULE.public_link_entities(
            "x",
            [
                MessageEntityTextUrl("https://example.com/" + ("a" * 5_000))
                for _ in range(MODULE.MAX_LINK_ENTITIES + 5)
            ],
        )

        self.assertTrue(truncated)
        self.assertEqual(len(entities), MODULE.MAX_LINK_ENTITIES)
        self.assertEqual(len(entities[0]["url"]), MODULE.MAX_LINK_URL_CHARS)
        self.assertTrue(entities[0]["urlTruncated"])

    def test_available_reply_context_includes_safe_quote_and_links_without_recursion(self):
        class MessageEntityTextUrl:
            def __init__(self, offset, length, url):
                self.offset = offset
                self.length = length
                self.url = url

        reply_sender = SimpleNamespace(
            id=17,
            first_name="Илья",
            last_name="Крылов",
            username="ilya",
            phone="+79990000000",
            access_hash=987654321,
        )
        reply_chat = SimpleNamespace(
            id=42017729,
            title="Рабочий чат",
            username=None,
            access_hash=111,
        )
        reply_message = SimpleNamespace(
            id=101,
            sender=reply_sender,
            chat=reply_chat,
            message="Штатный источник",
            entities=[
                MessageEntityTextUrl(
                    0,
                    len("Штатный источник"),
                    "https://docs.example/official",
                )
            ],
            # The quoted message itself has a reply, but public_reply_context
            # must serialize exactly one level and never call it.
            reply_to_msg_id=99,
            get_reply_message=mock.AsyncMock(
                side_effect=AssertionError("nested reply must not be resolved")
            ),
        )
        message = SimpleNamespace(
            id=102,
            date=datetime(2026, 7, 24, 12, 0, tzinfo=timezone.utc),
            out=False,
            sender=reply_sender,
            message="Вот штатный источник, пробовал?",
            entities=[],
            media=None,
            file=None,
            reply_to_msg_id=101,
            reply_to=SimpleNamespace(
                reply_to_msg_id=101,
                reply_to_peer_id=None,
                quote_text="Штатный источник",
                quote_entities=[
                    MessageEntityTextUrl(
                        0,
                        len("Штатный источник"),
                        "https://docs.example/official",
                    )
                ],
            ),
            get_reply_message=mock.AsyncMock(return_value=reply_message),
        )

        payload = asyncio.run(MODULE.public_messages([message], reply_chat))[0]
        reply = payload["replyContext"]

        self.assertEqual(reply["messageId"], 101)
        self.assertFalse(reply["unavailable"])
        self.assertEqual(reply["author"]["title"], "Илья Крылов")
        self.assertEqual(reply["chat"]["id"], 42017729)
        self.assertEqual(reply["text"], "Штатный источник")
        self.assertEqual(reply["quoteText"], "Штатный источник")
        self.assertEqual(
            reply["linkEntities"][0]["url"],
            "https://docs.example/official",
        )
        self.assertEqual(
            reply["quoteLinkEntities"][0]["url"],
            "https://docs.example/official",
        )
        self.assertEqual(
            payload["replyContext"]["linkEntities"][0]["type"],
            "text_url",
        )
        reply_message.get_reply_message.assert_not_called()
        serialized = json.dumps(payload)
        for forbidden in ("phone", "access_hash", "session", "api_hash"):
            self.assertNotIn(forbidden, serialized)

    def test_deleted_or_unavailable_reply_keeps_header_quote_safely(self):
        class MessageEntityUrl:
            def __init__(self, offset, length):
                self.offset = offset
                self.length = length

        current_chat = SimpleNamespace(
            id=42017729,
            title="Рабочий чат",
            username=None,
        )
        quote = "https://docs.example/deleted"
        message = SimpleNamespace(
            id=103,
            reply_to_msg_id=88,
            reply_to=SimpleNamespace(
                reply_to_msg_id=88,
                reply_to_peer_id=None,
                quote_text=quote,
                quote_entities=[MessageEntityUrl(0, len(quote))],
            ),
            get_reply_message=mock.AsyncMock(return_value=None),
        )

        reply = asyncio.run(MODULE.public_reply_context(message, current_chat))

        self.assertIsNotNone(reply)
        self.assertEqual(reply["messageId"], 88)
        self.assertTrue(reply["unavailable"])
        self.assertIsNone(reply["author"])
        self.assertEqual(reply["chat"]["id"], 42017729)
        self.assertEqual(reply["text"], quote)
        self.assertEqual(reply["linkEntities"][0]["url"], quote)
        self.assertEqual(reply["quoteLinkEntities"][0]["url"], quote)

    def test_cross_chat_unavailable_reply_does_not_guess_raw_peer(self):
        current_chat = SimpleNamespace(
            id=42017729,
            title="Рабочий чат",
            username=None,
        )
        message = SimpleNamespace(
            id=104,
            reply_to_msg_id=77,
            reply_to=SimpleNamespace(
                reply_to_msg_id=77,
                reply_to_peer_id=SimpleNamespace(
                    channel_id=123,
                    access_hash=456,
                ),
                quote_text=None,
                quote_entities=[],
            ),
            get_reply_message=mock.AsyncMock(
                side_effect=RuntimeError("raw RPC details must stay private")
            ),
        )

        reply = asyncio.run(MODULE.public_reply_context(message, current_chat))

        self.assertTrue(reply["unavailable"])
        self.assertIsNone(reply["chat"])
        self.assertNotIn("peer", json.dumps(reply))
        self.assertNotIn("RPC", json.dumps(reply))


if __name__ == "__main__":
    unittest.main()
