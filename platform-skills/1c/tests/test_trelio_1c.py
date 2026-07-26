from __future__ import annotations

import importlib.util
import gzip
import io
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
import xml.etree.ElementTree as ET
from argparse import Namespace
from pathlib import Path
from unittest import mock


SCRIPT = (
    Path(__file__).parents[2]
    / "1c-runtime"
    / "scripts"
    / "trelio_one_c_runtime.py"
)
SPEC = importlib.util.spec_from_file_location("trelio_one_c_runtime_general_test", SCRIPT)
assert SPEC and SPEC.loader
runtime = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = runtime
SPEC.loader.exec_module(runtime)

COMPANY_ID = "11111111-1111-4111-8111-111111111111"
MEMBER_ID = "22222222-2222-4222-8222-222222222222"
CONNECTION_ID = "33333333-3333-4333-8333-333333333333"
REFERENCE_ID = "44444444-4444-4444-8444-444444444444"
DOCUMENT_ID = "55555555-5555-4555-8555-555555555555"
ITEM_ID = "66666666-6666-4666-8666-666666666666"


METADATA = b"""<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx" Version="4.0">
  <edmx:DataServices>
    <Schema xmlns="http://docs.oasis-open.org/odata/ns/edm" Namespace="Sample">
      <EntityType Name="Catalog_\xd0\x9e\xd1\x80\xd0\xb3\xd0\xb0\xd0\xbd\xd0\xb8\xd0\xb7\xd0\xb0\xd1\x86\xd0\xb8\xd0\xb8">
        <Property Name="Ref_Key" Type="Edm.Guid" Nullable="false" />
        <Property Name="Description" Type="Edm.String" />
      </EntityType>
      <EntityType Name="Document_\xd0\x9f\xd0\xbe\xd1\x81\xd1\x82\xd1\x83\xd0\xbf\xd0\xbb\xd0\xb5\xd0\xbd\xd0\xb8\xd0\xb5">
        <Property Name="Ref_Key" Type="Edm.Guid" Nullable="false" />
        <Property Name="Number" Type="Edm.String" />
        <Property Name="\xd0\x9e\xd1\x80\xd0\xb3\xd0\xb0\xd0\xbd\xd0\xb8\xd0\xb7\xd0\xb0\xd1\x86\xd0\xb8\xd1\x8f_Key" Type="Edm.Guid" />
      </EntityType>
      <EntityType Name="Document_\xd0\x9f\xd1\x80\xd0\xb8\xd0\xbe\xd0\xb1\xd1\x80\xd0\xb5\xd1\x82\xd0\xb5\xd0\xbd\xd0\xb8\xd0\xb5\xd0\xa2\xd0\xbe\xd0\xb2\xd0\xb0\xd1\x80\xd0\xbe\xd0\xb2\xd0\xa3\xd1\x81\xd0\xbb\xd1\x83\xd0\xb3">
        <Property Name="Ref_Key" Type="Edm.Guid" Nullable="false" />
        <Property Name="\xd0\xa2\xd0\xbe\xd0\xb2\xd0\xb0\xd1\x80\xd1\x8b" Type="Collection(Sample.Document_\xd0\x9f\xd1\x80\xd0\xb8\xd0\xbe\xd0\xb1\xd1\x80\xd0\xb5\xd1\x82\xd0\xb5\xd0\xbd\xd0\xb8\xd0\xb5\xd0\xa2\xd0\xbe\xd0\xb2\xd0\xb0\xd1\x80\xd0\xbe\xd0\xb2\xd0\xa3\xd1\x81\xd0\xbb\xd1\x83\xd0\xb3_\xd0\xa2\xd0\xbe\xd0\xb2\xd0\xb0\xd1\x80\xd1\x8b_RowType)" />
      </EntityType>
      <ComplexType Name="Document_\xd0\x9f\xd1\x80\xd0\xb8\xd0\xbe\xd0\xb1\xd1\x80\xd0\xb5\xd1\x82\xd0\xb5\xd0\xbd\xd0\xb8\xd0\xb5\xd0\xa2\xd0\xbe\xd0\xb2\xd0\xb0\xd1\x80\xd0\xbe\xd0\xb2\xd0\xa3\xd1\x81\xd0\xbb\xd1\x83\xd0\xb3_\xd0\xa2\xd0\xbe\xd0\xb2\xd0\xb0\xd1\x80\xd1\x8b_RowType">
        <Property Name="LineNumber" Type="Edm.Int32" Nullable="false" />
        <Property Name="\xd0\x9d\xd0\xbe\xd0\xbc\xd0\xb5\xd0\xbd\xd0\xba\xd0\xbb\xd0\xb0\xd1\x82\xd1\x83\xd1\x80\xd0\xb0_Key" Type="Edm.Guid" />
        <Property Name="\xd0\x9a\xd0\xbe\xd0\xbb\xd0\xb8\xd1\x87\xd0\xb5\xd1\x81\xd1\x82\xd0\xb2\xd0\xbe" Type="Edm.Double" />
      </ComplexType>
      <EntityType Name="Catalog_\xd0\x97\xd0\xb0\xd1\x80\xd0\xbf\xd0\xbb\xd0\xb0\xd1\x82\xd0\xb0">
        <Property Name="Ref_Key" Type="Edm.Guid" />
      </EntityType>
      <EntityType Name="Document_\xd0\x9f\xd0\xbe\xd1\x81\xd1\x82\xd1\x83\xd0\xbf\xd0\xbb\xd0\xb5\xd0\xbd\xd0\xb8\xd0\xb5\xd0\x91\xd0\xb5\xd0\xb7\xd0\xbd\xd0\xb0\xd0\xbb\xd0\xb8\xd1\x87\xd0\xbd\xd1\x8b\xd1\x85\xd0\x94\xd0\xb5\xd0\xbd\xd0\xb5\xd0\xb6\xd0\xbd\xd1\x8b\xd1\x85\xd0\xa1\xd1\x80\xd0\xb5\xd0\xb4\xd1\x81\xd1\x82\xd0\xb2">
        <Property Name="Ref_Key" Type="Edm.Guid" />
      </EntityType>
      <EntityContainer Name="Container">
        <EntitySet Name="Catalog_\xd0\x9e\xd1\x80\xd0\xb3\xd0\xb0\xd0\xbd\xd0\xb8\xd0\xb7\xd0\xb0\xd1\x86\xd0\xb8\xd0\xb8" EntityType="Sample.Catalog_\xd0\x9e\xd1\x80\xd0\xb3\xd0\xb0\xd0\xbd\xd0\xb8\xd0\xb7\xd0\xb0\xd1\x86\xd0\xb8\xd0\xb8" />
        <EntitySet Name="Document_\xd0\x9f\xd0\xbe\xd1\x81\xd1\x82\xd1\x83\xd0\xbf\xd0\xbb\xd0\xb5\xd0\xbd\xd0\xb8\xd0\xb5" EntityType="Sample.Document_\xd0\x9f\xd0\xbe\xd1\x81\xd1\x82\xd1\x83\xd0\xbf\xd0\xbb\xd0\xb5\xd0\xbd\xd0\xb8\xd0\xb5" />
        <EntitySet Name="Document_\xd0\x9f\xd1\x80\xd0\xb8\xd0\xbe\xd0\xb1\xd1\x80\xd0\xb5\xd1\x82\xd0\xb5\xd0\xbd\xd0\xb8\xd0\xb5\xd0\xa2\xd0\xbe\xd0\xb2\xd0\xb0\xd1\x80\xd0\xbe\xd0\xb2\xd0\xa3\xd1\x81\xd0\xbb\xd1\x83\xd0\xb3" EntityType="Sample.Document_\xd0\x9f\xd1\x80\xd0\xb8\xd0\xbe\xd0\xb1\xd1\x80\xd0\xb5\xd1\x82\xd0\xb5\xd0\xbd\xd0\xb8\xd0\xb5\xd0\xa2\xd0\xbe\xd0\xb2\xd0\xb0\xd1\x80\xd0\xbe\xd0\xb2\xd0\xa3\xd1\x81\xd0\xbb\xd1\x83\xd0\xb3" />
        <EntitySet Name="Catalog_\xd0\x97\xd0\xb0\xd1\x80\xd0\xbf\xd0\xbb\xd0\xb0\xd1\x82\xd0\xb0" EntityType="Sample.Catalog_\xd0\x97\xd0\xb0\xd1\x80\xd0\xbf\xd0\xbb\xd0\xb0\xd1\x82\xd0\xb0" />
        <EntitySet Name="Document_\xd0\x9f\xd0\xbe\xd1\x81\xd1\x82\xd1\x83\xd0\xbf\xd0\xbb\xd0\xb5\xd0\xbd\xd0\xb8\xd0\xb5\xd0\x91\xd0\xb5\xd0\xb7\xd0\xbd\xd0\xb0\xd0\xbb\xd0\xb8\xd1\x87\xd0\xbd\xd1\x8b\xd1\x85\xd0\x94\xd0\xb5\xd0\xbd\xd0\xb5\xd0\xb6\xd0\xbd\xd1\x8b\xd1\x85\xd0\xa1\xd1\x80\xd0\xb5\xd0\xb4\xd1\x81\xd1\x82\xd0\xb2" EntityType="Sample.Document_\xd0\x9f\xd0\xbe\xd1\x81\xd1\x82\xd1\x83\xd0\xbf\xd0\xbb\xd0\xb5\xd0\xbd\xd0\xb8\xd0\xb5\xd0\x91\xd0\xb5\xd0\xb7\xd0\xbd\xd0\xb0\xd0\xbb\xd0\xb8\xd1\x87\xd0\xbd\xd1\x8b\xd1\x85\xd0\x94\xd0\xb5\xd0\xbd\xd0\xb5\xd0\xb6\xd0\xbd\xd1\x8b\xd1\x85\xd0\xa1\xd1\x80\xd0\xb5\xd0\xb4\xd1\x81\xd1\x82\xd0\xb2" />
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>
"""


