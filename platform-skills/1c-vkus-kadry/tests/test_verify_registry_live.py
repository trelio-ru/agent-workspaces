from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path
from unittest import mock


MODULE_PATH = (
    Path(__file__).resolve().parents[1]
    / "development"
    / "verify_registry_live.py"
)
SPEC = importlib.util.spec_from_file_location("verify_registry_live", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class VerifyRegistryLiveTests(unittest.TestCase):
    def test_verifier_serializes_classes_without_values(self) -> None:
        registry = {
            "profileSchemaDigest": f"sha256:{'a' * 64}",
            "registryDigest": f"sha256:{'b' * 64}",
            "sources": [
                {
                    "key": "people-111111111111",
                    "title": "\u0421\u043e\u0442\u0440\u0443\u0434\u043d\u0438\u043a\u0438",
                    "categories": ["people"],
                    "fields": [
                        {
                            "name": "Ref_Key",
                            "type": "Edm.Guid",
                            "sensitive": False,
                        },
                        {
                            "name": "\u041f\u0430\u0441\u043f\u043e\u0440\u0442",
                            "type": "Edm.String",
                            "sensitive": True,
                        },
                    ],
                },
            ],
        }
        with mock.patch.object(
            MODULE.runtime,
            "_request_rows",
            return_value=[{
                "Ref_Key": "11111111-1111-4111-8111-111111111111",
                "\u041f\u0430\u0441\u043f\u043e\u0440\u0442": "1234 567890",
            }],
        ):
            result = MODULE.verify_registry(registry, workers=1)

        self.assertEqual(result["failedCount"], 0)
        serialized = str(result)
        self.assertNotIn("1234 567890", serialized)
        self.assertEqual(
            result["sources"][0]["returnedFieldClasses"]["\u041f\u0430\u0441\u043f\u043e\u0440\u0442"],
            "string",
        )


if __name__ == "__main__":
    unittest.main()
