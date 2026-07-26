"""Security and protocol regressions for the signed 1C EDO runtime."""

from __future__ import annotations

import argparse
import importlib.util
import io
import json
import os
import sys
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).parents[1] / "scripts" / "trelio-1c-edo.py"
SPEC = importlib.util.spec_from_file_location("trelio_1c_edo", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)

COMPANY_ID = "11111111-1111-4111-8111-111111111111"
MEMBER_ID = "22222222-2222-4222-8222-222222222222"
CONNECTION_ID = "33333333-3333-4333-8333-333333333333"
DOCUMENT_ID = "44444444-4444-4444-8444-444444444444"
MESSAGE_ID = "55555555-5555-4555-8555-555555555555"
FILE_ID = "66666666-6666-4666-8666-666666666666"


def company_config(**overrides: object) -> dict[str, object]:
    return {
        "schemaVersion": 1,
        "odataBaseUrl": "https://example.test/taste/odata/standard.odata/",
        "filesBaseUrl": "https://example.test/taste/hs/files/",
        "maxRows": 50,
        "maxPages": 3,
        "maxFileBytes": 1024 * 1024,
        "requestTimeoutMs": 20_000,
        "accessHelpUrl": "https://help.example.test/1c",
        "accessInstructions": "Запросите личный доступ у администратора.",
        **overrides,
    }


class FakeResponse:
    def __init__(self, body: bytes, headers: dict[str, str] | None = None) -> None:
        self._stream = io.BytesIO(body)
        self.headers = headers or {}

    def read(self, size: int = -1) -> bytes:
        return self._stream.read(size)

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *_: object) -> None:
        return None


class OneCEdoRuntimeTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.environment = mock.patch.dict(
            os.environ,
            {
                "TRELIO_CONFIG_HOME": self.temporary.name,
                "TRELIO_SKILL_ID": "1c-edo",
                "TRELIO_SKILL_COMPANY_ID": COMPANY_ID,
                "TRELIO_SKILL_MEMBER_ID": MEMBER_ID,
                "TRELIO_SKILL_CONNECTION_ID": CONNECTION_ID,
                "TRELIO_SKILL_CONNECTION_CONFIG_JSON": json.dumps(company_config()),
                "TRELIO_1C_EDO_X_ODATA": "x" * 32,
            },
            clear=False,
        )
        self.environment.start()

    def tearDown(self) -> None:
        self.environment.stop()
        self.temporary.cleanup()

    def identity_and_config(self):
        return MODULE.load_identity(), MODULE.load_company_config()

    def store_connected_credentials(self):
        identity, config = self.identity_and_config()
        credentials = MODULE.Credentials("employee", "password")
        MODULE.save_credentials(identity, config, credentials)
        MODULE.save_access_state(identity, config, "connected")
        return identity, config, credentials

    def test_company_config_is_fingerprinted_and_bounded(self) -> None:
        _, first = self.identity_and_config()
        os.environ["TRELIO_SKILL_CONNECTION_CONFIG_JSON"] = json.dumps(
            company_config(maxRows=51),
        )
        second = MODULE.load_company_config()
        self.assertNotEqual(first.fingerprint, second.fingerprint)

        os.environ["TRELIO_SKILL_CONNECTION_CONFIG_JSON"] = json.dumps(
            company_config(odataBaseUrl="http://example.test/odata/"),
        )
        with self.assertRaisesRegex(MODULE.OneCEdoError, "HTTPS"):
            MODULE.load_company_config()

    def test_no_access_is_only_explicit_and_resets_on_fingerprint_change(self) -> None:
        identity, config = self.identity_and_config()
        with self.assertRaisesRegex(MODULE.OneCEdoError, "явного выбора"):
            MODULE.command_access_no_access(argparse.Namespace(confirmed=False))
        MODULE.command_access_no_access(argparse.Namespace(confirmed=True))
        self.assertEqual(MODULE.load_access_state(identity, config)["status"], "no_access")
        with self.assertRaisesRegex(MODULE.OneCEdoError, "администратору"):
            MODULE._connected_context()

        os.environ["TRELIO_SKILL_CONNECTION_CONFIG_JSON"] = json.dumps(
            company_config(maxPages=4),
        )
        changed = MODULE.load_company_config()
        state = MODULE.load_access_state(identity, changed)
        self.assertEqual(state["status"], "unknown")
        self.assertTrue(state["connectionChanged"])

    def test_connect_is_protected_and_auth_failure_never_means_no_access(self) -> None:
        identity, config = self.identity_and_config()
        supplied = MODULE.Credentials("employee", "wrong")
        with (
            mock.patch.object(MODULE, "prompt_credentials", return_value=supplied),
            mock.patch.object(
                MODULE,
                "_request_odata",
                side_effect=MODULE.AuthenticationError(
                    "authentication_failed",
                    "rejected",
                ),
            ),
            self.assertRaises(MODULE.AuthenticationError),
        ):
            MODULE.command_connect(argparse.Namespace())
        self.assertEqual(
            MODULE.load_access_state(identity, config)["status"],
            "needs_reconnect",
        )
        self.assertFalse(MODULE.credentials_path(identity).exists())

    def test_successful_connect_persists_only_local_credentials(self) -> None:
        identity, config = self.identity_and_config()
        supplied = MODULE.Credentials("employee", "correct-password")
        with (
            mock.patch.object(MODULE, "prompt_credentials", return_value=supplied),
            mock.patch.object(MODULE, "_request_odata", return_value={"value": []}),
        ):
            result = MODULE.command_connect(argparse.Namespace())
        self.assertEqual(result["status"], "connected")
        self.assertEqual(MODULE.load_access_state(identity, config)["status"], "connected")
        self.assertEqual(MODULE.load_credentials(identity, config), supplied)

    def test_connect_network_failure_preserves_previous_state(self) -> None:
        identity, config, _ = self.store_connected_credentials()
        with (
            mock.patch.object(
                MODULE,
                "prompt_credentials",
                return_value=MODULE.Credentials("employee", "new-password"),
            ),
            mock.patch.object(
                MODULE,
                "_request_odata",
                side_effect=MODULE.NetworkError("network_error", "offline"),
            ),
            self.assertRaises(MODULE.NetworkError),
        ):
            MODULE.command_connect(argparse.Namespace())
        self.assertEqual(MODULE.load_access_state(identity, config)["status"], "connected")
        self.assertEqual(MODULE.load_credentials(identity, config).password, "password")

    def test_filters_use_percent_20_and_fixed_new_old_chains(self) -> None:
        _, config, credentials = self.store_connected_credentials()
        new_filter = (
            f"ВладелецФайла eq cast(guid'{DOCUMENT_ID}', "
            "'Document_ЭлектронныйДокументВходящийЭДО')"
        )
        new_url = MODULE._odata_url(
            config,
            MODULE.NEW_FILE_ENTITY,
            (("$filter", new_filter),),
        )
        self.assertIn("%20eq%20cast", new_url)
        self.assertNotIn("+", new_url)

        calls: list[tuple[str, tuple[tuple[str, object], ...]]] = []

        def fake_request(_config, _credentials, entity, parameters=()):
            parameters = tuple(parameters)
            calls.append((entity, parameters))
            if entity == MODULE.NEW_FILE_ENTITY:
                return {"value": [{"Ref_Key": FILE_ID}]}
            if entity == MODULE.OLD_MESSAGE_ENTITY:
                return {"value": [{"Ref_Key": MESSAGE_ID}]}
            if entity == MODULE.OLD_FILE_ENTITY:
                return {"value": [{"Ref_Key": FILE_ID}]}
            return {"value": []}

        with mock.patch.object(MODULE, "_request_odata", side_effect=fake_request):
            new_files = MODULE._new_files(
                config,
                credentials,
                DOCUMENT_ID,
                MODULE.DOCUMENT_ENTITIES["incoming"],
            )
            old_files = MODULE._old_files(
                config,
                credentials,
                DOCUMENT_ID,
                MODULE.DOCUMENT_ENTITIES["incoming"],
            )
        self.assertEqual(new_files[0]["scheme"], "new")
        self.assertEqual(old_files[0]["scheme"], "old")
        self.assertIn("ВладелецФайла eq cast", str(calls[0][1]))
        self.assertIn("ЭлектронныйДокумент eq cast", str(calls[1][1]))
        self.assertIn("ВладелецФайла_Key eq guid", str(calls[2][1]))

    def test_arbitrary_entity_method_and_file_route_are_blocked(self) -> None:
        _, config = self.identity_and_config()
        with self.assertRaisesRegex(MODULE.OneCEdoError, "entity"):
            MODULE._odata_url(config, "Catalog_Users")
        with self.assertRaisesRegex(MODULE.OneCEdoError, "GET и HEAD"):
            MODULE._http_open(
                "POST",
                "https://example.test/",
                credentials=MODULE.Credentials("u", "p"),
                timeout=1,
                x_odata=None,
            )
        with self.assertRaisesRegex(MODULE.OneCEdoError, "new и old"):
            MODULE._file_url(config, "custom", FILE_ID)
        with self.assertRaises(MODULE.OneCEdoError):
            MODULE._file_url(config, "new", "not-a-uuid")
        with (
            mock.patch.object(
                MODULE.socket,
                "getaddrinfo",
                return_value=[(2, 1, 6, "", ("127.0.0.1", 443))],
            ),
            self.assertRaisesRegex(MODULE.OneCEdoError, "непубличный"),
        ):
            MODULE._http_open(
                "GET",
                "https://example.test/",
                credentials=MODULE.Credentials("u", "p"),
                timeout=1,
                x_odata=None,
            )

    def test_download_is_atomic_bounded_and_reports_sha256(self) -> None:
        self.store_connected_credentials()
        payload = b"verified document bytes"
        destination = Path(self.temporary.name) / "downloads" / "document.bin"
        response = FakeResponse(payload, {"Content-Length": str(len(payload))})
        with mock.patch.object(MODULE, "_http_open", return_value=response) as request:
            result = MODULE.command_download_file(
                argparse.Namespace(
                    scheme="new",
                    file_id=FILE_ID,
                    output=str(destination),
                ),
            )
        self.assertEqual(destination.read_bytes(), payload)
        self.assertEqual(
            result["sha256"],
            __import__("hashlib").sha256(payload).hexdigest(),
        )
        self.assertEqual(request.call_args.args[0], "GET")
        self.assertIsNone(request.call_args.kwargs["x_odata"])
        self.assertEqual(list(destination.parent.glob("*.part")), [])

    def test_search_is_bounded_and_auth_failure_sets_needs_reconnect(self) -> None:
        identity, config, _ = self.store_connected_credentials()
        with mock.patch.object(
            MODULE,
            "_request_odata",
            side_effect=MODULE.AuthenticationError("authentication_failed", "rejected"),
        ):
            with self.assertRaises(MODULE.AuthenticationError):
                MODULE.command_search_documents(
                    argparse.Namespace(direction="incoming", query=""),
                )
        self.assertEqual(
            MODULE.load_access_state(identity, config)["status"],
            "needs_reconnect",
        )

    def test_forget_credentials_does_not_echo_secret(self) -> None:
        identity, config, _ = self.store_connected_credentials()
        result = MODULE.command_forget_credentials(argparse.Namespace())
        self.assertTrue(result["credentialsRemoved"])
        self.assertFalse(MODULE.credentials_path(identity).exists())
        self.assertEqual(MODULE.load_access_state(identity, config)["status"], "unknown")


if __name__ == "__main__":
    unittest.main()
