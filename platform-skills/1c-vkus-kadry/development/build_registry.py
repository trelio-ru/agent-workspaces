#!/usr/bin/env python3
"""Build the signed HR source registry from a reviewed structural inventory."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path
from typing import Any, Iterable, Mapping


REGISTRY_SCHEMA_VERSION = 2
MAX_SOURCE_FIELDS = 512
MAX_SOURCE_COLLECTIONS = 64
MAX_ATTACHMENT_SOURCES = 200
SAFE_SCALAR_FIELDS = frozenset({
    "Ref_Key",
    "Description",
    "Code",
    "Number",
    "Date",
    "Posted",
    "DeletionMark",
    "Period",
    "LineNumber",
    "Active",
    "RecordType",
    "Recorder",
    "Recorder_Type",
    "Организация_Key",
    "Подразделение_Key",
    "Сотрудник_Key",
    "ФизическоеЛицо_Key",
    "Работник_Key",
    "Дата",
    "Номер",
    "Статус",
    "Состояние",
})
EMPLOYEE_FIELD_NAMES = frozenset({
    "Сотрудник_Key",
    "ФизическоеЛицо_Key",
    "Работник_Key",
})
SEARCH_FIELD_TERMS = (
    "description",
    "наименование",
    "фио",
    "фамили",
    "имя",
    "отчеств",
    "number",
    "номер",
    "code",
    "код",
)
DATE_FIELD_PRIORITY = (
    "Date",
    "Period",
    "Дата",
    "ДатаНачала",
    "ДатаОкончания",
    "ДатаСобытия",
)
EXCLUDED_SOURCE_TERMS = (
    "ПрисоединенныеФайлы",
    "Удалить",
    "ВнешниеПечатныеФормы",
    "ДополнительныеРеквизиты",
    "ФиксацияИзменений",
    "Очередь",
    "Настройки",
    "Шаблон",
    "Версия",
    "История",
    "Пакет",
)
EXCLUDED_PREFIXES = (
    "BusinessProcess_",
    "Task_",
)
QUERYABLE_PREFIXES = (
    "Catalog_",
    "Document_",
    "InformationRegister_",
    "AccumulationRegister_",
    "CalculationRegister_",
    "ChartOfCharacteristicTypes_",
    "ChartOfCalculationTypes_",
)
REGISTER_PREFIXES = (
    "InformationRegister_",
    "AccumulationRegister_",
    "CalculationRegister_",
)
ATTACHMENT_SUFFIX = "ПрисоединенныеФайлы"
ATTACHMENT_REQUIRED_FIELDS = {
    "Ref_Key": "Edm.Guid",
    "ВладелецФайла_Key": "Edm.Guid",
    "Размер": "Edm.Int64",
    "ФайлХранилище": "Edm.Stream",
}
ATTACHMENT_OPTIONAL_FIELDS = (
    "Description",
    "Описание",
    "Расширение",
    "ДатаСоздания",
    "ДатаМодификацииУниверсальная",
    "Зашифрован",
    "ПодписанЭП",
    "ТипХраненияФайла",
)


def _canonical_json(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def _source_title(entity: str) -> str:
    return entity.split("_", 1)[1]


def _primary_category(categories: Iterable[str]) -> str:
    ordered = (
        "people",
        "employment",
        "organization",
        "time",
        "health",
        "payroll",
        "taxes",
        "identity",
        "contact",
        "banking",
        "qualifications",
    )
    values = set(categories)
    return next((category for category in ordered if category in values), "hr")


def _source_key(entity: str, categories: Iterable[str]) -> str:
    category = _primary_category(categories)
    digest = hashlib.sha256(entity.encode("utf-8")).hexdigest()[:12]
    return f"{category}-{digest}"


def _is_excluded(entity: str) -> bool:
    return (
        not entity.startswith(QUERYABLE_PREFIXES)
        or entity.startswith(EXCLUDED_PREFIXES)
        or any(term in entity for term in EXCLUDED_SOURCE_TERMS)
    )


def _field_specs(raw_fields: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if len(raw_fields) > MAX_SOURCE_FIELDS:
        raise ValueError("source field count exceeds the registry limit")
    specs: list[dict[str, Any]] = []
    for field in raw_fields:
        name = str(field.get("name") or "")
        field_type = str(field.get("type") or "")
        if (
            not name
            or not field_type
            or name.startswith("Удалить")
            or field_type.startswith("Collection(")
            or field_type == "Edm.Binary"
        ):
            continue
        specs.append({
            "name": name,
            "type": field_type,
            "nullable": bool(field.get("nullable", True)),
            "sensitive": name not in SAFE_SCALAR_FIELDS,
        })
    return specs


def _query_fields(candidate: Mapping[str, Any]) -> tuple[str, list[dict[str, Any]]]:
    entity = str(candidate["entitySet"])
    if entity.startswith(REGISTER_PREFIXES):
        record_sets = [
            collection
            for collection in candidate.get("collections", [])
            if collection.get("name") == "RecordSet"
        ]
        if len(record_sets) != 1:
            raise ValueError(f"{entity} has no exact RecordSet schema")
        return f"{entity}_RecordType", _field_specs(record_sets[0]["properties"])
    return entity, _field_specs(candidate.get("properties", []))


def _collection_specs(candidate: Mapping[str, Any]) -> list[dict[str, Any]]:
    collections = candidate.get("collections", [])
    if len(collections) > MAX_SOURCE_COLLECTIONS:
        raise ValueError("source collection count exceeds the registry limit")
    result: list[dict[str, Any]] = []
    for collection in collections:
        collection_name = str(collection.get("name") or "")
        if (
            collection_name == "RecordSet"
            or collection_name.startswith("Удалить")
        ):
            continue
        result.append({
            "name": collection_name,
            "rowType": str(collection.get("rowType") or ""),
            "fields": _field_specs(collection.get("properties", [])),
        })
    return result


def _available_filters(fields: list[dict[str, Any]]) -> dict[str, Any]:
    field_types = {
        str(field["name"]): str(field["type"])
        for field in fields
    }
    search_fields = [
        name
        for name, field_type in field_types.items()
        if (
            field_type == "Edm.String"
            and any(term in name.casefold() for term in SEARCH_FIELD_TERMS)
        )
    ][:12]
    employee_fields = [
        name
        for name in EMPLOYEE_FIELD_NAMES
        if field_types.get(name) == "Edm.Guid"
    ]
    date_fields = [
        name
        for name in DATE_FIELD_PRIORITY
        if field_types.get(name) == "Edm.DateTime"
    ]
    if not date_fields:
        date_fields = [
            name
            for name, field_type in field_types.items()
            if field_type == "Edm.DateTime" and "дат" in name.casefold()
        ][:4]
    return {
        "recordId": "Ref_Key" if field_types.get("Ref_Key") == "Edm.Guid" else None,
        "queryFields": search_fields,
        "employeeFields": employee_fields,
        "dateFields": date_fields,
    }


def _attachment_source_key(entity: str) -> str:
    digest = hashlib.sha256(entity.encode("utf-8")).hexdigest()[:12]
    return f"attachment-{digest}"


def _attachment_sources(
    inventory: Mapping[str, Any],
    sources: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    owner_sources = {
        str(source["entity"]).split("_", 1)[1]: source["key"]
        for source in sources
        if "_" in str(source["entity"])
    }
    result: list[dict[str, Any]] = []
    for candidate in inventory.get("candidates", []):
        entity = str(candidate.get("entitySet") or "")
        if (
            not entity.startswith("Catalog_")
            or not entity.endswith(ATTACHMENT_SUFFIX)
            or entity.count("_") != 1
        ):
            continue
        properties = {
            str(field.get("name") or ""): str(field.get("type") or "")
            for field in candidate.get("properties", [])
        }
        if any(
            properties.get(name) != field_type
            for name, field_type in ATTACHMENT_REQUIRED_FIELDS.items()
        ):
            continue
        categories = sorted({
            str(match.get("group") or "")
            for match in candidate.get("matchedBy", {}).get("entityName", [])
            if match.get("group")
        })
        owner_stem = entity[len("Catalog_"):-len(ATTACHMENT_SUFFIX)]
        metadata_fields = [
            {
                "name": name,
                "type": properties[name],
                "sensitive": True,
            }
            for name in (
                "Ref_Key",
                "ВладелецФайла_Key",
                "Размер",
                *ATTACHMENT_OPTIONAL_FIELDS,
            )
            if name in properties and not properties[name].startswith("Collection(")
        ]
        result.append({
            "key": _attachment_source_key(entity),
            "title": owner_stem,
            "categories": categories,
            "entity": entity,
            "ownerField": "ВладелецФайла_Key",
            "recordIdField": "Ref_Key",
            "sizeField": "Размер",
            "contentField": "ФайлХранилище",
            "metadataFields": metadata_fields,
            "ownerSourceKey": owner_sources.get(owner_stem),
        })
    result.sort(key=lambda item: (item["title"], item["key"]))
    if len(result) > MAX_ATTACHMENT_SOURCES:
        raise ValueError("attachment source count exceeds the registry limit")
    return result


def build_registry(inventory: Mapping[str, Any]) -> dict[str, Any]:
    if inventory.get("ok") is not True:
        raise ValueError("inventory is not successful")
    if inventory.get("matchMode") != "name":
        raise ValueError("registry requires entity-name inventory")
    if inventory.get("baseEntitiesOnly") is not True:
        raise ValueError("registry requires base entities only")
    if inventory.get("candidatesTruncated") is not False:
        raise ValueError("registry cannot be built from truncated inventory")
    schema_digest = str(inventory.get("schemaDigest") or "")
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", schema_digest):
        raise ValueError("inventory schema digest is invalid")

    sources: list[dict[str, Any]] = []
    for candidate in inventory.get("candidates", []):
        if (
            candidate.get("propertiesTruncated")
            or candidate.get("collectionsTruncated")
            or any(
                collection.get("propertiesTruncated")
                for collection in candidate.get("collections", [])
            )
        ):
            raise ValueError("inventory contains a truncated source schema")
        entity = str(candidate.get("entitySet") or "")
        if _is_excluded(entity):
            continue
        categories = sorted({
            str(match.get("group") or "")
            for match in candidate.get("matchedBy", {}).get("entityName", [])
            if match.get("group")
        })
        query_entity, fields = _query_fields(candidate)
        if not fields:
            continue
        source = {
            "key": _source_key(entity, categories),
            "title": _source_title(entity),
            "categories": categories,
            "sourceKind": entity.split("_", 1)[0],
            "entity": query_entity,
            "fields": fields,
            "collections": _collection_specs(candidate),
            "filters": _available_filters(fields),
        }
        sources.append(source)

    sources.sort(key=lambda item: (item["title"], item["key"]))
    source_keys = [source["key"] for source in sources]
    if len(source_keys) != len(set(source_keys)):
        raise ValueError("generated source keys are not unique")
    attachment_sources = _attachment_sources(inventory, sources)
    attachment_source_keys = [
        source["key"]
        for source in attachment_sources
    ]
    if len(attachment_source_keys) != len(set(attachment_source_keys)):
        raise ValueError("generated attachment source keys are not unique")
    payload = {
        "schemaVersion": REGISTRY_SCHEMA_VERSION,
        "profileSchemaDigest": schema_digest,
        "sourceCount": len(sources),
        "attachmentSourceCount": len(attachment_sources),
        "categories": sorted({
            category
            for source in sources
            for category in source["categories"]
        }),
        "sources": sources,
        "attachmentSources": attachment_sources,
        "limits": {
            "maxPageSize": 10,
            "maxPages": 3,
            "maxResponseBytes": 8 * 1024 * 1024,
            "maxScalarFieldsPerSource": MAX_SOURCE_FIELDS,
            "maxCollectionsPerSource": MAX_SOURCE_COLLECTIONS,
            "maxAttachmentSources": MAX_ATTACHMENT_SOURCES,
            "maxAttachmentPageSize": 10,
            "maxAttachmentPages": 3,
            "maxAttachmentBytes": 100 * 1024 * 1024,
        },
        "safety": {
            "readOnly": True,
            "arbitraryEntity": False,
            "arbitraryField": False,
            "arbitraryOData": False,
            "massExport": False,
            "sensitiveFieldsRequireExplicitFlag": True,
            "binaryFieldsIncludedInRecordSearch": False,
            "exactAttachmentDownload": True,
            "attachmentOwnerRequired": True,
            "attachmentContentRequiresExplicitFlag": True,
        },
    }
    payload["registryDigest"] = (
        f"sha256:{hashlib.sha256(_canonical_json(payload)).hexdigest()}"
    )
    return payload


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Build the signed Vkus HR registry from a reviewed inventory.",
    )
    parser.add_argument("--inventory", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)

    inventory = json.loads(args.inventory.read_text(encoding="utf-8"))
    registry = build_registry(inventory)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(registry, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(
        json.dumps(
            {
                "ok": True,
                "sourceCount": registry["sourceCount"],
                "attachmentSourceCount": registry["attachmentSourceCount"],
                "registryDigest": registry["registryDigest"],
            },
            ensure_ascii=False,
            separators=(",", ":"),
        ),
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
