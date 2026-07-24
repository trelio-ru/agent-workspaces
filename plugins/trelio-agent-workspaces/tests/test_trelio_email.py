import email
import importlib.util
import pathlib
import sys
import unittest
from unittest import mock


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

    def test_default_policy_requires_confirmation(self):
        with mock.patch.object(MODULE, "email_policy_path", return_value=pathlib.Path("/missing/policy.json")):
            self.assertEqual(MODULE.load_email_policy("work"), {"sendMode": "confirm"})

    def test_read_only_policy_blocks_send_even_when_confirmed(self):
        args = MODULE.build_parser().parse_args(
            [
                "send",
                "--account",
                "work",
                "--to",
                "a@example.com",
                "--subject",
                "Test",
                "--confirm",
            ]
        )
        with mock.patch.object(MODULE, "load_email_policy", return_value={"sendMode": "read-only"}):
            with self.assertRaisesRegex(MODULE.MailboxError, "read-only"):
                MODULE.command_send(args)

    def test_autonomous_policy_does_not_require_confirm_flag(self):
        args = MODULE.build_parser().parse_args(
            ["send", "--account", "work", "--to", "a@example.com", "--subject", "Test"]
        )
        fake_account = MODULE.Account(
            name="work",
            email_address="person@example.com",
            display_name="",
            username="person@example.com",
            imap_host="imap.example.com",
            imap_port=993,
            smtp_host="smtp.example.com",
            smtp_port=465,
            smtp_security="ssl",
            credential_store="file",
        )
        smtp_client = mock.MagicMock()
        smtp_client.send_message.return_value = {}
        smtp_context = mock.MagicMock()
        smtp_context.__enter__.return_value = smtp_client
        with (
            mock.patch.object(MODULE, "load_email_policy", return_value={"sendMode": "autonomous"}),
            mock.patch.object(MODULE, "load_account", return_value=fake_account),
            mock.patch.object(MODULE, "smtp_connection", return_value=smtp_context),
        ):
            result = MODULE.command_send(args)

        self.assertTrue(result["sent"])
        self.assertEqual(result["policyMode"], "autonomous")

    def test_broad_search_is_rejected(self):
        args = MODULE.build_parser().parse_args(["search", "--account", "work"])
        with self.assertRaisesRegex(MODULE.MailboxError, "at least one search filter"):
            MODULE.command_search(args)

    def test_gmail_is_detected_by_address_or_transport_host(self):
        self.assertTrue(MODULE.is_gmail_account("person@gmail.com"))
        self.assertTrue(MODULE.is_gmail_account("person@company.example", "imap.gmail.com"))
        self.assertFalse(MODULE.is_gmail_account("person@example.com", "imap.example.com"))

    def test_gmail_app_password_spaces_are_removed_before_storage(self):
        account = MODULE.Account(
            name="gmail",
            email_address="person@gmail.com",
            display_name="Person",
            username="person@gmail.com",
            imap_host="imap.gmail.com",
            imap_port=993,
            smtp_host="smtp.gmail.com",
            smtp_port=465,
            smtp_security="ssl",
            credential_store="file",
        )
        self.assertEqual(
            MODULE.normalize_password_for_account(account, "abcd efgh ijkl mnop"),
            "abcdefghijklmnop",
        )

    def test_gmail_app_password_must_have_sixteen_characters(self):
        account = MODULE.Account(
            name="gmail",
            email_address="person@gmail.com",
            display_name="",
            username="person@gmail.com",
            imap_host="imap.gmail.com",
            imap_port=993,
            smtp_host="smtp.gmail.com",
            smtp_port=465,
            smtp_security="ssl",
            credential_store="file",
        )
        with self.assertRaisesRegex(MODULE.MailboxError, "exactly 16 characters"):
            MODULE.normalize_password_for_account(account, "too short")

    def test_non_gmail_password_whitespace_is_not_rewritten(self):
        account = MODULE.Account(
            name="custom",
            email_address="person@example.com",
            display_name="",
            username="person@example.com",
            imap_host="imap.example.com",
            imap_port=993,
            smtp_host="smtp.example.com",
            smtp_port=465,
            smtp_security="ssl",
            credential_store="file",
        )
        self.assertEqual(MODULE.normalize_password_for_account(account, " secret value "), " secret value ")

    def test_terminal_password_mode_remains_available_for_headless_use(self):
        account = MODULE.Account(
            name="work",
            email_address="person@example.com",
            display_name="",
            username="person@example.com",
            imap_host="imap.example.com",
            imap_port=993,
            smtp_host="smtp.example.com",
            smtp_port=465,
            smtp_security="ssl",
            credential_store="file",
        )
        with mock.patch.object(MODULE.getpass, "getpass", return_value="secret-value") as getpass_mock:
            self.assertEqual(MODULE.prompt_password(account, "terminal"), "secret-value")
        getpass_mock.assert_called_once()

    def test_macos_dialog_returns_secret_without_putting_it_in_process_arguments(self):
        completed = MODULE.subprocess.CompletedProcess(
            args=["osascript"],
            returncode=0,
            stdout="abcd efgh ijkl mnop\n",
            stderr="",
        )
        with (
            mock.patch.object(MODULE.shutil, "which", return_value="/usr/bin/osascript"),
            mock.patch.object(MODULE.subprocess, "run", return_value=completed) as run_mock,
        ):
            password = MODULE.prompt_password_macos("Title", "Prompt")

        self.assertEqual(password, "abcd efgh ijkl mnop")
        process_arguments = run_mock.call_args.args[0]
        self.assertNotIn(password, process_arguments)

    def test_windows_dialog_returns_secret_without_putting_it_in_process_arguments(self):
        completed = MODULE.subprocess.CompletedProcess(
            args=["powershell.exe"],
            returncode=0,
            stdout="abcd efgh ijkl mnop",
            stderr="",
        )
        with (
            mock.patch.object(MODULE.shutil, "which", return_value="C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"),
            mock.patch.object(MODULE.subprocess, "run", return_value=completed) as run_mock,
        ):
            password = MODULE.prompt_password_windows("Title", "Prompt")

        self.assertEqual(password, "abcd efgh ijkl mnop")
        process_arguments = run_mock.call_args.args[0]
        self.assertNotIn(password, process_arguments)

    def test_configure_uses_native_window_mode_by_default(self):
        args = MODULE.build_parser().parse_args(["configure", "--account", "work"])
        self.assertEqual(args.password_input, "auto")

    def test_gmail_configure_persists_only_compact_password(self):
        args = MODULE.build_parser().parse_args(["configure", "--account", "gmail"])
        prompt_values = iter(
            [
                "person@gmail.com",
                "person@gmail.com",
                "Person",
                "imap.gmail.com",
                "993",
                "smtp.gmail.com",
                "ssl",
                "465",
            ]
        )
        with (
            mock.patch.object(MODULE, "load_raw_config", side_effect=[{"accounts": {}}, {"accounts": {}}]),
            mock.patch.object(MODULE, "prompt", side_effect=lambda *_args: next(prompt_values)),
            mock.patch.object(MODULE, "prompt_password", return_value="abcd efgh ijkl mnop"),
            mock.patch.object(MODULE, "store_password", return_value="keychain") as store_password_mock,
            mock.patch.object(MODULE, "write_raw_config") as write_config_mock,
        ):
            result = MODULE.command_configure(args)

        stored_account, stored_password = store_password_mock.call_args.args
        self.assertEqual(stored_account.email_address, "person@gmail.com")
        self.assertEqual(stored_password, "abcdefghijklmnop")
        self.assertEqual(result["appPasswordUrl"], MODULE.GOOGLE_APP_PASSWORDS_URL)
        write_config_mock.assert_called_once()


if __name__ == "__main__":
    unittest.main()
