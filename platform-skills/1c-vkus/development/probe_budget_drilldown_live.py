#!/usr/bin/env python3
"""Inspect one exact internal-consumption registrar in the expense register.

This development-only release helper intentionally exposes the minimum
business values needed to verify the task's acceptance example before a new
signed runtime is published.  It is not packed into the production skill.
The caller supplies only one validated registrar UUID; the 1C entity, typed
registrar cast, selected fields, active-state predicate, ordering and row cap
remain fixed constants owned by this reviewed source file.

Credentials are still loaded through the normal ``1c-edo`` connection.  The
script must therefore be launched by a protected Agent Secret checkout from a
materialized Trelio Run, never with a password in arguments or environment
assembled by the caller.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.parse
from decimal import Decimal
from pathlib import Path
from typing import Any


EXPECTED_COMPANY_ID = "33638f79-4d63-47f8-ab40-55ed70331592"
FIXED_ENTITY = "AccumulationRegister_ПрочиеРасходы_RecordType"
FIXED_EXPENSE_ITEM_ENTITY = "ChartOfCharacteristicTypes_СтатьиРасходов"
FIXED_REGISTRAR_TYPE = "Document_ВнутреннееПотребление"
ACCEPTANCE_BUSINESS_UNIT_ID = "77850bd5-505f-11e9-babd-38d547b779c5"
ACCEPTANCE_EXPENSE_ITEM_ID = "d8eec0da-8508-11e8-baa5-38d547b779c5"
ACCEPTANCE_DATE_FROM = "2026-06-01"
ACCEPTANCE_DATE_TO_EXCLUSIVE = "2026-07-01"
MAX_ROWS = 50
FIXED_FIELDS: dict[str, str] = {
    "Recorder": "Edm.String",
    "Recorder_Type": "Edm.String",
    "Period": "Edm.DateTime",
    "LineNumber": "Edm.Int64",
    "Active": "Edm.Boolean",
    "СтатьяРасходов_Key": "Edm.Guid",
    "Подразделение_Key": "Edm.Guid",
    "АналитикаУчетаНоменклатуры_Key": "Edm.Guid",
    "Сумма": "Edm.Double",
    "СуммаБезНДС": "Edm.Double",
    "СуммаУпр": "Edm.Double",
    "СуммаРегл": "Edm.Double",
}
FIXED_EXPENSE_ITEM_FIELDS: dict[str, str] = {
    "Ref_Key": "Edm.Guid",
    "Description": "Edm.String",
    "Code": "Edm.String",
    "DeletionMark": "Edm.Boolean",
}

RUNTIME_SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(RUNTIME_SCRIPTS))

import trelio_one_c_vkus_runtime as provider  # noqa: E402


def _identity() -> provider.Identity:
    """Accept only the Vkus host context bound by the protected checkout."""

    company_id = provider._uuid(
        os.environ.get("TRELIO_SKILL_COMPANY_ID"),
        "company id",
    )
    if company_id != EXPECTED_COMPANY_ID:
        raise provider.OneCEdoError(
            "invalid_host_context",
            "Budget probe разрешён только для компании «Вкус».",
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


def _request_parameters(registrar_id: str) -> tuple[tuple[str, str | int], ...]:
    """Build the only query shape this release helper is allowed to issue."""

    registrar = provider._uuid(registrar_id, "registrar id")
    return (
        ("$select", ",".join(FIXED_FIELDS)),
        (
            "$filter",
            (
                "(Active eq true) and "
                "(Recorder eq "
                f"cast(guid'{registrar}', '{FIXED_REGISTRAR_TYPE}'))"
            ),
        ),
        ("$orderby", "Period asc,Recorder asc,LineNumber asc"),
        ("$top", MAX_ROWS + 1),
    )


def _acceptance_parameters() -> tuple[tuple[str, str | int], ...]:
    """Build the immutable task acceptance scope for the June reconciliation."""

    return (
        ("$select", ",".join(FIXED_FIELDS)),
        (
            "$filter",
            (
                "(Active eq true) and "
                f"(Period ge datetime'{ACCEPTANCE_DATE_FROM}T00:00:00') and "
                f"(Period lt datetime'{ACCEPTANCE_DATE_TO_EXCLUSIVE}T00:00:00') and "
                f"(Подразделение_Key eq guid'{ACCEPTANCE_BUSINESS_UNIT_ID}') and "
                f"(СтатьяРасходов_Key eq guid'{ACCEPTANCE_EXPENSE_ITEM_ID}')"
            ),
        ),
        ("$orderby", "Period asc,Recorder asc,LineNumber asc"),
        ("$top", MAX_ROWS + 1),
    )


def _normalized_row(raw: dict[str, Any]) -> dict[str, Any]:
    """Return only values needed to review the exact acceptance document."""

    provider._validate_general_source_record(raw, FIXED_FIELDS)
    safe = provider._safe_selected_record(raw, FIXED_FIELDS)
    return {
        "registrarId": provider._uuid(str(safe.get("Recorder") or ""), "registrar id"),
        "registrarType": provider._general_text(safe.get("Recorder_Type")),
        "period": provider._normalized_1c_datetime(
            safe.get("Period"),
            field_label="budget period",
        ),
        "lineNumber": provider._general_integer(safe.get("LineNumber")),
        "expenseItemId": provider._general_uuid_value(
            safe.get("СтатьяРасходов_Key"),
            "expense item id",
        ),
        "businessUnitId": provider._general_uuid_value(
            safe.get("Подразделение_Key"),
            "business unit id",
        ),
        "itemAccountingAnalyticsId": provider._general_uuid_value(
            safe.get("АналитикаУчетаНоменклатуры_Key"),
            "item accounting analytics id",
        ),
        "amount": provider._general_number(safe.get("Сумма")),
        "amountWithoutVat": provider._general_number(safe.get("СуммаБезНДС")),
        "amountManagement": provider._general_number(safe.get("СуммаУпр")),
        "amountRegulated": provider._general_number(safe.get("СуммаРегл")),
    }


def _fixed_get(
    config: provider.CompanyConfig,
    credentials: provider.Credentials,
    entity: str,
    parameters: tuple[tuple[str, str | int], ...],
) -> dict[str, Any]:
    """Issue GET only to one of the two literal release-review entities."""

    if entity not in {FIXED_ENTITY, FIXED_EXPENSE_ITEM_ENTITY}:
        raise provider.OneCEdoError(
            "entity_blocked",
            "Budget probe получил неподдерживаемый внутренний источник.",
        )
    encoded_entity = urllib.parse.quote(entity, safe="_")
    url = f"{config.odata_base_url}{encoded_entity}?{provider._odata_query(parameters)}"
    response = provider._http_open(
        "GET",
        url,
        credentials=credentials,
        timeout=config.request_timeout_seconds,
        x_odata=provider._require_x_odata(),
        # Reuse the already reviewed budget diagnostic label; diagnostic
        # labels affect sanitized error reporting only, never the route.
        diagnostic_stage="general.financial.turnover.budget.search",
    )
    with response:
        raw = provider._read_limited(response, 8 * 1024 * 1024)
    return json.loads(raw.decode("utf-8"))


def _expense_item(
    config: provider.CompanyConfig,
    credentials: provider.Credentials,
    expense_item_id: str,
) -> dict[str, Any]:
    """Resolve one exact article UUID without a text or broad catalog search."""

    reference = provider._uuid(expense_item_id, "expense item id")
    payload = _fixed_get(
        config,
        credentials,
        FIXED_EXPENSE_ITEM_ENTITY,
        (
            ("$select", ",".join(FIXED_EXPENSE_ITEM_FIELDS)),
            ("$filter", f"Ref_Key eq guid'{reference}'"),
            ("$top", 2),
        ),
    )
    rows = provider._odata_rows(payload)
    if len(rows) != 1:
        raise provider.OneCEdoError(
            "source_contract_mismatch",
            "Expense article exact lookup вернул не одну запись.",
        )
    provider._validate_general_source_record(rows[0], FIXED_EXPENSE_ITEM_FIELDS)
    safe = provider._safe_selected_record(rows[0], FIXED_EXPENSE_ITEM_FIELDS)
    return {
        "id": provider._uuid(str(safe.get("Ref_Key") or ""), "expense item id"),
        "code": provider._general_text(safe.get("Code")),
        "name": provider._general_text(safe.get("Description")),
        "isDeleted": provider._normalized_boolean(safe.get("DeletionMark")),
    }


def _probe(registrar_id: str) -> dict[str, Any]:
    """Read one bounded exact-registrar page through the existing connection."""

    identity = _identity()
    config = provider.load_company_config()
    credentials = provider.load_credentials(identity, config)
    # The candidate entity is deliberately not added to the production
    # allowlist until this probe succeeds.  `_fixed_get` retains the same
    # HTTPS base, encoder, X-OData requirement, bounded reader and GET
    # transport while refusing any entity outside two reviewed constants.
    payload = _fixed_get(
        config,
        credentials,
        FIXED_ENTITY,
        _request_parameters(registrar_id),
    )
    raw_rows = provider._odata_rows(payload)
    if len(raw_rows) > MAX_ROWS:
        raise provider.OneCEdoError(
            "result_truncated",
            "Exact registrar содержит больше разрешённых строк.",
        )
    rows = [_normalized_row(row) for row in raw_rows]
    expense_item_ids = sorted({
        str(row["expenseItemId"])
        for row in rows
        if row.get("expenseItemId")
    })
    return {
        "registrarId": provider._uuid(registrar_id, "registrar id"),
        "rows": rows,
        "expenseItems": [
            _expense_item(config, credentials, expense_item_id)
            for expense_item_id in expense_item_ids
        ],
        "count": len(raw_rows),
        "source": FIXED_ENTITY,
        "readOnly": True,
    }


def _probe_acceptance_scope() -> dict[str, Any]:
    """Read the one task-defined month/unit/article combination."""

    identity = _identity()
    config = provider.load_company_config()
    credentials = provider.load_credentials(identity, config)
    payload = _fixed_get(
        config,
        credentials,
        FIXED_ENTITY,
        _acceptance_parameters(),
    )
    raw_rows = provider._odata_rows(payload)
    if len(raw_rows) > MAX_ROWS:
        raise provider.OneCEdoError(
            "result_truncated",
            "Acceptance scope содержит больше разрешённых строк.",
        )
    rows = [_normalized_row(row) for row in raw_rows]
    return {
        "dateFrom": ACCEPTANCE_DATE_FROM,
        "dateToExclusive": ACCEPTANCE_DATE_TO_EXCLUSIVE,
        "businessUnitId": ACCEPTANCE_BUSINESS_UNIT_ID,
        "expenseItem": _expense_item(
            config,
            credentials,
            ACCEPTANCE_EXPENSE_ITEM_ID,
        ),
        "rows": rows,
        "count": len(rows),
        "amountTotal": provider._general_decimal_number(
            sum(
                (
                    Decimal(str(row["amountManagement"] or 0))
                    for row in rows
                ),
                Decimal(0),
            ),
        ),
        "source": FIXED_ENTITY,
        "readOnly": True,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Probe one exact Vkus budget registrar for release review.",
    )
    scope = parser.add_mutually_exclusive_group(required=True)
    scope.add_argument("--registrar-id")
    scope.add_argument("--acceptance-scope", action="store_true")
    args = parser.parse_args(argv)
    try:
        result = (
            _probe_acceptance_scope()
            if args.acceptance_scope
            else _probe(args.registrar_id)
        )
    except provider.OneCEdoError as error:
        print(
            json.dumps(
                {"ok": False, "error": provider._safe_error_payload(error)},
                ensure_ascii=False,
                separators=(",", ":"),
            ),
        )
        return error.exit_code
    print(
        json.dumps(
            {"ok": True, **result},
            ensure_ascii=False,
            separators=(",", ":"),
        ),
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
