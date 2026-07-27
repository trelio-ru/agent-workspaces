#!/usr/bin/env python3
"""Development-only bounded live verifier for the signed HR registry.

Every selected source receives at most one ``$top=1`` GET. The verifier keeps
record values in process memory only long enough to validate their JSON/EDM
shape and serializes only value classes, availability and safe error codes.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import datetime as dt
import json
import os
import sys
import urllib.parse
import uuid
from pathlib import Path
from typing import Any, Mapping


SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

import trelio_one_c_vkus_kadry_runtime as runtime  # noqa: E402


MAX_SAMPLE_FIELDS = 24
MAX_WORKERS = 8


def _value_class(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, str):
        try:
            if str(uuid.UUID(value)).lower() == value.lower():
                return "uuid"
        except ValueError:
            pass
        if value.startswith("/Date(") or (
            len(value) >= 10
            and value[4:5] == "-"
            and value[7:8] == "-"
        ):
            return "date_or_datetime"
        return "string"
    return "non_scalar"


def _sample_fields(source: Mapping[str, Any]) -> list[dict[str, Any]]:
    fields = list(source["fields"])
    structural = [
        field
        for field in fields
        if field.get("sensitive") is not True
    ]
    sensitive = [
        field
        for field in fields
        if field.get("sensitive") is True
    ]
    selected: list[dict[str, Any]] = []
    for field in [*structural, *sensitive]:
        if field not in selected:
            selected.append(field)
        if len(selected) >= MAX_SAMPLE_FIELDS:
            break
    return selected


def verify_source(source: Mapping[str, Any]) -> dict[str, Any]:
    fields = _sample_fields(source)
    try:
        rows = runtime._request_rows(
            source,
            fields,
            filter_expression="",
            page=1,
            limit=1,
        )
    except runtime.provider.OneCEdoError as error:
        return {
            "sourceKey": source["key"],
            "title": source["title"],
            "accessible": False,
            "error": runtime.provider._safe_error_payload(error),
        }
    first = rows[0] if rows else {}
    return {
        "sourceKey": source["key"],
        "title": source["title"],
        "accessible": True,
        "hasRows": bool(rows),
        "sampledFieldCount": len(fields),
        "returnedFieldClasses": {
            str(field["name"]): _value_class(first.get(field["name"]))
            for field in fields
            if field["name"] in first
        },
    }


def verify_attachment_source(source: Mapping[str, Any]) -> dict[str, Any]:
    fields = list(source["metadataFields"])
    verification_stage = "metadata_request"
    try:
        config, credentials = runtime._connected_context()
        url = (
            f"{config.odata_base_url}"
            f"{urllib.parse.quote(str(source['entity']), safe='_')}"
            f"?{runtime.provider._odata_query((('$select', ','.join(str(field['name']) for field in fields)), ('$top', 1)))}"
        )
        response = runtime.provider._http_open(
            "GET",
            url,
            credentials=credentials,
            timeout=config.request_timeout_seconds,
            x_odata=runtime.provider._require_x_odata(),
            diagnostic_stage="doctor.probe",
        )
        with response:
            raw = runtime.provider._read_limited(
                response,
                runtime.MAX_RESPONSE_BYTES,
            )
        verification_stage = "metadata_decode"
        payload = json.loads(raw.decode("utf-8"))
        rows = runtime.provider._odata_rows(payload)
        if len(rows) > 1:
            raise runtime.HrRuntimeError(
                "attachment_contract_mismatch",
                "1С проигнорировала attachment sample limit.",
            )
        stream_sampled = False
        if rows:
            verification_stage = "metadata_validate"
            row = rows[0]
            for field in fields:
                name = str(field["name"])
                if (
                    name not in row
                    or not runtime._field_type_matches(
                        row[name],
                        str(field["type"]),
                    )
                ):
                    raise runtime.HrRuntimeError(
                        "attachment_contract_mismatch",
                        "Attachment metadata не совпадает с registry.",
                    )
            file_id = runtime._uuid(
                str(row[source["recordIdField"]]),
                "attachment file id",
            )
            owner_id = runtime._uuid(
                str(row[source["ownerField"]]),
                "attachment owner id",
            )
            verification_stage = "exact_lookup"
            exact_rows = runtime._request_attachment_rows(
                source,
                owner_id=owner_id,
                file_id=file_id,
                page=1,
                limit=2,
            )
            if len(exact_rows) != 1:
                raise runtime.HrRuntimeError(
                    "attachment_contract_mismatch",
                    "Exact attachment lookup неоднозначен.",
                )
            verification_stage = "stream_open"
            stream_response = runtime.provider._http_open(
                "GET",
                runtime._attachment_stream_url(
                    config,
                    source,
                    file_id,
                ),
                credentials=credentials,
                timeout=config.request_timeout_seconds,
                x_odata=runtime.provider._require_x_odata(),
                diagnostic_stage="file.new.download",
                accept="*/*",
            )
            with stream_response:
                stream_response.read(1)
            stream_sampled = True
    except Exception as error:
        if isinstance(error, runtime.provider.OneCEdoError):
            safe_error = runtime.provider._safe_error_payload(error)
        else:
            safe_error = {
                "code": "attachment_contract_mismatch",
                "message": "Attachment verifier получил неожиданный contract.",
                "errorClass": type(error).__name__,
            }
        safe_error["verificationStage"] = verification_stage
        return {
            "attachmentSourceKey": source["key"],
            "title": source["title"],
            "accessible": False,
            "error": safe_error,
        }
    return {
        "attachmentSourceKey": source["key"],
        "title": source["title"],
        "accessible": True,
        "hasRows": bool(rows),
        "sampledFieldCount": len(fields),
        "streamRouteSampled": stream_sampled,
        "recordValuesIncluded": False,
    }


def verify_registry(
    registry: Mapping[str, Any],
    *,
    category: str = "",
    max_sources: int | None = None,
    workers: int = 4,
    verify_attachments: bool = True,
    verify_sources: bool = True,
    attachment_source_key: str = "",
) -> dict[str, Any]:
    sources = [
        source
        for source in registry["sources"]
        if not category or category in source["categories"]
    ]
    if max_sources is not None:
        sources = sources[:max_sources]
    if verify_sources:
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
            results = list(executor.map(verify_source, sources))
    else:
        results = []
    accessible = sum(result.get("accessible") is True for result in results)
    attachment_sources = list(registry.get("attachmentSources") or [])
    if attachment_source_key:
        attachment_sources = [
            source
            for source in attachment_sources
            if source["key"] == attachment_source_key
        ]
    if max_sources is not None:
        attachment_sources = attachment_sources[:max_sources]
    if verify_attachments:
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
            attachment_results = list(
                executor.map(
                    verify_attachment_source,
                    attachment_sources,
                ),
            )
    else:
        attachment_results = []
    attachment_accessible = sum(
        result.get("accessible") is True
        for result in attachment_results
    )
    return {
        "verificationVersion": 1,
        "verifiedAt": (
            dt.datetime.now(dt.timezone.utc)
            .isoformat()
            .replace("+00:00", "Z")
        ),
        "profileSchemaDigest": registry["profileSchemaDigest"],
        "registryDigest": registry["registryDigest"],
        "selectedCategory": category or None,
        "sourceCount": len(results),
        "accessibleCount": accessible,
        "failedCount": len(results) - accessible,
        "sources": results,
        "attachmentSourceCount": len(attachment_results),
        "attachmentAccessibleCount": attachment_accessible,
        "attachmentFailedCount": (
            len(attachment_results) - attachment_accessible
        ),
        "attachmentSources": attachment_results,
        "limits": {
            "sampleRowsPerSource": 1,
            "maxSampleFieldsPerSource": MAX_SAMPLE_FIELDS,
            "workers": workers,
        },
        "privacy": {
            "recordValuesIncluded": False,
            "credentialsIncluded": False,
            "endpointIncluded": False,
            "responseBodiesIncluded": False,
            "attachmentBytesIncluded": False,
        },
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Verify every selected signed HR source with one bounded GET.",
    )
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--category", default="")
    parser.add_argument("--max-sources", type=int)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument(
        "--skip-attachments",
        action="store_true",
    )
    parser.add_argument("--skip-sources", action="store_true")
    parser.add_argument("--attachment-source-key", default="")
    args = parser.parse_args(argv)
    if args.max_sources is not None and not 1 <= args.max_sources <= 800:
        parser.error("--max-sources must be between 1 and 800")
    if not 1 <= args.workers <= MAX_WORKERS:
        parser.error(f"--workers must be between 1 and {MAX_WORKERS}")

    # Development fallback runs outside the future signed package but uses the
    # exact future skill identity so the same company/connection checks apply.
    os.environ["TRELIO_SKILL_ID"] = runtime.HR_SKILL_ID
    registry = runtime._load_registry()
    if args.category and args.category not in registry["categories"]:
        parser.error("--category is not present in the signed registry")
    if (
        args.attachment_source_key
        and args.attachment_source_key
        not in {
            source["key"]
            for source in registry["attachmentSources"]
        }
    ):
        parser.error("--attachment-source-key is not present in the signed registry")
    result = verify_registry(
        registry,
        category=args.category,
        max_sources=args.max_sources,
        workers=args.workers,
        verify_attachments=not args.skip_attachments,
        verify_sources=not args.skip_sources,
        attachment_source_key=args.attachment_source_key,
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(
            {
                "ok": (
                    result["failedCount"] == 0
                    and result["attachmentFailedCount"] == 0
                ),
                **result,
            },
            ensure_ascii=False,
            indent=2,
        ) + "\n",
        encoding="utf-8",
    )
    print(
        json.dumps(
            {
                "ok": (
                    result["failedCount"] == 0
                    and result["attachmentFailedCount"] == 0
                ),
                "sourceCount": result["sourceCount"],
                "accessibleCount": result["accessibleCount"],
                "failedCount": result["failedCount"],
                "attachmentSourceCount": result["attachmentSourceCount"],
                "attachmentAccessibleCount": result["attachmentAccessibleCount"],
                "attachmentFailedCount": result["attachmentFailedCount"],
                "output": str(args.output),
            },
            ensure_ascii=False,
            separators=(",", ":"),
        ),
    )
    return (
        0
        if (
            result["failedCount"] == 0
            and result["attachmentFailedCount"] == 0
        )
        else 3
    )


if __name__ == "__main__":
    raise SystemExit(main())
