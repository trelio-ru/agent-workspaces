#!/usr/bin/env python3
"""Private local Telegram MTProto runtime for the Trelio skill catalog.

The company-wide ``api_hash`` is accepted only through a short-lived
environment variable delivered by an Agent Secret checkout grant. Personal
authorization state is stored outside workspaces in a stable
skill/company/member/connection namespace.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import contextlib
import getpass
import http.server
import io
import json
import os
import re
import secrets
import subprocess
import sys
import threading
import time
import urllib.parse
import venv
import webbrowser
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator, Sequence


SKILL_ID = "telegram-mtproto"
API_HASH_ENV = "TRELIO_TELEGRAM_API_HASH"
RUNTIME_VERSION = "1"
POLICY_MODES = ("confirm", "autonomous", "read-only")
MAX_MESSAGE_CHARS = 4096
# Telegram already bounds ordinary messages, but keeping explicit output caps
# makes the JSON contract safe even when a future MTProto object or test double
# contains unexpectedly large values.
MAX_READ_TEXT_CHARS = 16_384
MAX_REPLY_TEXT_CHARS = 4_096
MAX_ENTITY_TITLE_CHARS = 256
MAX_ENTITY_USERNAME_CHARS = 64
MAX_FILE_NAME_CHARS = 512
MAX_LINK_ENTITIES = 32
MAX_LINK_TEXT_CHARS = 512
MAX_LINK_URL_CHARS = 2_048
MAX_REPLY_RESOLUTION_CONCURRENCY = 8
DEFAULT_QR_LOGIN_TIMEOUT_SECONDS = 300
DEFAULT_QR_REFRESH_SECONDS = 25
MAX_PROMPT_BODY_BYTES = 4_096
LOGIN_METHOD_CODE = "code"
LOGIN_METHOD_QR = "qr"
BROWSER_PROMPT_SESSION: "BrowserPromptSession | None" = None


class TelegramRuntimeError(RuntimeError):
    """Expected, user-safe configuration or protocol error."""


class PromptCancelled(TelegramRuntimeError):
    """Raised when the user intentionally cancels a local login prompt."""


class BrowserPromptUnavailable(TelegramRuntimeError):
    """Raised when a protected local browser prompt cannot be delivered."""


@dataclass(frozen=True)
class Identity:
    company_id: str
    member_id: str
    connection_id: str


def default_config_home() -> Path:
    override = os.environ.get("TRELIO_CONFIG_HOME")
    if override:
        return Path(override).expanduser()
    if os.name == "nt":
        return Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "Trelio"
    return Path.home() / ".config" / "trelio"


def default_cache_home() -> Path:
    override = os.environ.get("TRELIO_CACHE_HOME")
    if override:
        return Path(override).expanduser()
    if os.name == "nt":
        return Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "Trelio" / "cache"
    return Path.home() / ".cache" / "trelio"


def normalize_identity_part(value: str, label: str) -> str:
    normalized = value.strip().lower()
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,127}", normalized):
        raise TelegramRuntimeError(f"{label} must contain only lowercase letters, digits and hyphens.")
    return normalized


def identity_from_args(args: argparse.Namespace) -> Identity:
    return Identity(
        company_id=normalize_identity_part(args.company_id, "company-id"),
        member_id=normalize_identity_part(args.member_id, "member-id"),
        connection_id=normalize_identity_part(args.connection_id, "connection-id"),
    )


def connection_root(identity: Identity) -> Path:
    return (
        default_config_home()
        / "integrations"
        / SKILL_ID
        / identity.company_id
        / identity.member_id
        / identity.connection_id
    )


def runtime_root() -> Path:
    return default_cache_home() / "runtimes" / SKILL_ID / RUNTIME_VERSION


def runtime_python() -> Path:
    if os.name == "nt":
        return runtime_root() / "Scripts" / "python.exe"
    return runtime_root() / "bin" / "python"


def ensure_private_directory(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    if os.name == "posix":
        path.chmod(0o700)


def ensure_private_file(path: Path) -> None:
    if not path.exists() or os.name != "posix":
        return
    mode = path.stat().st_mode & 0o777
    if mode & 0o077:
        raise TelegramRuntimeError(f"Unsafe permissions on {path}: expected 600, got {mode:o}.")


def write_private_json(path: Path, value: dict[str, Any]) -> None:
    ensure_private_directory(path.parent)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if os.name == "posix":
        temporary.chmod(0o600)
    temporary.replace(path)


def policy_path(identity: Identity) -> Path:
    return connection_root(identity) / "config" / "policy.json"


def load_policy(identity: Identity) -> dict[str, Any]:
    path = policy_path(identity)
    if not path.exists():
        return {"sendMode": "confirm"}
    ensure_private_file(path)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise TelegramRuntimeError(f"Cannot read local policy {path}: {error}") from error
    mode = data.get("sendMode")
    if mode not in POLICY_MODES:
        raise TelegramRuntimeError(f"Local policy {path} has an unsupported sendMode.")
    return {"sendMode": mode}


def assert_send_allowed(
    identity: Identity,
    *,
    confirmed: bool,
    company_allows_autonomous: bool,
) -> str:
    mode = str(load_policy(identity)["sendMode"])
    if mode == "read-only":
        raise TelegramRuntimeError("Local Telegram policy is read-only; sending is disabled.")
    if mode == "autonomous" and not company_allows_autonomous:
        raise TelegramRuntimeError("The company connection forbids autonomous Telegram sending.")
    if mode == "confirm" and not confirmed:
        raise TelegramRuntimeError("Telegram send requires --confirm in local confirm mode.")
    return mode


@contextlib.contextmanager
def session_lock(identity: Identity) -> Iterator[None]:
    """Serialize one local MTProto session without storing lock data in a Run."""

    lock_dir = connection_root(identity) / "locks"
    ensure_private_directory(lock_dir)
    lock_path = lock_dir / "session.lock"
    lock_file = lock_path.open("a+b")
    try:
        if os.name == "nt":
            import msvcrt

            try:
                msvcrt.locking(lock_file.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError as error:
                raise TelegramRuntimeError("This Telegram session is already used by another process.") from error
        else:
            import fcntl

            try:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as error:
                raise TelegramRuntimeError("This Telegram session is already used by another process.") from error
        yield
    finally:
        if os.name == "nt":
            with contextlib.suppress(OSError):
                msvcrt.locking(lock_file.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            with contextlib.suppress(OSError):
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
        lock_file.close()


def browser_prompt_app_page() -> bytes:
    """Render the self-contained local login page without external assets."""

    return """<!doctype html>
