import email
import importlib.util
import pathlib
import sys
import unittest


SCRIPT_PATH = pathlib.Path(__file__).parents[1] / "scripts" / "trelio-email.py"
SPEC = importlib.util.spec_from_file_location("trelio_email", SCRIPT_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class TrelioEmailTests(unittest.TestCase):
    def test_message_text_prefers_plain_text(self):
        message = email.message_from_string(
            "Content-Type: multipart/alternative; boundary=x\n\n"
            "--x\nContent-Type: text/plain; charset=utf-8\n\nPlain body\n"
            "--x\nContent-Type: text/html; charset=utf-8\n\n<b>HTML body</b>\n--x--\n",
            policy=MODULE.default,
        )
        self.assertEqual(MODULE.message_text(message), "Plain body")

    def test_safe_filename_removes_parent_path(self):
        self.assertEqual(MODULE.safe_filename("../../secret.txt"), "secret.txt")

    def test_send_parser_does_not_confirm_implicitly(self):
        args = MODULE.build_parser().parse_args(
            ["send", "--account", "work", "--to", "a@example.com", "--subject", "Test"]
        )
        self.assertFalse(args.confirm)

    def test_broad_search_is_rejected(self):
        args = MODULE.build_parser().parse_args(["search", "--account", "work"])
        with self.assertRaisesRegex(MODULE.MailboxError, "at least one search filter"):
            MODULE.command_search(args)


if __name__ == "__main__":
    unittest.main()
