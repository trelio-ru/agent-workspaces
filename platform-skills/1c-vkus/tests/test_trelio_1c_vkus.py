from __future__ import annotations

import dataclasses
import datetime as dt
import http.client
import importlib.util
import io
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
        "budget_item_id": "",
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

    def test_release_owns_credentials_and_has_no_metadata_code_path(self) -> None:
        source = SCRIPT.read_text(encoding="utf-8")

        self.assertEqual(runtime.RUNTIME_VERSION, "1.2.2")
        self.assertEqual(runtime.CREDENTIAL_PROVIDER_NAMESPACE, "1c-vkus")
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

    def test_main_emits_utf8_when_windows_stdout_uses_cp1251(self) -> None:
        """The JSON wire format must not inherit the Windows ANSI code page."""

        raw_stdout = io.BytesIO()
        cp1251_stdout = io.TextIOWrapper(raw_stdout, encoding="cp1251")
        parser = mock.Mock()
        parser.parse_args.return_value = Namespace(
            handler=lambda _args: {"message": "Проверка UTF-8"},
        )

        with (
            mock.patch.object(runtime, "build_parser", return_value=parser),
            mock.patch.object(sys, "stdout", cp1251_stdout),
        ):
            exit_code = runtime.main(expected_skill_id=runtime.VKUS_SKILL_ID)

        # Detach the wrapper so its finalizer cannot close the BytesIO before
        # the byte-level assertion. The runtime itself has already flushed the
        # protocol line through the binary stream.
        cp1251_stdout.detach()
        output = raw_stdout.getvalue()

        self.assertEqual(exit_code, 0)
        self.assertEqual(
            output,
            '{"ok":true,"message":"Проверка UTF-8"}\n'.encode("utf-8"),
        )
        self.assertEqual(json.loads(output.decode("utf-8"))["message"], "Проверка UTF-8")

    def test_page_limit_change_migrates_legacy_session_without_relogin(self) -> None:
        """The reviewed 3 -> 10 page change cannot redirect credentials."""

        # Runtime 1.2.0 stored only the complete connection-policy hash. Keep
        # that exact legacy shape to prove an untouched employee device can be
        # migrated on its first command after the administrative limit change.
        runtime._write_private_json(
            runtime.credentials_path(self.identity),
            {
                "schemaVersion": 1,
                "fingerprint": self.config.fingerprint,
                "username": self.credentials.username,
                "password": self.credentials.password,
            },
        )
        runtime._write_private_json(
            runtime.access_state_path(self.identity),
            {
                "schemaVersion": 1,
                "fingerprint": self.config.fingerprint,
                "status": "connected",
            },
        )
        expanded_raw = json.loads(os.environ[runtime.CONNECTION_CONFIG_ENV])
        expanded_raw["maxPages"] = 10
        with mock.patch.dict(
            os.environ,
            {runtime.CONNECTION_CONFIG_ENV: json.dumps(expanded_raw)},
        ):
            expanded = runtime.load_company_config()
            loaded = runtime.load_credentials(self.identity, expanded)
            state = runtime.load_access_state(self.identity, expanded)

        self.assertEqual(loaded, self.credentials)
        self.assertEqual(state["status"], "connected")
        self.assertFalse(state["connectionChanged"])
        migrated_credentials = runtime._read_private_json(
            runtime.credentials_path(self.identity),
        )
        migrated_state = runtime._read_private_json(
            runtime.access_state_path(self.identity),
        )
        self.assertEqual(
            migrated_credentials["credentialTargetFingerprint"],
            expanded.credential_target_fingerprint,
        )
        self.assertEqual(
            migrated_state["credentialTargetFingerprint"],
            expanded.credential_target_fingerprint,
        )

    def test_endpoint_change_still_rejects_legacy_credentials(self) -> None:
        """Operational compatibility must never cross a credential destination."""

        runtime._write_private_json(
            runtime.credentials_path(self.identity),
            {
                "schemaVersion": 1,
                "fingerprint": self.config.fingerprint,
                "username": self.credentials.username,
                "password": self.credentials.password,
            },
        )
        changed_raw = json.loads(os.environ[runtime.CONNECTION_CONFIG_ENV])
        changed_raw["odataBaseUrl"] = "https://changed.example.test/odata/"
        with mock.patch.dict(
            os.environ,
            {runtime.CONNECTION_CONFIG_ENV: json.dumps(changed_raw)},
        ):
            changed = runtime.load_company_config()
            with self.assertRaises(runtime.OneCEdoError) as caught:
                runtime.load_credentials(self.identity, changed)

        self.assertEqual(caught.exception.code, "credentials_missing")

    def test_connect_uses_protected_browser_without_autocomplete(self) -> None:
        page = runtime.browser_prompt_app_page().decode("utf-8")
        expected = runtime.Credentials("employee", "password")

        self.assertIn("Trelio — 1С", page)
        self.assertIn('<form id="prompt-form" autocomplete="off">', page)
        self.assertIn('type="${inputType}" autocomplete="off"', page)
        self.assertIn("Сохранять данные в браузере не нужно", page)
        self.assertIn("подключение будет сохранено отдельно на этом устройстве", page)
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

    def test_connect_openers_use_default_browser(self) -> None:
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

    def test_connect_loopback_rejects_cross_origin_submit(self) -> None:
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
        self.assertIs(
            parser.parse_args(["connect"]).handler,
            runtime.command_connect,
        )
        self.assertIs(
            parser.parse_args(["doctor"]).handler,
            runtime.command_doctor,
        )
        self.assertIs(
            parser.parse_args(["access-status", "show"]).handler,
            runtime.command_access_show,
        )
        self.assertIs(
            parser.parse_args(
                [
                    "get-budget-turnover-details",
                    "--date-from",
                    "2026-06-01",
                    "--date-to",
                    "2026-06-30",
                    "--business-unit-id",
                    REFERENCE_ID,
                    "--budget-item-id",
                    ITEM_ID,
                    "--include-sensitive",
                ],
            ).handler,
            runtime.command_general_get_budget_turnover_details,
        )
        with self.assertRaises(SystemExit):
            parser.parse_args(["developer-inventory-metadata"])

    def test_connection_probe_uses_only_the_signed_broad_registry(self) -> None:
        with mock.patch.object(runtime, "_request_odata", return_value={}) as request:
            runtime._probe_personal_connection(
                self.config,
                self.credentials,
                diagnostic_stage="doctor.probe",
            )

        self.assertEqual(request.call_args.args[2], "Catalog_Организации")
        self.assertEqual(
            request.call_args.args[3],
            (("$select", "Ref_Key"), ("$top", 1)),
        )

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

        self.assertEqual(result["registryVersion"], 5)
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
        self.assertEqual(len(result["sections"]["references"]), 13)
        self.assertEqual(len(result["sections"]["documents"]), 8)
        self.assertEqual(len(result["sections"]["financialTurnovers"]), 10)
        self.assertEqual(len(result["sections"]["financialRecords"]), 3)
        self.assertEqual(len(result["sections"]["balances"]), 2)
        self.assertEqual(
            result["sections"]["budgetDrilldowns"],
            [
                {
                    "kind": "budget",
                    "status": "supported",
                    "filters": ["period", "business_unit", "budget_item"],
                    "registrarTypes": [
                        "internal_consumption",
                        "purchase",
                        "service_purchase",
                        "expense_report",
                    ],
                    "controlRegistrarTypes": ["expense_distribution"],
                    "coverage": "fail_closed_all_active_registrars",
                    "sensitiveConfirmationRequired": True,
                    "capabilityDigest": result["schema"]["capabilityDigests"][
                        "financial_turnover.budget"
                    ],
                },
            ],
        )
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
        self.assertEqual(
            result["limits"],
            {
                "maxPageSize": 50,
                "maxFinancialPageSize": 50,
                # The test connection remains tightened to three pages.  The
                # signed package ceiling is asserted separately below.
                "maxPages": 3,
                "maxLines": 500,
                "maxFinancialPeriodDays": 366,
                "requestTimeoutSeconds": 20,
                "responseBytes": runtime.MAX_ODATA_RESPONSE_BYTES,
            },
        )
        self.assertNotIn("metadataBytes", result["limits"])

    def test_expanded_read_limits_remain_bounded_by_connection_policy(self) -> None:
        """The package can cover a year, while live policy may stay stricter."""

        permissive = dataclasses.replace(self.config, max_pages=10, max_rows=50)
        self.assertEqual(
            runtime._general_page(Namespace(page=10, limit=50), permissive),
            (10, 50),
        )
        self.assertEqual(
            runtime._general_financial_page(
                Namespace(page=10, limit=50),
                permissive,
            ),
            (10, 50),
        )
        self.assertEqual(
            runtime._general_financial_period(
                Namespace(date_from="2024-01-01", date_to="2024-12-31"),
            ),
            (dt.date(2024, 1, 1), dt.date(2025, 1, 1)),
        )
        with self.assertRaises(runtime.OneCEdoError) as caught:
            runtime._general_page(Namespace(page=4, limit=50), self.config)
        self.assertEqual(caught.exception.code, "page_out_of_range")

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
            "budget_item_id": "",
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
            lambda: runtime.command_general_get_budget_turnover_details(
                Namespace(
                    date_from="2026-07-01",
                    date_to="2026-07-31",
                    business_unit_id=REFERENCE_ID,
                    budget_item_id=ITEM_ID,
                    limit=3,
                    include_sensitive=True,
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

    def test_internal_consumption_enrichment_joins_only_fixed_safe_fields(self) -> None:
        """Item/unit labels and register amounts are merged by exact UUID/line."""

        document = {
            "id": DOCUMENT_ID,
            "date": "2026-06-15T10:00:00",
            "businessUnitId": REFERENCE_ID,
            "lines": [
                {
                    "lineNumber": 1,
                    "itemId": ITEM_ID,
                    "unitId": None,
                    "quantity": 4.0,
                    "amount": None,
                    "expenseItemReference": COMPANY_ID,
                    "expenseItemType": (
                        "StandardODATA.ChartOfCharacteristicTypes_СтатьиРасходов"
                    ),
                },
            ],
            "lineInfo": {"included": True},
        }
        maps = {
            "item": {
                ITEM_ID: {
                    "id": ITEM_ID,
                    "name": "Защитное стекло для планшета (ГФУ 10.6)",
                    "unitId": REFERENCE_ID,
                },
            },
            "unit": {
                REFERENCE_ID: {
                    "id": REFERENCE_ID,
                    "name": "Штука",
                    "fullName": "штука",
                    "unitSymbol": "шт",
                },
            },
            "budget_item": {
                COMPANY_ID: {
                    "id": COMPANY_ID,
                    "name": "66 Инвентарь и мелкое оборудование",
                },
            },
        }
        budget_rows = [
            {
                "dimensions": {
                    "registrarReference": DOCUMENT_ID,
                    "registrarType": (
                        "StandardODATA.Document_ВнутреннееПотребление"
                    ),
                    "lineNumber": 1,
                    "budgetItemReference": COMPANY_ID,
                    "businessUnitId": REFERENCE_ID,
                },
                "metrics": {"amount": 1232.0},
            },
        ]

        with (
            mock.patch.object(
                runtime,
                "_general_reference_map_by_ids",
                side_effect=lambda _config, _credentials, kind, _ids: maps[kind],
            ),
            mock.patch.object(
                runtime,
                "_general_budget_turnover_rows",
                return_value=(budget_rows, False),
            ) as budget_query,
        ):
            result = runtime._general_enrich_internal_consumption_document(
                self.config,
                self.credentials,
                document,
            )

        line = result["lines"][0]
        self.assertEqual(
            line["itemName"],
            "Защитное стекло для планшета (ГФУ 10.6)",
        )
        self.assertEqual(line["unit"]["symbol"], "шт")
        self.assertEqual(line["quantity"], 4.0)
        self.assertEqual(line["amount"], 1232)
        self.assertEqual(
            line["budgetItems"],
            [{"id": COMPANY_ID, "name": "66 Инвентарь и мелкое оборудование"}],
        )
        self.assertEqual(line["expenseItem"]["id"], COMPANY_ID)
        self.assertEqual(result["lineEnrichment"]["status"], "complete")
        self.assertEqual(
            budget_query.call_args.kwargs["registrar_id"],
            DOCUMENT_ID,
        )
        self.assertEqual(
            budget_query.call_args.kwargs["business_unit_id"],
            "",
        )

    def test_service_and_expense_report_lines_use_fixed_collections(self) -> None:
        """New document adapters normalize business text and stable row ids."""

        service_spec = runtime.GENERAL_DOCUMENT_SPECS["service_purchase"][0]
        service_raw = source_record(service_spec["fields"], record_id=DOCUMENT_ID)
        service_line = source_record(service_spec["lineFields"])
        service_line.update({
            "LineNumber": "1",
            "Содержание": "Обработка анкет соискателей, стандартное интервью",
            "Количество": 1.0,
            "Цена": 1270.87,
            "Сумма": 1270.87,
            "СуммаНДС": 0.0,
            "СуммаСНДС": 1270.87,
            "СтатьяРасходов": ITEM_ID,
            "СтатьяРасходов_Type": (
                "StandardODATA.ChartOfCharacteristicTypes_СтатьиРасходов"
            ),
            "ИдентификаторСтроки": "service-line-1",
        })
        service_raw["Расходы"] = [service_line]
        service = runtime._general_document_record(
            "service_purchase",
            service_spec,
            service_raw,
            matched_by=["id"],
            include_lines=True,
            line_limit=10,
        )
        self.assertEqual(service["lines"][0]["content"], service_line["Содержание"])
        self.assertEqual(service["lines"][0]["expenseItemReference"], ITEM_ID)
        self.assertEqual(service["lines"][0]["sourceLineId"], "service-line-1")

        report_spec = runtime.GENERAL_DOCUMENT_SPECS["expense_report"][0]
        report_raw = source_record(report_spec["fields"], record_id=DOCUMENT_ID)
        report_raw.update({
            "СуммаИзрасходовано": 37968.79,
            "НазначениеАванса": "Хозяйственные расходы",
            "ДатаУтверждения": "2026-06-30T12:00:00",
        })
        report_line = source_record(report_spec["lineFields"])
        report_line.update({
            "LineNumber": "1",
            "Сумма": 20000.0,
            "Содержание": "Расход, признанный в мае",
            "Комментарий": "Не повторять в июне",
            "СтатьяРасходов": ITEM_ID,
            "СтатьяРасходов_Type": (
                "StandardODATA.ChartOfCharacteristicTypes_СтатьиРасходов"
            ),
            "ИдентификаторСтроки": "advance-line-1",
            "Отменено": False,
        })
        report_raw["ПрочиеРасходы"] = [report_line]
        report = runtime._general_document_record(
            "expense_report",
            report_spec,
            report_raw,
            matched_by=["id"],
            include_lines=True,
            line_limit=10,
        )
        self.assertEqual(report["amount"], 37968.79)
        self.assertEqual(report["advancePurpose"], "Хозяйственные расходы")
        self.assertEqual(report["lines"][0]["sourceLineId"], "advance-line-1")

    def test_line_reference_enrichment_builds_cross_period_deduplication_key(self) -> None:
        document = {
            "id": DOCUMENT_ID,
            "kind": "expense_report",
            "type": "expense_report",
            "lines": [
                {
                    "lineNumber": 1,
                    "sourceLineId": "advance-line-1",
                    "itemId": None,
                    "unitId": None,
                    "expenseItemId": ITEM_ID,
                },
            ],
            "lineInfo": {"included": True},
        }

        def reference_map(
            _config: object,
            _credentials: object,
            kind: str,
            _references: object,
        ) -> dict[str, dict[str, object]]:
            return (
                {
                    ITEM_ID: {
                        "id": ITEM_ID,
                        "name": "Прочие",
                    },
                }
                if kind == "budget_item"
                else {}
            )

        with mock.patch.object(
            runtime,
            "_general_reference_map_by_ids",
            side_effect=reference_map,
        ):
            result = runtime._general_enrich_document_line_references(
                self.config,
                self.credentials,
                document,
            )

        line = result["lines"][0]
        self.assertEqual(
            line["sourceLineKey"],
            f"expense_report:{DOCUMENT_ID}:advance-line-1",
        )
        self.assertEqual(line["expenseItem"]["name"], "Прочие")

    def test_budget_drilldown_aggregates_lines_and_resolves_fixed_registrars(self) -> None:
        """Several register rows for one document become one reconciled header."""

        internal_type = "StandardODATA.Document_ВнутреннееПотребление"
        distribution_type = "StandardODATA.Document_РаспределениеПрочихЗатрат"

        def turnover_row(
            registrar: str,
            line: int,
            amount: float,
            registrar_type: str = internal_type,
        ) -> dict[str, object]:
            return {
                "dimensions": {
                    "budgetItemReference": ITEM_ID,
                    "businessUnitId": REFERENCE_ID,
                    "registrarReference": registrar,
                    "registrarType": registrar_type,
                    "lineNumber": line,
                },
                "metrics": {"amount": amount},
            }

        budget_rows = [
            turnover_row(DOCUMENT_ID, 1, 1000.0),
            turnover_row(DOCUMENT_ID, 2, 232.0),
            turnover_row(COMPANY_ID, 1, 1036.0),
            turnover_row(REFERENCE_ID, 1, 2268.0, distribution_type),
        ]

        def document_by_id(
            _config: object,
            _credentials: object,
            _kind: str,
            reference: str,
            **_kwargs: object,
        ) -> list[dict[str, object]]:
            number = "ВККА-001511" if reference == DOCUMENT_ID else "ВККА-001421"
            return [
                {
                    "id": reference,
                    "number": number,
                    "date": "2026-06-15T10:00:00",
                    "postingStatus": "posted",
                },
            ]

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
                    {
                        "id": ITEM_ID,
                        "kind": "budget_item",
                        "name": "66 Инвентарь и мелкое оборудование",
                    },
                ],
            ),
            mock.patch.object(
                runtime,
                "_general_budget_turnover_rows",
                return_value=(budget_rows, False),
            ),
            mock.patch.object(
                runtime,
                "_general_documents_by_id",
                side_effect=document_by_id,
            ),
            mock.patch.object(runtime, "save_access_state"),
        ):
            result = runtime.command_general_get_budget_turnover_details(
                Namespace(
                    date_from="2026-06-01",
                    date_to="2026-06-30",
                    business_unit_id=REFERENCE_ID,
                    budget_item_id=ITEM_ID,
                    limit=50,
                    include_sensitive=True,
                ),
            )

        self.assertEqual(result["total"], 2268)
        self.assertEqual(result["reconciliation"]["registrarAmountSum"], 2268)
        self.assertEqual(result["reconciliation"]["controlAmountSum"], 2268)
        self.assertTrue(result["reconciliation"]["controlMatches"])
        self.assertTrue(result["reconciliation"]["complete"])
        source_registrars = [
            item for item in result["registrars"] if item["role"] == "source"
        ]
        by_number = {item["number"]: item for item in source_registrars}
        self.assertEqual(by_number["ВККА-001511"]["amount"], 1232)
        self.assertEqual(by_number["ВККА-001421"]["amount"], 1036)
        self.assertTrue(
            all(item["type"] == "internal_consumption" for item in by_number.values()),
        )
        self.assertTrue(
            all(item["sourceType"] == internal_type for item in by_number.values()),
        )
        self.assertTrue(
            all(item["resolutionStatus"] == "resolved" for item in by_number.values()),
        )
        self.assertEqual(
            result["budgetItem"]["name"],
            "66 Инвентарь и мелкое оборудование",
        )

    def test_budget_drilldown_unknown_registrar_blocks_completeness(self) -> None:
        """A zero-result adapter cannot hide an unreviewed active source type."""

        budget_rows = [
            {
                "dimensions": {
                    "budgetItemReference": ITEM_ID,
                    "businessUnitId": REFERENCE_ID,
                    "registrarReference": DOCUMENT_ID,
                    "registrarType": "StandardODATA.Document_НовыйТипРасхода",
                    "lineNumber": 1,
                },
                "metrics": {"amount": 500.0},
            },
        ]
        with (
            mock.patch.object(
                runtime,
                "_connected_context",
                side_effect=self.connected_context,
            ),
            mock.patch.object(runtime, "_general_reference_by_id", return_value=[]),
            mock.patch.object(
                runtime,
                "_general_budget_turnover_rows",
                return_value=(budget_rows, False),
            ),
            mock.patch.object(runtime, "save_access_state"),
        ):
            result = runtime.command_general_get_budget_turnover_details(
                Namespace(
                    date_from="2026-06-01",
                    date_to="2026-06-30",
                    business_unit_id=REFERENCE_ID,
                    budget_item_id=ITEM_ID,
                    limit=50,
                    include_sensitive=True,
                ),
            )

        self.assertEqual(result["total"], 0)
        self.assertFalse(result["reconciliation"]["complete"])
        self.assertEqual(result["reconciliation"]["unknownAmountSum"], 500)
        self.assertEqual(
            result["reconciliation"]["unknownRegistrarTypes"],
            ["StandardODATA.Document_НовыйТипРасхода"],
        )

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
                date_from="2025-01-01",
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

    def test_budget_filter_uses_only_fixed_direct_guid_literals(self) -> None:
        """The article filter accepts a UUID value, never an OData clause."""

        spec = runtime.GENERAL_FINANCIAL_TURNOVER_SPECS["budget"]
        filter_value, matched = runtime._general_financial_filter(
            finance_args(
                "budget",
                business_unit_id=REFERENCE_ID,
                budget_item_id=ITEM_ID,
            ),
            spec,
        )

        self.assertIn(
            f"Подразделение_Key eq guid'{REFERENCE_ID}'",
            filter_value,
        )
        self.assertIn(
            f"СтатьяРасходов_Key eq guid'{ITEM_ID}'",
            filter_value,
        )
        self.assertEqual(matched, ["business_unit", "budget_item"])
        with self.assertRaises(runtime.OneCEdoError) as caught:
            runtime._general_financial_filter(
                finance_args(
                    "budget",
                    business_unit_id=REFERENCE_ID,
                    budget_item_id="x' or true",
                ),
                spec,
            )
        self.assertEqual(caught.exception.code, "invalid_identity")

        with self.assertRaises(runtime.OneCEdoError) as caught:
            runtime._general_financial_filter(
                finance_args(
                    "sales_cost",
                    business_unit_id=REFERENCE_ID,
                    budget_item_id=ITEM_ID,
                ),
                runtime.GENERAL_FINANCIAL_TURNOVER_SPECS["sales_cost"],
            )
        self.assertEqual(caught.exception.code, "filter_unsupported")

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

        budget_spec = runtime.GENERAL_FINANCIAL_TURNOVER_SPECS["budget"]
        self.assertEqual(budget_spec["transport"], "record_table")
        self.assertEqual(
            budget_spec["entity"],
            "AccumulationRegister_ПрочиеРасходы_RecordType",
        )
        self.assertIn("Recorder", budget_spec["fields"])
        self.assertIn("LineNumber", budget_spec["fields"])
        self.assertIn(budget_spec["entity"], runtime.GENERAL_ODATA_ENTITIES)
        with self.assertRaises(runtime.OneCEdoError) as caught:
            runtime._general_virtual_url(
                self.config,
                budget_spec,
                runtime.dt.date(2026, 6, 1),
                runtime.dt.date(2026, 7, 1),
                (),
            )
        self.assertEqual(caught.exception.code, "query_builder_error")

    def test_budget_record_page_uses_only_fixed_record_table_filters(self) -> None:
        """Budget detail is bounded raw data, never a caller-built query."""

        captured: dict[str, object] = {}

        def record_source(
            _config: object,
            _credentials: object,
            entity: str,
            parameters: object,
            *,
            diagnostic_stage: str,
        ) -> dict[str, object]:
            captured.update(
                entity=entity,
                parameters=parameters,
                diagnostic_stage=diagnostic_stage,
            )
            return {"value": []}

        with mock.patch.object(
            runtime,
            "_request_odata",
            side_effect=record_source,
        ), mock.patch.object(
            runtime,
            "_request_general_virtual_table",
            side_effect=AssertionError("budget must not use Turnovers"),
        ):
            rows = runtime._general_budget_record_page(
                self.config,
                self.credentials,
                start=runtime.dt.date(2026, 6, 1),
                end_exclusive=runtime.dt.date(2026, 7, 1),
                business_unit_id=REFERENCE_ID,
                budget_item_id=ITEM_ID,
                registrar_id=DOCUMENT_ID,
                skip=0,
                top=51,
            )

        self.assertEqual(rows, [])
        self.assertEqual(
            captured["entity"],
            "AccumulationRegister_ПрочиеРасходы_RecordType",
        )
        parameters = dict(captured["parameters"])
        filter_value = str(parameters["$filter"])
        self.assertIn("Active eq true", filter_value)
        self.assertNotIn("Recorder_Type", filter_value)
        self.assertIn(f"Подразделение_Key eq guid'{REFERENCE_ID}'", filter_value)
        self.assertIn(
            f"СтатьяРасходов_Key eq guid'{ITEM_ID}'",
            filter_value,
        )
        self.assertIn(
            f"Recorder eq cast(guid'{DOCUMENT_ID}', 'Document_ВнутреннееПотребление')",
            filter_value,
        )
        self.assertEqual(parameters["$top"], 51)
        self.assertNotIn("Dimensions", str(captured))
        self.assertNotIn("Turnovers", str(captured))

    def test_budget_record_page_accepts_exact_registrar_without_unit_scope(self) -> None:
        """Document enrichment must not assume two UUID namespaces coincide."""

        captured_parameters: list[tuple[str, object]] = []

        def record_source(
            _config: object,
            _credentials: object,
            _entity: str,
            parameters: object,
            *,
            diagnostic_stage: str,
        ) -> dict[str, object]:
            self.assertEqual(
                diagnostic_stage,
                "general.financial.turnover.budget.search",
            )
            captured_parameters.extend(parameters)
            return {"value": []}

        with mock.patch.object(
            runtime,
            "_request_odata",
            side_effect=record_source,
        ):
            runtime._general_budget_record_page(
                self.config,
                self.credentials,
                start=runtime.dt.date(2026, 6, 1),
                end_exclusive=runtime.dt.date(2026, 7, 1),
                registrar_id=DOCUMENT_ID,
                skip=0,
                top=51,
            )

        filter_value = str(dict(captured_parameters)["$filter"])
        self.assertIn(
            f"Recorder eq cast(guid'{DOCUMENT_ID}', 'Document_ВнутреннееПотребление')",
            filter_value,
        )
        self.assertNotIn("Подразделение_Key", filter_value)
        self.assertNotIn("Period ge", filter_value)
        self.assertNotIn("Period lt", filter_value)
        with self.assertRaises(runtime.OneCEdoError) as caught:
            runtime._general_budget_record_page(
                self.config,
                self.credentials,
                start=runtime.dt.date(2026, 6, 1),
                end_exclusive=runtime.dt.date(2026, 7, 1),
                skip=0,
                top=51,
            )
        self.assertEqual(caught.exception.code, "scope_filter_required")

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
