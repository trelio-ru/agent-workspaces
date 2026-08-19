from __future__ import annotations

import importlib.util
import hashlib
import io
import json
import os
import unittest
import urllib.error
from pathlib import Path
from unittest import mock


SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
os.sys.path.insert(0, str(SCRIPTS))
MODULE_PATH = SCRIPTS / "trelio_one_c_vkus_kadry_runtime.py"
SPEC = importlib.util.spec_from_file_location("hr_runtime", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class Response(io.BytesIO):
    def __init__(
        self,
        value: bytes,
        headers: dict[str, str] | None = None,
    ) -> None:
        super().__init__(value)
        self.headers = headers or {}

    def __enter__(self) -> "Response":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()


class VkusHrRuntimeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.registry = MODULE._load_registry()
        self.employee_source = next(
            source
            for source in self.registry["sources"]
            if source["title"] == "\u0421\u043e\u0442\u0440\u0443\u0434\u043d\u0438\u043a\u0438"
        )
        self.leave_balance_source = next(
            source
            for source in self.registry["sources"]
            if source["title"] == "РасчетРезерваОтпусков"
        )
        self.attachment_source = next(
            source
            for source in self.registry["attachmentSources"]
            if source["title"] == "\u0411\u043e\u043b\u044c\u043d\u0438\u0447\u043d\u044b\u0439\u041b\u0438\u0441\u0442"
        )

    def test_release_versions_are_current(self) -> None:
        self.assertEqual(MODULE.RUNTIME_VERSION, "1.1.0")
        self.assertEqual(MODULE.provider.RUNTIME_VERSION, "1.1.0")
        self.assertEqual(
            MODULE.provider.SUPPORTED_SKILL_IDS,
            {MODULE.HR_SKILL_ID},
        )
        self.assertEqual(
            MODULE.provider.CREDENTIAL_PROVIDER_NAMESPACE,
            "1c-vkus-kadry",
        )

    def _attachment_row(
        self,
        *,
        owner_id: str,
        file_id: str,
        declared_size: int,
    ) -> dict[str, object]:
        return {
            field["name"]: (
                file_id
                if field["name"] == "Ref_Key"
                else owner_id
                if field["name"] == "ВладелецФайла_Key"
                else declared_size
                if field["name"] == "Размер"
                else False
                if field["type"] == "Edm.Boolean"
                else "pdf"
            )
            for field in self.attachment_source["metadataFields"]
        }

    def _company_config(self) -> object:
        return MODULE.provider.CompanyConfig(
            odata_base_url="https://example.com/odata/",
            files_base_url="https://example.com/files/",
            max_rows=10,
            max_pages=3,
            max_file_bytes=1_000_000,
            request_timeout_seconds=1.0,
            access_help_url=None,
            access_instructions=None,
            fingerprint="a" * 64,
        )

    def _leave_balance_row(
        self,
        *,
        subject_id: str = "11111111-1111-4111-8111-111111111111",
        physical_person_id: str = "22222222-2222-4222-8222-222222222222",
        line_number: int = 1,
        **overrides: object,
    ) -> dict[str, object]:
        row: dict[str, object] = {
            "Recorder": "Document_LeaveReserve",
            "Period": "2026-07-31T23:59:59",
            "LineNumber": line_number,
            "Active": True,
            "Сотрудник_Key": subject_id,
            "ФизическоеЛицо_Key": physical_person_id,
            "ПериодРасчета": "2026-07-01T00:00:00",
            "ОстатокОтпуска": 64.0,
            "ОтпускАвансом": 0.0,
        }
        row.update(overrides)
        return row

    def _pdf_payload(self) -> bytes:
        prefix = (
            b"%PDF-1.4\n"
            b"1 0 obj\n"
            b"<< /Type /Catalog >>\n"
            b"endobj\n"
        )
        xref_offset = len(prefix)
        return (
            prefix
            + b"xref\n"
            + b"0 2\n"
            + b"0000000000 65535 f \n"
            + b"0000000009 00000 n \n"
            + b"trailer\n"
            + b"<< /Size 2 /Root 1 0 R >>\n"
            + b"startxref\n"
            + str(xref_offset).encode("ascii")
            + b"\n%%EOF\n"
        )

    def test_registry_is_fixed_and_contains_full_hr_categories(self) -> None:
        self.assertEqual(self.registry["sourceCount"], 278)
        self.assertIn("people", self.registry["categories"])
        self.assertIn("employment", self.registry["categories"])
        self.assertIn("health", self.registry["categories"])
        self.assertIn("payroll", self.registry["categories"])
        self.assertIn("taxes", self.registry["categories"])
        self.assertTrue(self.registry["safety"]["readOnly"])
        self.assertFalse(self.registry["safety"]["arbitraryEntity"])
        self.assertFalse(self.registry["safety"]["massExport"])
        self.assertEqual(self.registry["attachmentSourceCount"], 150)
        self.assertTrue(self.registry["safety"]["exactAttachmentDownload"])

    def test_sensitive_fields_require_explicit_selection(self) -> None:
        safe = MODULE._selected_fields(
            self.employee_source,
            include_sensitive=False,
        )
        full = MODULE._selected_fields(
            self.employee_source,
            include_sensitive=True,
        )

        self.assertLess(len(safe), len(full))
        self.assertTrue(all(field["sensitive"] is False for field in safe))
        self.assertTrue(any(field["sensitive"] is True for field in full))

    def test_leave_balance_uses_only_fixed_minimal_signed_fields(self) -> None:
        self.assertEqual(
            self.leave_balance_source["key"],
            MODULE.LEAVE_BALANCE_SOURCE_KEY,
        )
        subject_id = "11111111-1111-4111-8111-111111111111"
        row = self._leave_balance_row(subject_id=subject_id)
        response = Response(
            json.dumps({"value": [row]}, ensure_ascii=False).encode("utf-8"),
        )
        opened_urls: list[str] = []

        def fake_open(_: str, url: str, **__: object) -> Response:
            opened_urls.append(url)
            return response

        with (
            mock.patch.object(
                MODULE,
                "_connected_context",
                return_value=(
                    self._company_config(),
                    MODULE.provider.Credentials("employee", "password"),
                ),
            ),
            mock.patch.object(
                MODULE.provider,
                "_require_x_odata",
                return_value="x" * 32,
            ),
            mock.patch.object(
                MODULE.provider,
                "_http_open",
                side_effect=fake_open,
            ),
        ):
            result = MODULE.command_get_leave_balance(mock.Mock(
                subject_id=subject_id,
                as_of="2026-08-20",
                include_sensitive=True,
            ))

        self.assertTrue(result["found"])
        self.assertEqual(result["balanceDays"], 64.0)
        self.assertEqual(result["advancedDays"], 0.0)
        self.assertEqual(result["recordedAt"], "2026-07-31T23:59:59")
        self.assertEqual(result["matchedSubjectKind"], "employee")
        self.assertEqual(result["basis"], "one_c_leave_reserve_register")
        self.assertEqual(len(opened_urls), 1)
        url_tools = __import__("urllib.parse").parse
        decoded_url = url_tools.unquote(opened_urls[0])
        query = url_tools.parse_qs(url_tools.urlparse(opened_urls[0]).query)
        self.assertEqual(
            set(query["$select"][0].split(",")),
            {name for name, _, _ in MODULE.LEAVE_BALANCE_FIELD_CONTRACT},
        )
        self.assertEqual(
            query["$orderby"],
            ["Period desc,Recorder desc,LineNumber desc"],
        )
        self.assertIn("InformationRegister_РасчетРезерваОтпусков_RecordType", decoded_url)
        self.assertIn("Active eq true", decoded_url)
        self.assertIn("Period lt datetime'2026-08-21T00:00:00'", decoded_url)
        self.assertIn(subject_id, decoded_url)
        self.assertNotIn("СуммаРезерва", decoded_url)
        self.assertNotIn("СреднийЗаработок", decoded_url)
        self.assertLess(len(opened_urls[0]), 2_000)

    def test_leave_balance_requires_explicit_sensitive_access(self) -> None:
        with self.assertRaises(MODULE.HrRuntimeError) as caught:
            MODULE.command_get_leave_balance(mock.Mock(
                subject_id="11111111-1111-4111-8111-111111111111",
                as_of="2026-08-20",
                include_sensitive=False,
            ))

        self.assertEqual(
            caught.exception.code,
            "explicit_sensitive_access_required",
        )

    def test_leave_balance_fails_closed_on_conflicting_latest_rows(self) -> None:
        rows = [
            self._leave_balance_row(line_number=1, ОстатокОтпуска=64.0),
            self._leave_balance_row(line_number=2, ОстатокОтпуска=65.0),
        ]
        with mock.patch.object(MODULE, "_request_rows", return_value=rows):
            with self.assertRaises(MODULE.HrRuntimeError) as caught:
                MODULE.command_get_leave_balance(mock.Mock(
                    subject_id="11111111-1111-4111-8111-111111111111",
                    as_of="2026-08-20",
                    include_sensitive=True,
                ))

        self.assertEqual(caught.exception.code, "leave_balance_ambiguous")

    def test_leave_balance_rejects_ignored_server_filters(self) -> None:
        foreign_employee = "33333333-3333-4333-8333-333333333333"
        cases = (
            (
                "foreign subject",
                self._leave_balance_row(subject_id=foreign_employee),
            ),
            (
                "inactive movement",
                self._leave_balance_row(Active=False),
            ),
            (
                "future movement",
                self._leave_balance_row(Period="2026-08-21T00:00:00"),
            ),
        )
        for label, row in cases:
            with self.subTest(label=label):
                with mock.patch.object(MODULE, "_request_rows", return_value=[row]):
                    with self.assertRaises(MODULE.HrRuntimeError) as caught:
                        MODULE.command_get_leave_balance(mock.Mock(
                            subject_id="11111111-1111-4111-8111-111111111111",
                            as_of="2026-08-20",
                            include_sensitive=True,
                        ))
                self.assertEqual(caught.exception.code, "source_contract_mismatch")

    def test_leave_balance_rejects_missing_or_non_finite_balance(self) -> None:
        cases = (
            (None, "leave_balance_unavailable"),
            (float("nan"), "source_contract_mismatch"),
            (float("inf"), "source_contract_mismatch"),
        )
        for balance, expected_code in cases:
            with self.subTest(balance=balance):
                row = self._leave_balance_row(ОстатокОтпуска=balance)
                with mock.patch.object(MODULE, "_request_rows", return_value=[row]):
                    with self.assertRaises(MODULE.HrRuntimeError) as caught:
                        MODULE.command_get_leave_balance(mock.Mock(
                            subject_id="11111111-1111-4111-8111-111111111111",
                            as_of="2026-08-20",
                            include_sensitive=True,
                        ))
                self.assertEqual(caught.exception.code, expected_code)

    def test_leave_balance_reads_conflict_beyond_first_page(self) -> None:
        first_page = [
            self._leave_balance_row(line_number=index)
            for index in range(1, MODULE.MAX_PAGE_SIZE + 1)
        ]
        second_page = [
            self._leave_balance_row(line_number=11, ОстатокОтпуска=65.0),
        ]
        with mock.patch.object(
            MODULE,
            "_request_rows",
            side_effect=[first_page, second_page],
        ) as request_rows:
            with self.assertRaises(MODULE.HrRuntimeError) as caught:
                MODULE.command_get_leave_balance(mock.Mock(
                    subject_id="11111111-1111-4111-8111-111111111111",
                    as_of="2026-08-20",
                    include_sensitive=True,
                ))

        self.assertEqual(caught.exception.code, "leave_balance_ambiguous")
        self.assertEqual(request_rows.call_count, 2)
        self.assertEqual(request_rows.call_args_list[1].kwargs["page"], 2)

    def test_leave_balance_fails_when_latest_period_exceeds_page_bound(self) -> None:
        pages = [
            [
                self._leave_balance_row(
                    line_number=(page * MODULE.MAX_PAGE_SIZE) + index,
                )
                for index in range(1, MODULE.MAX_PAGE_SIZE + 1)
            ]
            for page in range(MODULE.MAX_PAGES)
        ]
        with mock.patch.object(MODULE, "_request_rows", side_effect=pages):
            with self.assertRaises(MODULE.HrRuntimeError) as caught:
                MODULE.command_get_leave_balance(mock.Mock(
                    subject_id="11111111-1111-4111-8111-111111111111",
                    as_of="2026-08-20",
                    include_sensitive=True,
                ))

        self.assertEqual(caught.exception.code, "leave_balance_incomplete")

    def test_leave_balance_rejects_multiple_employee_cards_for_physical_person(self) -> None:
        physical_person_id = "22222222-2222-4222-8222-222222222222"
        rows = [
            self._leave_balance_row(
                subject_id="11111111-1111-4111-8111-111111111111",
                physical_person_id=physical_person_id,
                line_number=1,
            ),
            self._leave_balance_row(
                subject_id="33333333-3333-4333-8333-333333333333",
                physical_person_id=physical_person_id,
                line_number=2,
            ),
        ]
        with mock.patch.object(MODULE, "_request_rows", return_value=rows):
            with self.assertRaises(MODULE.HrRuntimeError) as caught:
                MODULE.command_get_leave_balance(mock.Mock(
                    subject_id=physical_person_id,
                    as_of="2026-08-20",
                    include_sensitive=True,
                ))

        self.assertEqual(caught.exception.code, "leave_balance_subject_ambiguous")

    def test_leave_balance_rejects_zero_subject_uuid(self) -> None:
        with self.assertRaises(MODULE.provider.OneCEdoError) as caught:
            MODULE.command_get_leave_balance(mock.Mock(
                subject_id="00000000-0000-0000-0000-000000000000",
                as_of="2026-08-20",
                include_sensitive=True,
            ))

        self.assertEqual(caught.exception.code, "invalid_identity")

    def test_leave_balance_reports_missing_direct_calculation_without_estimate(self) -> None:
        with mock.patch.object(MODULE, "_request_rows", return_value=[]):
            result = MODULE.command_get_leave_balance(mock.Mock(
                subject_id="11111111-1111-4111-8111-111111111111",
                as_of="2026-08-20",
                include_sensitive=True,
            ))

        self.assertFalse(result["found"])
        self.assertNotIn("balanceDays", result)
        self.assertNotIn("estimatedBalanceDays", result)
        self.assertEqual(result["asOfRequested"], "2026-08-20")

    def test_filters_escape_text_and_accept_only_signed_fields(self) -> None:
        expression = MODULE._build_filter(
            self.employee_source,
            query="\u041e'\u0411\u0440\u0430\u0439\u0435\u043d",
            subject_id="11111111-1111-4111-8111-111111111111",
            date_from="",
            date_to="",
        )

        self.assertIn("\u041e''\u0411\u0440\u0430\u0439\u0435\u043d", expression)
        self.assertIn("\u0424\u0438\u0437\u0438\u0447\u0435\u0441\u043a\u043e\u0435\u041b\u0438\u0446\u043e_Key", expression)
        self.assertNotIn("$select", expression)

    def test_unknown_source_key_fails_closed(self) -> None:
        with self.assertRaises(MODULE.HrRuntimeError) as caught:
            MODULE._source_by_key(self.registry, "people-000000000000")

        self.assertEqual(caught.exception.code, "source_blocked")

    def test_search_validates_response_and_omits_sensitive_fields(self) -> None:
        fields = MODULE._selected_fields(
            self.employee_source,
            include_sensitive=False,
        )
        row = {
            field["name"]: (
                "11111111-1111-4111-8111-111111111111"
                if field["type"] == "Edm.Guid"
                else False
                if field["type"] == "Edm.Boolean"
                else 1
                if field["type"].startswith("Edm.Int")
                else "\u0418\u0432\u0430\u043d\u043e\u0432"
            )
            for field in fields
        }
        response = Response(
            json.dumps(
                {"value": [row]},
                ensure_ascii=False,
            ).encode("utf-8"),
        )
        config = MODULE.provider.CompanyConfig(
            odata_base_url="https://example.com/odata/",
            files_base_url="https://example.com/files/",
            max_rows=10,
            max_pages=3,
            max_file_bytes=1_000,
            request_timeout_seconds=1.0,
            access_help_url=None,
            access_instructions=None,
            fingerprint="a" * 64,
        )
        credentials = MODULE.provider.Credentials("employee", "password")
        opened_urls: list[str] = []

        def fake_open(_: str, url: str, **__: object) -> Response:
            opened_urls.append(url)
            return response

        with (
            mock.patch.object(
                MODULE,
                "_connected_context",
                return_value=(config, credentials),
            ),
            mock.patch.object(
                MODULE.provider,
                "_require_x_odata",
                return_value="x" * 32,
            ),
            mock.patch.object(
                MODULE.provider,
                "_http_open",
                side_effect=fake_open,
            ),
        ):
            rows = MODULE._request_rows(
                self.employee_source,
                fields,
                filter_expression="",
                page=1,
                limit=1,
            )

        self.assertEqual(rows, [row])
        decoded_url = os.linesep.join(opened_urls)
        self.assertIn("$select=", decoded_url)
        sensitive_name = next(
            field["name"]
            for field in self.employee_source["fields"]
            if field["sensitive"] is True
        )
        self.assertNotIn(
            urllib_quote(sensitive_name),
            decoded_url,
        )

    def test_provider_http_429_honors_retry_after_before_retrying(self) -> None:
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
                MODULE.provider.socket,
                "getaddrinfo",
                return_value=[
                    (
                        MODULE.provider.socket.AF_INET,
                        MODULE.provider.socket.SOCK_STREAM,
                        6,
                        "",
                        ("93.184.216.34", 443),
                    ),
                ],
            ),
            mock.patch.object(
                MODULE.provider.urllib.request,
                "build_opener",
                return_value=opener,
            ),
            mock.patch.object(MODULE.provider.time, "sleep") as sleep,
        ):
            response = MODULE.provider._http_open(
                "GET",
                "https://example.test/odata/fixed",
                credentials=MODULE.provider.Credentials("employee", "password"),
                timeout=1,
                x_odata="0123456789abcdef",
                diagnostic_stage="doctor.probe",
            )

        self.assertIs(response, success)
        self.assertEqual(opener.open.call_count, 2)
        sleep.assert_called_once_with(2.0)

    def test_collections_require_sensitive_flag(self) -> None:
        args = mock.Mock(
            source_key=self.employee_source["key"],
            id="11111111-1111-4111-8111-111111111111",
            include_sensitive=False,
            include_collections=True,
            line_limit=10,
        )
        with self.assertRaises(MODULE.HrRuntimeError) as caught:
            MODULE.command_get_record(args)

        self.assertEqual(
            caught.exception.code,
            "explicit_sensitive_access_required",
        )

    def test_parser_exposes_no_entity_field_or_odata_arguments(self) -> None:
        parser = MODULE.build_parser()
        help_text = parser.format_help()

        self.assertNotIn("--entity", help_text)
        self.assertNotIn("--field", help_text)
        self.assertNotIn("--filter", help_text)
        self.assertNotIn("--url", help_text)

    def test_parser_exposes_independent_browser_first_connection_commands(self) -> None:
        parser = MODULE.build_parser()

        connect = parser.parse_args(["connect"])
        self.assertFalse(connect.terminal_prompts)
        self.assertIs(connect.handler, MODULE.command_connect)
        self.assertIs(
            parser.parse_args(["doctor"]).handler,
            MODULE.command_doctor,
        )
        self.assertIs(
            parser.parse_args(["access-status", "show"]).handler,
            MODULE.command_access_show,
        )
        page = MODULE.provider.browser_prompt_app_page().decode("utf-8")
        self.assertIn("Сохранять данные в браузере не нужно", page)
        self.assertIn('autocomplete="off"', page)

    def test_parser_exposes_dedicated_leave_balance_command(self) -> None:
        parsed = MODULE.build_parser().parse_args([
            "get-leave-balance",
            "--subject-id",
            "11111111-1111-4111-8111-111111111111",
            "--as-of",
            "2026-08-20",
            "--include-sensitive",
        ])

        self.assertIs(parsed.handler, MODULE.command_get_leave_balance)
        self.assertTrue(parsed.include_sensitive)

    def test_connect_probes_exact_signed_hr_source_without_broad_allowlist(self) -> None:
        config = self._company_config()
        credentials = MODULE.provider.Credentials("employee", "password")
        identity = MODULE.provider.Identity(
            company_id=MODULE.EXPECTED_COMPANY_ID,
            member_id="11111111-1111-4111-8111-111111111111",
            connection_id="22222222-2222-4222-8222-222222222222",
        )
        response = Response(
            json.dumps(
                {
                    "value": [
                        {MODULE.CONNECTION_PROBE_FIELD: identity.member_id},
                    ],
                },
            ).encode("utf-8"),
        )
        opened_urls: list[str] = []

        def fake_open(_: str, url: str, **__: object) -> Response:
            opened_urls.append(url)
            return response

        with (
            mock.patch.object(MODULE, "_current_identity", return_value=identity),
            mock.patch.object(
                MODULE.provider,
                "load_company_config",
                return_value=config,
            ),
            mock.patch.object(
                MODULE.provider,
                "prompt_credentials",
                return_value=credentials,
            ),
            mock.patch.object(
                MODULE.provider,
                "_require_x_odata",
                return_value="x" * 32,
            ),
            mock.patch.object(
                MODULE.provider,
                "_request_odata",
                side_effect=AssertionError("broad provider allowlist must not run"),
            ),
            mock.patch.object(
                MODULE.provider,
                "_http_open",
                side_effect=fake_open,
            ) as opened,
            mock.patch.object(MODULE.provider, "save_credentials") as save_credentials,
            mock.patch.object(MODULE.provider, "save_access_state") as save_access_state,
        ):
            result = MODULE.command_connect(mock.Mock(terminal_prompts=False))

        self.assertEqual(result, {
            "status": "connected",
            "availability": {
                "status": "available",
                "skillId": MODULE.HR_SKILL_ID,
                "action": None,
            },
        })
        decoded_url = __import__("urllib.parse").parse.unquote(opened_urls[0])
        probe_source = next(
            source
            for source in self.registry["sources"]
            if source["key"] == MODULE.CONNECTION_PROBE_SOURCE_KEY
        )
        self.assertIn(probe_source["entity"], decoded_url)
        self.assertIn("$select=Ref_Key", decoded_url)
        self.assertIn("$top=1", decoded_url)
        self.assertEqual(opened.call_args.kwargs["x_odata"], "x" * 32)
        save_credentials.assert_called_once_with(identity, config, credentials)
        save_access_state.assert_called_once_with(identity, config, "connected")

    def test_availability_explains_setup_without_selecting_another_source(self) -> None:
        self.assertEqual(MODULE._availability("unknown"), {
            "status": "setup_required",
            "skillId": MODULE.HR_SKILL_ID,
            "action": "connect",
        })
        self.assertEqual(MODULE._availability("needs_reconnect"), {
            "status": "setup_required",
            "skillId": MODULE.HR_SKILL_ID,
            "action": "reconnect",
        })
        self.assertEqual(MODULE._availability("no_access"), {
            "status": "access_required",
            "skillId": MODULE.HR_SKILL_ID,
            "action": "request_access",
        })

        missing = MODULE.provider.OneCEdoError(
            "credentials_missing",
            "Личные данные не подключены.",
        )
        company = MODULE.provider.OneCEdoError(
            "connection_not_configured",
            "Компания не настроила подключение.",
        )
        self.assertEqual(
            MODULE._safe_error(missing)["availability"]["action"],
            "connect",
        )
        self.assertEqual(
            MODULE._safe_error(company)["availability"]["action"],
            "configure_company_connection",
        )

    def test_data_request_stops_on_unknown_personal_setup(self) -> None:
        identity = MODULE.provider.Identity(
            company_id=MODULE.EXPECTED_COMPANY_ID,
            member_id="11111111-1111-4111-8111-111111111111",
            connection_id="22222222-2222-4222-8222-222222222222",
        )
        config = self._company_config()

        with (
            mock.patch.object(MODULE, "_current_identity", return_value=identity),
            mock.patch.object(
                MODULE.provider,
                "load_company_config",
                return_value=config,
            ),
            mock.patch.object(
                MODULE.provider,
                "load_access_state",
                return_value={"status": "unknown", "connectionChanged": False},
            ),
            mock.patch.object(MODULE.provider, "load_credentials") as load_credentials,
        ):
            with self.assertRaises(MODULE.HrRuntimeError) as caught:
                MODULE._connected_context()

        self.assertEqual(caught.exception.code, "access_status_unknown")
        self.assertEqual(
            MODULE._safe_error(caught.exception)["availability"]["status"],
            "setup_required",
        )
        load_credentials.assert_not_called()

    def test_parser_requires_explicit_unverified_download_flag(self) -> None:
        parsed = MODULE.build_parser().parse_args(
            [
                "download-attachment",
                "--attachment-source-key",
                self.attachment_source["key"],
                "--owner-id",
                "11111111-1111-4111-8111-111111111111",
                "--file-id",
                "22222222-2222-4222-8222-222222222222",
                "--output",
                "/tmp/contract.pdf",
                "--include-sensitive",
            ],
        )
        self.assertFalse(parsed.allow_unverified_size_mismatch)

        parsed_with_opt_in = MODULE.build_parser().parse_args(
            [
                "download-attachment",
                "--attachment-source-key",
                self.attachment_source["key"],
                "--owner-id",
                "11111111-1111-4111-8111-111111111111",
                "--file-id",
                "22222222-2222-4222-8222-222222222222",
                "--output",
                "/tmp/contract.pdf",
                "--include-sensitive",
                "--allow-unverified-size-mismatch",
            ],
        )
        self.assertTrue(
            parsed_with_opt_in.allow_unverified_size_mismatch,
        )

    def test_attachment_listing_requires_explicit_sensitive_flag(self) -> None:
        args = mock.Mock(
            attachment_source_key=self.attachment_source["key"],
            owner_id="11111111-1111-4111-8111-111111111111",
            page=1,
            limit=10,
            include_sensitive=False,
        )
        with self.assertRaises(MODULE.HrRuntimeError) as caught:
            MODULE.command_list_attachments(args)

        self.assertEqual(
            caught.exception.code,
            "explicit_sensitive_access_required",
        )

    def test_attachment_download_is_exact_bounded_atomic_and_hashed(self) -> None:
        owner_id = "11111111-1111-4111-8111-111111111111"
        file_id = "22222222-2222-4222-8222-222222222222"
        payload = self._pdf_payload()
        row = self._attachment_row(
            owner_id=owner_id,
            file_id=file_id,
            declared_size=len(payload),
        )
        config = self._company_config()
        credentials = MODULE.provider.Credentials("employee", "password")
        with __import__("tempfile").TemporaryDirectory() as directory:
            destination = Path(directory) / "contract.pdf"
            args = mock.Mock(
                attachment_source_key=self.attachment_source["key"],
                owner_id=owner_id,
                file_id=file_id,
                output=str(destination),
                include_sensitive=True,
            )
            with (
                mock.patch.object(
                    MODULE,
                    "_request_attachment_rows",
                    return_value=[row],
                ),
                mock.patch.object(
                    MODULE,
                    "_connected_context",
                    return_value=(config, credentials),
                ),
                mock.patch.object(
                    MODULE.provider,
                    "_require_x_odata",
                    return_value="x" * 32,
                ),
                mock.patch.object(
                    MODULE.provider,
                    "_http_open",
                    return_value=Response(
                        payload,
                        {"Content-Length": str(len(payload))},
                    ),
                ) as opened,
            ):
                result = MODULE.command_download_attachment(args)

            self.assertEqual(destination.read_bytes(), payload)
            self.assertEqual(
                result["sha256"],
                hashlib.sha256(payload).hexdigest(),
            )
            self.assertEqual(
                result["integrity"]["status"],
                "metadata_size_matched",
            )
            self.assertEqual(
                result["integrity"]["contentInspection"]["status"],
                "passed",
            )
            self.assertIn(
                (
                    "/БольничныйЛистПрисоединенныеФайлы/"
                    "22222222-2222-4222-8222-222222222222"
                ),
                __import__("urllib.parse").parse.unquote(
                    opened.call_args.args[1],
                ),
            )
            self.assertIsNone(opened.call_args.kwargs["x_odata"])
            self.assertEqual(list(destination.parent.glob("*.part")), [])

    def test_attachment_size_mismatch_remains_fail_closed_by_default(self) -> None:
        owner_id = "11111111-1111-4111-8111-111111111111"
        file_id = "22222222-2222-4222-8222-222222222222"
        payload = self._pdf_payload()
        row = self._attachment_row(
            owner_id=owner_id,
            file_id=file_id,
            declared_size=130_231,
        )
        with __import__("tempfile").TemporaryDirectory() as directory:
            destination = Path(directory) / "contract.pdf"
            args = mock.Mock(
                attachment_source_key=self.attachment_source["key"],
                owner_id=owner_id,
                file_id=file_id,
                output=str(destination),
                include_sensitive=True,
                allow_unverified_size_mismatch=False,
            )
            with (
                mock.patch.object(
                    MODULE,
                    "_request_attachment_rows",
                    return_value=[row],
                ),
                mock.patch.object(
                    MODULE,
                    "_connected_context",
                    return_value=(
                        self._company_config(),
                        MODULE.provider.Credentials("employee", "password"),
                    ),
                ),
                mock.patch.object(
                    MODULE.provider,
                    "_require_x_odata",
                    return_value="x" * 32,
                ),
                mock.patch.object(
                    MODULE.provider,
                    "_http_open",
                    return_value=Response(
                        payload,
                        {"Content-Length": str(len(payload))},
                    ),
                ),
            ):
                with self.assertRaises(MODULE.HrRuntimeError) as caught:
                    MODULE.command_download_attachment(args)

            self.assertEqual(
                caught.exception.code,
                "attachment_contract_mismatch",
            )
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_size_matched_pdf_still_requires_valid_basic_structure(self) -> None:
        owner_id = "11111111-1111-4111-8111-111111111111"
        file_id = "22222222-2222-4222-8222-222222222222"
        payload = b"not a PDF"
        row = self._attachment_row(
            owner_id=owner_id,
            file_id=file_id,
            declared_size=len(payload),
        )
        with __import__("tempfile").TemporaryDirectory() as directory:
            destination = Path(directory) / "contract.pdf"
            args = mock.Mock(
                attachment_source_key=self.attachment_source["key"],
                owner_id=owner_id,
                file_id=file_id,
                output=str(destination),
                include_sensitive=True,
                allow_unverified_size_mismatch=False,
            )
            with (
                mock.patch.object(
                    MODULE,
                    "_request_attachment_rows",
                    return_value=[row],
                ),
                mock.patch.object(
                    MODULE,
                    "_connected_context",
                    return_value=(
                        self._company_config(),
                        MODULE.provider.Credentials("employee", "password"),
                    ),
                ),
                mock.patch.object(
                    MODULE.provider,
                    "_http_open",
                    return_value=Response(
                        payload,
                        {"Content-Length": str(len(payload))},
                    ),
                ),
            ):
                with self.assertRaises(MODULE.HrRuntimeError) as caught:
                    MODULE.command_download_attachment(args)

            self.assertEqual(
                caught.exception.code,
                "invalid_attachment_response",
            )
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_explicit_size_mismatch_is_saved_only_as_unverified(self) -> None:
        owner_id = "11111111-1111-4111-8111-111111111111"
        file_id = "22222222-2222-4222-8222-222222222222"
        payload = self._pdf_payload()
        declared_size = 130_231
        row = self._attachment_row(
            owner_id=owner_id,
            file_id=file_id,
            declared_size=declared_size,
        )
        with __import__("tempfile").TemporaryDirectory() as directory:
            destination = Path(directory) / "contract.pdf"
            args = mock.Mock(
                attachment_source_key=self.attachment_source["key"],
                owner_id=owner_id,
                file_id=file_id,
                output=str(destination),
                include_sensitive=True,
                allow_unverified_size_mismatch=True,
            )
            with (
                mock.patch.object(
                    MODULE,
                    "_request_attachment_rows",
                    return_value=[row],
                ),
                mock.patch.object(
                    MODULE,
                    "_connected_context",
                    return_value=(
                        self._company_config(),
                        MODULE.provider.Credentials("employee", "password"),
                    ),
                ),
                mock.patch.object(
                    MODULE.provider,
                    "_require_x_odata",
                    return_value="x" * 32,
                ),
                mock.patch.object(
                    MODULE.provider,
                    "_http_open",
                    return_value=Response(
                        payload,
                        {"Content-Length": str(len(payload))},
                    ),
                ),
            ):
                result = MODULE.command_download_attachment(args)

            unverified = Path(directory) / "contract.unverified.pdf"
            manifest_path = Path(
                f"{unverified}.integrity.json",
            )
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertFalse(destination.exists())
            self.assertEqual(unverified.read_bytes(), payload)
            self.assertEqual(
                result["integrity"]["status"],
                "unverified_metadata_size_mismatch",
            )
            self.assertEqual(
                result["integrity"]["manifestPath"],
                str(manifest_path.resolve()),
            )
            self.assertEqual(
                result["integrity"]["contentInspection"]["status"],
                "passed",
            )
            self.assertEqual(manifest["declaredSizeBytes"], declared_size)
            self.assertEqual(manifest["actualSizeBytes"], len(payload))
            self.assertEqual(
                manifest["sha256"],
                hashlib.sha256(payload).hexdigest(),
            )
            self.assertEqual(
                manifest["status"],
                "unverified_metadata_size_mismatch",
            )
            self.assertEqual(
                manifest["contentInspection"]["checks"],
                [
                    "header_signature",
                    "startxref_target",
                    "eof_marker",
                ],
            )
            self.assertEqual(list(Path(directory).glob("*.part")), [])

    def test_unverified_pdf_requires_valid_basic_structure(self) -> None:
        owner_id = "11111111-1111-4111-8111-111111111111"
        file_id = "22222222-2222-4222-8222-222222222222"
        payload = b"%PDF-1.4\ntruncated"
        row = self._attachment_row(
            owner_id=owner_id,
            file_id=file_id,
            declared_size=130_231,
        )
        with __import__("tempfile").TemporaryDirectory() as directory:
            destination = Path(directory) / "contract.pdf"
            args = mock.Mock(
                attachment_source_key=self.attachment_source["key"],
                owner_id=owner_id,
                file_id=file_id,
                output=str(destination),
                include_sensitive=True,
                allow_unverified_size_mismatch=True,
            )
            with (
                mock.patch.object(
                    MODULE,
                    "_request_attachment_rows",
                    return_value=[row],
                ),
                mock.patch.object(
                    MODULE,
                    "_connected_context",
                    return_value=(
                        self._company_config(),
                        MODULE.provider.Credentials("employee", "password"),
                    ),
                ),
                mock.patch.object(
                    MODULE.provider,
                    "_require_x_odata",
                    return_value="x" * 32,
                ),
                mock.patch.object(
                    MODULE.provider,
                    "_http_open",
                    return_value=Response(
                        payload,
                        {"Content-Length": str(len(payload))},
                    ),
                ),
            ):
                with self.assertRaises(MODULE.HrRuntimeError) as caught:
                    MODULE.command_download_attachment(args)

            self.assertEqual(
                caught.exception.code,
                "invalid_attachment_response",
            )
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_transport_length_mismatch_is_never_quarantined(self) -> None:
        owner_id = "11111111-1111-4111-8111-111111111111"
        file_id = "22222222-2222-4222-8222-222222222222"
        payload = b"%PDF-1.4\ncontract\n%%EOF\n"
        row = self._attachment_row(
            owner_id=owner_id,
            file_id=file_id,
            declared_size=130_231,
        )
        with __import__("tempfile").TemporaryDirectory() as directory:
            destination = Path(directory) / "contract.pdf"
            args = mock.Mock(
                attachment_source_key=self.attachment_source["key"],
                owner_id=owner_id,
                file_id=file_id,
                output=str(destination),
                include_sensitive=True,
                allow_unverified_size_mismatch=True,
            )
            with (
                mock.patch.object(
                    MODULE,
                    "_request_attachment_rows",
                    return_value=[row],
                ),
                mock.patch.object(
                    MODULE,
                    "_connected_context",
                    return_value=(
                        self._company_config(),
                        MODULE.provider.Credentials("employee", "password"),
                    ),
                ),
                mock.patch.object(
                    MODULE.provider,
                    "_require_x_odata",
                    return_value="x" * 32,
                ),
                mock.patch.object(
                    MODULE.provider,
                    "_http_open",
                    return_value=Response(
                        payload,
                        {"Content-Length": str(len(payload) + 1)},
                    ),
                ),
            ):
                with self.assertRaises(MODULE.HrRuntimeError) as caught:
                    MODULE.command_download_attachment(args)

            self.assertEqual(
                caught.exception.code,
                "invalid_attachment_response",
            )
            self.assertEqual(list(Path(directory).iterdir()), [])


def urllib_quote(value: str) -> str:
    import urllib.parse

    return urllib.parse.quote(value, safe="")


if __name__ == "__main__":
    unittest.main()
