#!/usr/bin/env python3
"""Offline release-time verifier for a reviewed Vkus 1C metadata snapshot.

This file is development tooling and is intentionally excluded from the signed
production skill package. A separately authorized diagnostic flow may capture
the fixed metadata response; this verifier then reduces that local snapshot to
capability match states and digests without printing raw XML, entity samples,
endpoint data or credentials.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any, Mapping


MAX_METADATA_SNAPSHOT_BYTES = 64 * 1024 * 1024
SCRIPT_DIRECTORY = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPT_DIRECTORY))

import trelio_one_c_vkus_runtime as runtime  # noqa: E402


def xml_local_name(tag: str) -> str:
    """Drop the namespace while keeping only structural XML names."""

    return tag.rsplit("}", 1)[-1]


def parse_schema(
    raw: bytes,
) -> tuple[dict[str, str], dict[str, dict[str, str]]]:
    """Reduce XML to the exact entity/type/property material under review."""

    try:
        root = ET.fromstring(raw)
    except ET.ParseError as error:
        raise ValueError("metadata snapshot is not valid XML") from error

    entity_sets: dict[str, str] = {}
    type_fields: dict[str, dict[str, str]] = {}
    for schema in (
        element
        for element in root.iter()
        if xml_local_name(element.tag) == "Schema"
    ):
        namespace = str(schema.attrib.get("Namespace") or "")
        for child in schema:
            local_name = xml_local_name(child.tag)
            if local_name in {"EntityType", "ComplexType"}:
                type_name = str(child.attrib.get("Name") or "")
                if not type_name:
                    continue
                properties = {
                    str(item.attrib["Name"]): str(item.attrib["Type"])
                    for item in child
                    if (
                        xml_local_name(item.tag) == "Property"
                        and item.attrib.get("Name")
                        and item.attrib.get("Type")
                    )
                }
                type_fields[type_name] = properties
                if namespace:
                    type_fields[f"{namespace}.{type_name}"] = properties
            elif local_name == "EntityContainer":
                for item in child:
                    if xml_local_name(item.tag) != "EntitySet":
                        continue
                    name = str(item.attrib.get("Name") or "")
                    entity_type = str(item.attrib.get("EntityType") or "")
                    if name and entity_type:
                        entity_sets[name] = entity_type
    return entity_sets, type_fields


def capability_states(
    entity_sets: Mapping[str, str],
    type_fields: Mapping[str, Mapping[str, str]],
) -> dict[str, str]:
    """Compare every frozen production mapping with the reviewed snapshot."""

    states: dict[str, str] = {}
    for section, registry in (
        ("reference", runtime.GENERAL_REFERENCE_SPECS),
        ("document", runtime.GENERAL_DOCUMENT_SPECS),
    ):
        for kind, sources in registry.items():
            state = "matched"
            for source in sources:
                entity_type = entity_sets.get(source["entity"])
                fields = type_fields.get(entity_type or "", {})
                if not entity_type:
                    state = "entity_missing"
                    break
                if any(
                    fields.get(field) != expected_type
                    for field, expected_type in source["fields"].items()
                ):
                    state = "field_mapping_changed"
                    break
                if not source.get("lineFields"):
                    continue
                collection_type = fields.get("Товары", "")
                if not (
                    collection_type.startswith("Collection(")
                    and collection_type.endswith(")")
                ):
                    state = "line_collection_changed"
                    break
                line_fields = type_fields.get(collection_type[11:-1], {})
                if any(
                    line_fields.get(field) != expected_type
                    for field, expected_type in source["lineFields"].items()
                ):
                    state = "line_mapping_changed"
                    break
            states[f"{section}.{kind}"] = state
    return states


def inspect_snapshot(path: Path) -> dict[str, Any]:
    """Read one bounded local file and return only safe release diagnostics."""

    resolved = path.resolve(strict=True)
    if resolved.stat().st_size > MAX_METADATA_SNAPSHOT_BYTES:
        raise ValueError("metadata snapshot exceeds the development limit")
    raw = resolved.read_bytes()
    entity_sets, type_fields = parse_schema(raw)
    states = capability_states(entity_sets, type_fields)
    return {
        "snapshotDigest": f"sha256:{hashlib.sha256(raw).hexdigest()}",
        "signedRegistryDigest": runtime._general_registry_digest(),
        "capabilityStates": states,
        "allMatched": all(state == "matched" for state in states.values()),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Verify a local Vkus 1C metadata snapshot for a release review.",
    )
    parser.add_argument("--metadata-file", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        result = inspect_snapshot(args.metadata_file)
    except (OSError, ValueError) as error:
        print(
            json.dumps(
                {"ok": False, "error": str(error)[:300]},
                ensure_ascii=False,
                separators=(",", ":"),
            ),
        )
        return 2
    print(
        json.dumps(
            {"ok": True, **result},
            ensure_ascii=False,
            separators=(",", ":"),
        ),
    )
    return 0 if result["allMatched"] else 3


if __name__ == "__main__":
    raise SystemExit(main())
