#!/usr/bin/env python3
"""Company-private read-only runtime for the complete Vkus HR 1C contour.

The runtime accepts only source keys and filters frozen in ``hr_registry.json``.
It has no caller-controlled URL, entity, field, OData expression or method.
Sensitive scalar fields and document lines are requested only after the caller
passes an explicit flag; binary fields are absent from the signed registry.
"""

from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import hashlib
import json
import os
import re
import sys
import tempfile
import urllib.parse
import uuid
from pathlib import Path
from typing import Any, Iterable, Mapping

import _one_c_provider_runtime as provider


HR_SKILL_ID = (
    "company-33638f79-4d63-47f8-ab40-55ed70331592-1c-vkus-kadry"
)
EXPECTED_COMPANY_ID = "33638f79-4d63-47f8-ab40-55ed70331592"
RUNTIME_VERSION = "1.0.6"
REGISTRY_PATH = Path(__file__).with_name("hr_registry.json")
MAX_RESPONSE_BYTES = 8 * 1024 * 1024
MAX_CONNECTION_PROBE_BYTES = 64 * 1024
MAX_QUERY_CHARS = 200
MAX_PAGE_SIZE = 10
MAX_PAGES = 3
MAX_LINE_LIMIT = 100
MAX_OUTPUT_FIELDS = 512
MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024
SOURCE_KEY_RE = re.compile(r"^[a-z]+-[0-9a-f]{12}$")
CONNECTION_PROBE_SOURCE_KEY = "people-873b10474c45"
CONNECTION_PROBE_FIELD = "Ref_Key"
ENTITY_RE = re.compile(
    r"^(?:Catalog|Document|InformationRegister|AccumulationRegister|"
    r"CalculationRegister|ChartOfCharacteristicTypes|"
    r"ChartOfCalculationTypes)_[A-Za-zА-Яа-яЁё0-9]+(?:_RecordType)?$",
)

# The HR runtime owns a separate connection and credential directory. There is
# deliberately no fallback to the old `1c-edo` identity or local files.
provider.configure_connection_surface(
    skill_id=HR_SKILL_ID,
    credential_namespace="1c-vkus-kadry",
    runtime_version=RUNTIME_VERSION,
)


class HrRuntimeError(provider.OneCEdoError):
    """Agent-visible fail-closed HR runtime error."""


