from __future__ import annotations

import http.client
import importlib.util
import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.error
from argparse import Namespace
from pathlib import Path
from types import SimpleNamespace
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


def finance_args(kind: str, **overrides: object) -> Namespace:
    """Build the complete public finance command contract for one test."""

    values: dict[str, object] = {
        "kind": kind,
        "date_from": "2026-07-01",
        "date_to": "2026-07-31",
        "organization_id": "",
        "business_unit_id": "",
        "account_id": "",
        "warehouse_id": "",
        "item_id": "",
        "page": 1,
        "limit": 25,
        "include_sensitive": True,
    }
    values.update(overrides)
    return Namespace(**values)


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

        self.assertEqual(runtime.RUNTIME_VERSION, "1.0.17")
        self.assertEqual(runtime.CREDENTIAL_PROVIDER_NAMESPACE, "1c-edo")
        self.assertEqual(runtime.SUPPORTED_SKILL_IDS, {runtime.VKUS_SKILL_ID})
        self.assertNotIn("$metadata", source)
        self.assertNotIn("def _request_metadata", source)
        self.assertNotIn("def _metadata_url", source)
        self.assertNotIn("general_schema_cache", source)
        self.assertNotIn("developer-inventory-metadata", source)
        self.assertNotIn("If-None-Match", source)
        self.assertNotIn("Accept-Encoding", source)
        self.assertNotIn("osascript", source)
        self.assertNotIn("System.Windows.Forms", source)

    def test_latent_provider_connect_uses_protected_browser_without_autocomplete(self) -> None:
        page = runtime.browser_prompt_app_page().decode("utf-8")
        expected = runtime.Credentials("employee", "password")

        self.assertIn("Trelio — 1С", page)
        self.assertIn('<form id="prompt-form" autocomplete="off">', page)
        self.assertIn('type="${inputType}" autocomplete="off"', page)
        with mock.patch.object(
            runtime,
            "_prompt_credentials_browser",
            return_value=expected,
        ) as browser_prompt, mock.patch.object(
            runtime,
            "_prompt_credentials_terminal",
            return_value=expected,
        ) as terminal_prompt:
            self.assertEqual(
                runtime.prompt_credentials(Namespace(terminal_prompts=False)),
                expected,
            )
            browser_prompt.assert_called_once()
            terminal_prompt.assert_not_called()

    def test_latent_provider_connect_openers_use_default_browser(self) -> None:
        completed = SimpleNamespace(returncode=0)
        with mock.patch.object(runtime.sys, "platform", "darwin"), mock.patch.object(
            runtime.subprocess,
            "run",
            return_value=completed,
        ) as run:
            runtime.open_browser_url("http://127.0.0.1:1234/token/")
        self.assertEqual(
            run.call_args.args[0],
            ["/usr/bin/open", "http://127.0.0.1:1234/token/"],
        )

        startfile = mock.Mock()
        with mock.patch.object(runtime.sys, "platform", "win32"), mock.patch.object(
            runtime.os,
            "startfile",
            startfile,
            create=True,
        ):
            runtime.open_browser_url("http://127.0.0.1:1234/token/")
        startfile.assert_called_once_with("http://127.0.0.1:1234/token/")

    def test_latent_provider_loopback_rejects_cross_origin_submit(self) -> None:
        session = runtime.BrowserPromptSession()
        session.opened = True
        received: list[str] = []

        worker = threading.Thread(
            target=lambda: received.append(
                session.ask(
                    "Введите личный пароль 1С",
                    hidden=True,
                    trim=False,
                    max_length=runtime.MAX_PASSWORD_CHARS,
                ),
            ),
        )
        worker.start()
        try:
            with session.condition:
                self.assertTrue(
                    session.condition.wait_for(
                        lambda: session.current_prompt is not None,
                        timeout=2,
                    ),
                )
                prompt_id = session.current_prompt["id"]

            body = f"id={prompt_id}&value=private-password"
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
            self.assertEqual(received, ["private-password"])
        finally:
            session.close()

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
        expected_capabilities = {
            *(f"reference.{kind}" for kind in runtime.GENERAL_REFERENCE_SPECS),
            *(f"document.{kind}" for kind in runtime.GENERAL_DOCUMENT_SPECS),
            *(
                f"financial_turnover.{kind}"
                for kind in runtime.GENERAL_FINANCIAL_TURNOVER_SPECS
            ),
            *(
                f"financial_record.{kind}"
                for kind in runtime.GENERAL_FINANCIAL_RECORD_SPECS
            ),
            *(f"balance.{kind}" for kind in runtime.GENERAL_BALANCE_SPECS),
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

        self.assertEqual(result["registryVersion"], 3)
        self.assertEqual(
            result["schema"]["registryDigest"],
            "sha256:ddfc68ca0bf1ee5d4816a5c4759eef70fbaed3970b3e86a86785b97380d7c46d",
        )
        self.assertEqual(
            result["schema"]["profileSchemaDigest"],
            runtime.GENERAL_PROFILE_SCHEMA_DIGEST,
        )
        self.assertEqual(
            set(result["schema"]["capabilityDigests"]),
            expected_capabilities,
        )
        self.assertTrue(
            all(
                len(value) == 71 and value.startswith("sha256:")
                for value in result["schema"]["capabilityDigests"].values()
            ),
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
        self.assertEqual(len(result["sections"]["references"]), 11)
        self.assertEqual(len(result["sections"]["documents"]), 5)
        self.assertEqual(len(result["sections"]["financialTurnovers"]), 9)
        self.assertEqual(len(result["sections"]["financialRecords"]), 3)
        self.assertEqual(len(result["sections"]["balances"]), 2)
        turnover_capabilities = {
            item["kind"]: item
            for item in result["sections"]["financialTurnovers"]
        }
        self.assertEqual(
            turnover_capabilities["payroll_accounting"]["filterSourceTypes"],
            {"business_unit": "organization_division"},
        )
        self.assertEqual(
            turnover_capabilities["sales_cost"]["filterSourceTypes"],
            {"business_unit": "enterprise_structure"},
        )
        self.assertEqual(
            result["reporting"],
            {"pnlAssembly": False, "sourceDataOnly": True},
        )
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
        common_finance = {
            "date_from": "2026-07-01",
            "date_to": "2026-07-31",
            "organization_id": "",
            "business_unit_id": "",
            "account_id": "",
            "warehouse_id": "",
            "item_id": "",
            "page": 1,
            "limit": 3,
            "include_sensitive": True,
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
            lambda: runtime.command_general_get_financial_turnovers(
                Namespace(
                    **{
                        **common_finance,
                        "kind": "sales_cost",
                        "business_unit_id": REFERENCE_ID,
                    },
                ),
            ),
            lambda: runtime.command_general_search_financial_records(
                Namespace(
                    **{
                        **common_finance,
                        "kind": "bank_receipt",
                        "business_unit_id": REFERENCE_ID,
                    },
                ),
            ),
            lambda: runtime.command_general_get_balance_and_turnovers(
                Namespace(
                    **{
                        **common_finance,
                        "kind": "stock",
                        "item_id": ITEM_ID,
                    },
                ),
            ),
        )

        def empty_virtual_source(
            _config: object,
            _credentials: object,
            _spec: object,
            _start: object,
            _end: object,
            _parameters: object,
            *,
            diagnostic_stage: str,
        ) -> dict[str, object]:
            self.assertTrue(diagnostic_stage.startswith("general."))
            return {"value": []}

        with (
            mock.patch.object(
                runtime,
                "_connected_context",
                side_effect=self.connected_context,
            ),
            mock.patch.object(runtime, "_request_odata", side_effect=empty_source),
            mock.patch.object(
                runtime,
                "_request_general_virtual_table",
                side_effect=empty_virtual_source,
            ),
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
        self.assertEqual(balances["reason"], "use_get_balance_and_turnovers")

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

    def test_http_429_honors_retry_after_before_retrying(self) -> None:
        rate_limited = urllib.error.HTTPError(
            "https://example.test/odata/fixed",
            429,
            "rate limited",
            {"Retry-After": "2"},
            None,
        )
        success = object()
        opener = mock.Mock()
        opener.open.side_effect = [rate_limited, success]

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
            mock.patch.object(runtime.time, "sleep") as sleep,
        ):
            response = runtime._http_open(
                "GET",
                "https://example.test/odata/fixed",
                credentials=self.credentials,
                timeout=1,
                x_odata="0123456789abcdef",
                diagnostic_stage="general.reference.organization.search",
            )

        self.assertIs(response, success)
        self.assertEqual(opener.open.call_count, 2)
        sleep.assert_called_once_with(2.0)

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

    def test_finance_requires_explicit_sensitive_basis_period_and_scope(self) -> None:
        with mock.patch.object(
            runtime,
            "_connected_context",
            side_effect=AssertionError("must fail before credentials"),
        ):
            with self.assertRaises(runtime.OneCEdoError) as caught:
                runtime.command_general_get_financial_turnovers(
                    finance_args(
                        "sales_cost",
                        business_unit_id=REFERENCE_ID,
                        include_sensitive=False,
                    ),
                )
        self.assertEqual(
            caught.exception.code,
            "sensitive_data_confirmation_required",
        )

        invalid_periods = (
            finance_args("sales_cost", date_from="", business_unit_id=REFERENCE_ID),
            finance_args(
                "sales_cost",
                date_from="2026-07-31",
                date_to="2026-07-01",
                business_unit_id=REFERENCE_ID,
            ),
            finance_args(
                "sales_cost",
                date_from="2026-01-01",
                date_to="2026-07-01",
                business_unit_id=REFERENCE_ID,
            ),
        )
        expected_codes = ("period_required", "invalid_period", "period_too_large")
        for args, expected_code in zip(invalid_periods, expected_codes, strict=True):
            with self.assertRaises(runtime.OneCEdoError) as caught:
                runtime._general_financial_period(args)
            self.assertEqual(caught.exception.code, expected_code)

        with self.assertRaises(runtime.OneCEdoError) as caught:
            runtime._general_financial_filter(
                finance_args("sales_cost"),
                runtime.GENERAL_FINANCIAL_TURNOVER_SPECS["sales_cost"],
            )
        self.assertEqual(caught.exception.code, "scope_filter_required")

        with self.assertRaises(runtime.OneCEdoError) as caught:
            runtime._general_financial_filter(
                finance_args(
                    "sales_cost",
                    business_unit_id=REFERENCE_ID,
                    organization_id=ITEM_ID,
                ),
                runtime.GENERAL_FINANCIAL_TURNOVER_SPECS["sales_cost"],
            )
        self.assertEqual(caught.exception.code, "filter_unsupported")

    def test_finance_virtual_routes_are_fixed_and_space_encoded(self) -> None:
        account_url = runtime._general_virtual_url(
            self.config,
            runtime.GENERAL_BALANCE_SPECS["accounts"],
            runtime.dt.date(2026, 7, 1),
            runtime.dt.date(2026, 8, 1),
            (("$filter", f"Account_Key eq guid'{REFERENCE_ID}'"),),
        )
        stock_url = runtime._general_virtual_url(
            self.config,
            runtime.GENERAL_BALANCE_SPECS["stock"],
            runtime.dt.date(2026, 7, 1),
            runtime.dt.date(2026, 8, 1),
            (("$filter", f"Номенклатура_Key eq guid'{ITEM_ID}'"),),
        )

        self.assertIn("AccountingRegister_", account_url)
        self.assertNotIn("Dimensions", account_url)
        self.assertIn("%20", account_url)
        self.assertNotIn("+", account_url)
        self.assertIn("Dimensions=", stock_url)
        self.assertIn(
            "%D0%9D%D0%BE%D0%BC%D0%B5%D0%BD%D0%BA%D0%BB%D0%B0%D1%82%D1%83%D1%80%D0%B0",
            stock_url,
        )

        unregistered = dict(runtime.GENERAL_BALANCE_SPECS["stock"])
        unregistered["entity"] = "Catalog_Пользователи"
        with self.assertRaises(runtime.OneCEdoError) as caught:
            runtime._general_virtual_url(
                self.config,
                unregistered,
                runtime.dt.date(2026, 7, 1),
                runtime.dt.date(2026, 8, 1),
                (),
            )
        self.assertEqual(caught.exception.code, "query_builder_error")

    def test_account_scope_expands_only_to_fixed_debit_and_credit_fields(self) -> None:
        filter_value, matched = runtime._general_financial_filter(
            finance_args("account_entry", account_id=REFERENCE_ID),
            runtime.GENERAL_FINANCIAL_RECORD_SPECS["account_entry"],
        )

        self.assertEqual(matched, ["account"])
        self.assertIn(f"AccountDr_Key eq guid'{REFERENCE_ID}'", filter_value)
        self.assertIn(f"AccountCr_Key eq guid'{REFERENCE_ID}'", filter_value)
        self.assertNotIn("$", filter_value)
        self.assertNotIn("substring", filter_value)

    def test_financial_rows_are_normalized_and_sensitive_extras_never_leak(self) -> None:
        spec = runtime.GENERAL_FINANCIAL_TURNOVER_SPECS["payroll_accounting"]
        row = source_record(spec["fields"])
        row.update(
            {
                "Организация_Key": REFERENCE_ID,
                "Подразделение_Key": ITEM_ID,
                "СуммаTurnover": 123.45,
                "ФизическоеЛицо_Key": DOCUMENT_ID,
                "БанковскийСчет_Key": DOCUMENT_ID,
                "НазначениеПлатежа": "must-not-leak",
            },
        )

        normalized = runtime._general_financial_record(
            "payroll_accounting",
            spec,
            row,
            source_kind="virtual_table",
        )
        serialized = json.dumps(normalized, ensure_ascii=False)
        self.assertEqual(normalized["dimensions"]["organizationId"], REFERENCE_ID)
        self.assertEqual(normalized["dimensions"]["businessUnitId"], ITEM_ID)
        self.assertEqual(normalized["metrics"]["amount"], 123.45)
        self.assertNotIn(DOCUMENT_ID, serialized)
        self.assertNotIn("Физическое", serialized)
        self.assertNotIn("Банков", serialized)
        self.assertNotIn("must-not-leak", serialized)

        missing = dict(row)
        missing.pop("СуммаTurnover")
        with self.assertRaises(runtime.OneCEdoError) as caught:
            runtime._general_financial_record(
                "payroll_accounting",
                spec,
                missing,
                source_kind="virtual_table",
            )
        self.assertEqual(caught.exception.code, "capability_schema_changed")

        changed = dict(row)
        changed["СуммаTurnover"] = "123.45"
        with self.assertRaises(runtime.OneCEdoError) as caught:
            runtime._general_financial_record(
                "payroll_accounting",
                spec,
                changed,
                source_kind="virtual_table",
            )
        self.assertEqual(caught.exception.code, "capability_schema_changed")

    def test_finance_commands_cap_ignored_top_and_select_no_bank_requisites(self) -> None:
        turnover_spec = runtime.GENERAL_FINANCIAL_TURNOVER_SPECS["sales_cost"]
        turnover_row = source_record(turnover_spec["fields"])
        captured_virtual_parameters: list[tuple[str, object]] = []

        def virtual_source(
            _config: object,
            _credentials: object,
            _spec: object,
            _start: object,
            _end: object,
            parameters: object,
            *,
            diagnostic_stage: str,
        ) -> dict[str, object]:
            self.assertEqual(
                diagnostic_stage,
                "general.financial.turnover.sales_cost.search",
            )
            captured_virtual_parameters.extend(parameters)
            # Simulate a non-conforming server that ignores `$top`; the runtime
            # must still normalize and expose no more than limit + lookahead.
            return {"value": [dict(turnover_row) for _ in range(20)]}

        with (
            mock.patch.object(
                runtime,
                "_connected_context",
                side_effect=self.connected_context,
            ),
            mock.patch.object(
                runtime,
                "_request_general_virtual_table",
                side_effect=virtual_source,
            ),
            mock.patch.object(runtime, "save_access_state"),
        ):
            turnovers = runtime.command_general_get_financial_turnovers(
                finance_args(
                    "sales_cost",
                    business_unit_id=REFERENCE_ID,
                    limit=2,
                ),
            )
        self.assertEqual(turnovers["count"], 2)
        self.assertTrue(turnovers["pagination"]["truncated"])
        self.assertIn(("$top", 3), captured_virtual_parameters)

        bank_spec = runtime.GENERAL_FINANCIAL_RECORD_SPECS["bank_payment"]
        bank_row = source_record(bank_spec["fields"], record_id=DOCUMENT_ID)
        bank_row.update(
            {
                "БанковскийСчет_Key": REFERENCE_ID,
                "НомерСчета": "40702810-must-not-leak",
                "НазначениеПлатежа": "must-not-leak",
            },
        )
        captured_record_parameters: list[tuple[str, object]] = []

        def record_source(
            _config: object,
            _credentials: object,
            entity: str,
            parameters: object,
            *,
            diagnostic_stage: str,
        ) -> dict[str, object]:
            self.assertEqual(entity, bank_spec["entity"])
            self.assertEqual(
                diagnostic_stage,
                "general.financial.record.bank_payment.search",
            )
            captured_record_parameters.extend(parameters)
            return {"value": [bank_row]}

        with (
            mock.patch.object(
                runtime,
                "_connected_context",
                side_effect=self.connected_context,
            ),
            mock.patch.object(runtime, "_request_odata", side_effect=record_source),
            mock.patch.object(runtime, "save_access_state"),
        ):
            payments = runtime.command_general_search_financial_records(
                finance_args(
                    "bank_payment",
                    business_unit_id=ITEM_ID,
                    limit=2,
                ),
            )
        query = json.dumps(captured_record_parameters, ensure_ascii=False)
        serialized = json.dumps(payments, ensure_ascii=False)
        self.assertNotIn("БанковскийСчет", query)
        self.assertNotIn("НомерСчета", query)
        self.assertNotIn("НазначениеПлатежа", query)
        self.assertNotIn("must-not-leak", serialized)
        self.assertNotIn("40702810", serialized)

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
