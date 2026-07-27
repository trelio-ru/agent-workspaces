from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path


MODULE_PATH = (
    Path(__file__).resolve().parents[1]
    / "development"
    / "build_registry.py"
)
SPEC = importlib.util.spec_from_file_location("build_registry", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class BuildRegistryTests(unittest.TestCase):
    def test_builds_fixed_sources_and_excludes_binary_fields(self) -> None:
        inventory = {
            "ok": True,
            "matchMode": "name",
            "baseEntitiesOnly": True,
            "candidatesTruncated": False,
            "schemaDigest": f"sha256:{'a' * 64}",
            "candidates": [
                {
                    "entitySet": "Catalog_\u0421\u043e\u0442\u0440\u0443\u0434\u043d\u0438\u043a\u0438",
                    "propertiesTruncated": False,
                    "collectionsTruncated": False,
                    "properties": [
                        {"name": "Ref_Key", "type": "Edm.Guid", "nullable": False},
                        {"name": "Description", "type": "Edm.String", "nullable": True},
                        {"name": "\u041f\u0430\u0441\u043f\u043e\u0440\u0442", "type": "Edm.String", "nullable": True},
                        {"name": "\u0424\u043e\u0442\u043e", "type": "Edm.Binary", "nullable": True},
                    ],
                    "collections": [],
                    "matchedBy": {
                        "entityName": [{"group": "people", "term": "\u0441\u043e\u0442\u0440\u0443\u0434"}],
                    },
                },
                {
                    "entitySet": "Catalog_\u0411\u043e\u043b\u044c\u043d\u0438\u0447\u043d\u044b\u0439\u041b\u0438\u0441\u0442\u041f\u0440\u0438\u0441\u043e\u0435\u0434\u0438\u043d\u0435\u043d\u043d\u044b\u0435\u0424\u0430\u0439\u043b\u044b",
                    "propertiesTruncated": False,
                    "collectionsTruncated": False,
                    "properties": [
                        {"name": "Ref_Key", "type": "Edm.Guid", "nullable": False},
                        {"name": "ВладелецФайла_Key", "type": "Edm.Guid", "nullable": True},
                        {"name": "Размер", "type": "Edm.Int64", "nullable": True},
                        {"name": "Расширение", "type": "Edm.String", "nullable": True},
                        {"name": "ФайлХранилище", "type": "Edm.Stream", "nullable": True},
                    ],
                    "collections": [],
                    "matchedBy": {
                        "entityName": [{"group": "health", "term": "\u0431\u043e\u043b\u044c\u043d\u0438\u0447"}],
                    },
                },
            ],
        }

        registry = MODULE.build_registry(inventory)

        self.assertEqual(registry["sourceCount"], 1)
        source = registry["sources"][0]
        self.assertEqual(source["title"], "\u0421\u043e\u0442\u0440\u0443\u0434\u043d\u0438\u043a\u0438")
        self.assertEqual(source["filters"]["recordId"], "Ref_Key")
        self.assertEqual(source["filters"]["queryFields"], ["Description"])
        self.assertEqual(
            [field["name"] for field in source["fields"]],
            ["Ref_Key", "Description", "\u041f\u0430\u0441\u043f\u043e\u0440\u0442"],
        )
        self.assertFalse(source["fields"][0]["sensitive"])
        self.assertTrue(source["fields"][2]["sensitive"])
        self.assertEqual(registry["attachmentSourceCount"], 1)
        attachment = registry["attachmentSources"][0]
        self.assertEqual(
            attachment["title"],
            "\u0411\u043e\u043b\u044c\u043d\u0438\u0447\u043d\u044b\u0439\u041b\u0438\u0441\u0442",
        )
        self.assertEqual(attachment["ownerField"], "ВладелецФайла_Key")
        self.assertEqual(attachment["contentField"], "ФайлХранилище")
        self.assertTrue(registry["safety"]["exactAttachmentDownload"])
        self.assertTrue(registry["registryDigest"].startswith("sha256:"))


if __name__ == "__main__":
    unittest.main()