def production_metadata(
    *,
    override: tuple[str, str] | None = None,
) -> bytes:
    """Build a deterministic metadata snapshot from the frozen registry.

    Digest literals below remain the independent review gate for mapping
    changes; this XML fixture exercises the actual entity/ComplexType verifier.
    """

    root = ET.Element(
        "{http://docs.oasis-open.org/odata/ns/edmx}Edmx",
        {"Version": "4.0"},
    )
    services = ET.SubElement(
        root,
        "{http://docs.oasis-open.org/odata/ns/edmx}DataServices",
    )
    schema = ET.SubElement(
        services,
        "{http://docs.oasis-open.org/odata/ns/edm}Schema",
        {"Namespace": "StandardODATA"},
    )
    container = ET.Element(
        "{http://docs.oasis-open.org/odata/ns/edm}EntityContainer",
        {"Name": "Container"},
    )
    registries = (
        runtime.GENERAL_REFERENCE_SPECS,
        runtime.GENERAL_DOCUMENT_SPECS,
    )
    for registry in registries:
        for sources in registry.values():
            for source in sources:
                entity = ET.SubElement(
                    schema,
                    "{http://docs.oasis-open.org/odata/ns/edm}EntityType",
                    {"Name": source["entity"]},
                )
                for field, field_type in source["fields"].items():
                    actual_type = (
                        override[1]
                        if override and override[0] == f"{source['entity']}.{field}"
                        else field_type
                    )
                    ET.SubElement(
                        entity,
                        "{http://docs.oasis-open.org/odata/ns/edm}Property",
                        {"Name": field, "Type": actual_type},
                    )
                ET.SubElement(
                    container,
                    "{http://docs.oasis-open.org/odata/ns/edm}EntitySet",
                    {
                        "Name": source["entity"],
                        "EntityType": f"StandardODATA.{source['entity']}",
                    },
                )
                if source.get("lineFields"):
                    collection_type = source["fields"]["Товары"][11:-1]
                    row_name = collection_type.removeprefix("StandardODATA.")
                    row_type = ET.SubElement(
                        schema,
                        "{http://docs.oasis-open.org/odata/ns/edm}ComplexType",
                        {"Name": row_name},
                    )
                    for field, field_type in source["lineFields"].items():
                        ET.SubElement(
                            row_type,
                            "{http://docs.oasis-open.org/odata/ns/edm}Property",
                            {"Name": field, "Type": field_type},
                        )
    schema.append(container)
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


class OneCGeneralRuntimeTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.environment = mock.patch.dict(
            os.environ,
            {
                "TRELIO_SKILL_ID": "1c",
                "TRELIO_SKILL_COMPANY_ID": COMPANY_ID,
                "TRELIO_SKILL_MEMBER_ID": MEMBER_ID,
                "TRELIO_SKILL_CONNECTION_ID": CONNECTION_ID,
                "TRELIO_CONFIG_HOME": self.temporary.name,
            },
            clear=False,
        )
        self.environment.start()

    def tearDown(self) -> None:
        self.environment.stop()
        self.temporary.cleanup()

    def test_metadata_has_a_separate_bounded_limit(self) -> None:
        self.assertEqual(runtime.MAX_ODATA_RESPONSE_BYTES, 8 * 1024 * 1024)
        self.assertEqual(runtime.MAX_METADATA_RESPONSE_BYTES, 64 * 1024 * 1024)

    def test_inventory_is_bounded_structural_and_excludes_sensitive_catalogs(self) -> None:
        digest, candidates, truncated, counts = runtime._metadata_candidates(METADATA)

        self.assertEqual(len(digest), 64)
        self.assertFalse(truncated)
        self.assertEqual(
            [candidate["entitySet"] for candidate in candidates],
            [
                "Catalog_\u041e\u0440\u0433\u0430\u043d\u0438\u0437\u0430\u0446\u0438\u0438",
                "Document_\u041f\u043e\u0441\u0442\u0443\u043f\u043b\u0435\u043d\u0438\u0435",
                "Document_\u041f\u0440\u0438\u043e\u0431\u0440\u0435\u0442\u0435\u043d\u0438\u0435\u0422\u043e\u0432\u0430\u0440\u043e\u0432\u0423\u0441\u043b\u0443\u0433",
            ],
        )
        self.assertNotIn("\u0417\u0430\u0440\u043f\u043b\u0430\u0442\u0430", str(candidates))
        self.assertNotIn("\u0414\u0435\u043d\u0435\u0436\u043d", str(candidates))
        self.assertEqual(counts["reference.organization"]["returned"], 1)
        self.assertEqual(counts["document.purchase"]["returned"], 2)
        acquisition = next(
            candidate
            for candidate in candidates
            if candidate["entitySet"]
            == "Document_\u041f\u0440\u0438\u043e\u0431\u0440\u0435\u0442\u0435\u043d\u0438\u0435\u0422\u043e\u0432\u0430\u0440\u043e\u0432\u0423\u0441\u043b\u0443\u0433"
        )
        self.assertEqual(acquisition["collections"][0]["name"], "\u0422\u043e\u0432\u0430\u0440\u044b")
        self.assertEqual(
            [field["name"] for field in acquisition["collections"][0]["properties"]],
            ["LineNumber", "\u041d\u043e\u043c\u0435\u043d\u043a\u043b\u0430\u0442\u0443\u0440\u0430_Key", "\u041a\u043e\u043b\u0438\u0447\u0435\u0441\u0442\u0432\u043e"],
        )
        self.assertLessEqual(
            max(len(candidate["properties"]) for candidate in candidates),
            runtime.MAX_INVENTORY_PROPERTIES,
        )

    def test_inventory_samples_are_bounded_per_capability(self) -> None:
        candidates = [
            {
                "entitySet": f"Catalog_\u041e\u0440\u0433\u0430\u043d\u0438\u0437\u0430\u0446\u0438\u0438{index}",
                "matches": [{"section": "reference", "kind": "organization"}],
            }
            for index in range(5)
        ]
        candidates.extend([
            {
                "entitySet": f"Document_\u041f\u043e\u0441\u0442\u0443\u043f\u043b\u0435\u043d\u0438\u0435{index}",
                "matches": [{"section": "document", "kind": "purchase"}],
            }
            for index in range(5)
        ])

        selected = runtime._inventory_sample_names(candidates)

        self.assertEqual(len(selected), 4)
        self.assertEqual(
            len([name for name in selected if name.startswith("Catalog_")]),
            runtime.MAX_INVENTORY_SAMPLES_PER_CAPABILITY,
        )
        self.assertEqual(
            len([name for name in selected if name.startswith("Document_")]),
            runtime.MAX_INVENTORY_SAMPLES_PER_CAPABILITY,
        )

    def test_inventory_command_never_returns_sample_values(self) -> None:
        identity = runtime.Identity(COMPANY_ID, MEMBER_ID, CONNECTION_ID)
        config = mock.Mock()
        credentials = runtime.Credentials("private-user", "private-password")

        with (
            mock.patch.object(runtime, "_connected_context", return_value=(identity, config, credentials)),
            mock.patch.object(runtime, "_request_metadata", return_value=METADATA),
            mock.patch.object(
                runtime,
                "_request_inventory_sample",
                return_value={
                    "accessible": True,
                    "hasRows": True,
                    "selectedFields": ["Ref_Key", "Description"],
                    "returnedFieldClasses": {
                        "Ref_Key": "uuid",
                        "Description": "string",
                    },
                },
            ),
        ):
            result = runtime.command_developer_inventory_metadata(mock.Mock())

        serialized = str(result)
        self.assertNotIn("private-user", serialized)
        self.assertNotIn("private-password", serialized)
        self.assertIn("schemaDigest", result)
        self.assertTrue(all("sample" in candidate for candidate in result["candidates"]))

    def test_general_surface_reuses_legacy_provider_credential_namespace(self) -> None:
        identity = runtime.load_identity()
        root = runtime.connection_root(identity)

        self.assertIn("/integrations/1c-edo/", root.as_posix())
        self.assertNotIn("/integrations/1c/", root.as_posix())

    def test_general_parser_has_no_raw_odata_arguments(self) -> None:
        parser = runtime.build_parser("1c")
        with self.assertRaises(SystemExit):
            parser.parse_args(["developer-inventory-metadata"])
        with self.assertRaises(SystemExit):
            parser.parse_args(["raw-query", "--url", "https://example.test/"])
        with self.assertRaises(SystemExit):
            parser.parse_args([
                "search-reference-items",
                "--kind",
                "users",
            ])

    def test_production_registry_digests_match_reviewed_snapshot(self) -> None:
        expected = {
            "document.purchase": "sha256:7afac154856c37c72da3a896ca9bfa081687e9a448a0176b97d5b2fa7f163887",
            "document.receipt": "sha256:888b63f2aa4c5f44da03d658ca4ee8fb6bfaa3d26e6db94a333c057e25eab56a",
            "document.return": "sha256:2e4720f7a1b2bd674b36bb78d5215683bb52c0e2de6ac5179e352a20502bd7b8",
            "document.sale": "sha256:3f25c1c0b73ace19903cb6f8cb7bdd943cc29deac2f16365fb402c55e9fd86d7",
            "document.transfer": "sha256:7d7fb239dec93035810f32d2cd6ae85c3eae6a0a273f8589090e10c419db1e78",
            "reference.business_unit": "sha256:504bcc3fa2baf43b8847cef3e8403d108a8b4e30726489569a01567448b5f958",
            "reference.contract": "sha256:19545b544023b17f0d7ec492013ac8ebde0142f39d48143f7f5bcbef5234466f",
            "reference.counterparty": "sha256:027a55880241d5296930773e365fbf85e969cee06a4be22f491e0481f70a1fb1",
            "reference.item": "sha256:d266c949bbcfe2d08661e04af143c5c4e0963e982579a396f53bd96d749607b0",
            "reference.organization": "sha256:24ba32743bcd09da852e45fca91758aaf756487e2233de79dbd85adf39d45a77",
            "reference.partner": "sha256:ab90293f0b52ac67238e8ac40d928590e29168e3339f9f13ceb3fc091b1c58fe",
            "reference.warehouse": "sha256:2de83f9ebf0c315904554e1cec813adc844f86308874172045b306cfc1cfb35f",
        }
        actual = {
            f"reference.{kind}": runtime._general_capability_digest(
                "reference",
                kind,
            )
            for kind in runtime.GENERAL_REFERENCE_SPECS
        }
        actual.update({
            f"document.{kind}": runtime._general_capability_digest(
                "document",
                kind,
            )
            for kind in runtime.GENERAL_DOCUMENT_SPECS
        })

        self.assertEqual(runtime.GENERAL_INVENTORY_SCHEMA_DIGEST, "sha256:24fdf38337a373147df742a235b9bc025f45616e4f0753fe06dc769bda45353b")
        self.assertEqual(actual, expected)

    def test_schema_verifier_accepts_snapshot_and_rejects_affected_drift(self) -> None:
        config = mock.Mock(fingerprint="test-connection-fingerprint")
        credentials = runtime.Credentials("user", "password")
        capabilities = [
            *(("reference", kind) for kind in runtime.GENERAL_REFERENCE_SPECS),
            *(("document", kind) for kind in runtime.GENERAL_DOCUMENT_SPECS),
        ]
        with mock.patch.object(
            runtime,
            "_request_metadata_resource",
            return_value=runtime.MetadataResource(
                status=200,
                body=production_metadata(),
                etag='"schema-v1"',
                last_modified=None,
            ),
        ):
            verified = runtime._verify_general_schema(
                config,
                credentials,
                capabilities,
            )

        self.assertEqual(len(verified["capabilityDigests"]), 12)

        drifted = production_metadata(
            override=("Catalog_Организации.Description", "Edm.Int32"),
        )
        with (
            mock.patch.object(
                runtime,
                "_request_metadata_resource",
                return_value=runtime.MetadataResource(
                    status=200,
                    body=drifted,
                    etag='"schema-v2"',
                    last_modified=None,
                ),
            ),
            self.assertRaisesRegex(runtime.OneCEdoError, "reference.organization"),
        ):
            runtime._verify_general_schema(
                config,
                credentials,
                (("reference", "organization"),),
            )

    def test_schema_cache_requires_conditional_confirmation_on_every_call(self) -> None:
        config = mock.Mock(fingerprint="test-connection-fingerprint")
        credentials = runtime.Credentials("user", "password")
        capability = (("reference", "organization"),)
        requests: list[dict[str, str] | None] = []

        def request(*_args, validators=None, **_kwargs):
            requests.append(validators)
            if len(requests) == 1:
                return runtime.MetadataResource(
                    status=200,
                    body=production_metadata(),
                    etag='"stable-schema"',
                    last_modified=None,
                )
            return runtime.MetadataResource(
                status=304,
                body=None,
                etag='"stable-schema"',
                last_modified=None,
            )

        with mock.patch.object(
            runtime,
            "_request_metadata_resource",
            side_effect=request,
        ):
            cold = runtime._verify_general_schema(
                config,
                credentials,
                capability,
            )
            warm = runtime._verify_general_schema(
                config,
                credentials,
                capability,
            )

        self.assertIsNone(requests[0])
        self.assertEqual(
            requests[1],
            {"etag": '"stable-schema"', "lastModified": None},
        )
        self.assertEqual(cold["validation"]["mode"], "full_download")
        self.assertEqual(
            warm["validation"]["mode"],
            "conditional_not_modified",
        )
        self.assertTrue(warm["validation"]["cacheProjectionUsed"])

    def test_schema_without_validator_is_downloaded_again_not_ttl_cached(self) -> None:
        config = mock.Mock(fingerprint="test-connection-fingerprint")
        credentials = runtime.Credentials("user", "password")
        requests: list[dict[str, str] | None] = []

        def request(*_args, validators=None, **_kwargs):
            requests.append(validators)
            return runtime.MetadataResource(
                status=200,
                body=production_metadata(),
                etag=None,
                last_modified=None,
            )

        with mock.patch.object(
            runtime,
            "_request_metadata_resource",
            side_effect=request,
        ):
            first = runtime._verify_general_schema(
                config,
                credentials,
                (("reference", "organization"),),
            )
            second = runtime._verify_general_schema(
                config,
                credentials,
                (("reference", "organization"),),
            )

        self.assertEqual(requests, [None, None])
        self.assertEqual(first["validation"]["serverValidator"], "none")
        self.assertEqual(second["validation"]["mode"], "full_download")
        self.assertFalse(
            runtime.general_schema_cache_path(runtime.load_identity()).exists(),
        )

    def test_schema_cache_tampering_fails_closed_before_network(self) -> None:
        config = mock.Mock(fingerprint="test-connection-fingerprint")
        credentials = runtime.Credentials("user", "password")
        identity = runtime.load_identity()
        with mock.patch.object(
            runtime,
            "_request_metadata_resource",
            return_value=runtime.MetadataResource(
                status=200,
                body=production_metadata(),
                etag='"stable-schema"',
                last_modified=None,
            ),
        ):
            runtime._verify_general_schema(
                config,
                credentials,
                (("reference", "organization"),),
            )

        path = runtime.general_schema_cache_path(identity)
        payload = json.loads(path.read_text(encoding="utf-8"))
        payload["schemaDigest"] = "sha256:" + ("0" * 64)
        path.write_text(json.dumps(payload), encoding="utf-8")
        path.chmod(0o600)

        with (
            mock.patch.object(runtime, "_request_metadata_resource") as request,
            self.assertRaisesRegex(runtime.OneCEdoError, "Целостность"),
        ):
            runtime._verify_general_schema(
                config,
                credentials,
                (("reference", "organization"),),
            )
        request.assert_not_called()

    def test_schema_cache_rejects_a_contradictory_304_validator(self) -> None:
        config = mock.Mock(fingerprint="test-connection-fingerprint")
        credentials = runtime.Credentials("user", "password")
        capability = (("reference", "organization"),)
        with mock.patch.object(
            runtime,
            "_request_metadata_resource",
            return_value=runtime.MetadataResource(
                status=200,
                body=production_metadata(),
                etag='"schema-v1"',
                last_modified=None,
            ),
        ):
            runtime._verify_general_schema(config, credentials, capability)

        with (
            mock.patch.object(
                runtime,
                "_request_metadata_resource",
                return_value=runtime.MetadataResource(
                    status=304,
                    body=None,
                    etag='"schema-v2"',
                    last_modified=None,
                ),
            ),
            self.assertRaisesRegex(
                runtime.OneCEdoError,
                "противоречивое",
            ),
        ):
            runtime._verify_general_schema(config, credentials, capability)

    def test_schema_cache_is_private_minimal_and_never_stale_on_error(self) -> None:
        config = mock.Mock(fingerprint="test-connection-fingerprint")
        credentials = runtime.Credentials("private-user", "private-password")
        identity = runtime.load_identity()
        with mock.patch.object(
            runtime,
            "_request_metadata_resource",
            return_value=runtime.MetadataResource(
                status=200,
                body=production_metadata(),
                etag='"stable-schema"',
                last_modified=None,
            ),
        ):
            runtime._verify_general_schema(
                config,
                credentials,
                (("reference", "organization"),),
            )

        path = runtime.general_schema_cache_path(identity)
        serialized = path.read_text(encoding="utf-8")
        self.assertEqual(path.stat().st_mode & 0o077, 0)
        self.assertNotIn("private-user", serialized)
        self.assertNotIn("private-password", serialized)
        self.assertNotIn("Catalog_", serialized)
        self.assertNotIn("Document_", serialized)

        with (
            mock.patch.object(
                runtime,
                "_request_metadata_resource",
                side_effect=runtime.NetworkError(
                    "network_error",
                    "offline",
                ),
            ),
            self.assertRaises(runtime.NetworkError),
        ):
            runtime._verify_general_schema(
                config,
                credentials,
                (("reference", "organization"),),
            )

    def test_metadata_validator_diagnostic_never_returns_header_values(self) -> None:
        headers = {
            "ETag": '"private-etag-value"',
            "Last-Modified": "Sun, 27 Jul 2026 00:00:00 GMT",
        }

        etag, last_modified = runtime._safe_metadata_validators(headers)
        diagnostic = runtime._metadata_validator_kind(etag, last_modified)

        self.assertEqual(diagnostic, "etag_and_last_modified")
        self.assertNotIn("private-etag-value", diagnostic)
        self.assertEqual(
            runtime._safe_metadata_validators(
                {
                    "ETag": "invalid\r\nInjected: value",
                    "Last-Modified": "not-a-date",
                },
            ),
            (None, None),
        )

    def test_metadata_gzip_is_fully_decoded_and_independently_bounded(self) -> None:
        raw = production_metadata()
        compressed = gzip.compress(raw)

        self.assertEqual(
            runtime._safe_metadata_content_encoding(
                {"Content-Encoding": "gzip"},
            ),
            "gzip",
        )
        self.assertEqual(
            runtime._read_gzip_limited(io.BytesIO(compressed), len(raw)),
            raw,
        )
        with self.assertRaisesRegex(
            runtime.OneCEdoError,
            "Распакованный metadata",
        ):
            runtime._read_gzip_limited(
                io.BytesIO(compressed),
                len(raw) - 1,
            )
        with self.assertRaisesRegex(
            runtime.OneCEdoError,
            "неподдерживаемое кодирование",
        ):
            runtime._safe_metadata_content_encoding(
                {"Content-Encoding": "br"},
            )

    def test_metadata_request_advertises_and_decodes_only_gzip(self) -> None:
        class Response(io.BytesIO):
            status = 200
            headers = {"Content-Encoding": "gzip"}

            def getcode(self) -> int:
                return self.status

        raw = production_metadata()
        response = Response(gzip.compress(raw))
        config = mock.Mock()
        credentials = runtime.Credentials("user", "password")
        with (
            mock.patch.object(runtime, "_require_x_odata", return_value="secret"),
            mock.patch.object(
                runtime,
                "_http_open",
                return_value=response,
            ) as http_open,
        ):
            resource = runtime._request_metadata_resource(
                config,
                credentials,
            )

        self.assertEqual(resource.status, 200)
        self.assertEqual(resource.body, raw)
        self.assertEqual(resource.content_encoding, "gzip")
        self.assertEqual(
            http_open.call_args.kwargs["accept_encoding"],
            "gzip",
        )

    def test_schema_cache_survives_separate_one_shot_process(self) -> None:
        config = mock.Mock(fingerprint="test-connection-fingerprint")
        credentials = runtime.Credentials("user", "password")
        with mock.patch.object(
            runtime,
            "_request_metadata_resource",
            return_value=runtime.MetadataResource(
                status=200,
                body=production_metadata(),
                etag='"stable-schema"',
                last_modified=None,
            ),
        ):
            runtime._verify_general_schema(
                config,
                credentials,
                (("reference", "organization"),),
            )

        child = f"""
import importlib.util
import json
import sys
from pathlib import Path
from unittest import mock
path = Path({str(SCRIPT)!r})
spec = importlib.util.spec_from_file_location("trelio_one_c_child", path)
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
config = mock.Mock(fingerprint="test-connection-fingerprint")
credentials = module.Credentials("user", "password")
with mock.patch.object(
    module,
    "_request_metadata_resource",
    return_value=module.MetadataResource(
        status=304,
        body=None,
        etag='"stable-schema"',
        last_modified=None,
    ),
):
    result = module._verify_general_schema(
        config,
        credentials,
        (("reference", "organization"),),
    )
print(json.dumps(result["validation"], sort_keys=True))
"""
        started = time.monotonic()
        completed = subprocess.run(
            [sys.executable, "-c", child],
            check=True,
            capture_output=True,
            text=True,
            env=dict(os.environ),
            timeout=5,
        )
        elapsed = time.monotonic() - started

        validation = json.loads(completed.stdout)
        self.assertEqual(validation["mode"], "conditional_not_modified")
        self.assertLess(elapsed, 2.0)

    def test_reference_search_normalizes_and_drops_unselected_fields(self) -> None:
        identity = runtime.Identity(COMPANY_ID, MEMBER_ID, CONNECTION_ID)
        config = mock.Mock(max_rows=50, max_pages=3)
        credentials = runtime.Credentials("user", "password")
        args = Namespace(
            kind="counterparty",
            query="Поставщик",
            page=1,
            limit=10,
        )
        row = {
            "Ref_Key": REFERENCE_ID,
            "Description": "Поставщик",
            "НаименованиеПолное": "ООО Поставщик",
            "Партнер_Key": ITEM_ID,
            "ЮридическоеФизическоеЛицо": "ЮридическоеЛицо",
            "DeletionMark": False,
            "ИНН": "must-not-leak",
            "БанковскийСчет_Key": ITEM_ID,
        }
        schema = {
            "schemaDigest": runtime.GENERAL_INVENTORY_SCHEMA_DIGEST,
            "capabilityDigests": {
                "reference.counterparty": runtime._general_capability_digest(
                    "reference",
                    "counterparty",
                ),
            },
        }
        with (
            mock.patch.object(
                runtime,
                "_connected_context",
                return_value=(identity, config, credentials),
            ),
            mock.patch.object(
                runtime,
                "_verify_general_schema",
                return_value=schema,
            ),
            mock.patch.object(
                runtime,
                "_general_reference_search_rows",
                return_value=[row],
            ),
            mock.patch.object(runtime, "save_access_state"),
        ):
            result = runtime.command_general_search_reference_items(args)

        serialized = str(result)
        self.assertEqual(result["items"][0]["id"], REFERENCE_ID)
        self.assertEqual(result["items"][0]["partnerId"], ITEM_ID)
        self.assertIn("query.name", result["items"][0]["matchedBy"])
        self.assertNotIn("must-not-leak", serialized)
        self.assertNotIn("Банков", serialized)
        self.assertNotIn("ИНН", serialized)

    def test_document_filter_escapes_text_and_blocks_unsupported_relation(self) -> None:
        common = {
            "date_from": "2026-07-01",
            "date_to": "2026-07-31",
            "organization_id": REFERENCE_ID,
            "business_unit_id": "",
            "counterparty_id": "",
            "contract_id": "",
            "number": "A' or true",
            "status": "posted",
        }
        filter_value, matched = runtime._general_document_filter(
            Namespace(**common),
            runtime.GENERAL_DOCUMENT_SPECS["sale"][0],
        )

        self.assertIn("substringof('A'' or true',Number)", filter_value)
        self.assertIn("Posted eq true", filter_value)
        self.assertIn("period", matched)
        self.assertIn("number", matched)

        blocked = dict(common)
        blocked["counterparty_id"] = REFERENCE_ID
        with self.assertRaisesRegex(runtime.OneCEdoError, "counterparty"):
            runtime._general_document_filter(
                Namespace(**blocked),
                runtime.GENERAL_DOCUMENT_SPECS["receipt"][0],
            )

    def test_document_lines_are_normalized_and_locally_truncated(self) -> None:
        spec = runtime.GENERAL_DOCUMENT_SPECS["purchase"][0]
        raw = {
            "Ref_Key": DOCUMENT_ID,
            "Number": "П-1",
            "Date": "2026-07-26T10:00:00",
            "DeletionMark": False,
            "Posted": True,
            "Организация_Key": REFERENCE_ID,
            "Контрагент_Key": ITEM_ID,
            "Товары": [
                {
                    "LineNumber": str(index),
                    "Номенклатура_Key": ITEM_ID,
                    "Количество": 2.0,
                    "Цена": 10.0,
                    "Сумма": 20.0,
                    "БанковскийСчет_Key": "must-not-leak",
                }
                for index in range(1, 4)
            ],
            "БанковскийСчетОрганизации_Key": "must-not-leak",
        }

        result = runtime._general_document_record(
            "purchase",
            spec,
            raw,
            matched_by=["id"],
            include_lines=True,
            line_limit=2,
        )

        self.assertEqual(result["id"], DOCUMENT_ID)
        self.assertEqual(len(result["lines"]), 2)
        self.assertEqual(result["lines"][0]["lineNumber"], 1)
        self.assertTrue(result["lineInfo"]["truncated"])
        self.assertNotIn("must-not-leak", str(result))
        self.assertNotIn("Банков", str(result))

    def test_stock_balance_is_explicitly_unsupported(self) -> None:
        result = runtime.command_general_get_balances(Namespace(kind="stock"))

        self.assertEqual(result["status"], "unsupported")
        self.assertEqual(result["reason"], "needs_custom_endpoint")
        self.assertEqual(result["balances"], [])

    def test_general_entity_allowlist_rejects_arbitrary_catalog(self) -> None:
        config = mock.Mock(odata_base_url="https://example.test/odata/")
        with self.assertRaisesRegex(runtime.OneCEdoError, "entity"):
            runtime._odata_url(config, "Catalog_Пользователи")


if __name__ == "__main__":
    unittest.main()
