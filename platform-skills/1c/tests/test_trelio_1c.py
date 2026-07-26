from __future__ import annotations

import importlib.util
import os
import sys
import tempfile
import unittest
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
      <EntityType Name="Catalog_\xd0\x97\xd0\xb0\xd1\x80\xd0\xbf\xd0\xbb\xd0\xb0\xd1\x82\xd0\xb0">
        <Property Name="Ref_Key" Type="Edm.Guid" />
      </EntityType>
      <EntityType Name="Document_\xd0\x9f\xd0\xbe\xd1\x81\xd1\x82\xd1\x83\xd0\xbf\xd0\xbb\xd0\xb5\xd0\xbd\xd0\xb8\xd0\xb5\xd0\x91\xd0\xb5\xd0\xb7\xd0\xbd\xd0\xb0\xd0\xbb\xd0\xb8\xd1\x87\xd0\xbd\xd1\x8b\xd1\x85\xd0\x94\xd0\xb5\xd0\xbd\xd0\xb5\xd0\xb6\xd0\xbd\xd1\x8b\xd1\x85\xd0\xa1\xd1\x80\xd0\xb5\xd0\xb4\xd1\x81\xd1\x82\xd0\xb2">
        <Property Name="Ref_Key" Type="Edm.Guid" />
      </EntityType>
      <EntityContainer Name="Container">
        <EntitySet Name="Catalog_\xd0\x9e\xd1\x80\xd0\xb3\xd0\xb0\xd0\xbd\xd0\xb8\xd0\xb7\xd0\xb0\xd1\x86\xd0\xb8\xd0\xb8" EntityType="Sample.Catalog_\xd0\x9e\xd1\x80\xd0\xb3\xd0\xb0\xd0\xbd\xd0\xb8\xd0\xb7\xd0\xb0\xd1\x86\xd0\xb8\xd0\xb8" />
        <EntitySet Name="Document_\xd0\x9f\xd0\xbe\xd1\x81\xd1\x82\xd1\x83\xd0\xbf\xd0\xbb\xd0\xb5\xd0\xbd\xd0\xb8\xd0\xb5" EntityType="Sample.Document_\xd0\x9f\xd0\xbe\xd1\x81\xd1\x82\xd1\x83\xd0\xbf\xd0\xbb\xd0\xb5\xd0\xbd\xd0\xb8\xd0\xb5" />
        <EntitySet Name="Catalog_\xd0\x97\xd0\xb0\xd1\x80\xd0\xbf\xd0\xbb\xd0\xb0\xd1\x82\xd0\xb0" EntityType="Sample.Catalog_\xd0\x97\xd0\xb0\xd1\x80\xd0\xbf\xd0\xbb\xd0\xb0\xd1\x82\xd0\xb0" />
        <EntitySet Name="Document_\xd0\x9f\xd0\xbe\xd1\x81\xd1\x82\xd1\x83\xd0\xbf\xd0\xbb\xd0\xb5\xd0\xbd\xd0\xb8\xd0\xb5\xd0\x91\xd0\xb5\xd0\xb7\xd0\xbd\xd0\xb0\xd0\xbb\xd0\xb8\xd1\x87\xd0\xbd\xd1\x8b\xd1\x85\xd0\x94\xd0\xb5\xd0\xbd\xd0\xb5\xd0\xb6\xd0\xbd\xd1\x8b\xd1\x85\xd0\xa1\xd1\x80\xd0\xb5\xd0\xb4\xd1\x81\xd1\x82\xd0\xb2" EntityType="Sample.Document_\xd0\x9f\xd0\xbe\xd1\x81\xd1\x82\xd1\x83\xd0\xbf\xd0\xbb\xd0\xb5\xd0\xbd\xd0\xb8\xd0\xb5\xd0\x91\xd0\xb5\xd0\xb7\xd0\xbd\xd0\xb0\xd0\xbb\xd0\xb8\xd1\x87\xd0\xbd\xd1\x8b\xd1\x85\xd0\x94\xd0\xb5\xd0\xbd\xd0\xb5\xd0\xb6\xd0\xbd\xd1\x8b\xd1\x85\xd0\xa1\xd1\x80\xd0\xb5\xd0\xb4\xd1\x81\xd1\x82\xd0\xb2" />
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>
"""


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
            ["Catalog_\u041e\u0440\u0433\u0430\u043d\u0438\u0437\u0430\u0446\u0438\u0438", "Document_\u041f\u043e\u0441\u0442\u0443\u043f\u043b\u0435\u043d\u0438\u0435"],
        )
        self.assertNotIn("\u0417\u0430\u0440\u043f\u043b\u0430\u0442\u0430", str(candidates))
        self.assertNotIn("\u0414\u0435\u043d\u0435\u0436\u043d", str(candidates))
        self.assertEqual(counts["reference.organization"]["returned"], 1)
        self.assertEqual(counts["document.purchase"]["returned"], 1)
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
            parser.parse_args(["developer-inventory-metadata", "--entity", "Catalog_Users"])
        with self.assertRaises(SystemExit):
            parser.parse_args(["raw-query", "--url", "https://example.test/"])


if __name__ == "__main__":
    unittest.main()
