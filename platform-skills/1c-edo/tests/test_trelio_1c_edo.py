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
BUSINESS_ID = "77777777-7777-4777-8777-777777777777"
ORG_SUBDIVISION_ID = "99999999-9999-4999-8999-999999999999"
CONTRACT_ID = "982a385d-df58-11f0-a58a-047c16799dce"
OUTGOING_DOCUMENT_ID = "88888888-8888-4888-8888-888888888888"
LIVE_OUTGOING_DOCUMENT_ID = "90adbd07-868e-11f1-a591-047c16799dce"
LIVE_INCOMING_DOCUMENT_ID = "55a667b1-874c-11f1-a591-047c16799dce"


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

        def fake_request(
            _config,
            _credentials,
            entity,
            parameters=(),
            *,
            diagnostic_stage=None,
        ):
            self.assertIn(diagnostic_stage, MODULE.DIAGNOSTIC_STAGES)
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
                diagnostic_stage="doctor.probe",
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
                diagnostic_stage="doctor.probe",
            )

    def test_http_400_reports_only_fixed_stage_and_status(self) -> None:
        """A rejected OData expression must be diagnosable without echoing it."""

        sensitive_url = (
            "https://private.example.test/odata/"
            "Catalog_ДоговорыКонтрагентов?"
            "$filter=substringof('secret-client',Description)"
        )
        remote_error = urllib.error.HTTPError(
            sensitive_url,
            400,
            "query contains secret-client",
            {},
            io.BytesIO(b"proxy echoed X-OData and a private server path"),
        )
        self.addCleanup(remote_error.close)
        opener = mock.Mock()
        opener.open.side_effect = remote_error
        with (
            mock.patch.object(
                MODULE.socket,
                "getaddrinfo",
                return_value=[(2, 1, 6, "", ("93.184.216.34", 443))],
            ),
            mock.patch.object(MODULE.urllib.request, "build_opener", return_value=opener),
            self.assertRaises(MODULE.NetworkError) as raised,
        ):
            MODULE._http_open(
                "GET",
                sensitive_url,
                credentials=MODULE.Credentials("private-user", "private-password"),
                timeout=1,
                x_odata="private-x-odata",
                diagnostic_stage="search.contracts.by-subdivision",
            )

        payload = MODULE._safe_error_payload(raised.exception)
        self.assertEqual(payload["code"], "http_error")
        self.assertEqual(
            payload["details"],
            {
                "stage": "search.contracts.by-subdivision",
                "httpStatus": 400,
            },
        )
        serialized = json.dumps(payload, ensure_ascii=False)
        for forbidden in (
            sensitive_url,
            "secret-client",
            "private-user",
            "private-password",
            "private-x-odata",
            "private server path",
        ):
            self.assertNotIn(forbidden, serialized)

    def test_live_document_signature_samples_are_normalized_from_date_only(self) -> None:
        """The document signing date, not an attachment flag, is authoritative."""

        outgoing = MODULE._normalize_document(
            {
                "Ref_Key": LIVE_OUTGOING_DOCUMENT_ID,
                "Number": "00000002110",
                "НомерДокумента": "2110",
                "ДатаПодписания": "2026-07-23T15:04:00",
                "ДатаОтправки": "2026-07-23T15:04:04",
                "Остановлен": False,
                "ОбменБезПодписи": False,
                "УдалитьСостояниеЭДО": "",
                "УдалитьДатаИзмененияСостоянияЭДО": "0001-01-01T00:00:00",
            },
        )
        incoming = MODULE._normalize_document(
            {
                "Ref_Key": LIVE_INCOMING_DOCUMENT_ID,
                "Number": "00000064205",
                "НомерДокумента": "32668",
                "ДатаПодписания": "0001-01-01T00:00:00",
                "ДатаПолучения": "2026-07-24T13:42:22",
                "Остановлен": False,
                "ОбменБезПодписи": False,
                "УдалитьСостояниеЭДО": "",
                "УдалитьДатаИзмененияСостоянияЭДО": "0001-01-01T00:00:00",
            },
        )

        self.assertEqual(
            outgoing["signature"],
            {
                "isSigned": True,
                "signedAt": "2026-07-23T15:04:00",
                "basis": "document_signing_date",
            },
        )
        self.assertEqual(
            incoming["signature"],
            {
                "isSigned": False,
                "signedAt": None,
                "basis": "document_signing_date",
            },
        )
        for document in (outgoing, incoming):
            self.assertEqual(document["edoStatus"], "unknown")
            self.assertEqual(
                document["statusAvailability"],
                {
                    "available": False,
                    "basis": "document_legacy_status_field",
                    "coverage": "opportunistic",
                    "statusChangedAt": None,
                    "reason": "document_legacy_status_field_empty",
                },
            )
            self.assertFalse(document["isStopped"])
            self.assertFalse(document["exchangeWithoutSignature"])

    def test_legacy_status_is_opportunistic_and_normalizes_change_date(self) -> None:
        """A card status is useful only when the fixed legacy field is non-empty."""

        filled = MODULE._normalize_document(
            {
                "ДатаПодписания": "0001-01-01T00:00:00",
                "УдалитьСостояниеЭДО": "  Ожидается подтверждение  ",
                "УдалитьДатаИзмененияСостоянияЭДО": "2026-07-25T10:20:30",
                "Остановлен": False,
                "ОбменБезПодписи": False,
            },
        )
        empty = MODULE._normalize_document(
            {
                "ДатаПодписания": "2026-07-23T15:04:00",
                "УдалитьСостояниеЭДО": "   ",
                "УдалитьДатаИзмененияСостоянияЭДО": "0001-01-01T00:00:00",
                "Остановлен": True,
                "ОбменБезПодписи": True,
            },
        )

        self.assertEqual(filled["edoStatus"], "Ожидается подтверждение")
        self.assertEqual(
            filled["statusAvailability"],
            {
                "available": True,
                "basis": "document_legacy_status_field",
                "coverage": "opportunistic",
                "statusChangedAt": "2026-07-25T10:20:30",
            },
        )
        self.assertFalse(filled["signature"]["isSigned"])
        self.assertFalse(filled["isStopped"])
        self.assertFalse(filled["exchangeWithoutSignature"])

        self.assertEqual(empty["edoStatus"], "unknown")
        self.assertEqual(
            empty["statusAvailability"],
            {
                "available": False,
                "basis": "document_legacy_status_field",
                "coverage": "opportunistic",
                "statusChangedAt": None,
                "reason": "document_legacy_status_field_empty",
            },
        )
        self.assertTrue(empty["signature"]["isSigned"])
        self.assertTrue(empty["isStopped"])
        self.assertTrue(empty["exchangeWithoutSignature"])

    def test_empty_sentinel_and_malformed_signing_dates_fail_closed(self) -> None:
        for unset in (None, "", "   ", "0001-01-01T00:00:00", "0001-01-01T00:00:00Z"):
            normalized = MODULE._normalize_document({"ДатаПодписания": unset})
            self.assertFalse(normalized["signature"]["isSigned"])
            self.assertIsNone(normalized["signature"]["signedAt"])

        for malformed in (False, 1, "not-a-timestamp"):
            with self.assertRaisesRegex(
                MODULE.OneCEdoError,
                "некорректную дату подписания",
            ):
                MODULE._normalize_document({"ДатаПодписания": malformed})

    def test_malformed_legacy_status_fields_fail_closed(self) -> None:
        for malformed_status in (False, 1, "contains\ncontrol", "я" * 513):
            with self.assertRaisesRegex(
                MODULE.OneCEdoError,
                "некорректное legacy-состояние",
            ):
                MODULE._normalize_document(
                    {"УдалитьСостояниеЭДО": malformed_status},
                )

        for malformed_date in (False, 1, "not-a-timestamp"):
            with self.assertRaisesRegex(
                MODULE.OneCEdoError,
                "некорректную дату изменения legacy-состояния",
            ):
                MODULE._normalize_document(
                    {
                        "УдалитьСостояниеЭДО": "Подписан",
                        "УдалитьДатаИзмененияСостоянияЭДО": malformed_date,
                    },
                )

    def test_mixed_file_signature_flags_never_change_document_signature(self) -> None:
        """Mixed new/old attachment flags must stay file-local."""

        _, config, credentials = self.store_connected_credentials()

        def fake_request(
            _config,
            _credentials,
            entity,
            parameters=(),
            *,
            diagnostic_stage,
        ):
            self.assertIn(diagnostic_stage, MODULE.DIAGNOSTIC_STAGES)
            if entity == MODULE.NEW_FILE_ENTITY:
                return {
                    "value": [
                        {
                            "Ref_Key": FILE_ID,
                            "ПодписанЭП": False,
                            "Description": "Визуальная PDF-копия",
                        },
                    ],
                }
            if entity == MODULE.OLD_MESSAGE_ENTITY:
                return {"value": [{"Ref_Key": MESSAGE_ID}]}
            if entity == MODULE.OLD_FILE_ENTITY:
                return {
                    "value": [
                        {"Ref_Key": FILE_ID, "ПодписанЭП": True},
                        {
                            "Ref_Key": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                            "ПодписанЭП": True,
                        },
                        {
                            "Ref_Key": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                            "ПодписанЭП": False,
                        },
                    ],
                }
            raise AssertionError(f"unexpected entity: {entity}")

        with mock.patch.object(MODULE, "_request_odata", side_effect=fake_request):
            files = [
                *MODULE._new_files(
                    config,
                    credentials,
                    LIVE_OUTGOING_DOCUMENT_ID,
                    MODULE.DOCUMENT_ENTITIES["outgoing"],
                ),
                *MODULE._old_files(
                    config,
                    credentials,
                    LIVE_INCOMING_DOCUMENT_ID,
                    MODULE.DOCUMENT_ENTITIES["incoming"],
                ),
            ]

        self.assertEqual(
            [item["file"]["ПодписанЭП"] for item in files],
            [False, True, True, False],
        )
        signed_document = MODULE._normalize_document(
            {"ДатаПодписания": "2026-07-23T15:04:00"},
        )
        unsigned_document = MODULE._normalize_document(
            {"ДатаПодписания": "0001-01-01T00:00:00"},
        )
        self.assertTrue(signed_document["signature"]["isSigned"])
        self.assertFalse(unsigned_document["signature"]["isSigned"])

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

    def test_search_follows_business_contract_chain_for_both_directions(self) -> None:
        self.store_connected_credentials()
        calls: list[tuple[str, tuple[tuple[str, object], ...], str]] = []

        def fake_request(
            _config,
            _credentials,
            entity,
            parameters=(),
            *,
            diagnostic_stage,
        ):
            parameters = tuple(parameters)
            calls.append((entity, parameters, diagnostic_stage))
            query = dict(parameters)
            filter_value = str(query.get("$filter", ""))
            if entity == "Catalog_ПодразделенияОрганизаций":
                return {
                    "value": [
                        {
                            "Ref_Key": ORG_SUBDIVISION_ID,
                            "Description": "Мурманск-4",
                        },
                    ],
                }
            if entity == "Catalog_СтруктураПредприятия":
                return {
                    "value": [
                        {
                            "Ref_Key": BUSINESS_ID,
                            "Description": "Мурманск-4",
                            "НеожиданноеПоле": "не должно выйти наружу",
                        },
                    ],
                }
            if entity == MODULE.CONTRACT_ENTITY:
                if "Подразделение_Key eq guid" in filter_value:
                    return {
                        "value": [
                            {
                                "Ref_Key": CONTRACT_ID,
                                "Description": (
                                    "Агентский договор №120 от 18.12.2025 "
                                    "(Мурманск-4)"
                                ),
                                "Подразделение_Key": BUSINESS_ID,
                            },
                        ],
                    }
                if "substringof" in filter_value:
                    # The same contract is intentionally returned by the
                    # direct fallback to verify stable deduplication.
                    return {
                        "value": [
                            {
                                "Ref_Key": CONTRACT_ID,
                                "Description": "Мурманск-4",
                                "Подразделение_Key": BUSINESS_ID,
                            },
                        ],
                    }
            if entity == MODULE.DOCUMENT_ENTITIES["incoming"]:
                return {
                    "value": [
                        {
                            "Ref_Key": DOCUMENT_ID,
                            "Number": "IN-120",
                            "Комментарий": "Мурманск-4",
                            "ДатаПодписания": "0001-01-01T00:00:00",
                            "УдалитьСостояниеЭДО": "",
                            "УдалитьДатаИзмененияСостоянияЭДО": (
                                "0001-01-01T00:00:00"
                            ),
                            "Остановлен": False,
                            "ОбменБезПодписи": False,
                            "ServerIgnoredSelect": "blocked",
                        },
                    ],
                }
            if entity == MODULE.DOCUMENT_ENTITIES["outgoing"]:
                return {
                    "value": [
                        {
                            "Ref_Key": OUTGOING_DOCUMENT_ID,
                            "Number": "OUT-120",
                            "Комментарий": "Мурманск-4",
                            "ДатаПодписания": "2026-07-23T15:04:00",
                            "УдалитьСостояниеЭДО": "Подписан",
                            "УдалитьДатаИзмененияСостоянияЭДО": (
                                "2026-07-23T15:04:04"
                            ),
                            "Остановлен": False,
                            "ОбменБезПодписи": False,
                        },
                    ],
                }
            return {"value": []}

        with mock.patch.object(MODULE, "_request_odata", side_effect=fake_request):
            result = MODULE.command_search_documents(
                argparse.Namespace(direction="both", query="Мурманск-4"),
            )

        self.assertEqual(result["count"], 2)
        self.assertEqual(
            {item["direction"] for item in result["documents"]},
            {"incoming", "outgoing"},
        )
        self.assertEqual(len(result["contracts"]), 1)
        self.assertEqual(
            {match["kind"] for match in result["contracts"][0]["matchedBy"]},
            {"enterprise_structure", "contract_text"},
        )
        self.assertEqual(len(result["businessObjects"]), 2)
        self.assertNotIn(
            "ServerIgnoredSelect",
            result["documents"][0]["document"],
        )
        signatures = {
            item["direction"]: item["document"]["signature"]
            for item in result["documents"]
        }
        self.assertFalse(signatures["incoming"]["isSigned"])
        self.assertIsNone(signatures["incoming"]["signedAt"])
        self.assertTrue(signatures["outgoing"]["isSigned"])
        self.assertEqual(
            signatures["outgoing"]["signedAt"],
            "2026-07-23T15:04:00",
        )
        statuses = {
            item["direction"]: (
                item["document"]["edoStatus"],
                item["document"]["statusAvailability"],
            )
            for item in result["documents"]
        }
        self.assertEqual(statuses["incoming"][0], "unknown")
        self.assertFalse(statuses["incoming"][1]["available"])
        self.assertIsNone(statuses["incoming"][1]["statusChangedAt"])
        self.assertEqual(statuses["outgoing"][0], "Подписан")
        self.assertTrue(statuses["outgoing"][1]["available"])
        self.assertEqual(
            statuses["outgoing"][1]["statusChangedAt"],
            "2026-07-23T15:04:04",
        )
        for item in result["documents"]:
            self.assertEqual(
                {match["kind"] for match in item["matchedBy"]},
                {"contract", "document_text"},
            )

        contract_document_calls = [
            (entity, dict(parameters))
            for entity, parameters, _stage in calls
            if entity in MODULE.DOCUMENT_ENTITIES.values()
            and "ДоговорКонтрагента eq cast" in str(dict(parameters).get("$filter"))
        ]
        self.assertEqual(len(contract_document_calls), 2)
        self.assertTrue(
            all(
                CONTRACT_ID in str(parameters["$filter"])
                for _, parameters in contract_document_calls
            ),
        )
        contract_calls = [
            (dict(parameters), stage)
            for entity, parameters, stage in calls
            if entity == MODULE.CONTRACT_ENTITY
        ]
        self.assertTrue(contract_calls)
        self.assertTrue(
            all(parameters["$orderby"] == "Дата desc" for parameters, _ in contract_calls),
        )
        self.assertIn(
            "search.contracts.by-subdivision",
            {stage for _, stage in contract_calls},
        )
        document_calls = [
            dict(parameters)
            for entity, parameters, _stage in calls
            if entity in MODULE.DOCUMENT_ENTITIES.values()
        ]
        self.assertTrue(document_calls)
        self.assertTrue(
            all(
                "ДатаПодписания" in parameters["$select"]
                and "Остановлен" in parameters["$select"]
                and "ОбменБезПодписи" in parameters["$select"]
                and "УдалитьСостояниеЭДО" in parameters["$select"]
                and "УдалитьДатаИзмененияСостоянияЭДО" in parameters["$select"]
                for parameters in document_calls
            ),
        )

    def test_get_document_matches_search_status_contract_for_both_directions(self) -> None:
        self.store_connected_credentials()
        calls: list[tuple[str, dict[str, object]]] = []

        def fake_request(
            _config,
            _credentials,
            entity,
            parameters=(),
            *,
            diagnostic_stage,
        ):
            query = dict(parameters)
            calls.append((entity, query))
            self.assertIn(diagnostic_stage, MODULE.DIAGNOSTIC_STAGES)
            self.assertIn("$select", query)
            self.assertIn("УдалитьСостояниеЭДО", str(query["$select"]))
            self.assertIn(
                "УдалитьДатаИзмененияСостоянияЭДО",
                str(query["$select"]),
            )
            common = {
                "Остановлен": False,
                "ОбменБезПодписи": False,
                # A server ignoring `$select` must not leak extra card fields.
                "ServerIgnoredSelect": "blocked",
            }
            if entity == MODULE.DOCUMENT_ENTITIES["outgoing"]:
                return {
                    "value": [
                        {
                            **common,
                            "Ref_Key": LIVE_OUTGOING_DOCUMENT_ID,
                            "ДатаПодписания": "2026-07-23T15:04:00",
                            "УдалитьСостояниеЭДО": "Подписан",
                            "УдалитьДатаИзмененияСостоянияЭДО": (
                                "2026-07-23T15:04:04"
                            ),
                        },
                    ],
                }
            return {
                "value": [
                    {
                        **common,
                        "Ref_Key": LIVE_INCOMING_DOCUMENT_ID,
                        "ДатаПодписания": "0001-01-01T00:00:00",
                        "УдалитьСостояниеЭДО": "",
                        "УдалитьДатаИзмененияСостоянияЭДО": (
                            "0001-01-01T00:00:00"
                        ),
                    },
                ],
            }

        with mock.patch.object(MODULE, "_request_odata", side_effect=fake_request):
            outgoing = MODULE.command_get_document(
                argparse.Namespace(
                    direction="outgoing",
                    document_id=LIVE_OUTGOING_DOCUMENT_ID,
                ),
            )["document"]
            incoming = MODULE.command_get_document(
                argparse.Namespace(
                    direction="incoming",
                    document_id=LIVE_INCOMING_DOCUMENT_ID,
                ),
            )["document"]

        self.assertEqual(outgoing["edoStatus"], "Подписан")
        self.assertTrue(outgoing["statusAvailability"]["available"])
        self.assertEqual(
            outgoing["statusAvailability"]["statusChangedAt"],
            "2026-07-23T15:04:04",
        )
        self.assertTrue(outgoing["signature"]["isSigned"])
        self.assertEqual(incoming["edoStatus"], "unknown")
        self.assertFalse(incoming["statusAvailability"]["available"])
        self.assertIsNone(incoming["statusAvailability"]["statusChangedAt"])
        self.assertFalse(incoming["signature"]["isSigned"])
        self.assertNotIn("ServerIgnoredSelect", outgoing)
        self.assertNotIn("ServerIgnoredSelect", incoming)
        self.assertEqual(
            {entity for entity, _query in calls},
            set(MODULE.DOCUMENT_ENTITIES.values()),
        )

    def test_search_escapes_apostrophe_unicode_and_percent_20(self) -> None:
        self.store_connected_credentials()
        filters: list[str] = []

        def fake_request(
            config,
            _credentials,
            entity,
            parameters=(),
            *,
            diagnostic_stage,
        ):
            self.assertIn(diagnostic_stage, MODULE.DIAGNOSTIC_STAGES)
            query = dict(parameters)
            if "$filter" in query:
                filters.append(str(query["$filter"]))
                url = MODULE._odata_url(config, entity, parameters)
                self.assertNotIn("+", url)
                self.assertNotIn(" ", url)
                self.assertIn("%20", url)
            return {"value": []}

        term = "ООО O'Reilly – Мурманск"
        with mock.patch.object(MODULE, "_request_odata", side_effect=fake_request):
            result = MODULE.command_search_documents(
                argparse.Namespace(direction="incoming", query=term),
            )
        self.assertEqual(result["count"], 0)
        self.assertTrue(filters)
        self.assertTrue(all("O''Reilly" in value for value in filters))
        self.assertTrue(any("–" in value for value in filters))

    def test_paging_caps_rows_even_when_server_ignores_top(self) -> None:
        _, config, credentials = self.store_connected_credentials()
        os.environ["TRELIO_SKILL_CONNECTION_CONFIG_JSON"] = json.dumps(
            company_config(maxRows=2, maxPages=2),
        )
        config = MODULE.load_company_config()
        requests: list[dict[str, object]] = []
        excessive_rows = [
            {"Ref_Key": str(__import__("uuid").uuid4()), "Description": str(index)}
            for index in range(100)
        ]

        def fake_request(
            _config,
            _credentials,
            _entity,
            parameters=(),
            *,
            diagnostic_stage,
        ):
            self.assertEqual(diagnostic_stage, "search.business.subdivision")
            requests.append(dict(parameters))
            return {"value": excessive_rows}

        with mock.patch.object(MODULE, "_request_odata", side_effect=fake_request):
            rows = MODULE._bounded_odata_rows(
                config,
                credentials,
                "Catalog_ПодразделенияОрганизаций",
                parameters=(
                    ("$select", "Ref_Key,Description"),
                    ("$filter", "substringof('Мурманск',Description)"),
                ),
                limit=50,
                diagnostic_stage="search.business.subdivision",
            )
        self.assertEqual(len(rows), 4)
        self.assertEqual(len(requests), 2)
        self.assertEqual(
            [(request["$top"], request["$skip"]) for request in requests],
            [(2, 0), (2, 2)],
        )

    def test_search_rejects_arbitrary_odata_cli_and_long_or_control_query(self) -> None:
        parser = MODULE.build_parser()
        for option in ("--entity", "--filter", "--select", "--orderby", "--url"):
            with self.assertRaises(SystemExit):
                parser.parse_args(
                    ["search-documents", option, "Catalog_Users"],
                )
        with self.assertRaisesRegex(MODULE.OneCEdoError, "длиннее"):
            MODULE._search_term("я" * (MODULE.MAX_SEARCH_QUERY_CHARS + 1))
        with self.assertRaisesRegex(MODULE.OneCEdoError, "управляющие"):
            MODULE._search_term("Мурманск\n4")

    def test_empty_search_browses_fixed_entities_and_no_match_is_empty(self) -> None:
        self.store_connected_credentials()
        calls: list[tuple[str, dict[str, object]]] = []

        def browse_request(
            _config,
            _credentials,
            entity,
            parameters=(),
            *,
            diagnostic_stage,
        ):
            self.assertIn(diagnostic_stage, MODULE.DIAGNOSTIC_STAGES)
            query = dict(parameters)
            calls.append((entity, query))
            if entity == MODULE.DOCUMENT_ENTITIES["incoming"]:
                return {"value": [{"Ref_Key": DOCUMENT_ID, "Number": "recent"}]}
            if entity == MODULE.DOCUMENT_ENTITIES["outgoing"]:
                return {
                    "value": [
                        {"Ref_Key": OUTGOING_DOCUMENT_ID, "Number": "recent"},
                    ],
                }
            raise AssertionError(f"unexpected entity: {entity}")

        with mock.patch.object(MODULE, "_request_odata", side_effect=browse_request):
            browse = MODULE.command_search_documents(
                argparse.Namespace(direction="both", query=""),
            )
        self.assertEqual(browse["count"], 2)
        self.assertEqual(
            {entity for entity, _ in calls},
            set(MODULE.DOCUMENT_ENTITIES.values()),
        )
        self.assertTrue(all("$filter" not in query for _, query in calls))
        self.assertTrue(all(query["$orderby"] == "Date desc" for _, query in calls))

        with mock.patch.object(
            MODULE,
            "_request_odata",
            return_value={"value": []},
        ):
            empty = MODULE.command_search_documents(
                argparse.Namespace(direction="outgoing", query="нет совпадений"),
            )
        self.assertEqual(empty["count"], 0)
        self.assertEqual(empty["documents"], [])
        self.assertEqual(empty["contracts"], [])
        self.assertEqual(empty["businessObjects"], [])

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
