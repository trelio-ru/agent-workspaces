import asyncio
import http.client
import importlib.util
import json
import os
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
    def test_bootstrap_installs_portable_iana_timezone_data(self):
        """Keep named export timezones available on Windows as well as POSIX."""

        self.assertIn("tzdata>=2025.2,<2027", MODULE.RUNTIME_PYTHON_PACKAGES)

    def identity(self):
        return MODULE.Identity(
            company_id="11111111-1111-1111-1111-111111111111",
            member_id="22222222-2222-2222-2222-222222222222",
            connection_id="33333333-3333-3333-3333-333333333333",
        )

    def export_args(self, **overrides):
        """Build a complete export namespace while keeping each test focused."""

        values = {
            "chat": ["work_chat"],
            "all_dialogs": False,
            "since": "2026-07-27",
            "until": "2026-08-03",
            "timezone": "Europe/Moscow",
            "chat_type": "any",
            "dialog_limit": 500,
            "per_chat_limit": 2_000,
            "scan_limit": 10_000,
            "total_message_limit": 10_000,
            "max_output_bytes": 1_048_576,
            "chronological": False,
            "include_links": False,
            "json": True,
        }
        values.update(overrides)
        return SimpleNamespace(**values)

    def telegram_message(self, message_id, date, text="Сообщение"):
        """Return the allowlisted message shape used by export regressions."""

        return SimpleNamespace(
            id=message_id,
            date=date,
            out=False,
            sender=None,
            message=text,
            entities=[],
            media=None,
            file=None,
            reply_to_msg_id=None,
            reply_to=None,
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

    def test_api_hash_checkout_initializes_private_local_cache(self):
        with tempfile.TemporaryDirectory() as temporary:
            with mock.patch.dict(
                MODULE.os.environ,
                {
                    "TRELIO_CONFIG_HOME": temporary,
                    MODULE.API_HASH_ENV: "A" * 32,
                },
                clear=True,
            ):
                self.assertEqual(MODULE.require_api_hash(self.identity()), "a" * 32)
                self.assertNotIn(MODULE.API_HASH_ENV, MODULE.os.environ)
                path = MODULE.api_hash_path(self.identity())
                self.assertEqual(path.read_text(encoding="utf-8"), ("a" * 32) + "\n")
                if os.name == "posix":
                    self.assertEqual(path.stat().st_mode & 0o777, 0o600)
                    self.assertEqual(path.parent.stat().st_mode & 0o777, 0o700)

            with mock.patch.dict(
                MODULE.os.environ,
                {"TRELIO_CONFIG_HOME": temporary},
                clear=True,
            ):
                self.assertEqual(MODULE.require_api_hash(self.identity()), "a" * 32)

    def test_api_hash_checkout_replaces_cached_company_value(self):
        with tempfile.TemporaryDirectory() as temporary:
            with mock.patch.dict(
                MODULE.os.environ,
                {
                    "TRELIO_CONFIG_HOME": temporary,
                    "TRELIO_CACHE_HOME": temporary,
                    MODULE.API_HASH_ENV: "a" * 32,
                },
                clear=True,
            ):
                MODULE.require_api_hash(self.identity())
            with mock.patch.dict(
                MODULE.os.environ,
                {
                    "TRELIO_CONFIG_HOME": temporary,
                    MODULE.API_HASH_ENV: "b" * 32,
                },
                clear=True,
            ):
                self.assertEqual(MODULE.require_api_hash(self.identity()), "b" * 32)
                self.assertEqual(
                    MODULE.api_hash_path(self.identity()).read_text(encoding="utf-8"),
                    ("b" * 32) + "\n",
                )

    def test_api_hash_requires_one_checkout_when_cache_is_missing(self):
        with tempfile.TemporaryDirectory() as temporary:
            with mock.patch.dict(
                MODULE.os.environ,
                {
                    "TRELIO_CONFIG_HOME": temporary,
                    "TRELIO_CACHE_HOME": temporary,
                },
                clear=True,
            ):
                with self.assertRaisesRegex(MODULE.TelegramRuntimeError, "not cached"):
                    MODULE.require_api_hash(self.identity())

    @unittest.skipUnless(os.name == "posix", "POSIX permission regression")
    def test_api_hash_cache_rejects_group_or_world_access(self):
        with tempfile.TemporaryDirectory() as temporary:
            with mock.patch.dict(
                MODULE.os.environ,
                {
                    "TRELIO_CONFIG_HOME": temporary,
                    MODULE.API_HASH_ENV: "a" * 32,
                },
                clear=True,
            ):
                MODULE.require_api_hash(self.identity())
                MODULE.api_hash_path(self.identity()).chmod(0o644)
            with mock.patch.dict(
                MODULE.os.environ,
                {"TRELIO_CONFIG_HOME": temporary},
                clear=True,
            ):
                with self.assertRaisesRegex(MODULE.TelegramRuntimeError, "expected 600"):
                    MODULE.require_api_hash(self.identity())

    def test_doctor_reports_and_initializes_api_hash_cache_without_revealing_value(self):
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
                "doctor",
            ]
        )
        with tempfile.TemporaryDirectory() as temporary:
            with mock.patch.dict(
                MODULE.os.environ,
                {
                    "TRELIO_CONFIG_HOME": temporary,
                    "TRELIO_CACHE_HOME": temporary,
                    MODULE.API_HASH_ENV: "a" * 32,
                },
                clear=True,
            ):
                result = MODULE.command_doctor(args)
                self.assertTrue(result["apiHashDelivered"])
                self.assertTrue(result["apiHashCached"])
                self.assertTrue(result["apiHashAvailable"])
                self.assertNotIn("a" * 32, json.dumps(result))

            with mock.patch.dict(
                MODULE.os.environ,
                {
                    "TRELIO_CONFIG_HOME": temporary,
                    "TRELIO_CACHE_HOME": temporary,
                },
                clear=True,
            ):
                result = MODULE.command_doctor(args)
                self.assertFalse(result["apiHashDelivered"])
                self.assertTrue(result["apiHashCached"])
                self.assertTrue(result["apiHashAvailable"])

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
        self.assertIn('<form id="prompt-form" autocomplete="off">', page)
        self.assertIn('type="${inputType}" autocomplete="off"', page)
        self.assertIn("Сохранять данные в браузере не нужно", page)
        self.assertIn("подключение будет сохранено отдельно на этом устройстве", page)
        self.assertNotIn('autocomplete="one-time-code"', page)
        self.assertNotIn('autocomplete="tel"', page)
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

    def test_public_entity_serializes_exact_and_coarse_last_activity_without_guessing(self):
        UserStatusOffline = type("UserStatusOffline", (), {})
        offline = UserStatusOffline()
        offline.was_online = datetime(2026, 8, 20, 12, 30, tzinfo=timezone.utc)
        exact = MODULE.public_entity(
            SimpleNamespace(
                id=17,
                first_name="Илья",
                last_name="Крылов",
                username="ilya",
                status=offline,
            )
        )
        self.assertEqual(
            exact["lastActivity"],
            {
                "kind": "offline",
                "exact": True,
                "lastSeenAt": "2026-08-20T12:30:00Z",
            },
        )

        for telegram_type, expected_kind in (
            ("UserStatusRecently", "recently"),
            ("UserStatusLastWeek", "last_week"),
            ("UserStatusLastMonth", "last_month"),
        ):
            status = type(telegram_type, (), {})()
            # Telegram may expose a by_me privacy hint on coarse statuses. It
            # must not be promoted to a guessed date or leaked as raw state.
            status.by_me = True
            payload = MODULE.public_entity(
                SimpleNamespace(
                    id=18,
                    first_name="Мария",
                    last_name=None,
                    username=None,
                    status=status,
                )
            )
            self.assertEqual(
                payload["lastActivity"],
                {"kind": expected_kind, "exact": False},
            )
            self.assertNotIn("by_me", json.dumps(payload))

    def test_public_entity_keeps_online_expiry_and_fails_closed_for_unknown_status(self):
        UserStatusOnline = type("UserStatusOnline", (), {})
        online = UserStatusOnline()
        online.expires = 1_777_777_777
        payload = MODULE.public_entity(
            SimpleNamespace(
                id=19,
                first_name="Олег",
                last_name=None,
                username="oleg",
                status=online,
            )
        )
        self.assertEqual(payload["lastActivity"]["kind"], "online")
        self.assertTrue(payload["lastActivity"]["exact"])
        self.assertRegex(payload["lastActivity"]["expiresAt"], r"Z$")

        unknown = MODULE.public_entity(
            SimpleNamespace(
                id=20,
                first_name="Новая версия",
                last_name=None,
                username=None,
                status=type("UserStatusFuture", (), {"raw": "private"})(),
            )
        )
        self.assertNotIn("lastActivity", unknown)
        self.assertNotIn("private", json.dumps(unknown))

    def test_phone_lookup_requires_one_normalized_international_number(self):
        self.assertEqual(
            MODULE.normalize_phone_lookup("＋7 (999) 000-00-00"),
            "79990000000",
        )
        for invalid in (
            "89990000000",
            "+01234",
            "+7 999 000 00 00 доб. 5",
            "+1234",
            "+1234567890123456",
        ):
            with self.subTest(invalid=invalid):
                with self.assertRaises(MODULE.TelegramRuntimeError) as raised:
                    MODULE.normalize_phone_lookup(invalid)
                self.assertNotIn(invalid, str(raised.exception))

    def test_phone_lookup_rate_limit_persists_only_a_timestamp(self):
        with tempfile.TemporaryDirectory() as temporary, mock.patch.dict(
            MODULE.os.environ,
            {"TRELIO_CONFIG_HOME": temporary},
            clear=True,
        ), mock.patch.object(
            MODULE.time,
            "time",
            side_effect=[100.0, 101.0, 103.0],
        ), mock.patch.object(MODULE.time, "sleep") as sleep:
            self.assertEqual(MODULE.reserve_resolve_phone_slot(self.identity()), 0.0)
            self.assertEqual(MODULE.reserve_resolve_phone_slot(self.identity()), 2.0)
            state_path = MODULE.resolve_phone_rate_state_path(self.identity())
            state = json.loads(state_path.read_text(encoding="utf-8"))

        sleep.assert_called_once()
        self.assertAlmostEqual(sleep.call_args.args[0], 2.0)
        self.assertEqual(
            state,
            {
                "schemaVersion": MODULE.RESOLVE_PHONE_RATE_STATE_VERSION,
                "lastAttemptAt": 103.0,
            },
        )
        self.assertNotIn("phone", json.dumps(state).lower())

    def test_resolve_phone_returns_only_allowlisted_user_and_last_activity(self):
        class ResolvePhoneRequest:
            def __init__(self, phone):
                self.phone = phone

        class PhoneNotOccupiedError(Exception):
            pass

        UserStatusOffline = type("UserStatusOffline", (), {})
        status = UserStatusOffline()
        status.was_online = datetime(2026, 8, 20, 15, 45, tzinfo=timezone.utc)
        user = SimpleNamespace(
            id=42,
            first_name="Анна",
            last_name="Иванова",
            username="anna",
            phone="+79990000000",
            access_hash=987654321,
            status=status,
        )
        response = SimpleNamespace(
            peer=SimpleNamespace(user_id=42, access_hash=987654321),
            users=[user],
            chats=[],
        )

        class FakeClient:
            def __init__(self):
                self.requests = []
                self.disconnect = mock.AsyncMock()

            async def __call__(self, request):
                self.requests.append(request)
                return response

        client = FakeClient()
        args = SimpleNamespace(phone="+7 (999) 000-00-00")
        with mock.patch.object(
            MODULE,
            "import_telethon_phone_resolver",
            return_value=(ResolvePhoneRequest, PhoneNotOccupiedError),
        ), mock.patch.object(
            MODULE,
            "build_client",
            return_value=client,
        ), mock.patch.object(
            MODULE,
            "ensure_authorized",
            new=mock.AsyncMock(),
        ), mock.patch.object(MODULE, "reserve_resolve_phone_slot", return_value=0.0):
            result = asyncio.run(
                MODULE.command_resolve_phone_async(args, self.identity())
            )

        self.assertEqual(client.requests[0].phone, "79990000000")
        self.assertEqual(
            result,
            {
                "found": True,
                "user": {
                    "id": 42,
                    "title": "Анна Иванова",
                    "username": "anna",
                    "lastActivity": {
                        "kind": "offline",
                        "exact": True,
                        "lastSeenAt": "2026-08-20T15:45:00Z",
                    },
                },
                "securityBoundary": "chat-only",
            },
        )
        serialized = json.dumps(result)
        for forbidden in ("79990000000", "phone", "access_hash", "987654321"):
            self.assertNotIn(forbidden, serialized)
        client.disconnect.assert_awaited_once()

    def test_resolve_phone_reports_private_or_missing_without_raw_rpc_details(self):
        class ResolvePhoneRequest:
            def __init__(self, phone):
                self.phone = phone

        class PhoneNotOccupiedError(Exception):
            pass

        class FakeClient:
            def __init__(self, error):
                self.error = error
                self.disconnect = mock.AsyncMock()

            async def __call__(self, _request):
                raise self.error

        common_patches = (
            mock.patch.object(
                MODULE,
                "import_telethon_phone_resolver",
                return_value=(ResolvePhoneRequest, PhoneNotOccupiedError),
            ),
            mock.patch.object(
                MODULE,
                "ensure_authorized",
                new=mock.AsyncMock(),
            ),
            mock.patch.object(MODULE, "reserve_resolve_phone_slot", return_value=0.0),
        )

        private_client = FakeClient(PhoneNotOccupiedError())
        with common_patches[0], common_patches[1], common_patches[2], mock.patch.object(
            MODULE,
            "build_client",
            return_value=private_client,
        ):
            result = asyncio.run(
                MODULE.command_resolve_phone_async(
                    SimpleNamespace(phone="+79990000000"),
                    self.identity(),
                )
            )
        self.assertEqual(result["reason"], "not_found_or_private")
        self.assertFalse(result["found"])
        self.assertNotIn("79990000000", json.dumps(result))

        ambiguous_client = FakeClient(
            RuntimeError("raw RPC failure for +79990000000 access_hash=secret")
        )
        with mock.patch.object(
            MODULE,
            "import_telethon_phone_resolver",
            return_value=(ResolvePhoneRequest, PhoneNotOccupiedError),
        ), mock.patch.object(
            MODULE,
            "ensure_authorized",
            new=mock.AsyncMock(),
        ), mock.patch.object(
            MODULE,
            "reserve_resolve_phone_slot",
            return_value=0.0,
        ), mock.patch.object(MODULE, "build_client", return_value=ambiguous_client):
            with self.assertRaises(MODULE.TelegramRuntimeError) as raised:
                asyncio.run(
                    MODULE.command_resolve_phone_async(
                        SimpleNamespace(phone="+79990000000"),
                        self.identity(),
                    )
                )
        self.assertNotIn("79990000000", str(raised.exception))
        self.assertNotIn("access_hash", str(raised.exception))

    def test_resolve_phone_parser_accepts_exactly_one_phone_argument(self):
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
                "resolve-phone",
                "--phone",
                "+79990000000",
            ]
        )
        self.assertEqual(args.command, "resolve-phone")
        self.assertEqual(args.phone, "+79990000000")

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

    def test_export_parser_supports_alias_and_requires_one_selection_mode(self):
        base = [
            "--company-id",
            self.identity().company_id,
            "--member-id",
            self.identity().member_id,
            "--connection-id",
            self.identity().connection_id,
            "--api-id",
            "12345",
        ]
        for command in ("export", "daily-export"):
            args = MODULE.build_parser().parse_args(
                base
                + [
                    command,
                    "--chat",
                    "finance",
                    "--chat",
                    "legal",
                    "--since",
                    "2026-07-27",
                    "--until",
                    "2026-08-03",
                    "--chronological",
                    "--json",
                ]
            )
            self.assertEqual(args.command, command)
            self.assertEqual(args.chat, ["finance", "legal"])
            self.assertTrue(args.chronological)

        with self.assertRaises(SystemExit):
            MODULE.build_parser().parse_args(
                base
                + [
                    "export",
                    "--since",
                    "2026-07-27",
                    "--until",
                    "2026-08-03",
                ]
            )

    def test_export_period_uses_moscow_for_naive_boundaries(self):
        zone, since, until = MODULE.export_period(self.export_args())

        self.assertEqual(str(zone), "Europe/Moscow")
        self.assertEqual(since.isoformat(), "2026-07-26T21:00:00+00:00")
        self.assertEqual(until.isoformat(), "2026-08-02T21:00:00+00:00")
        with self.assertRaisesRegex(MODULE.TelegramRuntimeError, "earlier"):
            MODULE.export_period(
                self.export_args(since="2026-08-03", until="2026-08-03")
            )

    def test_export_is_half_open_uses_until_cursor_and_can_be_chronological(self):
        class Channel:
            id = 42
            title = "Финансы"
            username = "finance"
            megagroup = True
            broadcast = False

        entity = Channel()
        messages = [
            self.telegram_message(4, datetime(2026, 8, 2, 21, 0, tzinfo=timezone.utc)),
            self.telegram_message(3, datetime(2026, 8, 2, 12, 0, tzinfo=timezone.utc), "Позже"),
            self.telegram_message(
                2,
                datetime(2026, 7, 26, 21, 0, tzinfo=timezone.utc),
                "На границе",
            ),
            self.telegram_message(1, datetime(2026, 7, 26, 20, 59, tzinfo=timezone.utc)),
        ]

        class FakeClient:
            def __init__(self):
                self.disconnect = mock.AsyncMock()
                self.iter_messages_kwargs = None

            async def get_entity(self, reference):
                self.reference = reference
                return entity

            def iter_messages(self, selected, **kwargs):
                self.iter_messages_kwargs = kwargs

                async def iterate():
                    for message in messages:
                        yield message

                return iterate()

        client = FakeClient()
        args = self.export_args(chronological=True)
        with mock.patch.object(MODULE, "build_client", return_value=client), mock.patch.object(
            MODULE,
            "ensure_authorized",
            new=mock.AsyncMock(),
        ):
            result = asyncio.run(MODULE.command_export_async(args, self.identity()))

        self.assertEqual(
            client.iter_messages_kwargs["offset_date"].isoformat(),
            "2026-08-02T21:00:00+00:00",
        )
        self.assertIsNone(client.iter_messages_kwargs["limit"])
        self.assertEqual([item["id"] for item in result["chats"][0]["messages"]], [2, 3])
        self.assertEqual(result["message_count"], 2)
        self.assertEqual(result["scanned_count"], 4)
        self.assertTrue(result["chats"][0]["stopped_older_than_since"])
        self.assertFalse(result["chats"][0]["incomplete"])
        self.assertEqual(
            result["period"]["semantics"],
            "since <= message.date < until",
        )
        client.disconnect.assert_awaited_once()

    def test_export_reports_per_chat_and_scan_limits_as_incomplete(self):
        class Chat:
            id = 77
            title = "Юристы"
            username = None

        entity = Chat()
        messages = [
            self.telegram_message(
                message_id,
                datetime(2026, 7, 30, 12, message_id, tzinfo=timezone.utc),
            )
            for message_id in (3, 2, 1)
        ]

        class FakeClient:
            disconnect = mock.AsyncMock()

            async def get_entity(self, _reference):
                return entity

            def iter_messages(self, _selected, **_kwargs):
                async def iterate():
                    for message in messages:
                        yield message

                return iterate()

        for limit_name, expected_reason in (
            ("per_chat_limit", "per_chat_limit"),
            ("scan_limit", "scan_limit"),
        ):
            client = FakeClient()
            overrides = {limit_name: 2}
            with mock.patch.object(MODULE, "build_client", return_value=client), mock.patch.object(
                MODULE,
                "ensure_authorized",
                new=mock.AsyncMock(),
            ):
                result = asyncio.run(
                    MODULE.command_export_async(
                        self.export_args(**overrides),
                        self.identity(),
                    )
                )

            chat = result["chats"][0]
            self.assertTrue(chat["incomplete"])
            self.assertIn(expected_reason, chat["incomplete_reasons"])
            self.assertEqual(chat["message_count"], 2)
            self.assertEqual(len(result["incomplete_chats"]), 1)

    def test_export_has_global_message_and_output_byte_caps(self):
        class Channel:
            def __init__(self, entity_id, title):
                self.id = entity_id
                self.title = title
                self.username = None
                self.megagroup = True
                self.broadcast = False

        first = Channel(1, "Первый")
        second = Channel(2, "Второй")
        large_messages = [
            self.telegram_message(
                message_id,
                datetime(2026, 7, 30, 12, 0, tzinfo=timezone.utc),
                "я" * MODULE.MAX_READ_TEXT_CHARS,
            )
            for message_id in range(1, 45)
        ]

        class FakeClient:
            def __init__(self):
                self.disconnect = mock.AsyncMock()

            def iter_dialogs(self, **_kwargs):
                async def iterate():
                    yield SimpleNamespace(entity=first)
                    yield SimpleNamespace(entity=second)

                return iterate()

            def iter_messages(self, entity, **_kwargs):
                async def iterate():
                    for message in large_messages if entity is first else []:
                        yield message

                return iterate()

        client = FakeClient()
        args = self.export_args(
            chat=None,
            all_dialogs=True,
            total_message_limit=40,
            max_output_bytes=1_048_576,
        )
        with mock.patch.object(MODULE, "build_client", return_value=client), mock.patch.object(
            MODULE,
            "ensure_authorized",
            new=mock.AsyncMock(),
        ):
            result = asyncio.run(MODULE.command_export_async(args, self.identity()))

        self.assertTrue(result["hit_output_byte_limit"])
        self.assertTrue(result["hit_total_message_limit"])
        self.assertIn("output_byte_limit_reached", result["warnings"])
        self.assertIn("total_message_limit_reached", result["warnings"])
        self.assertLess(result["message_count"], 40)
        self.assertLessEqual(
            MODULE.compact_json_bytes({"ok": True, **result}),
            args.max_output_bytes,
        )
        self.assertNotIn("linkEntities", result["chats"][0]["messages"][0])
        self.assertTrue(result["chats"][0]["incomplete"])

    def test_export_strips_only_structured_links_when_not_requested(self):
        payload = {
            "text": "https://example.com",
            "linkEntities": [{"url": "https://example.com"}],
            "linkEntitiesTruncated": False,
            "replyContext": {
                "text": "источник",
                "linkEntities": [{"url": "https://docs.example"}],
                "linkEntitiesTruncated": False,
                "quoteLinkEntities": [{"url": "https://docs.example"}],
                "quoteLinkEntitiesTruncated": False,
            },
        }

        stripped = MODULE.export_message_without_links(payload)

        self.assertEqual(stripped["text"], "https://example.com")
        self.assertEqual(stripped["replyContext"]["text"], "источник")
        self.assertNotIn("linkEntities", stripped)
        self.assertNotIn("quoteLinkEntities", stripped["replyContext"])


if __name__ == "__main__":
    unittest.main()
