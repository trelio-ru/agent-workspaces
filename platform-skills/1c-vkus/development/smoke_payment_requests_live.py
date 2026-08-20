#!/usr/bin/env python3
"""Live-verify the fixed payment-request runtime without printing business data.

This maintainer-only smoke runs the prospective production commands against a
bounded period and one exact organization UUID. It selects a keyword from an
already authorized returned text only in memory, proves that the same fixed
search finds the document, then exact-reads and reconciles its lines. Stdout
contains structural booleans, counts, lengths and status enums only: document
ids, numbers, names, text and amounts never leave the process.
"""

from __future__ import annotations

import argparse
import json
import sys
from argparse import Namespace
from decimal import Decimal
from pathlib import Path
from typing import Any


RUNTIME_SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(RUNTIME_SCRIPTS))

import trelio_one_c_vkus_runtime as provider  # noqa: E402


REQUEST_TRACE: list[dict[str, Any]] = []
_ORIGINAL_REQUEST_ODATA = provider._request_odata


def _traced_request_odata(
    config: provider.CompanyConfig,
    credentials: provider.Credentials,
    entity: str,
    parameters: Any = (),
    *,
    diagnostic_stage: str,
) -> dict[str, Any]:
    """Record only query shape so a failed release probe stays diagnosable."""

    fixed = tuple(parameters)
    values = dict(fixed)
    REQUEST_TRACE.append({
        "stage": diagnostic_stage,
        "entity": entity,
        "parameterKeys": [key for key, _value in fixed],
        "selectCharacters": len(str(values.get("$select") or "")),
        "filterCharacters": len(str(values.get("$filter") or "")),
        "top": values.get("$top"),
        "skip": values.get("$skip"),
    })
    return _ORIGINAL_REQUEST_ODATA(
        config,
        credentials,
        entity,
        fixed,
        diagnostic_stage=diagnostic_stage,
    )


provider._request_odata = _traced_request_odata


def _document_args(
    *,
    date_from: str,
    date_to: str,
    organization_id: str,
    query: str = "",
) -> Namespace:
    """Build the complete fixed search namespace used by the public parser."""

    return Namespace(
        kind="payment_request",
        date_from=date_from,
        date_to=date_to,
        organization_id=organization_id,
        destination_organization_id="",
        business_unit_id="",
        counterparty_id="",
        contract_id="",
        number="",
        query=query,
        status="",
        page=1,
        limit=5,
        include_sensitive=True,
    )