def _canonical_json(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def _load_registry() -> dict[str, Any]:
    try:
        value = json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise HrRuntimeError(
            "registry_invalid",
            "Подписанный кадровый registry недоступен или повреждён.",
        ) from error
    if not isinstance(value, dict) or value.get("schemaVersion") != 2:
        raise HrRuntimeError(
            "registry_invalid",
            "Подписанный кадровый registry имеет неподдерживаемую схему.",
        )
    expected_digest = value.get("registryDigest")
    unsigned = dict(value)
    unsigned.pop("registryDigest", None)
    actual_digest = f"sha256:{hashlib.sha256(_canonical_json(unsigned)).hexdigest()}"
    if expected_digest != actual_digest:
        raise HrRuntimeError(
            "registry_invalid",
            "Подписанный кадровый registry не прошёл проверку digest.",
        )
    sources = value.get("sources")
    if (
        not isinstance(sources, list)
        or value.get("sourceCount") != len(sources)
        or len(sources) > 800
    ):
        raise HrRuntimeError(
            "registry_invalid",
            "Подписанный кадровый registry содержит некорректный список источников.",
        )
    seen: set[str] = set()
    for source in sources:
        if not isinstance(source, dict):
            raise HrRuntimeError("registry_invalid", "Кадровый source contract повреждён.")
        key = source.get("key")
        entity = source.get("entity")
        if (
            not isinstance(key, str)
            or not SOURCE_KEY_RE.fullmatch(key)
            or key in seen
            or not isinstance(entity, str)
            or not ENTITY_RE.fullmatch(entity)
        ):
            raise HrRuntimeError("registry_invalid", "Кадровый source contract повреждён.")
        seen.add(key)
    attachment_sources = value.get("attachmentSources")
    if (
        not isinstance(attachment_sources, list)
        or value.get("attachmentSourceCount") != len(attachment_sources)
        or len(attachment_sources) > 200
    ):
        raise HrRuntimeError(
            "registry_invalid",
            "Подписанный кадровый registry содержит некорректные attachment sources.",
        )
    attachment_seen: set[str] = set()
    for source in attachment_sources:
        if not isinstance(source, dict):
            raise HrRuntimeError(
                "registry_invalid",
                "Кадровый attachment source contract повреждён.",
            )
        key = source.get("key")
        entity = source.get("entity")
        metadata_fields = source.get("metadataFields")
        if (
            not isinstance(key, str)
            or not SOURCE_KEY_RE.fullmatch(key)
            or key in attachment_seen
            or not isinstance(entity, str)
            or not entity.startswith("Catalog_")
            or not entity.endswith("ПрисоединенныеФайлы")
            or not ENTITY_RE.fullmatch(entity)
            or source.get("ownerField") != "ВладелецФайла_Key"
            or source.get("recordIdField") != "Ref_Key"
            or source.get("sizeField") != "Размер"
            or source.get("contentField") != "ФайлХранилище"
            or not isinstance(metadata_fields, list)
            or not metadata_fields
        ):
            raise HrRuntimeError(
                "registry_invalid",
                "Кадровый attachment source contract повреждён.",
            )
        field_contract = {
            str(field.get("name") or ""): str(field.get("type") or "")
            for field in metadata_fields
            if isinstance(field, dict)
        }
        if (
            field_contract.get("Ref_Key") != "Edm.Guid"
            or field_contract.get("ВладелецФайла_Key") != "Edm.Guid"
            or field_contract.get("Размер") != "Edm.Int64"
        ):
            raise HrRuntimeError(
                "registry_invalid",
                "Кадровый attachment metadata contract повреждён.",
            )
        attachment_seen.add(key)
    return value


def _current_identity() -> provider.Identity:
    skill_id = str(os.environ.get("TRELIO_SKILL_ID") or "").strip()
    if skill_id != HR_SKILL_ID:
        raise HrRuntimeError(
            "invalid_host_context",
            "Runtime запущен не для кадрового навыка компании «Вкус».",
        )
    company_id = provider._uuid(
        os.environ.get("TRELIO_SKILL_COMPANY_ID"),
        "company id",
    )
    if company_id != EXPECTED_COMPANY_ID:
        raise HrRuntimeError(
            "invalid_host_context",
            "Runtime запущен не для компании «Вкус».",
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


def _connected_context() -> tuple[
    provider.CompanyConfig,
    provider.Credentials,
]:
    identity = _current_identity()
    config = provider.load_company_config()
    credentials = provider.load_credentials(identity, config)
    return config, credentials


def _probe_personal_connection(
    config: provider.CompanyConfig,
    credentials: provider.Credentials,
    *,
    diagnostic_stage: str,
) -> None:
    """Probe one fixed HR source without expanding the signed data contour.

    The shared provider helper deliberately allows only entities owned by the
    broad ``1c-vkus`` runtime. HR entities come from this runtime's separately
    signed registry, so routing the probe through the provider's broad entity
    allowlist would reject a valid HR source locally as ``entity_blocked``
    before any authentication request reached 1C. Build only this exact
    registry-backed GET here while retaining the provider's audited HTTPS,
    SSRF, redirect, timeout, Basic Auth and X-OData boundaries.
    """

    registry = _load_registry()
    matches = [
        source
        for source in registry["sources"]
        if source.get("key") == CONNECTION_PROBE_SOURCE_KEY
    ]
    if len(matches) != 1:
        raise HrRuntimeError(
            "registry_invalid",
            "Подписанный кадровый registry не содержит источник проверки доступа.",
        )
    source = matches[0]
    fields = source.get("fields")
    probe_fields = [
        field
        for field in fields
        if isinstance(field, dict)
        and field.get("name") == CONNECTION_PROBE_FIELD
        and field.get("sensitive") is False
    ] if isinstance(fields, list) else []
    if len(probe_fields) != 1:
        raise HrRuntimeError(
            "registry_invalid",
            "Подписанный кадровый registry не содержит поле для проверки доступа.",
        )
    probe_field = probe_fields[0]
    entity = str(source.get("entity") or "")
    if not ENTITY_RE.fullmatch(entity):
        raise HrRuntimeError(
            "registry_invalid",
            "Источник проверки доступа повреждён.",
        )
    parameters = (
        ("$select", CONNECTION_PROBE_FIELD),
        ("$top", 1),
    )
    url = (
        f"{config.odata_base_url}{urllib.parse.quote(entity, safe='_')}"
        f"?{provider._odata_query(parameters)}"
    )
    response = provider._http_open(
        "GET",
        url,
        credentials=credentials,
        timeout=config.request_timeout_seconds,
        x_odata=provider._require_x_odata(),
        diagnostic_stage=diagnostic_stage,
    )
    with response:
        raw = provider._read_limited(response, MAX_CONNECTION_PROBE_BYTES)
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise HrRuntimeError(
            "source_contract_mismatch",
            "1С вернула некорректный ответ проверки кадрового доступа.",
        ) from error
    if not isinstance(payload, dict):
        raise HrRuntimeError(
            "source_contract_mismatch",
            "1С вернула некорректный ответ проверки кадрового доступа.",
        )
    rows = provider._odata_rows(payload)
    if len(rows) > 1:
        raise HrRuntimeError(
            "source_contract_mismatch",
            "1С проигнорировала лимит проверки кадрового доступа.",
        )
    for row in rows:
        value = row.get(CONNECTION_PROBE_FIELD)
        if CONNECTION_PROBE_FIELD not in row or not _field_type_matches(
            value,
            str(probe_field.get("type") or ""),
        ):
            raise HrRuntimeError(
                "source_contract_mismatch",
                "1С вернула ответ вне подписанного контракта проверки доступа.",
            )


def command_connect(args: argparse.Namespace) -> dict[str, Any]:
    identity = _current_identity()
    config = provider.load_company_config()
    credentials = provider.prompt_credentials(args)
    try:
        _probe_personal_connection(
            config,
            credentials,
            diagnostic_stage="connect.probe",
        )
    except provider.AuthenticationError:
        provider._mark_auth_failure(identity, config)
        raise
    provider.save_credentials(identity, config, credentials)
    provider.save_access_state(identity, config, "connected")
    if provider.BROWSER_PROMPT_SESSION is not None:
        provider.BROWSER_PROMPT_SESSION.finish(
            title="1С подключена",
            message="Личные данные проверены и сохранены только на этом компьютере.",
        )
    return {"status": "connected"}


def command_doctor(_: argparse.Namespace) -> dict[str, Any]:
    identity = _current_identity()
    config = provider.load_company_config()
    state = provider.load_access_state(identity, config)
    result: dict[str, Any] = {
        "status": state["status"],
        "connectionChanged": state["connectionChanged"],
        "companyConfig": {
            "configured": True,
            "maxRows": config.max_rows,
            "maxPages": config.max_pages,
            "maxFileBytes": config.max_file_bytes,
            "requestTimeoutSeconds": config.request_timeout_seconds,
        },
        "network": "not_checked",
    }
    if state["status"] in {"connected", "needs_reconnect"}:
        try:
            credentials = provider.load_credentials(identity, config)
            _probe_personal_connection(
                config,
                credentials,
                diagnostic_stage="doctor.probe",
            )
            provider.save_access_state(identity, config, "connected")
            result["status"] = "connected"
            result["network"] = "ok"
        except provider.AuthenticationError:
            provider._mark_auth_failure(identity, config)
            result["status"] = "needs_reconnect"
            result["network"] = "authentication_failed"
        except provider.NetworkError:
            result["network"] = "unreachable"
    return result


def command_access_show(args: argparse.Namespace) -> dict[str, Any]:
    _current_identity()
    return provider.command_access_show(args)


def command_access_no_access(args: argparse.Namespace) -> dict[str, Any]:
    _current_identity()
    return provider.command_access_no_access(args)


def command_access_reset(args: argparse.Namespace) -> dict[str, Any]:
    _current_identity()
    return provider.command_access_reset(args)


def command_forget_credentials(args: argparse.Namespace) -> dict[str, Any]:
    _current_identity()
    return provider.command_forget_credentials(args)


def _source_by_key(registry: Mapping[str, Any], key: str) -> dict[str, Any]:
    matches = [
        source
        for source in registry["sources"]
        if source.get("key") == key
    ]
    if len(matches) != 1:
        raise HrRuntimeError(
            "source_blocked",
            "Источник не входит в текущий подписанный кадровый registry.",
        )
    return matches[0]


def _attachment_source_by_key(
    registry: Mapping[str, Any],
    key: str,
) -> dict[str, Any]:
    matches = [
        source
        for source in registry["attachmentSources"]
        if source.get("key") == key
    ]
    if len(matches) != 1:
        raise HrRuntimeError(
            "attachment_source_blocked",
            "Источник вложений не входит в текущий подписанный кадровый registry.",
        )
    return matches[0]


def _bounded_int(
    value: int,
    label: str,
    *,
    minimum: int,
    maximum: int,
) -> int:
    if isinstance(value, bool) or value < minimum or value > maximum:
        raise HrRuntimeError(
            "invalid_limit",
            f"Параметр {label} должен быть от {minimum} до {maximum}.",
        )
    return value


def _uuid(value: str, label: str) -> str:
    return provider._uuid(value, label)


def _date(value: str, label: str) -> dt.date:
    try:
        parsed = dt.date.fromisoformat(value)
    except ValueError as error:
        raise HrRuntimeError(
            "invalid_date",
            f"Параметр {label} должен использовать YYYY-MM-DD.",
        ) from error
    if parsed.year < 1900 or parsed.year > 2200:
        raise HrRuntimeError("invalid_date", f"Параметр {label} вне допустимого диапазона.")
    return parsed


def _odata_literal(value: str) -> str:
    normalized = value.strip()
    if not normalized or len(normalized) > MAX_QUERY_CHARS:
        raise HrRuntimeError(
            "invalid_query",
            f"Поисковый текст должен содержать от 1 до {MAX_QUERY_CHARS} символов.",
        )
    if any(ord(character) < 32 for character in normalized):
        raise HrRuntimeError("invalid_query", "Поисковый текст содержит управляющие символы.")
    return f"'{normalized.replace(chr(39), chr(39) * 2)}'"


def _field_type_matches(value: Any, expected_type: str) -> bool:
    if value is None:
        return True
    if expected_type == "Edm.String":
        return isinstance(value, str)
    if expected_type == "Edm.Boolean":
        return isinstance(value, bool)
    if expected_type == "Edm.Guid":
        if not isinstance(value, str):
            return False
        try:
            return str(uuid.UUID(value)).lower() == value.lower()
        except ValueError:
            return False
    if expected_type in {"Edm.DateTime", "Edm.DateTimeOffset", "Edm.Date"}:
        return (
            isinstance(value, str)
            and (
                re.fullmatch(r"\d{4}-\d{2}-\d{2}(?:T.*)?", value) is not None
                or re.fullmatch(r"/Date\(-?\d+(?:[+-]\d{4})?\)/", value) is not None
            )
        )
    if expected_type in {
        "Edm.Byte",
        "Edm.SByte",
        "Edm.Int16",
        "Edm.Int32",
        "Edm.Int64",
        "Edm.Single",
        "Edm.Double",
        "Edm.Decimal",
    }:
        return (
            not isinstance(value, bool)
            and isinstance(value, (int, float, str))
            and (
                not isinstance(value, str)
                or re.fullmatch(r"-?\d+(?:\.\d+)?", value) is not None
            )
        )
    return isinstance(value, (str, int, float, bool))


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


def _field_contract_key(name: str) -> str:
    return f"f-{hashlib.sha256(name.encode('utf-8')).hexdigest()[:10]}"


def _selected_fields(
    source: Mapping[str, Any],
    *,
    include_sensitive: bool,
) -> list[dict[str, Any]]:
    fields = [
        field
        for field in source["fields"]
        if include_sensitive or field.get("sensitive") is not True
    ]
    if len(fields) > MAX_OUTPUT_FIELDS:
        raise HrRuntimeError("registry_invalid", "Кадровый source содержит слишком много полей.")
    if not fields:
        raise HrRuntimeError(
            "source_contract_mismatch",
            "Источник не содержит разрешённых полей для выбранного режима.",
        )
    return fields


def _build_filter(
    source: Mapping[str, Any],
    *,
    query: str,
    subject_id: str,
    date_from: str,
    date_to: str,
) -> str:
    clauses: list[str] = []
    filters = source["filters"]
    if query:
        fields = list(filters.get("queryFields") or [])
        if not fields:
            raise HrRuntimeError(
                "filter_unsupported",
                "Этот источник не поддерживает текстовый поиск.",
            )
        literal = _odata_literal(query)
        clauses.append(
            "(" + " or ".join(
                f"substringof({literal},{field})"
                for field in fields
            ) + ")",
        )
    if subject_id:
        fields = list(filters.get("employeeFields") or [])
        if not fields:
            raise HrRuntimeError(
                "filter_unsupported",
                "Этот источник не публикует прямую ссылку на сотрудника или физлицо.",
            )
        normalized_id = _uuid(subject_id, "subject id")
        clauses.append(
            "(" + " or ".join(
                f"{field} eq guid'{normalized_id}'"
                for field in fields
            ) + ")",
        )
    date_fields = list(filters.get("dateFields") or [])
    if date_from or date_to:
        if not date_fields:
            raise HrRuntimeError(
                "filter_unsupported",
                "Этот источник не публикует разрешённое поле периода.",
            )
        field = date_fields[0]
        if date_from:
            parsed_from = _date(date_from, "date-from")
            clauses.append(f"{field} ge datetime'{parsed_from.isoformat()}T00:00:00'")
        if date_to:
            parsed_to = _date(date_to, "date-to")
            exclusive = parsed_to + dt.timedelta(days=1)
            clauses.append(f"{field} lt datetime'{exclusive.isoformat()}T00:00:00'")
        if date_from and date_to and _date(date_from, "date-from") > _date(date_to, "date-to"):
            raise HrRuntimeError("invalid_date_range", "date-from не может быть позже date-to.")
    return " and ".join(clauses)


def _request_rows(
    source: Mapping[str, Any],
    fields: list[dict[str, Any]],
    *,
    filter_expression: str,
    page: int,
    limit: int,
    collections: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    config, credentials = _connected_context()
    entity = str(source["entity"])
    if not ENTITY_RE.fullmatch(entity):
        raise HrRuntimeError("registry_invalid", "Кадровый source entity повреждён.")
    selected_collections = collections or []
    parameters: list[tuple[str, str | int]] = [
        (
            "$select",
            ",".join([
                *(str(field["name"]) for field in fields),
                *(str(collection["name"]) for collection in selected_collections),
            ]),
        ),
        ("$skip", (page - 1) * limit),
        ("$top", limit),
    ]
    if filter_expression:
        parameters.append(("$filter", filter_expression))
    date_fields = list(source["filters"].get("dateFields") or [])
    if date_fields:
        parameters.append(("$orderby", f"{date_fields[0]} desc"))
    url = (
        f"{config.odata_base_url}{urllib.parse.quote(entity, safe='_')}"
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
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise HrRuntimeError(
            "source_contract_mismatch",
            "1С вернула некорректный кадровый response.",
        ) from error
    if not isinstance(payload, dict):
        raise HrRuntimeError(
            "source_contract_mismatch",
            "1С вернула некорректный кадровый response.",
        )
    rows = provider._odata_rows(payload)
    if len(rows) > limit:
        raise HrRuntimeError(
            "source_contract_mismatch",
            "1С проигнорировала лимит кадрового запроса.",
        )
    for row in rows:
        for field in fields:
            name = str(field["name"])
            if name not in row:
                raise HrRuntimeError(
                    "source_contract_mismatch",
                    (
                        "Фактический кадровый response не содержит поле "
                        f"{_field_contract_key(name)} из подписанного registry."
                    ),
                )
            if not _field_type_matches(row[name], str(field["type"])):
                raise HrRuntimeError(
                    "source_contract_mismatch",
                    (
                        f"Поле {_field_contract_key(name)} не совпадает с "
                        f"{field['type']}: получен класс {_value_class(row[name])}."
                    ),
                )
        for collection in selected_collections:
            collection_name = str(collection["name"])
            raw_lines = row.get(collection_name)
            if not isinstance(raw_lines, list) or any(
                not isinstance(line, dict)
                for line in raw_lines
            ):
                raise HrRuntimeError(
                    "source_contract_mismatch",
                    "Строки кадрового документа не совпадают с подписанным registry.",
                )
            for line in raw_lines:
                for field in collection["fields"]:
                    name = str(field["name"])
                    if name not in line:
                        raise HrRuntimeError(
                            "source_contract_mismatch",
                            (
                                "Строка кадрового документа не содержит поле "
                                f"{_field_contract_key(name)}."
                            ),
                        )
                    if not _field_type_matches(line[name], str(field["type"])):
                        raise HrRuntimeError(
                            "source_contract_mismatch",
                            (
                                f"Поле строки {_field_contract_key(name)} не совпадает "
                                f"с {field['type']}: получен класс "
                                f"{_value_class(line[name])}."
                            ),
                        )
    return rows


def _request_attachment_rows(
    source: Mapping[str, Any],
    *,
    owner_id: str,
    file_id: str = "",
    page: int = 1,
    limit: int = 10,
) -> list[dict[str, Any]]:
    config, credentials = _connected_context()
    entity = str(source["entity"])
    fields = list(source["metadataFields"])
    normalized_owner = _uuid(owner_id, "attachment owner id")
    clauses = [
        f"{source['ownerField']} eq guid'{normalized_owner}'",
    ]
    if file_id:
        normalized_file = _uuid(file_id, "attachment file id")
        clauses.append(f"{source['recordIdField']} eq guid'{normalized_file}'")
    parameters: list[tuple[str, str | int]] = [
        ("$select", ",".join(str(field["name"]) for field in fields)),
        ("$filter", " and ".join(clauses)),
        ("$skip", (page - 1) * limit),
        ("$top", limit),
    ]
    field_names = {str(field["name"]) for field in fields}
    if "ДатаСоздания" in field_names:
        parameters.append(("$orderby", "ДатаСоздания desc"))
    url = (
        f"{config.odata_base_url}{urllib.parse.quote(entity, safe='_')}"
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
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise HrRuntimeError(
            "attachment_contract_mismatch",
            "1С вернула некорректный список кадровых вложений.",
        ) from error
    if not isinstance(payload, dict):
        raise HrRuntimeError(
            "attachment_contract_mismatch",
            "1С вернула некорректный список кадровых вложений.",
        )
    rows = provider._odata_rows(payload)
    if len(rows) > limit:
        raise HrRuntimeError(
            "attachment_contract_mismatch",
            "1С проигнорировала лимит списка кадровых вложений.",
        )
    for row in rows:
        for field in fields:
            name = str(field["name"])
            if name not in row or not _field_type_matches(
                row[name],
                str(field["type"]),
            ):
                raise HrRuntimeError(
                    "attachment_contract_mismatch",
                    (
                        "Метаданные кадрового вложения не совпадают с "
                        f"полем {_field_contract_key(name)} signed registry."
                    ),
                )
        if str(row[source["ownerField"]]).lower() != normalized_owner:
            raise HrRuntimeError(
                "attachment_contract_mismatch",
                "1С вернула вложение другого владельца.",
            )
        if file_id and str(row[source["recordIdField"]]).lower() != normalized_file:
            raise HrRuntimeError(
                "attachment_contract_mismatch",
                "1С вернула вложение с другим exact id.",
            )
    return rows


def _normalized_attachment(
    source: Mapping[str, Any],
    row: Mapping[str, Any],
) -> dict[str, Any]:
    visible_names = {
        "Description",
        "Описание",
        "Расширение",
        "Размер",
        "ДатаСоздания",
        "ДатаМодификацииУниверсальная",
        "Зашифрован",
        "ПодписанЭП",
        "ТипХраненияФайла",
    }
    return {
        "attachmentSourceKey": source["key"],
        "fileId": row[source["recordIdField"]],
        "ownerId": row[source["ownerField"]],
        "fields": [
            {
                "key": _field_contract_key(str(field["name"])),
                "label": field["name"],
                "value": row.get(field["name"]),
                "sensitivity": "sensitive",
            }
            for field in source["metadataFields"]
            if field["name"] in visible_names
        ],
    }


def _attachment_file_service_url(
    config: provider.CompanyConfig,
    source: Mapping[str, Any],
    file_id: str,
) -> str:
    entity = str(source["entity"])
    if (
        not ENTITY_RE.fullmatch(entity)
        or not entity.startswith("Catalog_")
        or source.get("contentField") != "ФайлХранилище"
    ):
        raise HrRuntimeError(
            "registry_invalid",
            "Кадровый attachment route повреждён.",
        )
    normalized_file = _uuid(file_id, "attachment file id")
    catalog_name = entity.removeprefix("Catalog_")
    if not catalog_name.endswith("ПрисоединенныеФайлы"):
        raise HrRuntimeError(
            "registry_invalid",
            "Кадровый attachment route повреждён.",
        )
    return (
        f"{config.files_base_url}"
        f"{urllib.parse.quote(catalog_name, safe='')}/{normalized_file}"
    )


def _attachment_destination(value: str) -> Path:
    raw = Path(str(value or "").strip()).expanduser()
    if not raw.is_absolute() or raw.name in {"", ".", ".."}:
        raise HrRuntimeError(
            "invalid_output_path",
            "Для вложения нужен абсолютный путь нового файла.",
        )
    destination = raw.resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists() or destination.is_symlink():
        raise HrRuntimeError(
            "output_exists",
            "Файл назначения уже существует; перезапись запрещена.",
        )
    return destination


def _unverified_attachment_paths(destination: Path) -> tuple[Path, Path]:
    stem = destination.stem
    if not stem.endswith(".unverified"):
        stem = f"{stem}.unverified"
    unverified = destination.with_name(f"{stem}{destination.suffix}")
    manifest = unverified.with_name(f"{unverified.name}.integrity.json")
    for path in (unverified, manifest):
        if path.exists() or path.is_symlink():
            raise HrRuntimeError(
                "output_exists",
                "Файл назначения или его integrity-манифест уже существует; "
                "перезапись запрещена.",
            )
    return unverified, manifest


def _publish_unverified_attachment(
    temporary: Path,
    destination: Path,
    manifest: Mapping[str, Any],
) -> tuple[Path, Path]:
    unverified, manifest_path = _unverified_attachment_paths(destination)
    descriptor, temporary_manifest_name = tempfile.mkstemp(
        prefix=f".{manifest_path.name}.",
        suffix=".part",
        dir=destination.parent,
    )
    temporary_manifest = Path(temporary_manifest_name)
    manifest_published = False
    try:
        with os.fdopen(descriptor, "wb") as output_file:
            output_file.write(
                (
                    json.dumps(
                        manifest,
                        ensure_ascii=False,
                        indent=2,
                        sort_keys=True,
                    )
                    + "\n"
                ).encode("utf-8"),
            )
            output_file.flush()
            os.fsync(output_file.fileno())

        # The manifest becomes visible first. A crash may leave a harmless
        # manifest without bytes, but never an unmarked quarantined file.
        os.link(temporary_manifest, manifest_path)
        manifest_published = True
        try:
            os.link(temporary, unverified)
        except FileExistsError:
            manifest_path.unlink()
            manifest_published = False
            raise
    except FileExistsError as error:
        raise HrRuntimeError(
            "output_exists",
            "Файл назначения или его integrity-манифест уже существует; "
            "перезапись запрещена.",
        ) from error
    finally:
        with contextlib.suppress(OSError):
            os.close(descriptor)
        with contextlib.suppress(FileNotFoundError):
            temporary_manifest.unlink()
        if manifest_published and not unverified.exists():
            with contextlib.suppress(FileNotFoundError):
                manifest_path.unlink()
    return unverified, manifest_path


def _inspect_pdf_basic_structure(
    temporary: Path,
    *,
    size_bytes: int,
) -> dict[str, Any]:
    tail_size = min(size_bytes, 64 * 1024)
    with temporary.open("rb") as source_file:
        header = source_file.read(16)
        source_file.seek(max(0, size_bytes - tail_size))
        tail = source_file.read(tail_size)

    if re.match(br"%PDF-(?:1\.[0-7]|2\.0)", header) is None:
        raise HrRuntimeError(
            "invalid_attachment_response",
            "Вложение с расширением PDF не содержит корректную PDF-сигнатуру.",
        )
    startxref_match = re.search(
        br"startxref[\r\n\t ]+([0-9]+)[\r\n\t ]+%%EOF[\r\n\t ]*\Z",
        tail,
    )
    if startxref_match is None:
        raise HrRuntimeError(
            "invalid_attachment_response",
            "Вложение с расширением PDF не прошло базовую структурную проверку.",
        )
    xref_offset = int(startxref_match.group(1))
    if xref_offset >= size_bytes:
        raise HrRuntimeError(
            "invalid_attachment_response",
            "Вложение с расширением PDF содержит некорректный startxref.",
        )
    with temporary.open("rb") as source_file:
        source_file.seek(xref_offset)
        xref_marker = source_file.read(64).lstrip(b"\r\n\t ")
    if not (
        xref_marker.startswith(b"xref")
        or re.match(br"[0-9]+[\r\n\t ]+[0-9]+[\r\n\t ]+obj\b", xref_marker)
    ):
        raise HrRuntimeError(
            "invalid_attachment_response",
            "Вложение с расширением PDF содержит некорректный startxref.",
        )
    return {
        "kind": "pdf_basic_structure",
        "status": "passed",
        "checks": [
            "header_signature",
            "startxref_target",
            "eof_marker",
        ],
    }


def _download_attachment_bytes(
    source: Mapping[str, Any],
    *,
    owner_id: str,
    file_id: str,
    output: str,
    declared_size: int | None,
    declared_extension: str,
    allow_unverified_size_mismatch: bool,
) -> dict[str, Any]:
    config, credentials = _connected_context()
    maximum = min(config.max_file_bytes, MAX_ATTACHMENT_BYTES)
    if declared_size is not None and (
        declared_size < 0
        or declared_size > maximum
    ):
        raise HrRuntimeError(
            "attachment_too_large",
            "Кадровое вложение превышает разрешённый лимит.",
        )
    destination = _attachment_destination(output)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{destination.name}.",
        suffix=".part",
        dir=destination.parent,
    )
    temporary = Path(temporary_name)
    digest = hashlib.sha256()
    total = 0
    response_size: int | None = None
    try:
        response = provider._http_open(
            "GET",
            _attachment_file_service_url(config, source, file_id),
            credentials=credentials,
            timeout=config.request_timeout_seconds,
            # The fixed `/hs/files/` service authenticates the employee with
            # Basic Auth and returns the resolved file bytes. X-OData belongs
            # only to the preceding bounded metadata lookup and must not leak
            # into this separate file service.
            x_odata=None,
            diagnostic_stage="file.new.download",
            accept="*/*",
        )
        with response, os.fdopen(descriptor, "wb") as output_file:
            content_length = response.headers.get("Content-Length")
            if content_length:
                try:
                    response_size = int(content_length)
                except ValueError as error:
                    raise HrRuntimeError(
                        "invalid_attachment_response",
                        "Файловый endpoint вернул некорректный Content-Length.",
                    ) from error
                if response_size < 0 or response_size > maximum:
                    raise HrRuntimeError(
                        "attachment_too_large",
                        "Кадровое вложение превышает разрешённый лимит.",
                    )
            while True:
                chunk = response.read(min(1024 * 1024, maximum - total + 1))
                if not chunk:
                    break
                total += len(chunk)
                if total > maximum:
                    raise HrRuntimeError(
                        "attachment_too_large",
                        "Кадровое вложение превышает разрешённый лимит.",
                    )
                output_file.write(chunk)
                digest.update(chunk)
            output_file.flush()
            os.fsync(output_file.fileno())
        if response_size is not None and total != response_size:
            raise HrRuntimeError(
                "invalid_attachment_response",
                "Файловый endpoint передал не то число байт, которое объявил "
                "в Content-Length.",
            )
        size_mismatch = declared_size is not None and total != declared_size
        digest_hex = digest.hexdigest()
        content_inspection = (
            _inspect_pdf_basic_structure(
                temporary,
                size_bytes=total,
            )
            if declared_extension == "pdf"
            else {
                "kind": "not_applicable",
                "status": "not_performed",
            }
        )
        if size_mismatch:
            if not allow_unverified_size_mismatch:
                raise HrRuntimeError(
                    "attachment_contract_mismatch",
                    "Размер скачанного вложения не совпадает с metadata 1С.",
                )
            downloaded_at = (
                dt.datetime.now(dt.timezone.utc)
                .isoformat()
                .replace("+00:00", "Z")
            )
            unverified, manifest_path = _publish_unverified_attachment(
                temporary,
                destination,
                {
                    "actualSizeBytes": total,
                    "attachmentSourceKey": source["key"],
                    "contentInspection": content_inspection,
                    "declaredExtension": declared_extension or None,
                    "declaredSizeBytes": declared_size,
                    "downloadedAt": downloaded_at,
                    "fileId": file_id,
                    "httpContentLengthBytes": response_size,
                    "ownerId": owner_id,
                    "reason": "metadata_size_mismatch",
                    "schemaVersion": 1,
                    "sha256": digest_hex,
                    "sourceSkill": "1c-vkus-kadry",
                    "status": "unverified_metadata_size_mismatch",
                    "warning": (
                        "Файл получен из 1С, но его целостность относительно "
                        "metadata 1С не подтверждена."
                    ),
                },
            )
            return {
                "path": str(unverified),
                "sizeBytes": total,
                "sha256": digest_hex,
                "integrity": {
                    "status": "unverified_metadata_size_mismatch",
                    "declaredSizeBytes": declared_size,
                    "actualSizeBytes": total,
                    "contentInspection": content_inspection,
                    "httpContentLengthBytes": response_size,
                    "manifestPath": str(manifest_path),
                },
            }
        try:
            os.link(temporary, destination)
        except FileExistsError as error:
            raise HrRuntimeError(
                "output_exists",
                "Файл назначения уже существует; перезапись запрещена.",
            ) from error
    finally:
        with contextlib.suppress(OSError):
            os.close(descriptor)
        with contextlib.suppress(FileNotFoundError):
            temporary.unlink()
    return {
        "path": str(destination),
        "sizeBytes": total,
        "sha256": digest.hexdigest(),
        "integrity": {
            "status": (
                "metadata_size_matched"
                if declared_size is not None
                else "metadata_size_not_provided"
            ),
            "declaredSizeBytes": declared_size,
            "actualSizeBytes": total,
            "contentInspection": content_inspection,
            "httpContentLengthBytes": response_size,
        },
    }


def _normalized_row(
    source: Mapping[str, Any],
    fields: list[dict[str, Any]],
    row: Mapping[str, Any],
) -> dict[str, Any]:
    return {
        "sourceKey": source["key"],
        "sourceTitle": source["title"],
        "fields": [
            {
                "key": f"f-{hashlib.sha256(str(field['name']).encode('utf-8')).hexdigest()[:10]}",
                "label": field["name"],
                "value": row.get(field["name"]),
                "sensitivity": (
                    "sensitive"
                    if field.get("sensitive") is True
                    else "structural"
                ),
            }
            for field in fields
        ],
    }


def _normalized_collections(
    source: Mapping[str, Any],
    row: Mapping[str, Any],
    *,
    line_limit: int,
) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for collection in source["collections"]:
        raw_lines = list(row.get(collection["name"]) or [])
        lines = raw_lines[:line_limit]
        result.append({
            "key": (
                "c-"
                f"{hashlib.sha256(str(collection['name']).encode('utf-8')).hexdigest()[:10]}"
            ),
            "label": collection["name"],
            "rows": [
                {
                    "fields": [
                        {
                            "key": (
                                "f-"
                                f"{hashlib.sha256(str(field['name']).encode('utf-8')).hexdigest()[:10]}"
                            ),
                            "label": field["name"],
                            "value": line.get(field["name"]),
                            "sensitivity": (
                                "sensitive"
                                if field.get("sensitive") is True
                                else "structural"
                            ),
                        }
                        for field in collection["fields"]
                    ],
                }
                for line in lines
            ],
            "returned": len(lines),
            "truncated": len(raw_lines) > len(lines),
        })
    return result


def _schema_summary(registry: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "profileSchemaDigest": registry["profileSchemaDigest"],
        "registryDigest": registry["registryDigest"],
        "validation": "signed_registry_response_contract",
        "registrySource": "signed_package",
        "metadataRequest": False,
        "responseValidation": "fail_closed",
    }


def command_get_capabilities(args: argparse.Namespace) -> dict[str, Any]:
    registry = _load_registry()
    category = str(args.category or "").strip()
    query = str(args.query or "").strip().casefold()
    page = _bounded_int(args.page, "page", minimum=1, maximum=MAX_PAGES)
    limit = _bounded_int(args.limit, "limit", minimum=1, maximum=50)
    sources = [
        source
        for source in registry["sources"]
        if (
            (not category or category in source["categories"])
            and (
                not query
                or query in str(source["title"]).casefold()
                or query in str(source["key"]).casefold()
            )
        )
    ]
    start = (page - 1) * limit
    selected = sources[start:start + limit]
    attachment_sources = [
        source
        for source in registry["attachmentSources"]
        if (
            (not category or category in source["categories"])
            and (
                not query
                or query in str(source["title"]).casefold()
                or query in str(source["key"]).casefold()
            )
        )
    ]
    selected_attachments = attachment_sources[start:start + limit]
    return {
        "categories": registry["categories"],
        "sources": [
            {
                "sourceKey": source["key"],
                "title": source["title"],
                "categories": source["categories"],
                "sourceKind": source["sourceKind"],
                "filters": {
                    "recordId": source["filters"]["recordId"] is not None,
                    "query": bool(source["filters"]["queryFields"]),
                    "subjectId": bool(source["filters"]["employeeFields"]),
                    "dateRange": bool(source["filters"]["dateFields"]),
                },
                "sensitiveFields": any(
                    field.get("sensitive") is True
                    for field in source["fields"]
                ),
                "collections": [
                    collection["name"]
                    for collection in source["collections"]
                ],
            }
            for source in selected
        ],
        "attachmentSources": [
            {
                "attachmentSourceKey": source["key"],
                "title": source["title"],
                "categories": source["categories"],
                "ownerSourceKey": source["ownerSourceKey"],
                "requiresOwnerId": True,
                "sensitive": True,
            }
            for source in selected_attachments
        ],
        "pagination": {
            "page": page,
            "limit": limit,
            "total": len(sources),
            "returned": len(selected),
            "hasMore": start + len(selected) < len(sources),
        },
        "attachmentPagination": {
            "page": page,
            "limit": limit,
            "total": len(attachment_sources),
            "returned": len(selected_attachments),
            "hasMore": (
                start + len(selected_attachments)
                < len(attachment_sources)
            ),
        },
        "limits": registry["limits"],
        "safety": registry["safety"],
        "schema": _schema_summary(registry),
    }


def command_list_attachments(args: argparse.Namespace) -> dict[str, Any]:
    if not args.include_sensitive:
        raise HrRuntimeError(
            "explicit_sensitive_access_required",
            "Список кадровых вложений требует --include-sensitive.",
        )
    registry = _load_registry()
    source = _attachment_source_by_key(
        registry,
        args.attachment_source_key,
    )
    page = _bounded_int(
        args.page,
        "page",
        minimum=1,
        maximum=MAX_PAGES,
    )
    limit = _bounded_int(
        args.limit,
        "limit",
        minimum=1,
        maximum=MAX_PAGE_SIZE,
    )
    owner_id = _uuid(args.owner_id, "attachment owner id")
    rows = _request_attachment_rows(
        source,
        owner_id=owner_id,
        page=page,
        limit=limit,
    )
    return {
        "attachmentSource": {
            "attachmentSourceKey": source["key"],
            "title": source["title"],
            "categories": source["categories"],
            "ownerSourceKey": source["ownerSourceKey"],
        },
        "ownerId": owner_id,
        "attachments": [
            _normalized_attachment(source, row)
            for row in rows
        ],
        "sensitiveFieldsIncluded": True,
        "pagination": {
            "page": page,
            "limit": limit,
            "returned": len(rows),
            "hasMore": len(rows) == limit and page < MAX_PAGES,
        },
        "schema": _schema_summary(registry),
    }


def command_download_attachment(args: argparse.Namespace) -> dict[str, Any]:
    if not args.include_sensitive:
        raise HrRuntimeError(
            "explicit_sensitive_access_required",
            "Скачивание кадрового вложения требует --include-sensitive.",
        )
    registry = _load_registry()
    source = _attachment_source_by_key(
        registry,
        args.attachment_source_key,
    )
    owner_id = _uuid(args.owner_id, "attachment owner id")
    file_id = _uuid(args.file_id, "attachment file id")
    rows = _request_attachment_rows(
        source,
        owner_id=owner_id,
        file_id=file_id,
        page=1,
        limit=2,
    )
    if len(rows) != 1:
        raise HrRuntimeError(
            "attachment_not_found",
            "Кадровое вложение не найдено или exact id неоднозначен.",
        )
    raw_size = rows[0].get(source["sizeField"])
    declared_size: int | None
    if raw_size is None:
        declared_size = None
    elif (
        isinstance(raw_size, bool)
        or not isinstance(raw_size, (int, str))
        or not str(raw_size).isdigit()
    ):
        raise HrRuntimeError(
            "attachment_contract_mismatch",
            "Поле размера кадрового вложения не соответствует metadata 1С.",
        )
    else:
        declared_size = int(raw_size)
    raw_extension = rows[0].get("Расширение")
    declared_extension = (
        raw_extension.strip().lower().lstrip(".")
        if isinstance(raw_extension, str)
        else ""
    )
    downloaded = _download_attachment_bytes(
        source,
        owner_id=owner_id,
        file_id=file_id,
        output=args.output,
        declared_size=declared_size,
        declared_extension=declared_extension,
        allow_unverified_size_mismatch=(
            getattr(args, "allow_unverified_size_mismatch", False) is True
        ),
    )
    return {
        "attachmentSourceKey": source["key"],
        "ownerId": owner_id,
        "fileId": file_id,
        **downloaded,
        "schema": _schema_summary(registry),
    }


def command_search_records(args: argparse.Namespace) -> dict[str, Any]:
    registry = _load_registry()
    source = _source_by_key(registry, args.source_key)
    page = _bounded_int(args.page, "page", minimum=1, maximum=MAX_PAGES)
    limit = _bounded_int(args.limit, "limit", minimum=1, maximum=MAX_PAGE_SIZE)
    fields = _selected_fields(
        source,
        include_sensitive=bool(args.include_sensitive),
    )
    filter_expression = _build_filter(
        source,
        query=args.query,
        subject_id=args.subject_id,
        date_from=args.date_from,
        date_to=args.date_to,
    )
    rows = _request_rows(
        source,
        fields,
        filter_expression=filter_expression,
        page=page,
        limit=limit,
    )
    return {
        "source": {
            "sourceKey": source["key"],
            "title": source["title"],
            "categories": source["categories"],
        },
        "records": [
            _normalized_row(source, fields, row)
            for row in rows
        ],
        "sensitiveFieldsIncluded": bool(args.include_sensitive),
        "pagination": {
            "page": page,
            "limit": limit,
            "returned": len(rows),
            "hasMore": len(rows) == limit and page < MAX_PAGES,
        },
        "matchedBy": [
            name
            for name, value in (
                ("query", args.query),
                ("subject_id", args.subject_id),
                ("date_from", args.date_from),
                ("date_to", args.date_to),
            )
            if value
        ],
        "schema": _schema_summary(registry),
    }


def command_get_record(args: argparse.Namespace) -> dict[str, Any]:
    registry = _load_registry()
    source = _source_by_key(registry, args.source_key)
    id_field = source["filters"].get("recordId")
    if not id_field:
        raise HrRuntimeError(
            "record_lookup_unsupported",
            "У этого источника нет опубликованного exact record id.",
        )
    record_id = _uuid(args.id, "record id")
    fields = _selected_fields(
        source,
        include_sensitive=bool(args.include_sensitive),
    )
    include_collections = bool(args.include_collections)
    if include_collections and not args.include_sensitive:
        raise HrRuntimeError(
            "explicit_sensitive_access_required",
            "Строки кадрового документа доступны только вместе с --include-sensitive.",
        )
    line_limit = _bounded_int(
        args.line_limit,
        "line-limit",
        minimum=1,
        maximum=MAX_LINE_LIMIT,
    )
    collections = list(source["collections"]) if include_collections else []
    rows = _request_rows(
        source,
        fields,
        filter_expression=f"{id_field} eq guid'{record_id}'",
        page=1,
        limit=2,
        collections=collections,
    )
    if len(rows) != 1 or str(rows[0].get(id_field) or "").lower() != record_id:
        raise HrRuntimeError(
            "record_not_found",
            "Кадровая запись не найдена или exact id неоднозначен.",
        )
    return {
        "source": {
            "sourceKey": source["key"],
            "title": source["title"],
            "categories": source["categories"],
        },
        "record": _normalized_row(source, fields, rows[0]),
        "sensitiveFieldsIncluded": bool(args.include_sensitive),
        "collectionsIncluded": include_collections,
        "collections": (
            _normalized_collections(source, rows[0], line_limit=line_limit)
            if include_collections
            else []
        ),
        "schema": _schema_summary(registry),
    }


def build_parser() -> argparse.ArgumentParser:
    registry = _load_registry()
    parser = argparse.ArgumentParser(
        prog="trelio-1c-vkus-kadry",
        description="Read-only signed Vkus HR 1C runtime.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    connect = subparsers.add_parser(
        "connect",
        help="Connect personal credentials through a protected local browser page",
    )
    connect.add_argument(
        "--terminal-prompts",
        action="store_true",
        help="Use the current visible terminal instead of the protected local browser page",
    )
    connect.set_defaults(handler=command_connect)

    doctor = subparsers.add_parser("doctor")
    doctor.set_defaults(handler=command_doctor)

    access = subparsers.add_parser("access-status")
    access_subparsers = access.add_subparsers(dest="access_command", required=True)
    access_show = access_subparsers.add_parser("show")
    access_show.set_defaults(handler=command_access_show)
    access_set = access_subparsers.add_parser("set")
    access_set.add_argument("status", choices=["no-access"])
    access_set.add_argument("--confirmed", action="store_true")
    access_set.set_defaults(handler=command_access_no_access)
    access_reset = access_subparsers.add_parser("reset")
    access_reset.set_defaults(handler=command_access_reset)

    forget = subparsers.add_parser("forget-credentials")
    forget.set_defaults(handler=command_forget_credentials)

    capabilities = subparsers.add_parser("get-capabilities")
    capabilities.add_argument("--category", choices=["", *registry["categories"]], default="")
    capabilities.add_argument("--query", default="")
    capabilities.add_argument("--page", type=int, default=1)
    capabilities.add_argument("--limit", type=int, default=25)
    capabilities.set_defaults(handler=command_get_capabilities)

    search = subparsers.add_parser("search-records")
    search.add_argument(
        "--source-key",
        choices=[source["key"] for source in registry["sources"]],
        required=True,
    )
    search.add_argument("--query", default="")
    search.add_argument("--subject-id", default="")
    search.add_argument("--date-from", default="")
    search.add_argument("--date-to", default="")
    search.add_argument("--page", type=int, default=1)
    search.add_argument("--limit", type=int, default=10)
    search.add_argument("--include-sensitive", action="store_true")
    search.set_defaults(handler=command_search_records)

    record = subparsers.add_parser("get-record")
    record.add_argument(
        "--source-key",
        choices=[source["key"] for source in registry["sources"]],
        required=True,
    )
    record.add_argument("--id", required=True)
    record.add_argument("--include-sensitive", action="store_true")
    record.add_argument("--include-collections", action="store_true")
    record.add_argument("--line-limit", type=int, default=50)
    record.set_defaults(handler=command_get_record)

    attachments = subparsers.add_parser("list-attachments")
    attachments.add_argument(
        "--attachment-source-key",
        choices=[
            source["key"]
            for source in registry["attachmentSources"]
        ],
        required=True,
    )
    attachments.add_argument("--owner-id", required=True)
    attachments.add_argument("--page", type=int, default=1)
    attachments.add_argument("--limit", type=int, default=10)
    attachments.add_argument("--include-sensitive", action="store_true")
    attachments.set_defaults(handler=command_list_attachments)

    download = subparsers.add_parser("download-attachment")
    download.add_argument(
        "--attachment-source-key",
        choices=[
            source["key"]
            for source in registry["attachmentSources"]
        ],
        required=True,
    )
    download.add_argument("--owner-id", required=True)
    download.add_argument("--file-id", required=True)
    download.add_argument("--output", required=True)
    download.add_argument("--include-sensitive", action="store_true")
    download.add_argument(
        "--allow-unverified-size-mismatch",
        action="store_true",
        help=(
            "Save a metadata-size mismatch only as a marked .unverified file "
            "with an integrity manifest."
        ),
    )
    download.set_defaults(handler=command_download_attachment)
    return parser


def _safe_error(error: provider.OneCEdoError) -> dict[str, Any]:
    return provider._safe_error_payload(error)


def main(
    argv: list[str] | None = None,
    *,
    expected_skill_id: str = HR_SKILL_ID,
) -> int:
    try:
        if str(os.environ.get("TRELIO_SKILL_ID") or "").strip() != expected_skill_id:
            raise HrRuntimeError(
                "invalid_host_context",
                "Entrypoint и skill identity не совпадают.",
            )
        parser = build_parser()
        args = parser.parse_args(argv)
        result = args.handler(args)
        print(
            json.dumps(
                {"ok": True, **result},
                ensure_ascii=False,
                separators=(",", ":"),
            ),
        )
        return 0
    except provider.OneCEdoError as error:
        print(
            json.dumps(
                {"ok": False, "error": _safe_error(error)},
                ensure_ascii=False,
                separators=(",", ":"),
            ),
        )
        return error.exit_code
    except KeyboardInterrupt:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": {
                        "code": "cancelled",
                        "message": "Операция отменена.",
                    },
                },
                ensure_ascii=False,
                separators=(",", ":"),
            ),
        )
        return 130
    except Exception:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": {
                        "code": "unexpected_error",
                        "message": "Неожиданная ошибка кадрового runtime.",
                    },
                },
                ensure_ascii=False,
                separators=(",", ":"),
            ),
        )
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
