import importlib.util
import pathlib
import sys
import tempfile
import unittest
from unittest import mock


SCRIPT_PATH = pathlib.Path(__file__).parents[1] / "scripts" / "trelio-telegram.py"
SPEC = importlib.util.spec_from_file_location("trelio_telegram", SCRIPT_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class TrelioTelegramTests(unittest.TestCase):
    def identity(self):
        return MODULE.Identity(
            company_id="11111111-1111-1111-1111-111111111111",
            member_id="22222222-2222-2222-2222-222222222222",
            connection_id="33333333-3333-3333-3333-333333333333",
        )

    def test_default_policy_requires_confirmation(self):
        with mock.patch.object(MODULE, "policy_path", return_value=pathlib.Path("/missing/policy.json")):
            self.assertEqual(MODULE.load_policy(self.identity()), {"sendMode": "confirm"})
            with self.assertRaisesRegex(MODULE.TelegramRuntimeError, "--confirm"):
                MODULE.assert_send_allowed(
                    self.identity(),
                    confirmed=False,
                    company_allows_autonomous=True,
                )

    def test_read_only_policy_blocks_confirmed_send(self):
        with mock.patch.object(MODULE, "load_policy", return_value={"sendMode": "read-only"}):
            with self.assertRaisesRegex(MODULE.TelegramRuntimeError, "read-only"):
                MODULE.assert_send_allowed(
                    self.identity(),
                    confirmed=True,
                    company_allows_autonomous=True,
                )

    def test_autonomous_policy_obeys_company_ceiling(self):
        with mock.patch.object(MODULE, "load_policy", return_value={"sendMode": "autonomous"}):
            self.assertEqual(
                MODULE.assert_send_allowed(
                    self.identity(),
                    confirmed=False,
                    company_allows_autonomous=True,
                ),
                "autonomous",
            )
            with self.assertRaisesRegex(MODULE.TelegramRuntimeError, "company connection"):
                MODULE.assert_send_allowed(
                    self.identity(),
                    confirmed=False,
                    company_allows_autonomous=False,
                )

    def test_local_root_uses_stable_identity_and_not_workspace(self):
        with tempfile.TemporaryDirectory() as temporary:
            with mock.patch.dict(MODULE.os.environ, {"TRELIO_CONFIG_HOME": temporary}):
                root = MODULE.connection_root(self.identity())
        self.assertIn("telegram-mtproto", str(root))
        self.assertIn(self.identity().company_id, str(root))
        self.assertNotIn(".trelio", str(root))

    def test_api_hash_is_accepted_only_from_environment(self):
        with mock.patch.dict(MODULE.os.environ, {}, clear=True):
            with self.assertRaisesRegex(MODULE.TelegramRuntimeError, "Agent Secret checkout"):
                MODULE.require_api_hash()
        with mock.patch.dict(
            MODULE.os.environ,
            {MODULE.API_HASH_ENV: "a" * 32},
            clear=True,
        ):
            self.assertEqual(MODULE.require_api_hash(), "a" * 32)


if __name__ == "__main__":
    unittest.main()
