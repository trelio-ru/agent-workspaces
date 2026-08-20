from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path


SKILL_ROOT = Path(__file__).parents[1]
PROBE_PATH = SKILL_ROOT / "development" / "probe_finance_live.py"
INVENTORY_PATH = SKILL_ROOT / "development" / "inventory_finance_live.py"
SMOKE_PATH = SKILL_ROOT / "development" / "smoke_finance_runtime_live.py"
BUDGET_PROBE_PATH = (
    SKILL_ROOT / "development" / "probe_budget_drilldown_live.py"
)
PAYMENT_REQUEST_PROBE_PATH = (
    SKILL_ROOT / "development" / "probe_payment_requests_live.py"
)
PAYMENT_REQUEST_SMOKE_PATH = (
    SKILL_ROOT / "development" / "smoke_payment_requests_live.py"
)


def load_module(name: str, path: Path) -> object:
    """Load one development helper without turning its directory into a package."""

    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


probe = load_module("trelio_vkus_finance_probe_test", PROBE_PATH)
inventory = load_module("trelio_vkus_finance_inventory_test", INVENTORY_PATH)
smoke = load_module("trelio_vkus_finance_smoke_test", SMOKE_PATH)
budget_probe = load_module(
    "trelio_vkus_budget_drilldown_probe_test",
    BUDGET_PROBE_PATH,
)
payment_request_probe = load_module(
    "trelio_vkus_payment_request_probe_test",
    PAYMENT_REQUEST_PROBE_PATH,
)
payment_request_smoke = load_module(
    "trelio_vkus_payment_request_smoke_test",
    PAYMENT_REQUEST_SMOKE_PATH,
)


