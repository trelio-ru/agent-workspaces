#!/usr/bin/env python3
"""Probe the fixed Vkus payment-request source without emitting business data.

The production runtime must never discover entities or fields dynamically.
This development-only release helper checks the one reviewed
``Document_ЗаявкаНаРасходованиеДенежныхСредств`` route with a bounded period
and one exact organization or business-unit UUID.  Its output contains only
row counts, declared value classes, text lengths and reference source types;
document identifiers, numbers, names, text, amounts and other business values
are intentionally withheld.

The helper is not packed into the signed skill.  It exists so a maintainer can
prove that the prospective fixed registry still matches the live Vkus schema
before publishing a new immutable runtime release.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
import urllib.parse
from pathlib import Path
from typing import Any, Iterable, Mapping


EXPECTED_COMPANY_ID = "33638f79-4d63-47f8-ab40-55ed70331592"
FIXED_ENTITY = "Document_ЗаявкаНаРасходованиеДенежныхСредств"
MAX_RESPONSE_BYTES = 8 * 1024 * 1024
MAX_PROBE_ROWS = 5
MAX_PROBE_PERIOD_DAYS = 93
RUNTIME_SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(RUNTIME_SCRIPTS))

import trelio_one_c_vkus_runtime as provider  # noqa: E402


# Only fields required by Anna's acceptance scenario enter the probe.  Bank
# account numbers, tax requisites and other adjacent sensitive properties are
# deliberately excluded even though the source document publishes them.
FIXED_FIELDS: Mapping[str, str] = {
    "Ref_Key": "Edm.Guid",
    "Number": "Edm.String",
    "Date": "Edm.DateTime",
    "DeletionMark": "Edm.Boolean",
    "Posted": "Edm.Boolean",
    "Организация_Key": "Edm.Guid",
    "ОрганизацияПолучатель_Key": "Edm.Guid",
    "Подразделение_Key": "Edm.Guid",
    "Контрагент_Key": "Edm.Guid",
    "Партнер_Key": "Edm.Guid",
    "ПодотчетноеЛицо_Key": "Edm.Guid",
    "КтоЗаявил_Key": "Edm.Guid",
    "Автор_Key": "Edm.Guid",
    "СуммаДокумента": "Edm.Double",
    "Валюта_Key": "Edm.Guid",
    "Статус": "Edm.String",
    "ХозяйственнаяОперация": "Edm.String",
    "НазначениеПлатежа": "Edm.String",
    "Комментарий": "Edm.String",
    "ИнформацияПолучателюПлатежа": "Edm.String",
    "ЖелательнаяДатаПлатежа": "Edm.DateTime",
    "ДатаПлатежа": "Edm.DateTime",
    "СтатьяДвиженияДенежныхСредств_Key": "Edm.Guid",
    "СтатьяРасходов_Key": "Edm.Guid",
    "РасшифровкаПлатежа": (
        "Collection(StandardODATA."
        "Document_ЗаявкаНаРасходованиеДенежныхСредств_"
        "РасшифровкаПлатежа_RowType)"
    ),
}
FIXED_LINE_FIELDS: Mapping[str, str] = {
    "Ref_Key": "Edm.Guid",
    "LineNumber": "Edm.Int64",
    "Партнер_Key": "Edm.Guid",
    "Контрагент_Key": "Edm.Guid",
    "Организация_Key": "Edm.Guid",
    "Подразделение_Key": "Edm.Guid",
    "Сумма": "Edm.Double",
    "СуммаНДС": "Edm.Double",
    "ВалютаВзаиморасчетов_Key": "Edm.Guid",
    "СтатьяРасходов": "Edm.String",
    "СтатьяРасходов_Type": "Edm.String",
    "АналитикаРасходов": "Edm.String",
    "АналитикаРасходов_Type": "Edm.String",
    "СтатьяДвиженияДенежныхСредств_Key": "Edm.Guid",
    "Комментарий": "Edm.String",
}
TEXT_FIELDS = (
    "НазначениеПлатежа",
    "Комментарий",
    "ИнформацияПолучателюПлатежа",
)

# The OData document exposes plain GUIDs rather than navigation targets.  A
# bounded exact-id probe determines which already-known catalog owns each
# reference shape.  Results contain only catalog labels and match counts, not
# the GUID or catalog description.
REFERENCE_SOURCE_CANDIDATES: Mapping[str, tuple[str, ...]] = {
    "organization": ("Catalog_Организации",),
    "business_unit": (
        "Catalog_СтруктураПредприятия",
        "Catalog_ПодразделенияОрганизаций",
    ),
    "counterparty": ("Catalog_Контрагенты",),
    "partner": ("Catalog_Партнеры",),
    "person": (
        "Catalog_Пользователи",
        "Catalog_Сотрудники",
        "Catalog_ФизическиеЛица",
    ),
    "currency": ("Catalog_Валюты",),
    "expense_item": ("ChartOfCharacteristicTypes_СтатьиРасходов",),
    "cash_flow_item": ("Catalog_СтатьиДвиженияДенежныхСредств",),
}
# Applicant and currency labels are useful in the normalized read contract,
# but they must be frozen just as carefully as the payment-request fields.
# These two profiles are therefore checked against exact referenced UUIDs; the
# probe reports only JSON value classes and never serializes a catalog value.
REFERENCE_PROFILE_FIELDS: Mapping[str, Mapping[str, str]] = {
    "Catalog_Пользователи": {
        "Ref_Key": "Edm.Guid",
        "Description": "Edm.String",
        "DeletionMark": "Edm.Boolean",
    },
    "Catalog_Валюты": {
        "Ref_Key": "Edm.Guid",
        "Description": "Edm.String",
        "Code": "Edm.String",
        "DeletionMark": "Edm.Boolean",
    },
}
REFERENCE_FIELDS: Mapping[str, str] = {
    "Организация_Key": "organization",
    "ОрганизацияПолучатель_Key": "organization",
    "Подразделение_Key": "business_unit",
    "Контрагент_Key": "counterparty",
    "Партнер_Key": "partner",
    "ПодотчетноеЛицо_Key": "person",
    "КтоЗаявил_Key": "person",
    "Автор_Key": "person",
    "Валюта_Key": "currency",
    "СтатьяРасходов_Key": "expense_item",
    "СтатьяДвиженияДенежныхСредств_Key": "cash_flow_item",
}


def _identity() -> provider.Identity:
    """Read only the exact host identity bound to the Vkus company."""

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


def _date(value: str, label: str) -> dt.date:
    try:
        return dt.date.fromisoformat(value)
    except ValueError as error:
        raise ValueError(f"{label} must be YYYY-MM-DD") from error


def _value_class(value: Any) -> str:
    """Return a non-sensitive structural class for one live JSON value."""

    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, list):
        return "array"
    if isinstance(value, dict):
        return "object"
    return "unknown"


def _fixed_get(
    config: provider.CompanyConfig,
    credentials: provider.Credentials,
    entity: str,
    parameters: Iterable[tuple[str, str | int]],
) -> list[dict[str, Any]]:
    """Run one fixed read-only OData GET with the reviewed runtime transport."""

    allowed = {FIXED_ENTITY}
    for candidates in REFERENCE_SOURCE_CANDIDATES.values():
        allowed.update(candidates)
    if entity not in allowed:
        raise ValueError("development probe entity is not allowlisted")
    url = (
        f"{config.odata_base_url}"
        f"{urllib.parse.quote(entity, safe='_')}"
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
    return provider._odata_rows(json.loads(raw.decode("utf-8")))


def _reference_source_summary(
    config: provider.CompanyConfig,
    credentials: provider.Credentials,
    records: list[dict[str, Any]],
) -> dict[str, Any]:
    """Resolve reference source types while keeping exact IDs and names private."""

    resolved: dict[str, set[str]] = {field: set() for field in REFERENCE_FIELDS}
    unavailable_candidates: set[str] = set()
    profile_classes: dict[str, dict[str, set[str]]] = {
        entity: {field: set() for field in fields}
        for entity, fields in REFERENCE_PROFILE_FIELDS.items()
    }
    profile_mismatches: set[str] = set()
    values = {
        field: {
            value
            for record in records
            if isinstance((value := record.get(field)), str)
            and value != provider.ZERO_UUID
        }
        for field in REFERENCE_FIELDS
    }
    for field, source_kind in REFERENCE_FIELDS.items():
        # Five sampled documents times three person catalogs is the largest
        # branch. Every query remains exact-id and capped at two rows so an
        # ambiguous source fails review instead of turning into discovery.
        for reference in sorted(values[field]):
            normalized = provider._uuid(reference, f"{field} reference")
            for entity in REFERENCE_SOURCE_CANDIDATES[source_kind]:
                profile = REFERENCE_PROFILE_FIELDS.get(entity)
                try:
                    rows = _fixed_get(
                        config,
                        credentials,
                        entity,
                        (
                            (
                                "$select",
                                ",".join(profile) if profile else "Ref_Key",
                            ),
                            ("$filter", f"Ref_Key eq guid'{normalized}'"),
                            ("$top", 2),
                        ),
                    )
                except provider.OneCEdoError as error:
                    # Some standard-looking catalogs can be declared in the
                    # metadata while their EntitySet route is not published
                    # for this deployment. A fixed 400/404 marks only that
                    # candidate as unavailable; authentication, transport and
                    # every other failure must still abort the whole review.
                    if (
                        error.code == "http_error"
                        and error.details.get("httpStatus") in {400, 404}
                    ):
                        unavailable_candidates.add(entity)
                        continue
                    raise
                if len(rows) > 1:
                    raise ValueError("reference probe returned an ambiguous exact id")
                if rows:
                    resolved[field].add(entity)
                    if profile:
                        row = rows[0]
                        for profile_field, expected_type in profile.items():
                            value = row.get(profile_field)
                            profile_classes[entity][profile_field].add(
                                _value_class(value),
                            )
                            if (
                                profile_field not in row
                                or not provider._general_value_matches_edm(
                                    value,
                                    expected_type,
                                )
                            ):
                                profile_mismatches.add(
                                    f"{entity}.{profile_field}",
                                )
    return {
        "resolved": {
            field: sorted(entities)
            for field, entities in resolved.items()
        },
        "unavailableCandidates": sorted(unavailable_candidates),
        "profileClasses": {
            entity: {
                field: sorted(classes)
                for field, classes in fields.items()
            }
            for entity, fields in profile_classes.items()
        },
        "profileMismatches": sorted(profile_mismatches),
    }


def _structural_summary(records: list[dict[str, Any]]) -> dict[str, Any]:
    """Reduce live rows to evidence that contains no business values."""

    field_classes = {
        field: sorted({_value_class(record.get(field)) for record in records})
        for field in FIXED_FIELDS
    }
    missing_fields = sorted({
        field
        for field in FIXED_FIELDS
        if any(field not in record for record in records)
    })
    type_mismatches = sorted({
        field
        for field, expected_type in FIXED_FIELDS.items()
        if any(
            not provider._general_value_matches_edm(record.get(field), expected_type)
            for record in records
            if field in record
        )
    })
    lines = [
        line
        for record in records
        for line in (record.get("РасшифровкаПлатежа") or [])
        if isinstance(line, dict)
    ]
    line_missing_fields = sorted({
        field
        for field in FIXED_LINE_FIELDS
        if any(field not in line for line in lines)
    })
    line_type_mismatches = sorted({
        field
        for field, expected_type in FIXED_LINE_FIELDS.items()
        if any(
            not provider._general_value_matches_edm(line.get(field), expected_type)
            for line in lines
            if field in line
        )
    })
    return {
        "returned": len(records),
        "fieldClasses": field_classes,
        "missingFields": missing_fields,
        "typeMismatches": type_mismatches,
        "lineCount": len(lines),
        "lineMissingFields": line_missing_fields,
        "lineTypeMismatches": line_type_mismatches,
        "textLengths": {
            field: sorted({
                len(value)
                for record in records
                if isinstance((value := record.get(field)), str)
            })
            for field in TEXT_FIELDS
        },
        "lineCommentLengths": sorted({
            len(value)
            for line in lines
            if isinstance((value := line.get("Комментарий")), str)
        }),
        "businessValuesIncluded": False,
    }


def _contract_group_checks(
    config: provider.CompanyConfig,
    credentials: provider.Credentials,
    *,
    filter_value: str,
) -> dict[str, dict[str, Any]]:
    """Check fixed select groups and report only structural availability.

    1C occasionally publishes an EntitySet in ``$metadata`` while rejecting a
    particular field combination at runtime.  These deterministic probes make
    that difference reviewable without exposing the returned record.
    """

    groups = {
        "minimal": ("Ref_Key", "Date"),
        "header": tuple(
            field for field in FIXED_FIELDS if field != "РасшифровкаПлатежа"
        ),
        "lines": ("Ref_Key", "РасшифровкаПлатежа"),
        "full": tuple(FIXED_FIELDS),
    }
    result: dict[str, dict[str, Any]] = {}
    for name, fields in groups.items():
        try:
            rows = _fixed_get(
                config,
                credentials,
                FIXED_ENTITY,
                (
                    ("$select", ",".join(fields)),
                    ("$filter", filter_value),
                    ("$top", 1),
                ),
            )
            result[name] = {"available": True, "returned": min(len(rows), 1)}
        except provider.OneCEdoError as error:
            if (
                error.code == "http_error"
                and error.details.get("httpStatus") in {400, 404}
            ):
                result[name] = {
                    "available": False,
                    "httpStatus": error.details["httpStatus"],
                }
                continue
            raise
    return result


def _filter_shape_checks(
    config: provider.CompanyConfig,
    credentials: provider.Credentials,
    *,
    filter_value: str,
) -> dict[str, dict[str, Any]]:
    """Prove whether this source accepts generic per-clause parentheses."""

    # The base filter contains only fixed clauses joined by this helper, so
    # splitting that exact string cannot introduce caller-controlled syntax.
    wrapped = " and ".join(
        f"({clause})"
        for clause in filter_value.split(" and ")
    )
    result: dict[str, dict[str, Any]] = {}
    for name, candidate in (("flat", filter_value), ("wrapped", wrapped)):
        try:
            rows = _fixed_get(
                config,
                credentials,
                FIXED_ENTITY,
                (
                    ("$select", "Ref_Key,Date"),
                    ("$filter", candidate),
                    ("$orderby", "Date desc"),
                    ("$top", MAX_PROBE_ROWS + 1),
                ),
            )
            result[name] = {
                "available": True,
                "returned": min(len(rows), MAX_PROBE_ROWS + 1),
            }
        except provider.OneCEdoError as error:
            if (
                error.code == "http_error"
                and error.details.get("httpStatus") in {400, 404}
            ):
                result[name] = {
                    "available": False,
                    "httpStatus": error.details["httpStatus"],
                }
                continue
            raise
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Probe the fixed Vkus payment-request source safely.",
    )
    parser.add_argument("--date-from", required=True)
    parser.add_argument("--date-to-exclusive", required=True)
    scope = parser.add_mutually_exclusive_group(required=True)
    scope.add_argument("--organization-id")
    scope.add_argument("--business-unit-id")
    args = parser.parse_args(argv)

    try:
        start = _date(args.date_from, "date-from")
        end = _date(args.date_to_exclusive, "date-to-exclusive")
        if start >= end or end - start > dt.timedelta(days=MAX_PROBE_PERIOD_DAYS):
            raise ValueError(
                f"probe period must be from 1 to {MAX_PROBE_PERIOD_DAYS} days",
            )
        scope_field = (
            "Организация_Key" if args.organization_id else "Подразделение_Key"
        )
        scope_value = provider._uuid(
            args.organization_id or args.business_unit_id,
            "scope id",
        )
        identity = _identity()
        config = provider.load_company_config()
        credentials = provider.load_credentials(identity, config)
        start_literal = f"datetime'{start.isoformat()}T00:00:00'"
        end_literal = f"datetime'{end.isoformat()}T00:00:00'"
        filter_value = (
            f"Date ge {start_literal} and Date lt {end_literal} and "
            f"{scope_field} eq guid'{scope_value}' and "
            "DeletionMark eq false"
        )
        contract_checks = _contract_group_checks(
            config,
            credentials,
            filter_value=filter_value,
        )
        filter_shape_checks = _filter_shape_checks(
            config,
            credentials,
            filter_value=filter_value,
        )
        failed_groups = [
            name
            for name, check in contract_checks.items()
            if name in {"minimal", "header", "lines"}
            and not check["available"]
        ]
        if failed_groups:
            raise ValueError(
                "source contract groups failed: " + ", ".join(failed_groups),
            )
        # The live endpoint rejects one long `$select` that combines every
        # header field with the nested collection, while the same exact header
        # and collection contracts work independently. Keep the release probe
        # aligned with the prospective production split-read instead of
        # treating a URL-size quirk as missing data.
        header_fields = tuple(
            field for field in FIXED_FIELDS if field != "РасшифровкаПлатежа"
        )
        records = _fixed_get(
            config,
            credentials,
            FIXED_ENTITY,
            (
                ("$select", ",".join(header_fields)),
                (
                    "$filter",
                    filter_value,
                ),
                ("$orderby", "Date desc"),
                ("$top", MAX_PROBE_ROWS + 1),
            ),
        )
        if len(records) > MAX_PROBE_ROWS:
            records = records[:MAX_PROBE_ROWS]
            source_truncated = True
        else:
            source_truncated = False
        for record in records:
            reference = provider._uuid(
                str(record.get("Ref_Key") or ""),
                "payment request id",
            )
            line_rows = _fixed_get(
                config,
                credentials,
                FIXED_ENTITY,
                (
                    ("$select", "Ref_Key,РасшифровкаПлатежа"),
                    ("$filter", f"Ref_Key eq guid'{reference}'"),
                    ("$top", 2),
                ),
            )
            if len(line_rows) != 1 or line_rows[0].get("Ref_Key") != reference:
                raise ValueError("split line read did not return one exact document")
            record["РасшифровкаПлатежа"] = line_rows[0].get(
                "РасшифровкаПлатежа",
            )
        result = _structural_summary(records)
        result["referenceSources"] = _reference_source_summary(
            config,
            credentials,
            records,
        )
        result["sourceTruncated"] = source_truncated
        result["contractChecks"] = contract_checks
        result["filterShapeChecks"] = filter_shape_checks
        result["splitReadRequired"] = not contract_checks["full"]["available"]
    except provider.OneCEdoError as error:
        print(
            json.dumps(
                {"ok": False, "error": provider._safe_error_payload(error)},
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
                        "code": "payment_request_probe_failed",
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
            {
                "ok": True,
                "dateFrom": start.isoformat(),
                "dateToExclusive": end.isoformat(),
                "scopeKind": (
                    "organization" if args.organization_id else "business_unit"
                ),
                **result,
            },
            ensure_ascii=False,
            separators=(",", ":"),
        ),
    )
    return 0 if not result["missingFields"] and not result["typeMismatches"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
