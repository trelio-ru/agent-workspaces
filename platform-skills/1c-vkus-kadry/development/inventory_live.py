#!/usr/bin/env python3
"""Development-only structural inventory for the Vkus HR 1C contour.

This executable is never packed into the production skill. It reads the one
fixed ``$metadata`` endpoint through the existing 1c-edo connection, keeps
personal Basic Auth in the established private local namespace, and accepts
the company ``X-OData`` value only through one-use Agent Secret delivery.

The result contains only entity/property names, declared EDM types, match
reasons and a SHA-256 digest. Raw XML, annotations, record values, credentials,
headers and endpoint details are never serialized.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import sys
import uuid
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any, Mapping


EXPECTED_COMPANY_ID = "33638f79-4d63-47f8-ab40-55ed70331592"
MAX_METADATA_BYTES = 64 * 1024 * 1024
MAX_ENTITIES = 800
MAX_PROPERTIES_PER_TYPE = 512
MAX_COLLECTIONS_PER_TYPE = 64
MAX_MATCH_TERMS = 32

# The inventory intentionally casts a wider net than the future production
# registry. A candidate can match by entity name or by a declared property.
# Human review then freezes only confirmed HR entities/fields into the signed
# package. This avoids guessing from a typical 1C configuration while still
# finding configuration-specific names.
HR_TERM_GROUPS: Mapping[str, tuple[str, ...]] = {
    "people": (
        "сотруд",
        "работник",
        "физическ",
        "персонал",
        "кандидат",
        "анкета",
    ),
    "employment": (
        "кадр",
        "трудов",
        "приемнаработу",
        "приёмнаработу",
        "увольн",
        "кадровыйперевод",
        "переводсотруд",
        "перемещениесотруд",
        "совмещ",
        "занятост",
        "стаж",
        "выслуг",
    ),
    "organization": (
        "должност",
        "штатн",
        "рабочее место",
        "професс",
        "разряд",
        "грейд",
    ),
    "time": (
        "графикработ",
        "графикисотруд",
        "табел",
        "рабочее время",
        "отсутств",
        "отпуск",
        "командиров",
        "прогул",
        "сверхуроч",
    ),
    "health": (
        "больнич",
        "нетрудоспособ",
        "медицин",
        "медосмотр",
        "инвалид",
        "травм",
        "декрет",
    ),
    "payroll": (
        "зарплат",
        "заработ",
        "начислениезарплат",
        "начислениясотруд",
        "удержаниясотруд",
        "ведомост",
        "депонир",
        "расчетзарплат",
        "расчётзарплат",
        "расчетсреднегозаработ",
        "расчётсреднегозаработ",
        "расчетныйлист",
        "расчётныйлист",
        "преми",
        "компенсац",
    ),
    "taxes": (
        "ндфл",
        "страховыевзнос",
        "пособ",
        "алименты",
    ),
    "identity": (
        "паспорт",
        "удостоверя",
        "гражданств",
        "миграц",
        "военн",
        "снилс",
        "документфиз",
    ),
    "contact": (
        "контактнаяинформацияфиз",
        "адресафиз",
        "телефоныфиз",
    ),
    "banking": (
        "банковскиесчетафиз",
        "банковскиесчетасотруд",
        "банковскиесчётасотруд",
        "лицевойсчетсотруд",
        "лицевойсчётсотруд",
        "зарплатныйпроект",
        "платежнаякартасотруд",
        "платёжнаякартасотруд",
    ),
    "qualifications": (
        "образован",
        "квалификац",
        "аттестац",
        "обучен",
    ),
}

ALLOWED_ENTITY_PREFIXES = (
    "Catalog_",
    "Document_",
    "InformationRegister_",
    "AccumulationRegister_",
    "CalculationRegister_",
    "ChartOfCharacteristicTypes_",
    "ChartOfCalculationTypes_",
    "BusinessProcess_",
    "Task_",
)

RUNTIME_SCRIPTS = Path(__file__).resolve().parents[2] / "1c-vkus" / "scripts"
sys.path.insert(0, str(RUNTIME_SCRIPTS))

import trelio_one_c_vkus_runtime as provider_runtime  # noqa: E402


def _xml_local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _normalized_matches(value: str) -> list[dict[str, str]]:
    normalized = value.casefold().replace("_", "").replace(" ", "")
    matches: list[dict[str, str]] = []
    for group, terms in HR_TERM_GROUPS.items():
        for term in terms:
            normalized_term = term.casefold().replace("_", "").replace(" ", "")
            if normalized_term and normalized_term in normalized:
                matches.append({"group": group, "term": term})
                break
    return matches[:MAX_MATCH_TERMS]


def _read_identity() -> provider_runtime.Identity:
    company_id = provider_runtime._uuid(
        os.environ.get("TRELIO_SKILL_COMPANY_ID"),
        "company id",
    )
    if company_id != EXPECTED_COMPANY_ID:
        raise provider_runtime.OneCEdoError(
            "invalid_host_context",
            "Development inventory разрешён только для компании «Вкус».",
        )
    return provider_runtime.Identity(
        company_id=company_id,
        member_id=provider_runtime._uuid(
            os.environ.get("TRELIO_SKILL_MEMBER_ID"),
            "member id",
        ),
        connection_id=provider_runtime._uuid(
            os.environ.get("TRELIO_SKILL_CONNECTION_ID"),
            "connection id",
        ),
    )


def _request_metadata() -> bytes:
    identity = _read_identity()
    config = provider_runtime.load_company_config()
    credentials = provider_runtime.load_credentials(identity, config)
    response = provider_runtime._http_open(
        "GET",
        f"{config.odata_base_url}$metadata",
        credentials=credentials,
        timeout=config.request_timeout_seconds,
        x_odata=provider_runtime._require_x_odata(),
        diagnostic_stage="doctor.probe",
        accept="application/xml",
    )
    with response:
        return provider_runtime._read_limited(response, MAX_METADATA_BYTES)


def parse_inventory(
    raw: bytes,
    *,
    match_mode: str = "name",
    base_entities_only: bool = True,
) -> dict[str, Any]:
    if match_mode not in {"name", "name-or-field"}:
        raise ValueError("unsupported inventory match mode")
    try:
        root = ET.fromstring(raw)
    except ET.ParseError as error:
        raise ValueError("metadata response is not valid XML") from error

    types: dict[str, dict[str, Any]] = {}
    entity_sets: list[tuple[str, str]] = []
    for schema in (
        element
        for element in root.iter()
        if _xml_local_name(element.tag) == "Schema"
    ):
        namespace = str(schema.attrib.get("Namespace") or "")
        for child in schema:
            local_name = _xml_local_name(child.tag)
            if local_name in {"EntityType", "ComplexType"}:
                type_name = str(child.attrib.get("Name") or "")
                if not type_name:
                    continue
                properties: list[dict[str, Any]] = []
                navigations: list[dict[str, str]] = []
                for item in child:
                    item_name = str(item.attrib.get("Name") or "")
                    item_type = str(item.attrib.get("Type") or "")
                    if not item_name or not item_type:
                        continue
                    if _xml_local_name(item.tag) == "Property":
                        properties.append({
                            "name": item_name[:160],
                            "type": item_type[:240],
                            "nullable": item.attrib.get("Nullable") != "false",
                        })
                    elif _xml_local_name(item.tag) == "NavigationProperty":
                        navigations.append({
                            "name": item_name[:160],
                            "type": item_type[:240],
                        })
                definition = {
                    "properties": properties[:MAX_PROPERTIES_PER_TYPE],
                    "propertiesTruncated": len(properties) > MAX_PROPERTIES_PER_TYPE,
                    "navigationProperties": navigations[:MAX_PROPERTIES_PER_TYPE],
                    "navigationPropertiesTruncated": (
                        len(navigations) > MAX_PROPERTIES_PER_TYPE
                    ),
                }
                types[type_name] = definition
                if namespace:
                    types[f"{namespace}.{type_name}"] = definition
            elif local_name == "EntityContainer":
                for item in child:
                    if _xml_local_name(item.tag) != "EntitySet":
                        continue
                    entity_name = str(item.attrib.get("Name") or "")
                    entity_type = str(item.attrib.get("EntityType") or "")
                    if entity_name and entity_type:
                        entity_sets.append((entity_name, entity_type))

    candidates: list[dict[str, Any]] = []
    for entity_name, entity_type in entity_sets:
        if not entity_name.startswith(ALLOWED_ENTITY_PREFIXES):
            continue
        # Standard 1C OData publishes tabular sections and register row
        # projections as additional EntitySets after another underscore.
        # Their schemas are already captured through collection properties on
        # the base entity. Keeping both would duplicate the same contour and
        # would turn a few hundred reviewed sources into thousands of aliases.
        _, entity_remainder = entity_name.split("_", 1)
        if base_entities_only and "_" in entity_remainder:
            continue
        definition = types.get(entity_type, {
            "properties": [],
            "propertiesTruncated": False,
            "navigationProperties": [],
            "navigationPropertiesTruncated": False,
        })
        name_matches = _normalized_matches(entity_name)
        field_matches: list[dict[str, Any]] = []
        for field in [
            *definition["properties"],
            *definition["navigationProperties"],
        ]:
            matches = _normalized_matches(str(field.get("name") or ""))
            if matches:
                field_matches.append({
                    "field": str(field.get("name") or "")[:160],
                    "matches": matches,
                })
        if (
            not name_matches
            and (match_mode == "name" or not field_matches)
        ):
            continue

        collections: list[dict[str, Any]] = []
        for field in definition["properties"]:
            field_type = str(field.get("type") or "")
            if not (
                field_type.startswith("Collection(")
                and field_type.endswith(")")
            ):
                continue
            row_type = field_type[len("Collection("):-1]
            row_definition = types.get(row_type, {
                "properties": [],
                "propertiesTruncated": False,
            })
            collections.append({
                "name": str(field.get("name") or "")[:160],
                "rowType": row_type[:240],
                "properties": row_definition["properties"],
                "propertiesTruncated": row_definition["propertiesTruncated"],
            })

        candidates.append({
            "entitySet": entity_name[:240],
            "entityType": entity_type[:240],
            "matchedBy": {
                "entityName": name_matches,
                "fields": field_matches[:MAX_PROPERTIES_PER_TYPE],
                "fieldsTruncated": len(field_matches) > MAX_PROPERTIES_PER_TYPE,
            },
            "properties": definition["properties"],
            "propertiesTruncated": definition["propertiesTruncated"],
            "navigationProperties": definition["navigationProperties"],
            "navigationPropertiesTruncated": (
                definition["navigationPropertiesTruncated"]
            ),
            "collections": collections[:MAX_COLLECTIONS_PER_TYPE],
            "collectionsTruncated": len(collections) > MAX_COLLECTIONS_PER_TYPE,
        })

    candidates.sort(
        key=lambda item: (
            0 if item["matchedBy"]["entityName"] else 1,
            str(item["entitySet"]),
        ),
    )
    limited = candidates[:MAX_ENTITIES]
    return {
        "inventoryVersion": 1,
        "matchMode": match_mode,
        "baseEntitiesOnly": base_entities_only,
        "generatedAt": (
            dt.datetime.now(dt.timezone.utc)
            .isoformat()
            .replace("+00:00", "Z")
        ),
        "schemaDigest": f"sha256:{hashlib.sha256(raw).hexdigest()}",
        "candidateCount": len(limited),
        "candidateTotal": len(candidates),
        "candidatesTruncated": len(candidates) > len(limited),
        "candidates": limited,
        "limits": {
            "maxMetadataBytes": MAX_METADATA_BYTES,
            "maxEntities": MAX_ENTITIES,
            "maxPropertiesPerType": MAX_PROPERTIES_PER_TYPE,
            "maxCollectionsPerType": MAX_COLLECTIONS_PER_TYPE,
            "sampleRows": 0,
        },
        "privacy": {
            "recordValuesIncluded": False,
            "rawMetadataIncluded": False,
            "credentialsIncluded": False,
            "endpointIncluded": False,
        },
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Inventory the fixed Vkus 1C HR schema without record values.",
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
    try:
        raw = _request_metadata()
        result = parse_inventory(
            raw,
            match_mode=args.match_mode,
            base_entities_only=not args.include_derived_entity_sets,
        )
        output_path = args.output.resolve()
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(
            json.dumps(
                {"ok": True, **result},
                ensure_ascii=False,
                indent=2,
            ) + "\n",
            encoding="utf-8",
        )
    except provider_runtime.OneCEdoError as error:
        print(
            json.dumps(
                {"ok": False, "error": provider_runtime._safe_error_payload(error)},
                ensure_ascii=False,
                separators=(",", ":"),
            ),
        )
        return error.exit_code
    except (OSError, ValueError) as error:
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
