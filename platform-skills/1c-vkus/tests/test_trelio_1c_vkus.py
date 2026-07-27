from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
import unittest
import urllib.error
from argparse import Namespace
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).parents[1] / "scripts" / "trelio_one_c_vkus_runtime.py"
SPEC = importlib.util.spec_from_file_location("trelio_one_c_vkus_runtime_test", SCRIPT)
assert SPEC and SPEC.loader
runtime = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = runtime
SPEC.loader.exec_module(runtime)

COMPANY_ID = "11111111-1111-4111-8111-111111111111"
MEMBER_ID = "22222222-2222-4222-8222-222222222222"
CONNECTION_ID = "33333333-3333-4333-8333-333333333333"
REFERENCE_ID = "44444444-4444-4444-8444-444444444444"
DOCUMENT_ID = "55555555-5555-4555-8555-555555555555"
ITEM_ID = "66666666-6666-4666-8666-666666666666"


def source_value(expected_type: str, *, reference: str = REFERENCE_ID) -> object:
    """Return one canonical JSON value accepted by the frozen EDM contract."""

    if expected_type == "Edm.Guid":
        return reference
    if expected_type == "Edm.String":
        return "Значение"
    if expected_type == "Edm.Boolean":
        return False
    if expected_type == "Edm.DateTime":
        return "2026-07-26T10:00:00"
    if expected_type == "Edm.Double":
        return 12.5
    if expected_type == "Edm.Int64":
        # Standard OData JSON may serialize Int64 as a decimal string.
        return "1"
    if expected_type.startswith("Collection("):
        return []
    raise AssertionError(f"unsupported test type: {expected_type}")


def source_record(
    field_types: dict[str, str],
    *,
    record_id: str = REFERENCE_ID,
) -> dict[str, object]:
    """Build a complete record: omission itself is a contract failure."""

    return {
        field: source_value(
            expected_type,
            reference=record_id if field == "Ref_Key" else REFERENCE_ID,
        )
        for field, expected_type in field_types.items()
    }


class OneCVkusRuntimeTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.environment = mock.patch.dict(
            os.environ,
            {
                "TRELIO_SKILL_ID": runtime.VKUS_SKILL_ID,
                "TRELIO_SKILL_COMPANY_ID": COMPANY_ID,
                "TRELIO_SKILL_MEMBER_ID": MEMBER_ID,
                "TRELIO_SKILL_CONNECTION_ID": CONNECTION_ID,
                "TRELIO_CONFIG_HOME": self.temporary.name,
                "TRELIO_SKILL_CONNECTION_CONFIG_JSON": json.dumps(
                    {
                        "schemaVersion": 1,
                        "odataBaseUrl": "https://example.test/odata/",
                        "filesBaseUrl": "https://example.test/files/",
                        "maxRows": 50,
                        "maxPages": 3,
                        "maxFileBytes": 1024,
                        "requestTimeoutMs": 20_000,
                    },
                ),
                "TRELIO_1C_EDO_X_ODATA": "0123456789abcdef",
            },
            clear=False,
        )
        self.environment.start()
        self.identity = runtime.Identity(COMPANY_ID, MEMBER_ID, CONNECTION_ID)
        self.config = runtime.load_company_config()
        self.credentials = runtime.Credentials("user", "password")

    def tearDown(self) -> None:
        self.environment.stop()
        self.temporary.cleanup()

    def connected_context(self) -> tuple[object, object, object]:
        return self.identity, self.config, self.credentials

    def test_release_reuses_provider_credentials_and_has_no_metadata_code_path(self) -> None:
        source = SCRIPT.read_text(encoding="utf-8")

        self.assertEqual(runtime.RUNTIME_VERSION, "1.0.14")
        self.assertEqual(runtime.CREDENTIAL_PROVIDER_NAMESPACE, "1c-edo")
        self.assertEqual(runtime.SUPPORTED_SKILL_IDS, {runtime.VKUS_SKILL_ID})
        self.assertNotIn("$metadata", source)
        self.assertNotIn("def _request_metadata", source)
        self.assertNotIn("def _metadata_url", source)
        self.assertNotIn("general_schema_cache", source)
        self.assertNotIn("developer-inventory-metadata", source)
        self.assertNotIn("If-None-Match", source)
        self.assertNotIn("Accept-Encoding", source)

    def test_parser_exposes_only_fixed_business_arguments(self) -> None:
        parser = runtime.build_general_parser()
        forbidden = {
            "--url",
            "--entity",
            "--filter",
            "--select",
            "--orderby",
            "--query-expression",
            "--method",
        }
        option_strings = {
            option
            for action in parser._actions
            for option in action.option_strings
        }
        for action in parser._subparsers._group_actions:
            for child in action.choices.values():
                option_strings.update(
                    option
                    for child_action in child._actions
                    for option in child_action.option_strings
                )
        self.assertTrue(forbidden.isdisjoint(option_strings))
        with self.assertRaises(SystemExit):
            parser.parse_args(["developer-inventory-metadata"])

    def test_static_registry_is_complete_stable_and_network_free(self) -> None:
        expected_capability_digests = {
            "reference.organization": "sha256:c35936172ed9413a19b764098d3d0a59e69c040470300976a62cf1c5a7560631",
            "reference.business_unit": "sha256:86dede737531b4e422434dd53ca430ec7cb212d04d1bfc344bd47811d0567d7f",
            "reference.counterparty": "sha256:f45733e044e227dfa3790d112b916489dd4aca1ee6cfa6cdf71a93d9923f9b7c",
            "reference.partner": "sha256:d56747cf59c1081c2f74913a3cf56cf2b038748cf7d6cf1e2f9d165a4039361f",
            "reference.contract": "sha256:38a3f9f5c90f850a558f4839c56db1e804487d797ada22a6ea249b899ce335a8",
            "reference.item": "sha256:4b45fc48224dbc764c54b5053cfacf96bc5cd1497ab91cba1ebcbc01d651f799",
            "reference.warehouse": "sha256:d6bef1fc9b469ea4fd72de686dfb1d8c13bc3ae8fa6a3ff3945f5c61cd062649",
            "document.purchase": "sha256:45449c750b1122c9cf9f6effb20df57c876a9493ed1a46fd6c73068a245e31b8",
            "document.sale": "sha256:692d72dac092f15b1050cbf74a72eafbdab9ba3b429352f906d79b96aad5e4a1",
            "document.receipt": "sha256:47054e9b3c52c52fc43c1440859c625c404247dd918482723739c42bfa19f682",
            "document.return": "sha256:ce2909227b0c02f7807d144b8212cdaa7f3abc7e4344940a59853b5ff868e5f3",
            "document.transfer": "sha256:5737be9028869c2c278a4a4199eabb95697afca287c6b466625d40d7b657ec45",
        }
        with (
            mock.patch.object(
                runtime,
                "_http_open",
                side_effect=AssertionError("get-capabilities must be local"),
            ),
            mock.patch.object(
                runtime,
                "_connected_context",
                side_effect=AssertionError("credentials must not be loaded"),
            ),
        ):
            result = runtime.command_general_get_capabilities(Namespace())

        self.assertEqual(result["registryVersion"], 2)
        self.assertEqual(
            result["schema"]["registryDigest"],
            "sha256:99c53e81aa674da61090f44b5066c71d72a6eee7e235687017d5d30b4746d63d",
        )
        self.assertEqual(
            result["schema"]["profileSchemaDigest"],
            runtime.GENERAL_PROFILE_SCHEMA_DIGEST,
        )
        self.assertEqual(
            result["schema"]["capabilityDigests"],
            expected_capability_digests,
        )
        self.assertEqual(
            result["schema"]["validation"],
            {
                "mode": "signed_registry_response_contract",
                "metadataRequest": False,
                "registrySource": "signed_package",
                "responseValidation": "fail_closed",
            },
        )
        self.assertEqual(len(result["sections"]["references"]), 7)
        self.assertEqual(len(result["sections"]["documents"]), 5)
        self.assertNotIn("metadataBytes", result["limits"])

    def test_every_production_command_has_no_schema_discovery_request(self) -> None:
        """Exercise every broad handler while recording all transport sources."""

        requested_entities: list[str] = []

        def empty_source(
            _config: object,
            _credentials: object,
            entity: str,
            _parameters: object = (),
            *,
            diagnostic_stage: str,
        ) -> dict[str, object]:
            self.assertTrue(diagnostic_stage.startswith("general."))
            requested_entities.append(entity)
            return {"value": []}

        common_document = {
            "kind": "purchase",
            "date_from": "",
            "date_to": "",
            "organization_id": "",
            "business_unit_id": "",
            "counterparty_id": "",
            "contract_id": "",
            "number": "",
            "status": "",
            "page": 1,
            "limit": 3,
        }
        commands = (
            lambda: runtime.command_general_search_reference_items(
                Namespace(kind="organization", query="", page=1, limit=3),
            ),
            lambda: runtime.command_general_get_reference_item(
                Namespace(kind="organization", id=REFERENCE_ID),
            ),
            lambda: runtime.command_general_search_documents(
                Namespace(**common_document),
            ),
            lambda: runtime.command_general_get_document(
                Namespace(
                    kind="purchase",
                    id=DOCUMENT_ID,
                    include_lines=True,
                    line_limit=5,
                ),
            ),
            lambda: runtime.command_general_get_links(
                Namespace(kind="document", id=DOCUMENT_ID),
            ),
        )
        with (
            mock.patch.object(
                runtime,
                "_connected_context",
                side_effect=self.connected_context,
            ),
            mock.patch.object(runtime, "_request_odata", side_effect=empty_source),
            mock.patch.object(runtime, "save_access_state"),
        ):
            for command in commands:
                requested_entities.clear()
                command()
                self.assertTrue(
                    all(entity in runtime.GENERAL_ODATA_ENTITIES for entity in requested_entities),
                )

        with mock.patch.object(
            runtime,
            "_request_odata",
            side_effect=AssertionError("unsupported balance must be local"),
        ):
            balances = runtime.command_general_get_balances(Namespace(kind="stock"))
        self.assertEqual(balances["reason"], "needs_custom_endpoint")

    def test_reference_response_is_normalized_and_unselected_fields_never_leak(self) -> None:
        spec = runtime.GENERAL_REFERENCE_SPECS["counterparty"][0]
        row = source_record(spec["fields"])
        row.update(
            {
                "Description": "Поставщик",
                "НаименованиеПолное": "ООО Поставщик",
                "Партнер_Key": ITEM_ID,
                "ИНН": "must-not-leak",
                "БанковскийСчет_Key": ITEM_ID,
            },
        )
        with (
            mock.patch.object(
                runtime,
                "_connected_context",
                side_effect=self.connected_context,
            ),
            mock.patch.object(
                runtime,
                "_general_reference_search_rows",
                return_value=[row],
            ),
            mock.patch.object(runtime, "save_access_state"),
        ):
            result = runtime.command_general_search_reference_items(
                Namespace(
                    kind="counterparty",
                    query="Поставщик",
                    page=1,
                    limit=10,
                ),
            )

        serialized = json.dumps(result, ensure_ascii=False)
        self.assertEqual(result["items"][0]["id"], REFERENCE_ID)
        self.assertEqual(result["items"][0]["partnerId"], ITEM_ID)
        self.assertIn("query.name", result["items"][0]["matchedBy"])
        self.assertNotIn("must-not-leak", serialized)
        self.assertNotIn("Банков", serialized)
        self.assertNotIn("ИНН", serialized)

    def test_missing_or_changed_reference_field_fails_closed(self) -> None:
        spec = runtime.GENERAL_REFERENCE_SPECS["organization"][0]
        missing = source_record(spec["fields"])
        missing.pop("Статус")
        changed = source_record(spec["fields"])
        changed["DeletionMark"] = "false"

        for row in (missing, changed):
            with self.assertRaises(runtime.OneCEdoError) as caught:
                runtime._general_reference_record(
                    "organization",
                    spec,
                    row,
                    matched_by=["id"],
                )
            self.assertEqual(caught.exception.code, "capability_schema_changed")

    def test_odata_collection_shape_and_ambiguous_exact_result_fail_closed(self) -> None:
        for payload in ({}, {"value": {}}, {"value": [None]}):
            with self.assertRaises(runtime.OneCEdoError) as caught:
                runtime._odata_rows(payload)
            self.assertEqual(caught.exception.code, "source_contract_mismatch")

        record = source_record(
            runtime.GENERAL_REFERENCE_SPECS["organization"][0]["fields"],
        )
        with (
            mock.patch.object(
                runtime,
                "_connected_context",
                side_effect=self.connected_context,
            ),
            mock.patch.object(
                runtime,
                "_general_reference_by_id",
                return_value=[
                    runtime._general_reference_record(
                        "organization",
                        runtime.GENERAL_REFERENCE_SPECS["organization"][0],
                        record,
                        matched_by=["id"],
                    ),
                ]
                * 2,
            ),
            mock.patch.object(runtime, "save_access_state"),
        ):
            with self.assertRaises(runtime.OneCEdoError) as caught:
                runtime.command_general_get_reference_item(
                    Namespace(kind="organization", id=REFERENCE_ID),
                )
        self.assertEqual(caught.exception.code, "source_contract_mismatch")

    def test_document_lines_validate_int64_and_truncate_locally(self) -> None:
        spec = runtime.GENERAL_DOCUMENT_SPECS["purchase"][0]
        raw = source_record(spec["fields"], record_id=DOCUMENT_ID)
        raw.update(
            {
                "Number": "П-1",
                "Date": "2026-07-26T10:00:00",
                "Posted": True,
                "Организация_Key": REFERENCE_ID,
                "Контрагент_Key": ITEM_ID,
            },
        )
        lines: list[dict[str, object]] = []
        for index in range(1, 4):
            line = source_record(spec["lineFields"])
            line.update(
                {
                    "LineNumber": str(index),
                    "Номенклатура_Key": ITEM_ID,
                    "Количество": 2.0,
                    "Цена": 10.0,
                    "Сумма": 20.0,
                    "БанковскийСчет_Key": "must-not-leak",
                },
            )
            lines.append(line)
        raw["Товары"] = lines

        result = runtime._general_document_record(
            "purchase",
            spec,
            raw,
            matched_by=["id"],
            include_lines=True,
            line_limit=2,
        )

        self.assertEqual(result["id"], DOCUMENT_ID)
        self.assertEqual(len(result["lines"]), 2)
        self.assertEqual(result["lines"][0]["lineNumber"], 1)
        self.assertTrue(result["lineInfo"]["truncated"])
        self.assertNotIn("must-not-leak", str(result))

        raw["Товары"][0]["LineNumber"] = "1.0"
        with self.assertRaises(runtime.OneCEdoError) as caught:
            runtime._general_document_record(
                "purchase",
                spec,
                raw,
                matched_by=["id"],
                include_lines=True,
                line_limit=2,
            )
        self.assertEqual(caught.exception.code, "capability_schema_changed")

    def test_fixed_source_400_and_404_are_safe_contract_errors(self) -> None:
        for status in (400, 404):
            error = urllib.error.HTTPError(
                "https://must-not-leak.example/source?secret=query",
                status,
                "must-not-leak-body",
                {},
                None,
            )
            opener = mock.Mock()
            opener.open.side_effect = error
            with (
                mock.patch.object(
                    runtime.socket,
                    "getaddrinfo",
                    return_value=[
                        (
                            runtime.socket.AF_INET,
                            runtime.socket.SOCK_STREAM,
                            6,
                            "",
                            ("93.184.216.34", 443),
                        ),
                    ],
                ),
                mock.patch.object(
                    runtime.urllib.request,
                    "build_opener",
                    return_value=opener,
                ),
            ):
                with self.assertRaises(runtime.OneCEdoError) as caught:
                    runtime._http_open(
                        "GET",
                        "https://example.test/odata/fixed",
                        credentials=self.credentials,
                        timeout=1,
                        x_odata="0123456789abcdef",
                        diagnostic_stage="general.reference.organization.search",
                    )
            self.assertEqual(caught.exception.code, "source_contract_mismatch")
            self.assertEqual(caught.exception.details["httpStatus"], status)
            self.assertNotIn("must-not-leak", str(caught.exception))

    def test_document_filter_escapes_text_and_blocks_unsupported_relation(self) -> None:
        common = {
            "date_from": "2026-07-01",
            "date_to": "2026-07-31",
            "organization_id": REFERENCE_ID,
            "business_unit_id": "",
            "counterparty_id": "",
            "contract_id": "",
            "number": "A' or true",
            "status": "posted",
        }
        filter_value, matched = runtime._general_document_filter(
            Namespace(**common),
            runtime.GENERAL_DOCUMENT_SPECS["sale"][0],
        )

        self.assertIn("substringof('A'' or true',Number)", filter_value)
        self.assertIn("Posted eq true", filter_value)
        self.assertIn("period", matched)
        self.assertIn("number", matched)

        blocked = dict(common)
        blocked["counterparty_id"] = REFERENCE_ID
        with self.assertRaisesRegex(runtime.OneCEdoError, "counterparty"):
            runtime._general_document_filter(
                Namespace(**blocked),
                runtime.GENERAL_DOCUMENT_SPECS["receipt"][0],
            )

    def test_entity_allowlist_and_read_only_method_guard_remain_closed(self) -> None:
        with self.assertRaisesRegex(runtime.OneCEdoError, "entity"):
            runtime._odata_url(self.config, "Catalog_Пользователи")
        with self.assertRaises(runtime.OneCEdoError) as caught:
            runtime._http_open(
                "POST",
                "https://example.test/odata/fixed",
                credentials=self.credentials,
                timeout=1,
                x_odata="0123456789abcdef",
                diagnostic_stage="general.reference.organization.search",
            )
        self.assertEqual(caught.exception.code, "method_blocked")


if __name__ == "__main__":
    unittest.main()
