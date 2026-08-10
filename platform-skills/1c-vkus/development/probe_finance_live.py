#!/usr/bin/env python3
"""Probe fixed Vkus finance routes without emitting business values.

This development-only helper confirms that reviewed record and virtual-table
routes accept bounded GET requests and return the EDM scalar classes frozen in
the prospective production contract. Output contains only source labels,
counts and value classes; account balances, stock quantities, payroll amounts,
bank details and other business values are never serialized.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
import urllib.parse
from pathlib import Path
from typing import Any


EXPECTED_COMPANY_ID = "33638f79-4d63-47f8-ab40-55ed70331592"
MAX_RESPONSE_BYTES = 8 * 1024 * 1024
MAX_PROBE_ROWS = 2
RUNTIME_SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(RUNTIME_SCRIPTS))

import trelio_one_c_vkus_runtime as provider  # noqa: E402


PROBES: tuple[dict[str, Any], ...] = (
    {
        "key": "account_balance_turnovers",
        "route": (
            "AccountingRegister_Хозрасчетный/"
            "BalanceAndTurnovers("
            "StartPeriod={start},"
            "EndPeriod={end},"
            "Dimensions='Подразделение'"
            ")"
        ),
        "fields": {
            "Account_Key": "Edm.Guid",
            "Организация_Key": "Edm.Guid",
            "Подразделение_Key": "Edm.Guid",
            "НаправлениеДеятельности_Key": "Edm.Guid",
            "СуммаOpeningBalance": "Edm.Double",
            "СуммаTurnoverDr": "Edm.Double",
            "СуммаTurnoverCr": "Edm.Double",
            "СуммаClosingBalance": "Edm.Double",
        },
    },
    {
        "key": "stock_balance_turnovers",
        "route": (
            "AccumulationRegister_ТоварыНаСкладах/"
            "BalanceAndTurnovers("
            "StartPeriod={start},"
            "EndPeriod={end},"
            "Dimensions='Номенклатура,Характеристика,Склад'"
            ")"
        ),
        "fields": {
            "Номенклатура_Key": "Edm.Guid",
            "Характеристика_Key": "Edm.Guid",
            "Склад_Key": "Edm.Guid",
            "ВНаличииOpeningBalance": "Edm.Double",
            "ВНаличииReceipt": "Edm.Double",
            "ВНаличииExpense": "Edm.Double",
            "ВНаличииClosingBalance": "Edm.Double",
        },
    },
    {
        "key": "sales_cost_turnovers",
        "route": (
            "AccumulationRegister_ВыручкаИСебестоимостьПродаж/"
            "Turnovers("
            "StartPeriod={start},"
            "EndPeriod={end},"
            "Dimensions='Подразделение,ХозяйственнаяОперация'"
            ")"
        ),
        "fields": {
            "Подразделение_Key": "Edm.Guid",
            "ХозяйственнаяОперация": "Edm.String",
            "СуммаВыручкиБезНДСTurnover": "Edm.Double",
            "СтоимостьБезНДСTurnover": "Edm.Double",
            "ДопРасходыБезНДСTurnover": "Edm.Double",
        },
    },
    {
        "key": "sales_cost_records",
        "route": (
            "AccumulationRegister_ВыручкаИСебестоимостьПродаж_RecordType"
        ),
        "fields": {
            "Period": "Edm.DateTime",
            "Подразделение_Key": "Edm.Guid",
            "СуммаВыручкиБезНДС": "Edm.Double",
            "СтоимостьБезНДС": "Edm.Double",
            "Сторно": "Edm.Boolean",
        },
        "periodField": "Period",
    },
    {
        "key": "payroll_accounting_records",
        "route": (
            "AccumulationRegister_ОтражениеЗарплатыВФинансовомУчете_RecordType"
        ),
        "fields": {
            "Period": "Edm.DateTime",
            "Организация_Key": "Edm.Guid",
            "Подразделение_Key": "Edm.Guid",
            "ВидОперацииПоЗарплате": "Edm.String",
            "ТипНалога": "Edm.String",
            "СуммаРегл": "Edm.Double",
            "Сторно": "Edm.Boolean",
        },
        "periodField": "Period",
    },
    {
        "key": "bank_receipts",
        "route": "Document_ПоступлениеБезналичныхДенежныхСредств",
        "fields": {
            "Ref_Key": "Edm.Guid",
            "Date": "Edm.DateTime",
            "Posted": "Edm.Boolean",
            "Организация_Key": "Edm.Guid",
            "Подразделение_Key": "Edm.Guid",
            "СуммаДокумента": "Edm.Double",
            "СуммаКомиссии": "Edm.Double",
        },
        "periodField": "Date",
    },
    {
        "key": "bank_payments",
        "route": "Document_СписаниеБезналичныхДенежныхСредств",
        "fields": {
            "Ref_Key": "Edm.Guid",
            "Date": "Edm.DateTime",
            "Posted": "Edm.Boolean",
            "Организация_Key": "Edm.Guid",
            "Подразделение_Key": "Edm.Guid",
            "СуммаДокумента": "Edm.Double",
            "СуммаКомиссии": "Edm.Double",
        },
        "periodField": "Date",
    },
)

# Keep the live probe synchronized with the production registry. The
# hand-written seed list above documents the first discovery pass, while this
# derived tuple is the only one executed. It tests every releasable finance
# source and prevents a new production kind from being silently omitted from
# release validation.
def _production_finance_probes() -> tuple[dict[str, Any], ...]:
    probes: list[dict[str, Any]] = []
    for section, specs in (
        ("financial_turnover", provider.GENERAL_FINANCIAL_TURNOVER_SPECS),
        ("balance", provider.GENERAL_BALANCE_SPECS),
    ):
        for key, spec in specs.items():
            if spec.get("transport") == "record_table":
                probes.append({
                    "key": f"{section}.{key}",
                    "route": spec["entity"],
                    "fields": dict(spec["fields"]),
                    "periodField": spec["dateField"],
                })
                continue
            route_parameters = [
                "StartPeriod={start}",
                "EndPeriod={end}",
            ]
            dimensions = tuple(spec.get("dimensions", ()))
            if dimensions:
                route_parameters.append(
                    f"Dimensions='{','.join(dimensions)}'",
                )
            probes.append({
                "key": f"{section}.{key}",
                "route": (
                    f"{spec['entity']}/{spec['function']}"
                    f"({','.join(route_parameters)})"
                ),
                "fields": dict(spec["fields"]),
            })
    for key, spec in provider.GENERAL_FINANCIAL_RECORD_SPECS.items():
        probes.append({
            "key": f"financial_record.{key}",
            "route": spec["entity"],
            "fields": dict(spec["fields"]),
            "periodField": spec["dateField"],
        })
    return tuple(probes)


PROBES = _production_finance_probes()


def _date(value: str, label: str) -> dt.date:
    try:
        parsed = dt.date.fromisoformat(value)
    except ValueError as error:
        raise ValueError(f"{label} must be YYYY-MM-DD") from error
    if parsed.year < 2000 or parsed.year > 2200:
        raise ValueError(f"{label} is outside the bounded range")
    return parsed


def _value_class(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int):
        return "integer"
    if isinstance(value, float):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, list):
        return "array"
    if isinstance(value, dict):
        return "object"
    return "unknown"


def _read_identity() -> provider.Identity:
    company_id = provider._uuid(
        os.environ.get("TRELIO_SKILL_COMPANY_ID"),
        "company id",
    )
    if company_id != EXPECTED_COMPANY_ID:
        raise provider.OneCEdoError(
            "invalid_host_context",
            "Development probe разрешён только для компании «Вкус».",
        )
    return provider.Identity(
        company_id=company_id,
        member_id=provider._uuid(
            os.environ.get("TRELIO_SKILL_MEMBER_ID"),
            "member id",
        ),
        connection_id=provider._uuid(
            os.environ.get("TRELIO_SKILL_CONNECTION_ID"),
            "connection id",
        ),
    )


def _probe(
    spec: dict[str, Any],
    *,
    start: dt.date,
    end: dt.date,
) -> dict[str, Any]:
    identity = _read_identity()
    config = provider.load_company_config()
    credentials = provider.load_credentials(identity, config)
    start_literal = f"datetime'{start.isoformat()}T00:00:00'"
    end_literal = f"datetime'{end.isoformat()}T00:00:00'"
    route = str(spec["route"]).format(
        start=start_literal,
        end=end_literal,
    )
    parameters: list[tuple[str, str | int]] = [
        ("$select", ",".join(spec["fields"])),
        ("$top", MAX_PROBE_ROWS),
    ]
    period_field = spec.get("periodField")
    if period_field:
        parameters.extend([
            (
                "$filter",
                (
                    f"{period_field} ge {start_literal} and "
                    f"{period_field} lt {end_literal}"
                ),
            ),
            ("$orderby", f"{period_field} desc"),
        ])
    # Parentheses and quotes are fixed function syntax owned by this helper.
    # No user-controlled OData expression enters the path.
    encoded_route = urllib.parse.quote(route, safe="_/'(),=:")
    url = (
        f"{config.odata_base_url}"
        f"{encoded_route}"
        f"?{provider._odata_query(parameters)}"
    )
    response = provider._http_open(
        "GET",
        url,
        credentials=credentials,
        timeout=config.request_timeout_seconds,
        x_odata=provider._require_x_odata(),
        diagnostic_stage="doctor.probe",
    )
    with response:
        raw = provider._read_limited(response, MAX_RESPONSE_BYTES)
    payload = json.loads(raw.decode("utf-8"))
    rows = provider._odata_rows(payload)
    if len(rows) > MAX_PROBE_ROWS:
        raise ValueError("1C ignored the development probe row cap")

    field_classes = {
        field: sorted({
            _value_class(row.get(field))
            for row in rows
            if field in row
        })
        for field in spec["fields"]
    }
    missing_fields = sorted({
        field
        for field in spec["fields"]
        if any(field not in row for row in rows)
    })
    type_mismatches = sorted({
        field
        for field, expected_type in spec["fields"].items()
        if any(
            not provider._general_value_matches_edm(
                row.get(field),
                expected_type,
            )
            for row in rows
            if field in row
        )
    })
    return {
        "key": spec["key"],
        "returned": len(rows),
        "missingFields": missing_fields,
        "typeMismatches": type_mismatches,
        "fieldClasses": field_classes,
        "valuesIncluded": False,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Probe fixed Vkus finance routes without business values.",
    )
    parser.add_argument("--date-from", required=True)
    parser.add_argument("--date-to-exclusive", required=True)
    args = parser.parse_args(argv)
    try:
        start = _date(args.date_from, "date-from")
        end = _date(args.date_to_exclusive, "date-to-exclusive")
        if start >= end or end - start > dt.timedelta(days=93):
            raise ValueError("probe period must be from 1 to 93 days")
        results: list[dict[str, Any]] = []
        for spec in PROBES:
            try:
                results.append(_probe(spec, start=start, end=end))
            except provider.OneCEdoError as error:
                results.append({
                    "key": spec["key"],
                    "error": provider._safe_error_payload(error),
                    "valuesIncluded": False,
                })
    except provider.OneCEdoError as error:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": provider._safe_error_payload(error),
                },
                ensure_ascii=False,
                separators=(",", ":"),
            ),
        )
        return error.exit_code
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": {
                        "code": "finance_probe_failed",
                        "message": str(error)[:300],
                    },
                },
                ensure_ascii=False,
                separators=(",", ":"),
            ),
        )
        return 2
    all_routes_passed = all(
        "error" not in result
        and not result["missingFields"]
        and not result["typeMismatches"]
        for result in results
    )
    print(
        json.dumps(
            {
                "ok": True,
                "dateFrom": start.isoformat(),
                "dateToExclusive": end.isoformat(),
                "results": results,
                "businessValuesIncluded": False,
                "allRoutesPassed": all_routes_passed,
            },
            ensure_ascii=False,
            separators=(",", ":"),
        ),
    )
    return 0 if all_routes_passed else 2


if __name__ == "__main__":
    raise SystemExit(main())
