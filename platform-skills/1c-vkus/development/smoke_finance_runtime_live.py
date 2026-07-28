#!/usr/bin/env python3
"""Run every production finance handler without printing business values.

This release-only smoke test exercises the same argument validation, scope
filters, URLs, response contracts and normalizers that are packed into the
signed runtime. It reports only command names, row counts, pagination flags
and registry digests. Monetary amounts, quantities, names, document numbers
and source identifiers from returned rows are never serialized.
"""

from __future__ import annotations

import argparse
import json
import sys
from argparse import Namespace
from pathlib import Path
from typing import Any, Callable


RUNTIME_SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(RUNTIME_SCRIPTS))

import trelio_one_c_vkus_runtime as provider  # noqa: E402


def _finance_args(
    kind: str,
    *,
    date_from: str,
    date_to: str,
    organization_id: str = "",
    business_unit_id: str = "",
    warehouse_id: str = "",
) -> Namespace:
    """Build one complete public command namespace with tight live limits."""

    return Namespace(
        kind=kind,
        date_from=date_from,
        date_to=date_to,
        organization_id=organization_id,
        business_unit_id=business_unit_id,
        account_id="",
        warehouse_id=warehouse_id,
        item_id="",
        page=1,
        limit=2,
        include_sensitive=True,
    )


def _safe_result(label: str, result: dict[str, Any]) -> dict[str, Any]:
    """Reduce a production result to release evidence without row contents."""

    schema = result.get("schema")
    safe_schema = {
        "registryDigest": schema.get("registryDigest"),
        "capabilityDigests": schema.get("capabilityDigests"),
    } if isinstance(schema, dict) else None
    return {
        "command": label,
        "ok": True,
        "count": result.get("count"),
        "pagination": result.get("pagination"),
        "schema": safe_schema,
        "businessValuesIncluded": False,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Smoke-test every Vkus production finance command safely.",
    )
    parser.add_argument("--date-from", required=True)
    parser.add_argument("--date-to", required=True)
    parser.add_argument("--organization-id", required=True)
    parser.add_argument("--enterprise-unit-id", required=True)
    parser.add_argument("--organization-division-id", required=True)
    parser.add_argument("--warehouse-id", required=True)
    args = parser.parse_args(argv)

    commands: list[tuple[str, Callable[[Namespace], dict[str, Any]], Namespace]] = []
    for kind, spec in provider.GENERAL_FINANCIAL_TURNOVER_SPECS.items():
        filters = spec["filters"]
        commands.append((
            f"get-financial-turnovers:{kind}",
            provider.command_general_get_financial_turnovers,
            _finance_args(
                kind,
                date_from=args.date_from,
                date_to=args.date_to,
                organization_id=(
                    args.organization_id
                    if "organization" in filters
                    and "business_unit" not in filters
                    else ""
                ),
                business_unit_id=(
                    (
                        args.organization_division_id
                        if spec.get("filterSourceTypes", {}).get("business_unit")
                        == "organization_division"
                        else args.enterprise_unit_id
                    )
                    if "business_unit" in filters else ""
                ),
            ),
        ))
    for kind, spec in provider.GENERAL_FINANCIAL_RECORD_SPECS.items():
        filters = spec["filters"]
        commands.append((
            f"search-financial-records:{kind}",
            provider.command_general_search_financial_records,
            _finance_args(
                kind,
                date_from=args.date_from,
                date_to=args.date_to,
                organization_id=(
                    args.organization_id
                    if "business_unit" not in filters
                    else ""
                ),
                business_unit_id=(
                    args.enterprise_unit_id
                    if "business_unit" in filters
                    else ""
                ),
            ),
        ))
    commands.extend([
        (
            "get-balance-and-turnovers:accounts",
            provider.command_general_get_balance_and_turnovers,
            _finance_args(
                "accounts",
                date_from=args.date_from,
                date_to=args.date_to,
                business_unit_id=args.enterprise_unit_id,
            ),
        ),
        (
            "get-balance-and-turnovers:stock",
            provider.command_general_get_balance_and_turnovers,
            _finance_args(
                "stock",
                date_from=args.date_from,
                date_to=args.date_to,
                warehouse_id=args.warehouse_id,
            ),
        ),
    ])

    results: list[dict[str, Any]] = []
    for label, handler, command_args in commands:
        try:
            results.append(_safe_result(label, handler(command_args)))
        except provider.OneCEdoError as error:
            results.append({
                "command": label,
                "ok": False,
                "error": provider._safe_error_payload(error),
                "businessValuesIncluded": False,
            })
    all_commands_passed = all(result["ok"] for result in results)
    print(
        json.dumps(
            {
                "ok": all_commands_passed,
                "runtimeVersion": provider.RUNTIME_VERSION,
                "commandCount": len(results),
                "results": results,
                "businessValuesIncluded": False,
            },
            ensure_ascii=False,
            separators=(",", ":"),
        ),
    )
    return 0 if all_commands_passed else 2


if __name__ == "__main__":
    raise SystemExit(main())