class FinanceDevelopmentToolsTest(unittest.TestCase):
    def test_live_probe_covers_every_production_finance_source(self) -> None:
        expected = {
            *(
                f"financial_turnover.{kind}"
                for kind in probe.provider.GENERAL_FINANCIAL_TURNOVER_SPECS
            ),
            *(f"balance.{kind}" for kind in probe.provider.GENERAL_BALANCE_SPECS),
            *(
                f"financial_record.{kind}"
                for kind in probe.provider.GENERAL_FINANCIAL_RECORD_SPECS
            ),
        }
        actual = {item["key"] for item in probe.PROBES}

        self.assertEqual(actual, expected)
        self.assertEqual(len(actual), 15)
        account = next(
            item for item in probe.PROBES if item["key"] == "balance.accounts"
        )
        stock = next(
            item for item in probe.PROBES if item["key"] == "balance.stock"
        )
        self.assertNotIn("Dimensions=", account["route"])
        self.assertIn("Dimensions='Номенклатура,Характеристика,Склад'", stock["route"])

    def test_inventory_vocabulary_covers_every_requested_finance_group(self) -> None:
        expected_groups = {
            "sales_and_cost",
            "inventory_and_production",
            "income_and_expenses",
            "bank_and_cash",
            "taxes",
            "payroll",
            "fixed_assets",
            "accounting",
            "financing",
        }
        self.assertEqual(set(inventory.FINANCE_TERM_GROUPS), expected_groups)
        self.assertTrue(inventory._operation_matches("ОборотыИОстатки"))
        self.assertTrue(inventory._operation_matches("СтраховыеВзносы"))
        self.assertTrue(inventory._operation_matches("БанковскаяКомиссия"))
        self.assertTrue(inventory._operation_matches("СтатьиБюджетов"))
        self.assertTrue(inventory._operation_matches("ВнутреннееПотребление"))

    def test_smoke_reducer_never_serializes_financial_rows(self) -> None:
        reduced = smoke._safe_result(
            "get-financial-turnovers:sales_cost",
            {
                "count": 1,
                "rows": [{"metrics": {"revenue": 999}, "secret": "must-not-leak"}],
                "pagination": {"page": 1, "limit": 2, "truncated": False},
                "schema": {
                    "registryDigest": "sha256:" + ("a" * 64),
                    "capabilityDigests": {"financial_turnover.sales_cost": "safe"},
                },
            },
        )
        self.assertNotIn("rows", reduced)
        self.assertNotIn("must-not-leak", str(reduced))
        self.assertNotIn("999", str(reduced))
        self.assertFalse(reduced["businessValuesIncluded"])

    def test_budget_probe_has_one_fixed_exact_registrar_query(self) -> None:
        registrar_id = "fde1b318-686f-11f1-a591-047c16799dce"
        parameters = dict(budget_probe._request_parameters(registrar_id))

        self.assertEqual(
            budget_probe.FIXED_ENTITY,
            "AccumulationRegister_ПрочиеРасходы_RecordType",
        )
        self.assertEqual(parameters["$select"], ",".join(budget_probe.FIXED_FIELDS))
        self.assertEqual(parameters["$top"], budget_probe.MAX_ROWS + 1)
        self.assertEqual(
            parameters["$filter"],
            (
                "(Active eq true) and "
                "(Recorder eq cast("
                "guid'fde1b318-686f-11f1-a591-047c16799dce', "
                "'Document_ВнутреннееПотребление'))"
            ),
        )

    def test_budget_probe_exposes_no_arbitrary_odata_arguments(self) -> None:
        parser_source = BUDGET_PROBE_PATH.read_text(encoding="utf-8")

        self.assertIn('scope.add_argument("--registrar-id")', parser_source)
        self.assertIn('scope.add_argument("--acceptance-scope"', parser_source)
        for forbidden in ("--entity", "--route", "--select", "--filter", "--orderby"):
            self.assertNotIn(forbidden, parser_source)

    def test_budget_probe_acceptance_scope_is_fully_frozen(self) -> None:
        parameters = dict(budget_probe._acceptance_parameters())

        self.assertEqual(
            budget_probe.ACCEPTANCE_BUSINESS_UNIT_ID,
            "77850bd5-505f-11e9-babd-38d547b779c5",
        )
        self.assertEqual(
            budget_probe.ACCEPTANCE_EXPENSE_ITEM_ID,
            "d8eec0da-8508-11e8-baa5-38d547b779c5",
        )
        self.assertIn("Period ge datetime'2026-06-01T00:00:00'", parameters["$filter"])
        self.assertIn("Period lt datetime'2026-07-01T00:00:00'", parameters["$filter"])
        self.assertIn("Подразделение_Key eq guid'77850bd5", parameters["$filter"])
        self.assertIn("СтатьяРасходов_Key eq guid'd8eec0da", parameters["$filter"])

    def test_payment_request_probe_is_fixed_and_value_free(self) -> None:
        self.assertEqual(
            payment_request_probe.FIXED_ENTITY,
            "Document_ЗаявкаНаРасходованиеДенежныхСредств",
        )
        self.assertIn("НазначениеПлатежа", payment_request_probe.FIXED_FIELDS)
        self.assertIn("Комментарий", payment_request_probe.FIXED_FIELDS)
        self.assertIn(
            "РасшифровкаПлатежа",
            payment_request_probe.FIXED_FIELDS,
        )
        self.assertEqual(
            set(payment_request_probe.REFERENCE_PROFILE_FIELDS),
            {"Catalog_Пользователи", "Catalog_Валюты"},
        )

        summary = payment_request_probe._structural_summary([
            {
                field: source_value
                for field, source_value in (
                    (name, None)
                    for name in payment_request_probe.FIXED_FIELDS
                )
            },
        ])

        self.assertFalse(summary["businessValuesIncluded"])
        self.assertNotIn("records", summary)

    def test_payment_request_probe_exposes_no_arbitrary_odata_arguments(self) -> None:
        parser_source = PAYMENT_REQUEST_PROBE_PATH.read_text(encoding="utf-8")

        for allowed in (
            'parser.add_argument("--date-from"',
            'parser.add_argument("--date-to-exclusive"',
            'scope.add_argument("--organization-id")',
            'scope.add_argument("--business-unit-id")',
        ):
            self.assertIn(allowed, parser_source)
        for forbidden in ("--entity", "--route", "--select", "--filter", "--orderby"):
            self.assertNotIn(forbidden, parser_source)

    def test_payment_request_smoke_output_contract_is_value_free(self) -> None:
        source = PAYMENT_REQUEST_SMOKE_PATH.read_text(encoding="utf-8")

        self.assertIn('"businessValuesIncluded": False', source)
        self.assertNotIn('result["keyword"]', source)
        self.assertNotIn('result["documentId"]', source)
        self.assertEqual(
            payment_request_smoke._document_args(
                date_from="2026-07-01",
                date_to="2026-07-31",
                organization_id="44444444-4444-4444-8444-444444444444",
            ).kind,
            "payment_request",
        )


if __name__ == "__main__":
    unittest.main()
