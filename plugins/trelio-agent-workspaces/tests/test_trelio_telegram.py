import asyncio
import importlib.util
import json
import pathlib
import sys
import tempfile
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
