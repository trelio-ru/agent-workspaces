from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path


MODULE_PATH = (
    Path(__file__).resolve().parents[1]
    / "development"
    / "inventory_live.py"
)
SPEC = importlib.util.spec_from_file_location("inventory_live", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class InventoryLiveTests(unittest.TestCase):
    def test_inventory_returns_only_hr_structural_candidates(self) -> None:
        raw = b"""<?xml version="1.0" encoding="utf-8"?>
    <edmx:Edmx xmlns:edmx="urn:edmx">
      <edmx:DataServices>
        <Schema xmlns="urn:edm" Namespace="Vkus">
          <EntityType Name="Catalog_\xd0\xa1\xd0\xbe\xd1\x82\xd1\x80\xd1\x83\xd0\xb4\xd0\xbd\xd0\xb8\xd0\xba\xd0\xb8">
            <Property Name="Ref_Key" Type="Edm.Guid" Nullable="false" />
            <Property Name="\xd0\x9f\xd0\xb0\xd1\x81\xd0\xbf\xd0\xbe\xd1\x80\xd1\x82\xd0\xbd\xd1\x8b\xd0\xb5\xd0\x94\xd0\xb0\xd0\xbd\xd0\xbd\xd1\x8b" Type="Edm.String" />
            <Property Name="\xd0\x9d\xd0\xb0\xd1\x87\xd0\xb8\xd1\x81\xd0\xbb\xd0\xb5\xd0\xbd\xd0\xb8\xd1\x8f" Type="Collection(Vkus.PayRow)" />
          </EntityType>
          <ComplexType Name="PayRow">
            <Property Name="\xd0\xa1\xd1\x83\xd0\xbc\xd0\xbc\xd0\xb0" Type="Edm.Double" />
          </ComplexType>
          <EntityType Name="Document_\xd0\x9f\xd1\x80\xd0\xbe\xd0\xb8\xd0\xb7\xd0\xb2\xd0\xbe\xd0\xbb\xd1\x8c\xd0\xbd\xd1\x8b\xd0\xb9">
            <Property Name="Ref_Key" Type="Edm.Guid" />
            <Property Name="\xd0\xa1\xd0\xbe\xd1\x82\xd1\x80\xd1\x83\xd0\xb4\xd0\xbd\xd0\xb8\xd0\xba_Key" Type="Edm.Guid" />
          </EntityType>
          <EntityType Name="Catalog_\xd0\x9d\xd0\xbe\xd0\xbc\xd0\xb5\xd0\xbd\xd0\xba\xd0\xbb\xd0\xb0\xd1\x82\xd1\x83\xd1\x80\xd0\xb0">
            <Property Name="Ref_Key" Type="Edm.Guid" />
            <Property Name="Description" Type="Edm.String" />
          </EntityType>
          <EntityContainer Name="Container">
            <EntitySet Name="Catalog_\xd0\xa1\xd0\xbe\xd1\x82\xd1\x80\xd1\x83\xd0\xb4\xd0\xbd\xd0\xb8\xd0\xba\xd0\xb8" EntityType="Vkus.Catalog_\xd0\xa1\xd0\xbe\xd1\x82\xd1\x80\xd1\x83\xd0\xb4\xd0\xbd\xd0\xb8\xd0\xba\xd0\xb8" />
            <EntitySet Name="Document_\xd0\x9f\xd1\x80\xd0\xbe\xd0\xb8\xd0\xb7\xd0\xb2\xd0\xbe\xd0\xbb\xd1\x8c\xd0\xbd\xd1\x8b\xd0\xb9" EntityType="Vkus.Document_\xd0\x9f\xd1\x80\xd0\xbe\xd0\xb8\xd0\xb7\xd0\xb2\xd0\xbe\xd0\xbb\xd1\x8c\xd0\xbd\xd1\x8b\xd0\xb9" />
            <EntitySet Name="Catalog_\xd0\x9d\xd0\xbe\xd0\xbc\xd0\xb5\xd0\xbd\xd0\xba\xd0\xbb\xd0\xb0\xd1\x82\xd1\x83\xd1\x80\xd0\xb0" EntityType="Vkus.Catalog_\xd0\x9d\xd0\xbe\xd0\xbc\xd0\xb5\xd0\xbd\xd0\xba\xd0\xbb\xd0\xb0\xd1\x82\xd1\x83\xd1\x80\xd0\xb0" />
          </EntityContainer>
        </Schema>
      </edmx:DataServices>
    </edmx:Edmx>"""

        result = MODULE.parse_inventory(raw, match_mode="name-or-field")

        self.assertTrue(result["schemaDigest"].startswith("sha256:"))
        self.assertEqual(result["candidateCount"], 2)
        self.assertFalse(result["privacy"]["recordValuesIncluded"])
        entities = {
            candidate["entitySet"]: candidate
            for candidate in result["candidates"]
        }
        self.assertIn(
            "Catalog_\u0421\u043e\u0442\u0440\u0443\u0434\u043d\u0438\u043a\u0438",
            entities,
        )
        self.assertIn(
            "Document_\u041f\u0440\u043e\u0438\u0437\u0432\u043e\u043b\u044c\u043d\u044b\u0439",
            entities,
        )
        self.assertNotIn(
            "Catalog_\u041d\u043e\u043c\u0435\u043d\u043a\u043b\u0430\u0442\u0443\u0440\u0430",
            entities,
        )
        self.assertTrue(
            entities[
                "Document_\u041f\u0440\u043e\u0438\u0437\u0432\u043e\u043b\u044c\u043d\u044b\u0439"
            ]["matchedBy"]["fields"],
        )
        self.assertEqual(
            entities[
                "Catalog_\u0421\u043e\u0442\u0440\u0443\u0434\u043d\u0438\u043a\u0438"
            ]["collections"][0]["properties"],
            [
                {
                    "name": "\u0421\u0443\u043c\u043c\u0430",
                    "type": "Edm.Double",
                    "nullable": True,
                },
            ],
        )

        name_only = MODULE.parse_inventory(raw)
        self.assertEqual(name_only["matchMode"], "name")
        self.assertEqual(name_only["candidateCount"], 1)
        self.assertEqual(
            name_only["candidates"][0]["entitySet"],
            "Catalog_\u0421\u043e\u0442\u0440\u0443\u0434\u043d\u0438\u043a\u0438",
        )


if __name__ == "__main__":
    unittest.main()