<html lang="ru">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Trelio Telegram</title>
<style>
  :root { color-scheme: light; }
  body {
    margin: 0;
    min-height: 100vh;
    display: grid;
    place-items: center;
    background: #eef0f2;
    color: #202124;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  main {
    width: min(620px, calc(100vw - 32px));
    box-sizing: border-box;
    background: #fff;
    border: 1px solid #d9dce1;
    border-radius: 12px;
    box-shadow: 0 18px 48px rgba(0,0,0,.18);
    padding: 24px;
  }
  h1 { margin: 0 0 16px; font-size: 20px; line-height: 1.35; font-weight: 650; }
  form { display: grid; gap: 14px; }
  input {
    box-sizing: border-box;
    width: 100%;
    min-height: 44px;
    border: 2px solid #1a73e8;
    border-radius: 8px;
    padding: 8px 10px;
    color: #202124;
    background: #fff;
    font-size: 18px;
  }
  input:focus { outline: 3px solid rgba(26,115,232,.2); }
  .actions { display: flex; justify-content: flex-end; gap: 10px; flex-wrap: wrap; }
  button {
    min-width: 120px;
    min-height: 40px;
    border: 1px solid #c9cdd3;
    border-radius: 8px;
    background: #eef0f2;
    color: #202124;
    font-size: 16px;
    cursor: pointer;
  }
  button.primary { border-color: #1a73e8; background: #1a73e8; color: #fff; }
  .error { margin: 0 0 12px; color: #b00020; font-size: 14px; }
  .muted { margin: 0; color: #5f6368; line-height: 1.45; }
  .small { margin: 10px 0 0; color: #5f6368; font-size: 14px; line-height: 1.4; }
  .qr-wrap { display: grid; place-items: center; margin: 4px 0 16px; }
  .qr {
    width: min(72vw, 440px);
    height: auto;
    image-rendering: pixelated;
    background: #fff;
    padding: 18px;
    border: 1px solid #d9dce1;
    border-radius: 8px;
  }
</style>
<main id="app">
  <h1>Trelio Telegram</h1>
  <p class="muted">Жду следующий шаг входа…</p>
</main>
<script>
const app = document.getElementById("app");
let currentPromptId = null;
let polling = true;

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderWaiting() {
  currentPromptId = null;
  app.innerHTML = `<h1>Trelio Telegram</h1><p class="muted">Жду следующий шаг входа…</p>`;
}

function renderFinished(data) {
  currentPromptId = null;
  polling = false;
  app.innerHTML = `<h1>${escapeHtml(data.title || "Готово")}</h1>
    <p class="muted">${escapeHtml(data.message || "Можно закрыть вкладку и вернуться в Codex.")}</p>`;
}

function renderQr(data) {
  currentPromptId = "qr";
  const seconds = data.expires_in
    ? `<p class="small">QR обновится автоматически. Осталось примерно ${escapeHtml(data.expires_in)} сек.</p>`
    : "";
  app.innerHTML = `<h1>${escapeHtml(data.title || "Вход по QR-коду Telegram")}</h1>
    <div class="qr-wrap"><img class="qr" alt="Telegram QR" src="${escapeHtml(data.image_data_url)}"></div>
    <p class="muted">Telegram: Настройки → Устройства → Подключить устройство</p>
    <p class="small">Сканируйте QR только из приложения Telegram. Не пересылайте и не фотографируйте эту страницу.</p>
    ${seconds}`;
}

function renderPrompt(data) {
  currentPromptId = data.id;
  const error = data.error ? `<p class="error">${escapeHtml(data.error)}</p>` : "";
  const cancelLabel = escapeHtml(data.cancel_label || "Отмена");
  let controls = "";
  if (data.choices && data.choices.length) {
    controls = `<div class="actions">
      <button type="button" data-cancel="1">${cancelLabel}</button>
      ${data.choices.map(([value, label]) =>
        `<button class="primary" type="submit" name="choice" value="${escapeHtml(value)}">${escapeHtml(label)}</button>`
      ).join("")}
    </div>`;
  } else {
    const inputType = data.hidden ? "password" : "text";
    const required = data.allow_empty ? "" : "required";
    const autocomplete = data.hidden ? "one-time-code" : "tel";
    controls = `<input autofocus name="value" type="${inputType}" autocomplete="${autocomplete}" ${required}>
      <div class="actions">
        <button type="button" data-cancel="1">${cancelLabel}</button>
        <button class="primary" type="submit">Продолжить</button>
      </div>`;
  }
  app.innerHTML = `<h1>${escapeHtml(data.prompt)}</h1>${error}<form id="prompt-form">${controls}</form>`;
  const form = document.getElementById("prompt-form");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitter = event.submitter;
    const formData = new FormData(form);
    if (submitter && submitter.name) formData.set(submitter.name, submitter.value);
    formData.set("id", String(data.id));
    await submitPrompt(data, formData);
  });
  const cancelButton = form.querySelector("[data-cancel]");
  if (cancelButton) {
    cancelButton.addEventListener("click", async () => {
      const formData = new FormData();
      formData.set("id", String(data.id));
      formData.set("cancel", "1");
      await submitPrompt(data, formData);
    });
  }
  const input = form.querySelector("input");
  if (input) input.focus();
}

async function submitPrompt(data, formData) {
  const response = await fetch("submit", {
    method: "POST",
    headers: {"Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"},
    body: new URLSearchParams(formData),
    cache: "no-store",
  });
  const payload = await response.json();
  if (!payload.ok && payload.error) {
    data.error = payload.error;
    renderPrompt(data);
    return;
  }
  renderWaiting();
}

async function poll() {
  try {
    const response = await fetch("state?t=" + Date.now(), {cache: "no-store"});
    const data = await response.json();
    if (data.status === "prompt") {
      if (data.id !== currentPromptId) renderPrompt(data);
    } else if (data.status === "qr") {
      renderQr(data);
    } else if (data.status === "finished") {
      renderFinished(data);
      return;
    } else if (currentPromptId !== null) {
      renderWaiting();
    }
  } catch (_error) {
    polling = false;
    app.innerHTML = `<h1>Локальная страница закрыта</h1>
      <p class="muted">Вернитесь в Codex и при необходимости запустите вход заново.</p>`;
  } finally {
    if (polling) setTimeout(poll, 350);
  }
}

poll();
</script>
""".encode("utf-8")


def open_browser_url(url: str) -> None:
    """Open one loopback URL without leaking it into process output."""

    if sys.platform == "darwin":
        try:
            completed = subprocess.run(
                ["/usr/bin/open", url],
                check=False,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=10,
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            raise BrowserPromptUnavailable("Cannot open the protected local Telegram login page.") from error
        if completed.returncode != 0:
            raise BrowserPromptUnavailable("Cannot open the protected local Telegram login page.")
        return

    if sys.platform.startswith("win"):
        try:
            startfile = getattr(os, "startfile", None)
            if startfile is None:
                raise OSError("Windows shell opener is unavailable")
            startfile(url)
            return
        except OSError as error:
            raise BrowserPromptUnavailable(
                "Cannot open the protected local Telegram login page."
            ) from error

    try:
        if not webbrowser.open(url, new=2):
            raise BrowserPromptUnavailable("Cannot open the protected local Telegram login page.")
    except webbrowser.Error as error:
        raise BrowserPromptUnavailable("Cannot open the protected local Telegram login page.") from error


class BrowserPromptSession:
    """Serve one tokenized loopback page for a single login process."""

    def __init__(self) -> None:
        self.token = secrets.token_urlsafe(32)
        self.condition = threading.Condition()
        self.page_loaded = threading.Event()
        self.current_prompt: dict[str, Any] | None = None
        self.current_qr: dict[str, Any] | None = None
        self.response: dict[str, Any] | None = None
        self.finished: dict[str, str] | None = None
        self.next_prompt_id = 0
        self.opened = False
        try:
            self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), self._handler_class())
        except OSError as error:
            raise BrowserPromptUnavailable(
                "The protected Telegram login page cannot bind to 127.0.0.1."
            ) from error
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    @property
    def port(self) -> int:
        return int(self.server.server_address[1])

    @property
    def origin(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    @property
    def base_path(self) -> str:
        return f"/{self.token}"

    @property
    def url(self) -> str:
        return f"{self.origin}{self.base_path}/"

    def _handler_class(self) -> Any:
        session = self

        class PromptHandler(http.server.BaseHTTPRequestHandler):
            server_version = "TrelioLoopback/1"
            sys_version = ""

            def log_message(self, _format: str, *_args: Any) -> None:
                return

            def end_headers(self) -> None:
                self.send_header("Cache-Control", "no-store")
                self.send_header("Pragma", "no-cache")
                self.send_header("Referrer-Policy", "no-referrer")
                self.send_header("X-Content-Type-Options", "nosniff")
                self.send_header("X-Frame-Options", "DENY")
                self.send_header("Cross-Origin-Resource-Policy", "same-origin")
                self.send_header(
                    "Content-Security-Policy",
                    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; "
                    "img-src data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'",
                )
                super().end_headers()

            def send_bytes(self, body: bytes, content_type: str, status: int = 200) -> None:
                self.send_response(status)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.write(body)
                self.close_connection = True

            def send_json(self, payload: dict[str, Any], status: int = 200) -> None:
                self.send_bytes(
                    json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                    "application/json; charset=utf-8",
                    status,
                )

            def request_is_local(self) -> bool:
                return (
                    self.client_address[0] == "127.0.0.1"
                    and self.headers.get("Host") == f"127.0.0.1:{session.port}"
                )

            def prompt_subpath(self) -> str | None:
                path = urllib.parse.urlparse(self.path).path
                if path == session.base_path:
                    return "/"
                prefix = session.base_path + "/"
                if not path.startswith(prefix):
                    return None
                return "/" + path[len(prefix):]

            def do_GET(self) -> None:  # noqa: N802 - stdlib callback name.
                if not self.request_is_local():
                    self.send_json({"ok": False, "error": "Forbidden."}, status=403)
                    return
                subpath = self.prompt_subpath()
                if subpath == "/":
                    session.page_loaded.set()
                    self.send_bytes(browser_prompt_app_page(), "text/html; charset=utf-8")
                    return
                if subpath == "/state":
                    with session.condition:
                        finished = dict(session.finished) if session.finished else None
                        qr = dict(session.current_qr) if session.current_qr else None
                        prompt = dict(session.current_prompt) if session.current_prompt else None
                    if finished:
                        self.send_json({"status": "finished", **finished})
                    elif qr:
                        self.send_json({"status": "qr", **qr})
                    elif prompt:
                        self.send_json({"status": "prompt", **prompt})
                    else:
                        self.send_json({"status": "waiting"})
                    return
                self.send_json({"ok": False, "error": "Not found."}, status=404)

            def do_POST(self) -> None:  # noqa: N802 - stdlib callback name.
                if not self.request_is_local() or self.prompt_subpath() != "/submit":
                    self.send_json({"ok": False, "error": "Forbidden."}, status=403)
                    return
                if self.headers.get("Origin") != session.origin:
                    self.send_json({"ok": False, "error": "Forbidden."}, status=403)
                    return
                content_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
                if content_type != "application/x-www-form-urlencoded":
                    self.send_json({"ok": False, "error": "Unsupported request."}, status=415)
                    return
                try:
                    length = int(self.headers.get("Content-Length", ""))
                except ValueError:
                    length = -1
                if length < 0 or length > MAX_PROMPT_BODY_BYTES:
                    self.send_json({"ok": False, "error": "Invalid request size."}, status=413)
                    return

                try:
                    raw_body = self.rfile.read(length).decode("utf-8", errors="strict")
                    fields = urllib.parse.parse_qs(
                        raw_body,
                        keep_blank_values=True,
                        max_num_fields=4,
                    )
                except (UnicodeError, ValueError):
                    self.send_json({"ok": False, "error": "Invalid request body."}, status=400)
                    return
                try:
                    prompt_id = int((fields.get("id") or [""])[0])
                except ValueError:
                    self.send_json({"ok": False, "error": "Этот шаг уже не актуален."}, status=409)
                    return

                with session.condition:
                    prompt = session.current_prompt
                    if not prompt or prompt["id"] != prompt_id:
                        self.send_json({"ok": False, "error": "Этот шаг уже не актуален."}, status=409)
                        return
                    if fields.get("cancel"):
                        session.response = {"cancelled": True}
                    else:
                        choices = prompt.get("choices") or []
                        if choices:
                            value = (fields.get("choice") or [""])[0]
                            allowed_values = {choice_value for choice_value, _label in choices}
                            if value not in allowed_values:
                                self.send_json(
                                    {"ok": False, "error": "Выберите один из вариантов."},
                                    status=400,
                                )
                                return
                        else:
                            value = (fields.get("value") or [""])[0].strip()
                            if not value and not prompt.get("allow_empty"):
                                self.send_json(
                                    {"ok": False, "error": "Нужно заполнить поле."},
                                    status=400,
                                )
                                return
                        session.response = {"cancelled": False, "value": value}
                    session.current_prompt = None
                    session.condition.notify_all()
                self.send_json({"ok": True})

        return PromptHandler

    def open(self) -> None:
        """Open the protected page and require the browser to fetch its exact URL."""

        if self.opened:
            return
        self.page_loaded.clear()
        open_browser_url(self.url)
        if not self.page_loaded.wait(timeout=8):
            raise BrowserPromptUnavailable(
                "The default browser did not load the protected local Telegram login page."
            )
        self.opened = True

    def ask(
        self,
        prompt: str,
        *,
        hidden: bool,
        allow_empty: bool = False,
        choices: Sequence[tuple[str, str]] | None = None,
        cancel_label: str = "Отмена",
    ) -> str:
        with self.condition:
            self.next_prompt_id += 1
            self.response = None
            self.finished = None
            self.current_qr = None
            self.current_prompt = {
                "id": self.next_prompt_id,
                "prompt": prompt,
                "hidden": hidden,
                "allow_empty": allow_empty,
                "choices": list(choices or []),
                "cancel_label": cancel_label,
                "error": "",
            }
            self.condition.notify_all()
        try:
            self.open()
        except BrowserPromptUnavailable:
            with self.condition:
                self.current_prompt = None
            raise

        with self.condition:
            while self.response is None:
                self.condition.wait()
            response = self.response
            self.response = None
        if response.get("cancelled"):
            raise PromptCancelled(f"Ввод отменён: {prompt}")
        return str(response.get("value") or "")

    def show_qr(self, *, image_data_url: str, expires_in: int) -> None:
        with self.condition:
            self.current_prompt = None
            self.finished = None
            self.current_qr = {
                "title": "Вход по QR-коду Telegram",
                "image_data_url": image_data_url,
                "expires_in": expires_in,
            }
            self.condition.notify_all()
        self.open()

    def clear_qr(self) -> None:
        with self.condition:
            self.current_qr = None
            self.condition.notify_all()

    def finish(self, *, title: str, message: str) -> None:
        with self.condition:
            self.current_prompt = None
            self.current_qr = None
            self.response = None
            self.finished = {"title": title, "message": message}
            self.condition.notify_all()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)


def ensure_browser_prompt_session() -> BrowserPromptSession:
    global BROWSER_PROMPT_SESSION
    if BROWSER_PROMPT_SESSION is None:
        BROWSER_PROMPT_SESSION = BrowserPromptSession()
    return BROWSER_PROMPT_SESSION


def shutdown_browser_prompt_session() -> None:
    global BROWSER_PROMPT_SESSION
    if BROWSER_PROMPT_SESSION is None:
        return
    BROWSER_PROMPT_SESSION.close()
    BROWSER_PROMPT_SESSION = None


def prompt_value_terminal(
    prompt: str,
    *,
    hidden: bool,
    allow_empty: bool = False,
    cancel_label: str = "Отмена",
) -> str:
    if not sys.stdin.isatty():
        raise BrowserPromptUnavailable(
            "The local browser login page is unavailable and no visible terminal is attached."
        )
    label = f"{prompt} (или {cancel_label}): "
    value = getpass.getpass(label) if hidden else input(label)
    value = value.strip()
    if value.casefold() == cancel_label.casefold():
        raise PromptCancelled(f"Ввод отменён: {prompt}")
    if not value and not allow_empty:
        raise TelegramRuntimeError(f"Нужно заполнить поле: {prompt}")
    return value


def prompt_choice_terminal(
    prompt: str,
    choices: Sequence[tuple[str, str]],
    *,
    cancel_label: str = "Отмена",
) -> str:
    if not sys.stdin.isatty():
        raise BrowserPromptUnavailable(
            "The local browser login page is unavailable and no visible terminal is attached."
        )
    print(prompt)
    for index, (_value, label) in enumerate(choices, start=1):
        print(f"  {index}. {label}")
    print(f"  0. {cancel_label}")
    while True:
        answer = input("Выбор: ").strip().casefold()
        if answer in {"0", "q", "quit", "cancel", "отмена", "назад"}:
            raise PromptCancelled(f"Ввод отменён: {prompt}")
        if answer.isdigit() and 1 <= int(answer) <= len(choices):
            return choices[int(answer) - 1][0]
        for value, label in choices:
            if answer in {value.casefold(), label.casefold()}:
                return value
        print("Введите номер варианта.")


def prompt_value(
    prompt: str,
    *,
    hidden: bool = False,
    allow_empty: bool = False,
    terminal_prompts: bool = False,
    cancel_label: str = "Отмена",
) -> str:
    if not terminal_prompts:
        try:
            return ensure_browser_prompt_session().ask(
                prompt,
                hidden=hidden,
                allow_empty=allow_empty,
                cancel_label=cancel_label,
            )
        except BrowserPromptUnavailable:
            pass
    return prompt_value_terminal(
        prompt,
        hidden=hidden,
        allow_empty=allow_empty,
        cancel_label=cancel_label,
    )


def prompt_choice(
    prompt: str,
    choices: Sequence[tuple[str, str]],
    *,
    terminal_prompts: bool = False,
    cancel_label: str = "Отмена",
) -> str:
    if not terminal_prompts:
        try:
            return ensure_browser_prompt_session().ask(
                prompt,
                hidden=False,
                choices=choices,
                cancel_label=cancel_label,
            )
        except BrowserPromptUnavailable:
            pass
    return prompt_choice_terminal(prompt, choices, cancel_label=cancel_label)


def command_bootstrap(_args: argparse.Namespace) -> dict[str, Any]:
    root = runtime_root()
    python = runtime_python()
    ensure_private_directory(root.parent)
    if not python.exists():
        venv.EnvBuilder(with_pip=True, clear=False).create(root)
    completed = subprocess.run(
        [
            str(python),
            "-m",
            "pip",
            "install",
            "--disable-pip-version-check",
            "telethon>=1.38,<2",
            "qrcode[pil]>=8,<9",
        ],
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if completed.returncode != 0:
        detail = completed.stderr.strip().splitlines()[-1] if completed.stderr.strip() else "pip failed"
        raise TelegramRuntimeError(f"Cannot install Telegram runtime: {detail}")
    return {"runtimeReady": True, "runtimePython": str(python)}


def reexec_in_runtime_if_needed(command: str) -> None:
    if command in {"bootstrap", "doctor", "policy"}:
        return
    python = runtime_python()
    current_prefix = Path(sys.prefix).resolve()
    expected_prefix = runtime_root().resolve()
    if current_prefix == expected_prefix:
        return
    if not python.exists():
        raise TelegramRuntimeError("Telegram runtime is not installed. Run bootstrap first.")
    os.execve(str(python), [str(python), str(Path(__file__).resolve()), *sys.argv[1:]], dict(os.environ))


def import_telethon():
    try:
        from telethon import TelegramClient
        from telethon.errors import SessionPasswordNeededError
    except ImportError as error:
        raise TelegramRuntimeError("Telethon is unavailable. Run bootstrap first.") from error
    return TelegramClient, SessionPasswordNeededError


def import_qrcode():
    """Load QR rendering only for QR login after bootstrap installed it."""

    try:
        import qrcode
        import PIL.Image  # noqa: F401 - validates the qrcode[pil] extra.
    except ImportError as error:
        raise TelegramRuntimeError(
            "Telegram QR dependencies are unavailable. Run bootstrap first."
        ) from error
    return qrcode


def session_path(identity: Identity) -> Path:
    state_dir = connection_root(identity) / "state"
    ensure_private_directory(state_dir)
    return state_dir / "telegram"


def require_api_hash() -> str:
    value = os.environ.get(API_HASH_ENV, "").strip()
    if not re.fullmatch(r"[a-f0-9]{32}", value, flags=re.IGNORECASE):
        raise TelegramRuntimeError(
            "Telegram api_hash was not delivered. Use an Agent Secret checkout grant; do not pass it in chat or argv."
        )
    return value


def build_client(args: argparse.Namespace, identity: Identity):
    TelegramClient, _ = import_telethon()
    return TelegramClient(
        str(session_path(identity)),
        int(args.api_id),
        require_api_hash(),
        device_model="Trelio Agent",
        system_version=sys.platform,
        app_version="1.0",
    )


async def ensure_authorized(client: Any) -> None:
    await client.connect()
    if not await client.is_user_authorized():
        raise TelegramRuntimeError("Local Telegram session is not authorized. Run login first.")


def login_method_for_args(args: argparse.Namespace) -> str:
    """Choose code or QR before Telegram sends any one-time credential."""

    if args.qr:
        return LOGIN_METHOD_QR
    if args.code:
        return LOGIN_METHOD_CODE
    return prompt_choice(
        "Как войти в Telegram на этом компьютере?",
        (
            (LOGIN_METHOD_CODE, "Код Telegram"),
            (LOGIN_METHOD_QR, "QR-код"),
        ),
        terminal_prompts=args.terminal_prompts,
    )


async def authorize_with_code_login(
    client: Any,
    args: argparse.Namespace,
    SessionPasswordNeededError: Any,
) -> None:
    phone = prompt_value(
        "Телефон Telegram с кодом страны",
        terminal_prompts=args.terminal_prompts,
        cancel_label="Назад",
    )
    sent = await client.send_code_request(phone)
    code = prompt_value(
        "Код входа Telegram",
        hidden=True,
        terminal_prompts=args.terminal_prompts,
        cancel_label="Назад",
    ).replace(" ", "")
    try:
        await client.sign_in(
            phone=phone,
            code=code,
            phone_code_hash=sent.phone_code_hash,
        )
    except SessionPasswordNeededError:
        password = prompt_value(
            "Пароль 2FA Telegram",
            hidden=True,
            terminal_prompts=args.terminal_prompts,
            cancel_label="Назад",
        )
        await client.sign_in(password=password)


def qr_image_data_url(qrcode_module: Any, url: str) -> str:
    """Render the short-lived Telegram login URL without writing it to disk."""

    qr_image = qrcode_module.QRCode(border=3, box_size=14)
    qr_image.add_data(url)
    qr_image.make(fit=True)
    rendered = qr_image.make_image(fill_color="black", back_color="white")
    buffer = io.BytesIO()
    rendered.save(buffer, format="PNG")
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    return f"data:image/png;base64,{encoded}"


def terminal_qr_ascii(qrcode_module: Any, url: str) -> str:
    qr_image = qrcode_module.QRCode(border=2)
    qr_image.add_data(url)
    qr_image.make(fit=True)
    output = io.StringIO()
    qr_image.print_ascii(out=output, invert=True)
    return output.getvalue()


async def authorize_with_qr_login(
    client: Any,
    args: argparse.Namespace,
    SessionPasswordNeededError: Any,
) -> None:
    qrcode_module = import_qrcode()
    use_browser = not args.terminal_prompts
    loop = asyncio.get_running_loop()
    deadline = loop.time() + args.qr_timeout
    qr_login = await client.qr_login()

    while loop.time() < deadline:
        expires_in = max(
            1,
            int(qr_login.expires.timestamp() - time.time()),
        )
        if use_browser:
            try:
                ensure_browser_prompt_session().show_qr(
                    image_data_url=qr_image_data_url(qrcode_module, qr_login.url),
                    expires_in=expires_in,
                )
            except BrowserPromptUnavailable:
                use_browser = False
        if not use_browser:
            if not sys.stdin.isatty():
                raise BrowserPromptUnavailable(
                    "The local browser login page is unavailable and no visible terminal is attached."
                )
            print(terminal_qr_ascii(qrcode_module, qr_login.url))
            print("Telegram: Настройки → Устройства → Подключить устройство")

        wait_for = min(
            max(1, expires_in - 2),
            max(1, args.qr_refresh_seconds),
            max(1, int(deadline - loop.time())),
        )
        try:
            await asyncio.wait_for(qr_login.wait(), timeout=wait_for)
            if BROWSER_PROMPT_SESSION is not None:
                BROWSER_PROMPT_SESSION.clear_qr()
            return
        except SessionPasswordNeededError:
            if BROWSER_PROMPT_SESSION is not None:
                BROWSER_PROMPT_SESSION.clear_qr()
            password = prompt_value(
                "Пароль 2FA Telegram",
                hidden=True,
                terminal_prompts=args.terminal_prompts,
                cancel_label="Назад" if not args.qr else "Отмена",
            )
            await client.sign_in(password=password)
            return
        except asyncio.TimeoutError:
            if loop.time() >= deadline:
                break
            await qr_login.recreate()

    raise TelegramRuntimeError(
        "Время входа по QR истекло. Запустите login ещё раз и отсканируйте новый код."
    )


async def command_login_async(args: argparse.Namespace, identity: Identity) -> dict[str, Any]:
    _, SessionPasswordNeededError = import_telethon()
    client = build_client(args, identity)
    await client.connect()
    try:
        if not await client.is_user_authorized():
            while True:
                method = login_method_for_args(args)
                try:
                    if method == LOGIN_METHOD_QR:
                        await authorize_with_qr_login(client, args, SessionPasswordNeededError)
                    else:
                        await authorize_with_code_login(client, args, SessionPasswordNeededError)
                    break
                except PromptCancelled:
                    if args.qr or args.code:
                        raise
                    continue
        me = await client.get_me()
        session_file = session_path(identity).with_suffix(".session")
        if session_file.exists() and os.name == "posix":
            session_file.chmod(0o600)
        if BROWSER_PROMPT_SESSION is not None:
            BROWSER_PROMPT_SESSION.finish(
                title="Telegram подключён",
                message="Личная авторизация сохранена. Можно закрыть вкладку и вернуться в Codex.",
            )
            await asyncio.sleep(0.7)
        return {"authorized": True, "userId": me.id, "username": me.username}
    except TelegramRuntimeError:
        raise
    except Exception as error:
        # Telethon exceptions may contain transport or RPC details that are not
        # part of the agent-visible contract. Keep the local UI actionable while
        # returning only a stable, secret-free category to Codex.
        raise TelegramRuntimeError(
            "Telegram не завершил вход. Проверьте данные или соединение и запустите login заново."
        ) from error
    finally:
        await client.disconnect()


def bounded_string(value: Any, limit: int) -> tuple[str, bool]:
    """Return a JSON-safe bounded string without leaking object structure."""

    if value is None:
        text = ""
    elif isinstance(value, str):
        text = value
    else:
        text = str(value)
    return text[:limit], len(text) > limit


def optional_bounded_string(value: Any, limit: int) -> str | None:
    if value is None:
        return None
    text, _ = bounded_string(value, limit)
    return text or None


def public_entity(entity: Any) -> dict[str, Any]:
    """Allowlist the public identity fields used by the CLI JSON contract.

    Telethon entities also contain phone numbers, access hashes and raw peer
    structures. Reading individual known scalar attributes instead of dumping
    the MTProto object keeps all of that state outside agent-visible output.
    """

    raw_id = getattr(entity, "id", None)
    entity_id = raw_id if isinstance(raw_id, int) and not isinstance(raw_id, bool) else None
    title = (
        optional_bounded_string(getattr(entity, "title", None), MAX_ENTITY_TITLE_CHARS)
        or optional_bounded_string(
            " ".join(
                filter(
                    None,
                    [
                        optional_bounded_string(
                            getattr(entity, "first_name", None),
                            MAX_ENTITY_TITLE_CHARS,
                        ),
                        optional_bounded_string(
                            getattr(entity, "last_name", None),
                            MAX_ENTITY_TITLE_CHARS,
                        ),
                    ],
                )
            ),
            MAX_ENTITY_TITLE_CHARS,
        )
        or optional_bounded_string(
            getattr(entity, "username", None),
            MAX_ENTITY_TITLE_CHARS,
        )
    )
    return {
        "id": entity_id,
        "title": title,
        "username": optional_bounded_string(
            getattr(entity, "username", None),
            MAX_ENTITY_USERNAME_CHARS,
        ),
    }


def utf16_slice(text: str, offset: int, length: int) -> str:
    """Slice Telegram entity offsets, which are measured in UTF-16 units."""

    encoded = text.encode("utf-16-le", errors="surrogatepass")
    start = min(offset * 2, len(encoded))
    end = min((offset + length) * 2, len(encoded))
    return encoded[start:end].decode("utf-16-le", errors="replace")


def public_link_entities(
    text: str,
    entities: Any,
) -> tuple[list[dict[str, Any]], bool]:
    """Normalize only URL-bearing Telegram entities.

    The class-name allowlist is intentionally narrow. Other MTProto entity
    variants may carry mentions, custom emoji document ids or future fields
    that are not part of this read-only contract.
    """

    if not isinstance(entities, (list, tuple)):
        return [], False

    result: list[dict[str, Any]] = []
    supported_seen = 0
    for entity in entities:
        class_name = type(entity).__name__
        if class_name not in {"MessageEntityUrl", "MessageEntityTextUrl"}:
            continue
        supported_seen += 1
        if len(result) >= MAX_LINK_ENTITIES:
            continue

        offset = getattr(entity, "offset", None)
        length = getattr(entity, "length", None)
        if (
            not isinstance(offset, int)
            or isinstance(offset, bool)
            or not isinstance(length, int)
            or isinstance(length, bool)
            or offset < 0
            or length <= 0
        ):
            continue

        entity_text, text_truncated = bounded_string(
            utf16_slice(text, offset, length),
            MAX_LINK_TEXT_CHARS,
        )
        raw_url = (
            entity_text
            if class_name == "MessageEntityUrl"
            else getattr(entity, "url", None)
        )
        if not isinstance(raw_url, str) or not raw_url:
            continue
        url, url_truncated = bounded_string(raw_url, MAX_LINK_URL_CHARS)
        result.append({
            "type": "url" if class_name == "MessageEntityUrl" else "text_url",
            "offset": offset,
            "length": length,
            "text": entity_text,
            "url": url,
            "textTruncated": text_truncated,
            "urlTruncated": url_truncated,
        })

    return result, supported_seen > len(result)


async def optional_message_entity(message: Any, attribute: str, getter_name: str) -> Any | None:
    """Resolve sender/chat best-effort without exposing Telegram diagnostics."""

    entity = getattr(message, attribute, None)
    if entity is not None:
        return entity
    getter = getattr(message, getter_name, None)
    if not callable(getter):
        return None
    try:
        return await getter()
    except Exception:
        # Missing/deleted peers must not make an otherwise readable message
        # fail, and raw RPC diagnostics do not belong in normalized output.
        return None


async def public_reply_context(message: Any, current_chat: Any) -> dict[str, Any] | None:
    """Resolve one direct reply only; never recurse into the quoted message."""

    reply_header = getattr(message, "reply_to", None)
    reply_message_id = getattr(message, "reply_to_msg_id", None)
    if reply_message_id is None and reply_header is not None:
        reply_message_id = getattr(reply_header, "reply_to_msg_id", None)
    if (
        not isinstance(reply_message_id, int)
        or isinstance(reply_message_id, bool)
        or reply_message_id <= 0
    ):
        return None

    quote_text, quote_text_truncated = bounded_string(
        getattr(reply_header, "quote_text", None),
        MAX_REPLY_TEXT_CHARS,
    )
    quote_entities, quote_entities_truncated = public_link_entities(
        quote_text,
        getattr(reply_header, "quote_entities", None),
    )

    reply_message = None
    get_reply_message = getattr(message, "get_reply_message", None)
    if callable(get_reply_message):
        try:
            reply_message = await get_reply_message()
        except Exception:
            # A deleted message, an inaccessible cross-chat reply and a
            # transient MTProto lookup failure intentionally collapse to the
            # same non-sensitive unavailable state.
            reply_message = None

    if reply_message is None:
        return {
            "messageId": reply_message_id,
            "unavailable": True,
            "author": None,
            "chat": (
                None
                if getattr(reply_header, "reply_to_peer_id", None) is not None
                else public_entity(current_chat)
            ),
            "text": quote_text,
            "textTruncated": quote_text_truncated,
            "linkEntities": quote_entities,
            "linkEntitiesTruncated": quote_entities_truncated,
            "quoteText": quote_text or None,
            "quoteTextTruncated": quote_text_truncated,
            "quoteLinkEntities": quote_entities,
            "quoteLinkEntitiesTruncated": quote_entities_truncated,
        }

    sender = await optional_message_entity(reply_message, "sender", "get_sender")
    reply_chat = await optional_message_entity(reply_message, "chat", "get_chat")
    if reply_chat is None and getattr(reply_header, "reply_to_peer_id", None) is None:
        reply_chat = current_chat

    reply_text, reply_text_truncated = bounded_string(
        getattr(reply_message, "message", None),
        MAX_REPLY_TEXT_CHARS,
    )
    reply_entities, reply_entities_truncated = public_link_entities(
        reply_text,
        getattr(reply_message, "entities", None),
    )
    return {
        "messageId": reply_message_id,
        "unavailable": False,
        "author": public_entity(sender) if sender is not None else None,
        "chat": public_entity(reply_chat) if reply_chat is not None else None,
        "text": reply_text,
        "textTruncated": reply_text_truncated,
        "linkEntities": reply_entities,
        "linkEntitiesTruncated": reply_entities_truncated,
        "quoteText": quote_text or None,
        "quoteTextTruncated": quote_text_truncated,
        "quoteLinkEntities": quote_entities,
        "quoteLinkEntitiesTruncated": quote_entities_truncated,
    }


def public_message(
    message: Any,
    *,
    reply_context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    sender = getattr(message, "sender", None)
    text, text_truncated = bounded_string(
        getattr(message, "message", None),
        MAX_READ_TEXT_CHARS,
    )
    link_entities, link_entities_truncated = public_link_entities(
        text,
        getattr(message, "entities", None),
    )
    raw_file_size = getattr(getattr(message, "file", None), "size", None)
    file_size = (
        raw_file_size
        if isinstance(raw_file_size, int)
        and not isinstance(raw_file_size, bool)
        and raw_file_size >= 0
        else None
    )
    return {
        "id": message.id,
        "date": message.date.isoformat() if message.date else None,
        "outgoing": bool(message.out),
        "sender": public_entity(sender) if sender else None,
        "text": text,
        "textTruncated": text_truncated,
        "hasMedia": message.media is not None,
        "fileName": optional_bounded_string(
            getattr(getattr(message, "file", None), "name", None),
            MAX_FILE_NAME_CHARS,
        ),
        "fileSize": file_size,
        "linkEntities": link_entities,
        "linkEntitiesTruncated": link_entities_truncated,
        "replyContext": reply_context,
    }


async def public_messages(messages: list[Any], current_chat: Any) -> list[dict[str, Any]]:
    """Serialize a bounded page while limiting concurrent reply lookups."""

    semaphore = asyncio.Semaphore(MAX_REPLY_RESOLUTION_CONCURRENCY)

    async def serialize(message: Any) -> dict[str, Any]:
        async with semaphore:
            reply_context = await public_reply_context(message, current_chat)
        return public_message(message, reply_context=reply_context)

    return list(await asyncio.gather(*(serialize(message) for message in messages)))


async def resolve_entity(client: Any, reference: str):
    value = reference.strip()
    if not value:
        raise TelegramRuntimeError("Chat reference is required.")
    try:
        return await client.get_entity(int(value) if re.fullmatch(r"-?\d+", value) else value)
    except (ValueError, TypeError) as error:
        raise TelegramRuntimeError(f"Cannot resolve Telegram chat {reference!r}.") from error


async def command_dialogs_async(args: argparse.Namespace, identity: Identity) -> dict[str, Any]:
    client = build_client(args, identity)
    await ensure_authorized(client)
    try:
        query = (args.query or "").casefold()
        dialogs = []
        async for dialog in client.iter_dialogs(limit=min(args.limit * 5, 500)):
            title = str(dialog.name or "")
            if query and query not in title.casefold():
                continue
            dialogs.append({
                "id": dialog.id,
                "title": title,
                "unreadCount": dialog.unread_count,
                "entity": public_entity(dialog.entity),
            })
            if len(dialogs) >= args.limit:
                break
        return {"dialogs": dialogs}
    finally:
        await client.disconnect()


async def command_read_async(args: argparse.Namespace, identity: Identity) -> dict[str, Any]:
    client = build_client(args, identity)
    await ensure_authorized(client)
    try:
        entity = await resolve_entity(client, args.chat)
        raw_messages = [item async for item in client.iter_messages(entity, limit=args.limit)]
        messages = await public_messages(raw_messages, entity)
        return {"chat": public_entity(entity), "messages": messages}
    finally:
        await client.disconnect()


async def command_search_async(args: argparse.Namespace, identity: Identity) -> dict[str, Any]:
    client = build_client(args, identity)
    await ensure_authorized(client)
    try:
        entity = await resolve_entity(client, args.chat)
        raw_messages = [
            item async for item in client.iter_messages(entity, search=args.query, limit=args.limit)
        ]
        messages = await public_messages(raw_messages, entity)
        return {"chat": public_entity(entity), "query": args.query, "messages": messages}
    finally:
        await client.disconnect()


async def command_download_async(args: argparse.Namespace, identity: Identity) -> dict[str, Any]:
    client = build_client(args, identity)
    await ensure_authorized(client)
    try:
        entity = await resolve_entity(client, args.chat)
        message = await client.get_messages(entity, ids=args.message_id)
        if not message or not message.media:
            raise TelegramRuntimeError("The selected Telegram message has no downloadable media.")
        output = Path(args.output).expanduser().resolve()
        ensure_private_directory(output)
        downloaded = await client.download_media(message, file=str(output))
        if not downloaded:
            raise TelegramRuntimeError("Telegram did not return a downloaded file.")
        return {"chat": public_entity(entity), "messageId": message.id, "path": str(Path(downloaded).resolve())}
    finally:
        await client.disconnect()


def outgoing_text(args: argparse.Namespace) -> str:
    if args.message_file:
        path = Path(args.message_file).expanduser().resolve()
        ensure_private_file(path)
        text = path.read_text(encoding="utf-8")
    else:
        text = args.message or ""
    if len(text) > MAX_MESSAGE_CHARS:
        raise TelegramRuntimeError(f"Telegram text exceeds {MAX_MESSAGE_CHARS} characters.")
    if not text and not args.file:
        raise TelegramRuntimeError("send requires --message, --message-file or --file.")
    return text


async def command_send_async(args: argparse.Namespace, identity: Identity) -> dict[str, Any]:
    mode = assert_send_allowed(
        identity,
        confirmed=args.confirm,
        company_allows_autonomous=args.company_allows_autonomous,
    )
    text = outgoing_text(args)
    client = build_client(args, identity)
    await ensure_authorized(client)
    try:
        entity = await resolve_entity(client, args.chat)
        sent = await client.send_message(entity, text or None, file=args.file)
        return {
            "sent": True,
            "chat": public_entity(entity),
            "messageId": sent.id,
            "policyMode": mode,
            "retryPolicy": "Do not retry automatically after an ambiguous failure.",
        }
    except Exception as error:
        raise TelegramRuntimeError(
            f"Telegram send failed or its result is ambiguous: {error}. Do not retry automatically."
        ) from error
    finally:
        await client.disconnect()


def command_doctor(args: argparse.Namespace) -> dict[str, Any]:
    identity = identity_from_args(args)
    root = connection_root(identity)
    session_file = session_path(identity).with_suffix(".session")
    if session_file.exists():
        ensure_private_file(session_file)
    return {
        "runtimeReady": runtime_python().exists(),
        "apiIdConfigured": isinstance(args.api_id, int) and args.api_id > 0,
        "apiHashDelivered": bool(os.environ.get(API_HASH_ENV)),
        "sessionPresent": session_file.exists(),
        "policy": load_policy(identity),
        "localRoot": str(root),
        "securityBoundary": "chat-only",
    }


def command_policy(args: argparse.Namespace) -> dict[str, Any]:
    identity = identity_from_args(args)
    if args.policy_command == "set":
        write_private_json(policy_path(identity), {"sendMode": args.send_mode})
    return {
        "policy": load_policy(identity),
        "path": str(policy_path(identity)),
    }


def run_async_command(args: argparse.Namespace) -> dict[str, Any]:
    identity = identity_from_args(args)
    with session_lock(identity):
        if args.command == "login":
            return asyncio.run(command_login_async(args, identity))
        if args.command == "dialogs":
            return asyncio.run(command_dialogs_async(args, identity))
        if args.command == "read":
            return asyncio.run(command_read_async(args, identity))
        if args.command == "search":
            return asyncio.run(command_search_async(args, identity))
        if args.command == "download":
            return asyncio.run(command_download_async(args, identity))
        if args.command == "send":
            return asyncio.run(command_send_async(args, identity))
    raise TelegramRuntimeError(f"Unsupported Telegram command: {args.command}")


def add_connection_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--company-id", required=True)
    parser.add_argument("--member-id", required=True)
    parser.add_argument("--connection-id", required=True)
    parser.add_argument("--api-id", required=True, type=int)
    parser.add_argument(
        "--company-allows-autonomous",
        action=argparse.BooleanOptionalAction,
        default=True,
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Trelio Telegram MTProto runtime")
    add_connection_arguments(parser)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("bootstrap", help="Install the pinned local Telethon runtime")
    commands.add_parser("doctor", help="Check local runtime, policy and session without revealing secrets")
    policy = commands.add_parser("policy", help="Read or update local sending policy")
    policy_commands = policy.add_subparsers(dest="policy_command", required=True)
    policy_commands.add_parser("show")
    policy_set = policy_commands.add_parser("set")
    policy_set.add_argument("--send-mode", choices=POLICY_MODES, required=True)
    login = commands.add_parser(
        "login",
        help="Authorize the personal session through a protected local browser page",
    )
    login_method = login.add_mutually_exclusive_group()
    login_method.add_argument("--qr", action="store_true", help="Open QR login immediately")
    login_method.add_argument("--code", action="store_true", help="Open phone and code login immediately")
    login.add_argument(
        "--terminal-prompts",
        action="store_true",
        help="Use the current visible terminal instead of the protected local browser page",
    )
    login.add_argument(
        "--qr-timeout",
        type=int,
        choices=range(30, 601),
        default=DEFAULT_QR_LOGIN_TIMEOUT_SECONDS,
        metavar="30..600",
    )
    login.add_argument(
        "--qr-refresh-seconds",
        type=int,
        choices=range(5, 61),
        default=DEFAULT_QR_REFRESH_SECONDS,
        metavar="5..60",
    )
    dialogs = commands.add_parser("dialogs", help="List or narrowly search dialogs")
    dialogs.add_argument("--query")
    dialogs.add_argument("--limit", type=int, choices=range(1, 101), default=20, metavar="1..100")
    read = commands.add_parser("read", help="Read recent messages in one exact chat")
    read.add_argument("--chat", required=True)
    read.add_argument("--limit", type=int, choices=range(1, 201), default=20, metavar="1..200")
    search = commands.add_parser("search", help="Search messages inside one exact chat")
    search.add_argument("--chat", required=True)
    search.add_argument("--query", required=True)
    search.add_argument("--limit", type=int, choices=range(1, 201), default=20, metavar="1..200")
    download = commands.add_parser("download", help="Download media from one selected message")
    download.add_argument("--chat", required=True)
    download.add_argument("--message-id", required=True, type=int)
    download.add_argument("--output", required=True)
    send = commands.add_parser("send", help="Send according to local confirm/autonomous/read-only policy")
    send.add_argument("--chat", required=True)
    send.add_argument("--message")
    send.add_argument("--message-file")
    send.add_argument("--file")
    send.add_argument("--confirm", action="store_true")
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        reexec_in_runtime_if_needed(args.command)
        if args.command == "bootstrap":
            result = command_bootstrap(args)
        elif args.command == "doctor":
            result = command_doctor(args)
        elif args.command == "policy":
            result = command_policy(args)
        else:
            result = run_async_command(args)
    except (TelegramRuntimeError, OSError, UnicodeError, ValueError) as error:
        if BROWSER_PROMPT_SESSION is not None:
            BROWSER_PROMPT_SESSION.finish(
                title="Вход не завершён",
                message="Вернитесь в Codex, проверьте сообщение об ошибке и запустите вход заново.",
            )
            time.sleep(0.4)
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 2
    finally:
        shutdown_browser_prompt_session()
    print(json.dumps({"ok": True, **result}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
