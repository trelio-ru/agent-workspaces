from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path


SKILL_ROOT = Path(__file__).parents[1]
PROBE_PATH = SKILL_ROOT / "development" / "probe_finance_live.py"
INVENTORY_PATH = SKILL_ROOT / "development" / "inventory_finance_live.py"
SMOKE_PATH = SKILL_ROOT / "development" / "smoke_finance_runtime_live.py"


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
        self.assertEqual(len(actual), 14)
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


if __name__ == "__main__":
    unittest.main()