def _keyword(document: dict[str, Any]) -> str:
    """Choose a private deterministic substring without serializing it."""

    for field in ("paymentPurpose", "comment", "recipientInformation"):
        value = document.get(field)
        if isinstance(value, str) and value.strip():
            # A bounded prefix is long enough to exercise content search while
            # remaining inside the signed public query limit.
            return value.strip()[:24]
    raise ValueError("sampled payment request has no searchable text")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Smoke the fixed Vkus payment-request adapter safely.",
    )
    parser.add_argument("--date-from", required=True)
    parser.add_argument("--date-to", required=True)
    parser.add_argument("--organization-id", required=True)
    args = parser.parse_args(argv)

    try:
        organization_id = provider._uuid(
            args.organization_id,
            "organization id",
        )
        initial = provider.command_general_search_documents(
            _document_args(
                date_from=args.date_from,
                date_to=args.date_to,
                organization_id=organization_id,
            ),
        )
        documents = initial.get("documents")
        if not isinstance(documents, list) or not documents:
            raise ValueError("bounded search returned no payment request")
        first = documents[0]
        # Independently total the same fixed 1C contour through a smaller
        # projection. This is a release control for the normalized grouped
        # totals, not a second public or caller-selectable query surface.
        search_args = _document_args(
            date_from=args.date_from,
            date_to=args.date_to,
            organization_id=organization_id,
        )
        payment_spec = provider.GENERAL_DOCUMENT_SPECS["payment_request"][0]
        control_filter, _matched_by = provider._general_document_filter(
            search_args,
            payment_spec,
        )
        identity, config, credentials = provider._connected_context()
        del identity
        source_capacity = (
            min(config.max_rows, provider.GENERAL_MAX_PAGE_SIZE)
            * min(config.max_pages, provider.GENERAL_MAX_PAGES)
        )
        control_rows = provider._odata_rows(
            provider._request_odata(
                config,
                credentials,
                payment_spec["entity"],
                (
                    ("$select", "Ref_Key,Date,СуммаДокумента,Валюта_Key"),
                    ("$filter", control_filter),
                    ("$orderby", "Date desc"),
                    ("$top", source_capacity),
                ),
                diagnostic_stage="general.document.payment_request.search",
            ),
        )
        control_truncated = len(control_rows) >= source_capacity
        control_totals: dict[str | None, Decimal] = {}
        control_fields = {
            "Ref_Key": "Edm.Guid",
            "Date": "Edm.DateTime",
            "СуммаДокумента": "Edm.Double",
            "Валюта_Key": "Edm.Guid",
        }
        for row in control_rows[:source_capacity]:
            provider._validate_general_source_record(row, control_fields)
            amount = provider._general_number(row.get("СуммаДокумента"))
            if amount is None:
                raise ValueError("control row has no numeric amount")
            currency_id = provider._general_uuid_value(
                row.get("Валюта_Key"),
                "control currency id",
            )
            control_totals[currency_id] = (
                control_totals.get(currency_id, Decimal(0))
                + Decimal(str(amount))
            )
        summary_totals = {
            item.get("currencyId"): Decimal(str(item.get("amount")))
            for item in (
                initial.get("managementAccounting", {}).get("currencyTotals")
                or []
            )
            if isinstance(item, dict) and item.get("amount") is not None
        }
        contour_control_matched = control_totals == summary_totals
        reference = provider._uuid(
            str(first.get("id") or ""),
            "payment request id",
        )
        keyword_result = provider.command_general_search_documents(
            _document_args(
                date_from=args.date_from,
                date_to=args.date_to,
                organization_id=organization_id,
                query=_keyword(first),
            ),
        )
        keyword_matches = keyword_result.get("documents") or []
        keyword_match = any(
            candidate.get("id") == reference
            for candidate in keyword_matches
            if isinstance(candidate, dict)
        )
        exact = provider.command_general_get_document(
            Namespace(
                kind="payment_request",
                id=reference,
                include_lines=True,
                line_limit=provider.GENERAL_MAX_LINES,
                include_sensitive=True,
            ),
        ).get("document")
        if not isinstance(exact, dict):
            raise ValueError("exact payment request was not returned")

        line_info = exact.get("lineInfo") or {}
        reconciliation = exact.get("amountReconciliation") or {}
        accounting = exact.get("managementAccounting") or {}
        text_completeness = exact.get("textCompleteness") or {}
        stable_match = (
            exact.get("id") == reference
            and (exact.get("source") or {}).get("stableKey")
            == f"payment_request:{reference}"
        )
        full_text_lengths = {
            field: len(value)
            for field in (
                "paymentPurpose",
                "comment",
                "recipientInformation",
            )
            if isinstance((value := exact.get(field)), str)
        }
        result = {
            "runtimeVersion": provider.RUNTIME_VERSION,
            "returned": len(documents),
            "keywordMatch": keyword_match,
            "exactStableMatch": stable_match,
            "fullTextLengths": full_text_lengths,
            "fullTextComplete": text_completeness.get("complete") is True,
            "fullTextTruncated": text_completeness.get("truncated") is True,
            "noteFieldAvailable": (
                text_completeness.get("noteField") or {}
            ).get("available"),
            "lineCount": line_info.get("returned"),
            "lineComplete": line_info.get("complete") is True,
            "amountReconciliation": reconciliation.get("status"),
            "sourceBreakdownCount": len(
                accounting.get("sourceBreakdown") or [],
            ),
            "pnlRecognition": (
                accounting.get("pnlRecognition") or {}
            ).get("status"),
            "contourControlMatched": contour_control_matched,
            "contourControlComplete": not control_truncated,
            "sourceContourTruncated": (
                initial.get("managementAccounting", {})
                .get("completeness", {})
                .get("sourceTruncated")
            ),
            "businessValuesIncluded": False,
        }
        required = (
            result["keywordMatch"] is True
            and result["exactStableMatch"] is True
            and result["fullTextComplete"] is True
            and result["fullTextTruncated"] is False
            and result["noteFieldAvailable"] is False
            and result["lineComplete"] is True
            and result["amountReconciliation"] == "matched"
            and result["sourceBreakdownCount"] == result["lineCount"]
            and result["pnlRecognition"] == "not_inferred"
            and result["contourControlMatched"] is True
            and result["contourControlComplete"] is True
            and result["sourceContourTruncated"] is False
        )
    except provider.OneCEdoError as error:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": provider._safe_error_payload(error),
                    "requestTrace": REQUEST_TRACE,
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
                        "code": "payment_request_smoke_failed",
                        "message": str(error)[:300],
                    },
                },
                ensure_ascii=False,
                separators=(",", ":"),
            ),
        )
        return 2

    print(
        json.dumps(
            {"ok": required, **result},
            ensure_ascii=False,
            separators=(",", ":"),
        ),
    )
    return 0 if required else 2


if __name__ == "__main__":
    raise SystemExit(main())
