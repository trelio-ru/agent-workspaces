#!/usr/bin/env python3
"""Development-only structural inventory for the Vkus finance contour.

The production skill must never discover 1C schema at runtime. This helper is
kept outside the packed runtime and is used only during a reviewed release:
it requests the one fixed ``$metadata`` endpoint through the established
``1c-edo`` connection, then writes only matching entity/property names,
declared EDM types and the metadata digest. It never serializes record values,
raw XML, credentials, headers or endpoint details.

The generic parser and the guarded metadata request already live in the
development inventory for ``1c-vkus-kadry``. Reusing that reviewed
implementation here keeps the secret-delivery, size limits and privacy
contract identical. Only the business search vocabulary differs.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import xml.etree.ElementTree as ET
from pathlib import Path
from types import ModuleType
from typing import Any


SHARED_INVENTORY_PATH = (
    Path(__file__).resolve().parents[2]
    / "1c-vkus-kadry"
    / "development"
    / "inventory_live.py"
)

# This vocabulary intentionally casts a wider net than the future production
# registry. Human review must still freeze a small exact set of sources and
# fields after bounded sample checks; a term match alone never authorizes a
# production capability.
FINANCE_TERM_GROUPS: dict[str, tuple[str, ...]] = {
    "sales_and_cost": (
        "продаж",
        "реализац",
        "выруч",
        "себестоим",
        "закуп",
        "поступлен",
        "возврат",
    ),
    "inventory_and_production": (
        "склад",
        "запас",
        "товар",
        "номенклат",
        "внутреннеепотреб",
        "потреблен",
        "списан",
        "инвентар",
        "оприход",
        "перемещ",
        "производ",
        "выпуск",
    ),
    "income_and_expenses": (
        "затрат",
        "расход",
        "доход",
        "прочие",
        "услуг",
        "аренд",
        "коммунал",
        "эквайр",
        "статьярасход",
        "статьядоход",
        "статьирасход",
        "статьидоход",
        "статьябюдж",
        "бюджет",
    ),
    "bank_and_cash": (
        "банк",
        "безнал",
        "денеж",
        "касс",
        "платеж",
        "платёж",
        "комис",
        "движениеденеж",
    ),
    "taxes": (
        "налог",
        "ндс",
        "усн",
        "страховыевзнос",
        "страховыевзносы",
        "пени",
    ),
    "payroll": (
        "зарплат",
        "начислен",
        "удержан",
        "отпуск",
        "компенсац",
        "бухучетзарплат",
        "бухучётзарплат",
    ),
    "fixed_assets": (
        "амортиз",
        "основныесредств",
        "внеоборот",
    ),
    "accounting": (
        "закрытиемесяца",
        "распредел",
        "финансов",
        "бухгалтер",
        "регламент",
        "хозрасчет",
        "хозрасчёт",
        "оборот",
        "остат",
        "регистратор",
        "дебет",
        "кредит",
        "счетучета",
        "счётучета",
    ),
    "financing": (
        "кредит",
        "заем",
        "заём",
        "процент",
    ),
}
MAX_OPERATIONS = 600


def _load_shared_inventory() -> ModuleType:
    """Load the reviewed structural parser without making dev code a package."""

    spec = importlib.util.spec_from_file_location(
        "trelio_vkus_shared_inventory",
        SHARED_INVENTORY_PATH,
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("shared inventory module cannot be loaded")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _operation_matches(value: str) -> list[dict[str, str]]:
    """Return bounded finance vocabulary matches for one metadata name."""

    normalized = value.casefold().replace("_", "").replace(" ", "")
    matches: list[dict[str, str]] = []
    for group, terms in FINANCE_TERM_GROUPS.items():
        for term in terms:
            normalized_term = term.casefold().replace("_", "").replace(" ", "")
            if normalized_term and normalized_term in normalized:
                matches.append({"group": group, "term": term})
                break
    return matches


def _parse_operations(raw: bytes, shared: ModuleType) -> dict[str, Any]:
    """Inventory declared OData operations without serializing raw metadata."""

    root = ET.fromstring(raw)
    declared_types: dict[str, list[dict[str, Any]]] = {}
    for schema in (
        element
        for element in root.iter()
        if shared._xml_local_name(element.tag) == "Schema"
    ):
        namespace = str(schema.attrib.get("Namespace") or "")
        for child in schema:
            if shared._xml_local_name(child.tag) not in {
                "EntityType",
                "ComplexType",
            }:
                continue
            type_name = str(child.attrib.get("Name") or "")
            if not type_name:
                continue
            properties = [
                {
                    "name": str(item.attrib.get("Name") or "")[:160],
                    "type": str(item.attrib.get("Type") or "")[:240],
                    "nullable": item.attrib.get("Nullable") != "false",
                }
                for item in child
                if (
                    shared._xml_local_name(item.tag) == "Property"
                    and item.attrib.get("Name")
                    and item.attrib.get("Type")
                )
            ]
            declared_types[type_name] = properties
            if namespace:
                declared_types[f"{namespace}.{type_name}"] = properties

    operations: list[dict[str, Any]] = []
    for element in root.iter():
        kind = shared._xml_local_name(element.tag)
        if kind not in {
            "Function",
            "FunctionImport",
            "Action",
            "ActionImport",
        }:
            continue
        name = str(element.attrib.get("Name") or "")
        target = str(
            element.attrib.get("Function")
            or element.attrib.get("Action")
            or ""
        )
        return_type = str(element.attrib.get("ReturnType") or "")
        parameters = [
            {
                "name": str(child.attrib.get("Name") or "")[:160],
                "type": str(child.attrib.get("Type") or "")[:240],
                "nullable": child.attrib.get("Nullable") != "false",
            }
            for child in element
            if (
                shared._xml_local_name(child.tag) == "Parameter"
                and child.attrib.get("Name")
                and child.attrib.get("Type")
            )
        ]
        matches = _operation_matches(
            " ".join(
                [
                    name,
                    target,
                    return_type,
                    *(item["name"] for item in parameters),
                ],
            ),
        )
        if not matches:
            continue
        declared_return_type = return_type
        if (
            declared_return_type.startswith("Collection(")
            and declared_return_type.endswith(")")
        ):
            declared_return_type = declared_return_type[len("Collection("):-1]
        return_fields = declared_types.get(declared_return_type, [])
        operations.append({
            "kind": kind,
            "name": name[:240],
            "target": target[:240],
            "returnType": return_type[:240],
            "parameters": parameters[:64],
            "parametersTruncated": len(parameters) > 64,
            "returnFields": return_fields[:256],
            "returnFieldsTruncated": len(return_fields) > 256,
            "matches": matches,
        })
    operations.sort(
        key=lambda item: (
            str(item["kind"]),
            str(item["name"]),
            str(item["target"]),
        ),
    )
    return {
        "operationCount": min(len(operations), MAX_OPERATIONS),
        "operationTotal": len(operations),
        "operationsTruncated": len(operations) > MAX_OPERATIONS,
        "operations": operations[:MAX_OPERATIONS],
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Inventory the fixed Vkus 1C finance schema without record values."
        ),
    )
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--match-mode",
        choices=["name", "name-or-field"],
        default="name",
        help=(
            "Use entity-name matches for the releasable contour, or include "
            "field-only matches for a wider relationship review."
        ),
    )
    parser.add_argument(
        "--include-derived-entity-sets",
        action="store_true",
        help=(
            "Include tabular-section and register-row EntitySet aliases. "
            "Production review normally keeps them nested under base entities."
        ),
    )
    args = parser.parse_args(argv)

    shared = _load_shared_inventory()
    # The shared parser resolves term groups dynamically from its module
    # globals. Override only that data table; all request, size and privacy
    # guards remain unchanged. Finance spans more source families than HR, so
    # keep a larger but still hard-bounded structural candidate limit. This
    # contains names and declared types only, never business record values.
    shared.HR_TERM_GROUPS = FINANCE_TERM_GROUPS
    shared.MAX_ENTITIES = 3_000
    shared.ALLOWED_ENTITY_PREFIXES = (
        *shared.ALLOWED_ENTITY_PREFIXES,
        "AccountingRegister_",
        "ChartOfAccounts_",
    )
    try:
        raw = shared._request_metadata()
        result = shared.parse_inventory(
            raw,
            match_mode=args.match_mode,
            base_entities_only=not args.include_derived_entity_sets,
        )
        result.update(_parse_operations(raw, shared))
        output_path = args.output.resolve()
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(
            json.dumps(
                {"ok": True, **result},
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
    except shared.provider_runtime.OneCEdoError as error:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": shared.provider_runtime._safe_error_payload(error),
                },
                ensure_ascii=False,
                separators=(",", ":"),
            ),
        )
        return error.exit_code
    except (OSError, RuntimeError, ValueError) as error:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": {
                        "code": "inventory_failed",
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
                "output": str(args.output),
                "schemaDigest": result["schemaDigest"],
                "candidateCount": result["candidateCount"],
                "candidatesTruncated": result["candidatesTruncated"],
            },
            ensure_ascii=False,
            separators=(",", ":"),
        ),
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
