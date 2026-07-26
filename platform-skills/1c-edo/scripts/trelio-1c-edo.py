#!/usr/bin/env python3
"""Read-only local runtime for the Trelio platform skill ``1c-edo``.

The runtime deliberately separates three trust domains:

* Trelio supplies normalized non-secret company configuration through the
  signed package host;
* the shared ``X-OData`` value arrives only through a one-use Agent Secret
  checkout environment variable;
* personal 1C credentials are entered locally and stay in a private namespace
  outside chat, MCP, Agent Workspaces, process arguments and Git.

Only a fixed set of GET/HEAD requests can be built below. There is no generic
URL, entity, OData expression or HTTP-method escape hatch.
"""

from __future__ import annotations

import argparse
import base64
import contextlib
import datetime as dt
import getpass
import hashlib
import ipaddress
import json
import os
import re
import shutil
import socket
import ssl
import stat
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, BinaryIO, Iterable


SKILL_ID = "1c-edo"
RUNTIME_VERSION = "1.0.0"
X_ODATA_ENV = "TRELIO_1C_EDO_X_ODATA"
CONNECTION_CONFIG_ENV = "TRELIO_SKILL_CONNECTION_CONFIG_JSON"
ACCESS_STATES = ("unknown", "no_access", "connected", "needs_reconnect")
DOCUMENT_ENTITIES = {
    "incoming": "Document_ЭлектронныйДокументВходящийЭДО",
    "outgoing": "Document_ЭлектронныйДокументИсходящийЭДО",
}
NEW_FILE_ENTITY = "Catalog_КэшВизуализацииДокументовЭДОПрисоединенныеФайлы"
OLD_MESSAGE_ENTITY = "Document_СообщениеЭДО"
OLD_FILE_ENTITY = "Catalog_СообщениеЭДОПрисоединенныеФайлы"
FILE_METADATA = {
    "new": "КэшВизуализацииДокументовЭДОПрисоединенныеФайлы",
    "old": "СообщениеЭДОПрисоединенныеФайлы",
}
UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)
MAX_ODATA_RESPONSE_BYTES = 8 * 1024 * 1024
MAX_ERROR_MESSAGE_CHARS = 300


class OneCEdoError(RuntimeError):
    """Expected user-safe runtime failure."""

    def __init__(self, code: str, message: str, *, exit_code: int = 2) -> None:
        super().__init__(message)
        self.code = code
        self.exit_code = exit_code


class AuthenticationError(OneCEdoError):
    """1C rejected personal Basic Auth credentials."""


class NetworkError(OneCEdoError):
    """The fixed remote endpoint could not be reached safely."""


@dataclass(frozen=True)
class Identity:
    company_id: str
    member_id: str
    connection_id: str


@dataclass(frozen=True)
class CompanyConfig:
    odata_base_url: str
    files_base_url: str
    max_rows: int
    max_pages: int
    max_file_bytes: int
    request_timeout_seconds: float
    access_help_url: str | None
    access_instructions: str | None
    fingerprint: str


@dataclass(frozen=True)
class Credentials:
    username: str
    password: str


class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Reject every redirect so an allowed host cannot bounce credentials."""

    def redirect_request(
        self,
        req: urllib.request.Request,
        fp: BinaryIO,
        code: int,
        msg: str,
        headers: Any,
        newurl: str,
    ) -> None:
        raise OneCEdoError(
            "redirect_blocked",
            "1С вернула redirect. Runtime не передаёт credentials на другой адрес.",
        )


def _utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def _uuid(value: str | None, label: str) -> str:
    normalized = str(value or "").strip().lower()
    if not UUID_RE.fullmatch(normalized):
        raise OneCEdoError("invalid_identity", f"Некорректный {label}.")
    return str(uuid.UUID(normalized))


def load_identity() -> Identity:
    skill_id = str(os.environ.get("TRELIO_SKILL_ID", "")).strip()
    if skill_id != SKILL_ID:
        raise OneCEdoError("invalid_host_context", "Runtime запущен не для навыка 1c-edo.")
    return Identity(
        company_id=_uuid(os.environ.get("TRELIO_SKILL_COMPANY_ID"), "company id"),
        member_id=_uuid(os.environ.get("TRELIO_SKILL_MEMBER_ID"), "member id"),
        connection_id=_uuid(os.environ.get("TRELIO_SKILL_CONNECTION_ID"), "connection id"),
    )


def _normalize_base_url(value: Any, label: str) -> str:
    parsed = urllib.parse.urlsplit(str(value or "").strip())
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise OneCEdoError("invalid_company_config", f"{label} должен быть безопасным HTTPS URL.")
    # The backend rejects loopback/private IP literals and unsafe DNS names.
    # Runtime repeats the most important syntactic checks, then never accepts a
    # caller-supplied host or absolute URL after this point.
    if parsed.hostname.lower() in {"localhost", "localhost.localdomain"}:
        raise OneCEdoError("invalid_company_config", f"{label} не может указывать на localhost.")
    path = parsed.path if parsed.path.endswith("/") else f"{parsed.path}/"
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, path, "", ""))


def _bounded_integer(
    value: Any,
    label: str,
    minimum: int,
    maximum: int,
) -> int:
    if isinstance(value, bool):
        raise OneCEdoError("invalid_company_config", f"Некорректный лимит {label}.")
    try:
        parsed = int(value)
    except (TypeError, ValueError) as error:
        raise OneCEdoError("invalid_company_config", f"Некорректный лимит {label}.") from error
    if parsed < minimum or parsed > maximum:
        raise OneCEdoError("invalid_company_config", f"Лимит {label} вне безопасного диапазона.")
    return parsed


def _canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def load_company_config() -> CompanyConfig:
    raw = os.environ.get(CONNECTION_CONFIG_ENV)
    if not raw:
        raise OneCEdoError(
            "connection_not_configured",
            "Администратор компании ещё не настроил подключение 1С ЭДО.",
        )
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as error:
        raise OneCEdoError("invalid_company_config", "Company config содержит некорректный JSON.") from error
    if not isinstance(value, dict) or value.get("schemaVersion") != 1:
        raise OneCEdoError("invalid_company_config", "Неподдерживаемая схема company connection.")

    normalized_for_fingerprint = {
        "schemaVersion": 1,
        "odataBaseUrl": _normalize_base_url(value.get("odataBaseUrl"), "OData URL"),
        "filesBaseUrl": _normalize_base_url(value.get("filesBaseUrl"), "Files URL"),
        "maxRows": _bounded_integer(value.get("maxRows"), "строк", 1, 200),
        "maxPages": _bounded_integer(value.get("maxPages"), "страниц", 1, 10),
        "maxFileBytes": _bounded_integer(
            value.get("maxFileBytes"),
            "размера файла",
            1,
            500 * 1024 * 1024,
        ),
        "requestTimeoutMs": _bounded_integer(
            value.get("requestTimeoutMs"),
            "таймаута",
            1_000,
            60_000,
        ),
        "accessHelpUrl": str(value.get("accessHelpUrl") or "").strip() or None,
        "accessInstructions": str(value.get("accessInstructions") or "").strip() or None,
    }
    if (
        normalized_for_fingerprint["accessHelpUrl"] is not None
        and urllib.parse.urlsplit(normalized_for_fingerprint["accessHelpUrl"]).scheme != "https"
    ):
        raise OneCEdoError("invalid_company_config", "Ссылка для запроса доступа должна быть HTTPS.")
    if (
        normalized_for_fingerprint["accessInstructions"] is not None
        and len(normalized_for_fingerprint["accessInstructions"]) > 2_000
    ):
        raise OneCEdoError("invalid_company_config", "Инструкция для доступа слишком длинная.")

    fingerprint = hashlib.sha256(
        _canonical_json(normalized_for_fingerprint).encode("utf-8"),
    ).hexdigest()
    return CompanyConfig(
        odata_base_url=normalized_for_fingerprint["odataBaseUrl"],
        files_base_url=normalized_for_fingerprint["filesBaseUrl"],
        max_rows=normalized_for_fingerprint["maxRows"],
        max_pages=normalized_for_fingerprint["maxPages"],
        max_file_bytes=normalized_for_fingerprint["maxFileBytes"],
        request_timeout_seconds=normalized_for_fingerprint["requestTimeoutMs"] / 1_000,
        access_help_url=normalized_for_fingerprint["accessHelpUrl"],
        access_instructions=normalized_for_fingerprint["accessInstructions"],
        fingerprint=fingerprint,
    )


def default_config_home() -> Path:
    override = os.environ.get("TRELIO_CONFIG_HOME")
    if override:
        return Path(override).expanduser().resolve()
    if os.name == "nt":
        return Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "Trelio"
    return Path.home() / ".config" / "trelio"


def connection_root(identity: Identity) -> Path:
    return (
        default_config_home()
        / "integrations"
        / SKILL_ID
        / identity.company_id
        / identity.member_id
        / identity.connection_id
    )


def access_state_path(identity: Identity) -> Path:
    return connection_root(identity) / "config" / "access.json"


def credentials_path(identity: Identity) -> Path:
    return connection_root(identity) / "secrets" / "personal-basic-auth.json"


def _assert_not_symlink(path: Path) -> None:
    with contextlib.suppress(FileNotFoundError):
        if stat.S_ISLNK(path.lstat().st_mode):
            raise OneCEdoError("unsafe_local_storage", f"Локальный путь {path} не может быть symlink.")


def _apply_windows_private_acl(path: Path, *, directory: bool) -> None:
    if os.name != "nt":
        return
    current_user = getpass.getuser()
    inheritance = "(OI)(CI)F" if directory else "F"
    result = subprocess.run(
        [
            "icacls",
            str(path),
            "/inheritance:r",
            "/grant:r",
            f"{current_user}:{inheritance}",
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise OneCEdoError(
            "unsafe_local_storage",
            "Не удалось выставить приватный Windows ACL для локальных данных 1С.",
        )


def ensure_private_directory(path: Path) -> None:
    """Create/check namespace components without traversing a local symlink.

    We enforce the boundary from ``integrations`` downward. The user's config
    home itself may legitimately be a managed filesystem mount, but no skill,
    company, member or connection component may redirect storage elsewhere.
    """

    integration_root = default_config_home() / "integrations"
    current = integration_root
    for component in path.relative_to(integration_root).parts:
        _assert_not_symlink(current)
        current.mkdir(mode=0o700, parents=True, exist_ok=True)
        if os.name == "posix":
            current.chmod(0o700)
        _apply_windows_private_acl(current, directory=True)
        current = current / component
    _assert_not_symlink(current)
    current.mkdir(mode=0o700, parents=False, exist_ok=True)
    if os.name == "posix":
        current.chmod(0o700)
    _apply_windows_private_acl(current, directory=True)


def _read_private_json(path: Path) -> dict[str, Any] | None:
    _assert_not_symlink(path)
    if not path.exists():
        return None
    if os.name == "posix" and path.stat().st_mode & 0o077:
        raise OneCEdoError("unsafe_local_storage", f"Небезопасные права локального файла {path}.")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise OneCEdoError("invalid_local_state", f"Не удалось прочитать локальное состояние {path}.") from error
    if not isinstance(value, dict):
        raise OneCEdoError("invalid_local_state", f"Локальное состояние {path} повреждено.")
    return value


def _write_private_json(path: Path, value: dict[str, Any]) -> None:
    ensure_private_directory(path.parent)
    _assert_not_symlink(path)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=path.parent,
    )
    temporary = Path(temporary_name)
    try:
        if os.name == "posix":
            os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        _apply_windows_private_acl(temporary, directory=False)
        os.replace(temporary, path)
        if os.name == "posix":
            path.chmod(0o600)
            directory_descriptor = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(directory_descriptor)
            finally:
                os.close(directory_descriptor)
        _apply_windows_private_acl(path, directory=False)
    finally:
        with contextlib.suppress(FileNotFoundError):
            temporary.unlink()


def _delete_private_file(path: Path) -> bool:
    _assert_not_symlink(path)
    if not path.exists():
        return False
    path.unlink()
    return True


def load_access_state(identity: Identity, config: CompanyConfig) -> dict[str, Any]:
    value = _read_private_json(access_state_path(identity))
    if not value or value.get("fingerprint") != config.fingerprint:
        # A user choice of "no access" is meaningful only for the exact
        # company connection. Changing host, path or safety limits resets the
        # decision to unknown and prevents old credentials from being reused.
        return {
            "status": "unknown",
            "fingerprint": config.fingerprint,
            "connectionChanged": bool(value),
        }
    status_value = value.get("status")
    if status_value not in ACCESS_STATES:
        raise OneCEdoError("invalid_local_state", "Локальный access status повреждён.")
    if status_value == "connected":
        credentials = _read_private_json(credentials_path(identity))
        if not credentials or credentials.get("fingerprint") != config.fingerprint:
            return {
                "status": "needs_reconnect",
                "fingerprint": config.fingerprint,
                "connectionChanged": False,
            }
    return {
        "status": status_value,
        "fingerprint": config.fingerprint,
        "connectionChanged": False,
    }


def save_access_state(identity: Identity, config: CompanyConfig, status_value: str) -> None:
    if status_value not in ACCESS_STATES:
        raise OneCEdoError("invalid_access_state", "Неподдерживаемый access status.")
    _write_private_json(
        access_state_path(identity),
        {
            "schemaVersion": 1,
            "fingerprint": config.fingerprint,
            "status": status_value,
            "updatedAt": _utc_now(),
        },
    )


def load_credentials(identity: Identity, config: CompanyConfig) -> Credentials:
    value = _read_private_json(credentials_path(identity))
    if not value or value.get("fingerprint") != config.fingerprint:
        raise OneCEdoError(
            "credentials_missing",
            "Личные данные 1С не подключены для текущей company connection.",
        )
    username = value.get("username")
    password = value.get("password")
    if not isinstance(username, str) or not username or not isinstance(password, str) or not password:
        raise OneCEdoError("invalid_local_state", "Локальный credential-файл повреждён.")
    return Credentials(username=username, password=password)


def save_credentials(
    identity: Identity,
    config: CompanyConfig,
    credentials: Credentials,
) -> None:
    _write_private_json(
        credentials_path(identity),
        {
            "schemaVersion": 1,
            "fingerprint": config.fingerprint,
            "username": credentials.username,
            "password": credentials.password,
            "updatedAt": _utc_now(),
        },
    )


def _prompt_credentials_terminal() -> Credentials:
    if not sys.stdin.isatty() or not sys.stderr.isatty():
        raise OneCEdoError(
            "protected_prompt_unavailable",
            "Для connect нужен локальный интерактивный терминал или системное окно.",
        )
    username = input("Логин 1С: ").strip()
    password = getpass.getpass("Пароль 1С: ")
    if not username or not password:
        raise OneCEdoError("credentials_empty", "Логин и пароль 1С не могут быть пустыми.")
    return Credentials(username=username, password=password)


def _prompt_credentials_macos() -> Credentials | None:
    if sys.platform != "darwin" or not shutil.which("osascript"):
        return None
    script = """
set usernameAnswer to display dialog "Введите личный логин 1С. Он останется только на этом компьютере." default answer "" with title "Trelio – 1С ЭДО" buttons {"Отмена", "Продолжить"} default button "Продолжить" cancel button "Отмена"
set passwordAnswer to display dialog "Введите личный пароль 1С." default answer "" with hidden answer with title "Trelio – 1С ЭДО" buttons {"Отмена", "Подключить"} default button "Подключить" cancel button "Отмена"
return (text returned of usernameAnswer) & linefeed & (text returned of passwordAnswer)
"""
    result = subprocess.run(
        ["osascript", "-e", script],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise OneCEdoError("connect_cancelled", "Подключение отменено пользователем.")
    username, separator, password = result.stdout.rstrip("\n").partition("\n")
    if not separator or not username.strip() or not password:
        raise OneCEdoError("credentials_empty", "Логин и пароль 1С не могут быть пустыми.")
    return Credentials(username=username.strip(), password=password)


def _prompt_credentials_windows() -> Credentials | None:
    if os.name != "nt" or not shutil.which("powershell.exe"):
        return None
    # The script is constant and contains no credential values. The password
    # crosses only a private parent/child pipe and is never placed in argv.
    script = r"""
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$form = New-Object Windows.Forms.Form
$form.Text = 'Trelio – 1С ЭДО'
$form.Size = New-Object Drawing.Size(430,220)
$form.StartPosition = 'CenterScreen'
$login = New-Object Windows.Forms.TextBox
$login.Location = New-Object Drawing.Point(20,45)
$login.Width = 370
$password = New-Object Windows.Forms.TextBox
$password.Location = New-Object Drawing.Point(20,105)
$password.Width = 370
$password.UseSystemPasswordChar = $true
$ok = New-Object Windows.Forms.Button
$ok.Text = 'Подключить'
$ok.Location = New-Object Drawing.Point(290,145)
$ok.DialogResult = [Windows.Forms.DialogResult]::OK
$form.Controls.AddRange(@($login,$password,$ok))
$form.AcceptButton = $ok
if ($form.ShowDialog() -ne [Windows.Forms.DialogResult]::OK) { exit 3 }
@{username=$login.Text;password=$password.Text} | ConvertTo-Json -Compress
"""
    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise OneCEdoError("connect_cancelled", "Подключение отменено пользователем.")
    try:
        value = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise OneCEdoError("protected_prompt_failed", "Системное окно не вернуло credentials.") from error
    username = str(value.get("username") or "").strip()
    password = str(value.get("password") or "")
    if not username or not password:
        raise OneCEdoError("credentials_empty", "Логин и пароль 1С не могут быть пустыми.")
    return Credentials(username=username, password=password)


def prompt_credentials() -> Credentials:
    return (
        _prompt_credentials_macos()
        or _prompt_credentials_windows()
        or _prompt_credentials_terminal()
    )


def _require_x_odata() -> str:
    value = os.environ.get(X_ODATA_ENV)
    if not value or len(value) < 16 or len(value) > 1_024 or "\n" in value or "\r" in value:
        raise OneCEdoError(
            "x_odata_missing",
            "Нужен одноразовый checkout company Agent Secret с binding x_odata.",
        )
    return value


def _basic_auth(credentials: Credentials) -> str:
    raw = f"{credentials.username}:{credentials.password}".encode("utf-8")
    return f"Basic {base64.b64encode(raw).decode('ascii')}"


def _odata_query(parameters: Iterable[tuple[str, str | int]]) -> str:
    """Encode OData query with `%20`, never form-style `+`.

    Parentheses, commas and single quotes are syntax generated exclusively by
    this runtime. User input is reduced to validated UUIDs before reaching a
    filter, so the safe set cannot enable arbitrary OData expressions.
    """

    encoded: list[str] = []
    for key, value in parameters:
        encoded_key = urllib.parse.quote(str(key), safe="$")
        encoded_value = urllib.parse.quote(str(value), safe="'(),")
        encoded.append(f"{encoded_key}={encoded_value}")
    return "&".join(encoded)


def _odata_url(
    config: CompanyConfig,
    entity: str,
    parameters: Iterable[tuple[str, str | int]] = (),
) -> str:
    allowed = {
        *DOCUMENT_ENTITIES.values(),
        NEW_FILE_ENTITY,
        OLD_MESSAGE_ENTITY,
        OLD_FILE_ENTITY,
    }
    if entity not in allowed:
        raise OneCEdoError("entity_blocked", "Эта OData entity не разрешена runtime.")
    url = f"{config.odata_base_url}{urllib.parse.quote(entity, safe='_')}"
    query = _odata_query(parameters)
    return f"{url}?{query}" if query else url


def _file_url(config: CompanyConfig, scheme: str, file_id: str) -> str:
    metadata = FILE_METADATA.get(scheme)
    if metadata is None:
        raise OneCEdoError("file_path_blocked", "Разрешены только new и old file routes.")
    normalized_id = _uuid(file_id, "file id")
    return (
        f"{config.files_base_url}"
        f"{urllib.parse.quote(metadata, safe='')}/{normalized_id}"
    )


def _http_open(
    method: str,
    url: str,
    *,
    credentials: Credentials,
    timeout: float,
    x_odata: str | None,
) -> Any:
    if method not in {"GET", "HEAD"}:
        raise OneCEdoError("method_blocked", "Runtime разрешает только GET и HEAD.")
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "https" and not (
        os.environ.get("TRELIO_1C_EDO_TEST_ALLOW_HTTP") == "1"
        and parsed.hostname in {"127.0.0.1", "::1"}
    ):
        raise OneCEdoError("url_blocked", "Runtime разрешает только HTTPS endpoint.")
    try:
        resolved = socket.getaddrinfo(
            parsed.hostname,
            parsed.port or 443,
            type=socket.SOCK_STREAM,
        )
    except socket.gaierror as error:
        raise NetworkError("network_error", "DNS endpoint 1С недоступен.") from error
    for address in resolved:
        ip_value = ipaddress.ip_address(address[4][0])
        if not ip_value.is_global:
            raise OneCEdoError(
                "url_blocked",
                "Endpoint 1С разрешился в непубличный сетевой адрес.",
            )
    headers = {
        "Accept": "application/json" if x_odata else "*/*",
        "Authorization": _basic_auth(credentials),
        "User-Agent": f"Trelio-1C-EDO/{RUNTIME_VERSION}",
    }
    if x_odata is not None:
        headers["X-OData"] = x_odata
    request = urllib.request.Request(url, headers=headers, method=method)
    opener = urllib.request.build_opener(
        NoRedirectHandler(),
        urllib.request.HTTPSHandler(context=ssl.create_default_context()),
    )
    try:
        return opener.open(request, timeout=timeout)
    except urllib.error.HTTPError as error:
        if error.code in {401, 403}:
            raise AuthenticationError(
                "authentication_failed",
                "1С отклонила личный логин/пароль или доступ к endpoint.",
            ) from error
        if 300 <= error.code < 400:
            raise OneCEdoError("redirect_blocked", "Redirect от 1С заблокирован.") from error
        raise NetworkError("http_error", f"1С вернула HTTP {error.code}.") from error
    except (urllib.error.URLError, TimeoutError, socket.timeout, ssl.SSLError) as error:
        raise NetworkError("network_error", "Не удалось безопасно связаться с 1С.") from error


def _read_limited(stream: BinaryIO, limit: int) -> bytes:
    value = stream.read(limit + 1)
    if len(value) > limit:
        raise OneCEdoError("response_too_large", "Ответ 1С превысил безопасный лимит.")
    return value


def _request_odata(
    config: CompanyConfig,
    credentials: Credentials,
    entity: str,
    parameters: Iterable[tuple[str, str | int]] = (),
) -> dict[str, Any]:
    url = _odata_url(config, entity, parameters)
    response = _http_open(
        "GET",
        url,
        credentials=credentials,
        timeout=config.request_timeout_seconds,
        x_odata=_require_x_odata(),
    )
    with response:
        raw = _read_limited(response, MAX_ODATA_RESPONSE_BYTES)
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise OneCEdoError("invalid_odata_response", "1С вернула некорректный JSON.") from error
    if not isinstance(value, dict):
        raise OneCEdoError("invalid_odata_response", "1С вернула неожиданный OData payload.")
    return value


def _odata_rows(payload: dict[str, Any]) -> list[dict[str, Any]]:
    raw_rows = payload.get("value")
    if raw_rows is None and isinstance(payload.get("d"), dict):
        raw_rows = payload["d"].get("results")
    if raw_rows is None:
        raw_rows = []
    if not isinstance(raw_rows, list):
        raise OneCEdoError("invalid_odata_response", "OData rows имеют неожиданный формат.")
    return [row for row in raw_rows if isinstance(row, dict)]


def _safe_scalar_record(value: dict[str, Any]) -> dict[str, Any]:
    """Return only bounded scalars so backend internals cannot flood the agent."""

    result: dict[str, Any] = {}
    for key, item in value.items():
        if not isinstance(key, str) or len(key) > 128:
            continue
        if item is None or isinstance(item, (bool, int, float)):
            result[key] = item
        elif isinstance(item, str):
            result[key] = item[:4_000]
    return result


def _mark_auth_failure(identity: Identity, config: CompanyConfig) -> None:
    # 401/403 means "credentials/access must be checked", never "the employee
    # explicitly has no account". Only `access-status set no-access` can write
    # no_access.
    save_access_state(identity, config, "needs_reconnect")


def _connected_context() -> tuple[Identity, CompanyConfig, Credentials]:
    identity = load_identity()
    config = load_company_config()
    state = load_access_state(identity, config)
    if state["status"] == "no_access":
        raise OneCEdoError(
            "no_access",
            "Пользователь явно указал отсутствие личного доступа. Обратитесь к администратору компании.",
        )
    credentials = load_credentials(identity, config)
    return identity, config, credentials


def command_connect(_: argparse.Namespace) -> dict[str, Any]:
    identity = load_identity()
    config = load_company_config()
    credentials = prompt_credentials()
    try:
        _request_odata(config, credentials, next(iter(DOCUMENT_ENTITIES.values())), (("$top", 1),))
    except AuthenticationError:
        _mark_auth_failure(identity, config)
        raise
    # Network failures intentionally preserve the previous state and do not
    # destroy working credentials or invent either no_access/needs_reconnect.
    save_credentials(identity, config, credentials)
    save_access_state(identity, config, "connected")
    return {"status": "connected"}


def command_doctor(_: argparse.Namespace) -> dict[str, Any]:
    identity = load_identity()
    config = load_company_config()
    state = load_access_state(identity, config)
    result: dict[str, Any] = {
        "status": state["status"],
        "connectionChanged": state["connectionChanged"],
        "companyConfig": {
            "configured": True,
            "maxRows": config.max_rows,
            "maxPages": config.max_pages,
            "maxFileBytes": config.max_file_bytes,
            "requestTimeoutSeconds": config.request_timeout_seconds,
        },
        "network": "not_checked",
    }
    if state["status"] in {"connected", "needs_reconnect"}:
        try:
            credentials = load_credentials(identity, config)
            _request_odata(
                config,
                credentials,
                next(iter(DOCUMENT_ENTITIES.values())),
                (("$top", 1),),
            )
            save_access_state(identity, config, "connected")
            result["status"] = "connected"
            result["network"] = "ok"
        except AuthenticationError:
            _mark_auth_failure(identity, config)
            result["status"] = "needs_reconnect"
            result["network"] = "authentication_failed"
        except NetworkError:
            result["network"] = "unreachable"
    return result


def _access_help(config: CompanyConfig) -> dict[str, Any] | None:
    if not config.access_help_url and not config.access_instructions:
        return None
    return {
        "url": config.access_help_url,
        "instructions": config.access_instructions,
    }


def command_access_show(_: argparse.Namespace) -> dict[str, Any]:
    identity = load_identity()
    config = load_company_config()
    state = load_access_state(identity, config)
    return {
        "status": state["status"],
        "connectionChanged": state["connectionChanged"],
        "accessHelp": _access_help(config),
    }


def command_access_no_access(args: argparse.Namespace) -> dict[str, Any]:
    if not args.confirmed:
        raise OneCEdoError(
            "explicit_confirmation_required",
            "no_access можно поставить только после явного выбора пользователя (--confirmed).",
        )
    identity = load_identity()
    config = load_company_config()
    save_access_state(identity, config, "no_access")
    return {"status": "no_access", "accessHelp": _access_help(config)}


def command_access_reset(_: argparse.Namespace) -> dict[str, Any]:
    identity = load_identity()
    config = load_company_config()
    save_access_state(identity, config, "unknown")
    return {"status": "unknown"}


def _document_directions(direction: str) -> list[str]:
    if direction == "both":
        return ["incoming", "outgoing"]
    if direction not in DOCUMENT_ENTITIES:
        raise OneCEdoError("direction_blocked", "Разрешены incoming, outgoing или both.")
    return [direction]


def command_search_documents(args: argparse.Namespace) -> dict[str, Any]:
    identity, config, credentials = _connected_context()
    term = (args.query or "").strip().casefold()
    rows: list[dict[str, Any]] = []
    try:
        for direction in _document_directions(args.direction):
            entity = DOCUMENT_ENTITIES[direction]
            for page in range(config.max_pages):
                payload = _request_odata(
                    config,
                    credentials,
                    entity,
                    (
                        ("$top", config.max_rows),
                        ("$skip", page * config.max_rows),
                    ),
                )
                page_rows = _odata_rows(payload)
                for raw_row in page_rows:
                    safe_row = _safe_scalar_record(raw_row)
                    if term and term not in _canonical_json(safe_row).casefold():
                        continue
                    rows.append({"direction": direction, "document": safe_row})
                if len(page_rows) < config.max_rows:
                    break
        save_access_state(identity, config, "connected")
    except AuthenticationError:
        _mark_auth_failure(identity, config)
        raise
    return {
        "documents": rows,
        "count": len(rows),
        "limits": {"maxRows": config.max_rows, "maxPages": config.max_pages},
    }


def command_get_document(args: argparse.Namespace) -> dict[str, Any]:
    identity, config, credentials = _connected_context()
    direction = _document_directions(args.direction)
    if len(direction) != 1:
        raise OneCEdoError("direction_blocked", "get-document требует incoming или outgoing.")
    document_id = _uuid(args.document_id, "document id")
    entity = DOCUMENT_ENTITIES[direction[0]]
    filter_value = f"Ref_Key eq guid'{document_id}'"
    try:
        rows = _odata_rows(
            _request_odata(
                config,
                credentials,
                entity,
                (("$filter", filter_value), ("$top", 1)),
            ),
        )
        save_access_state(identity, config, "connected")
    except AuthenticationError:
        _mark_auth_failure(identity, config)
        raise
    return {
        "direction": direction[0],
        "document": _safe_scalar_record(rows[0]) if rows else None,
    }


def _new_files(
    config: CompanyConfig,
    credentials: Credentials,
    document_id: str,
    document_entity: str,
) -> list[dict[str, Any]]:
    owner_filter = (
        f"ВладелецФайла eq cast(guid'{document_id}', '{document_entity}')"
    )
    rows = _odata_rows(
        _request_odata(
            config,
            credentials,
            NEW_FILE_ENTITY,
            (("$filter", owner_filter), ("$top", config.max_rows)),
        ),
    )
    return [{"scheme": "new", "file": _safe_scalar_record(row)} for row in rows]


def _old_files(
    config: CompanyConfig,
    credentials: Credentials,
    document_id: str,
    document_entity: str,
) -> list[dict[str, Any]]:
    document_filter = (
        f"ЭлектронныйДокумент eq cast(guid'{document_id}', '{document_entity}')"
    )
    message_rows = _odata_rows(
        _request_odata(
            config,
            credentials,
            OLD_MESSAGE_ENTITY,
            (("$filter", document_filter), ("$top", config.max_rows)),
        ),
    )
    result: list[dict[str, Any]] = []
    for message in message_rows:
        if len(result) >= config.max_rows * config.max_pages:
            break
        message_id = message.get("Ref_Key")
        if not isinstance(message_id, str) or not UUID_RE.fullmatch(message_id):
            continue
        file_filter = f"ВладелецФайла_Key eq guid'{str(uuid.UUID(message_id))}'"
        file_rows = _odata_rows(
            _request_odata(
                config,
                credentials,
                OLD_FILE_ENTITY,
                (("$filter", file_filter), ("$top", config.max_rows)),
            ),
        )
        result.extend(
            {
                "scheme": "old",
                "messageId": str(uuid.UUID(message_id)),
                "file": _safe_scalar_record(row),
            }
            for row in file_rows
        )
        result = result[: config.max_rows * config.max_pages]
    return result


def command_list_files(args: argparse.Namespace) -> dict[str, Any]:
    identity, config, credentials = _connected_context()
    direction = _document_directions(args.direction)
    if len(direction) != 1:
        raise OneCEdoError("direction_blocked", "list-files требует incoming или outgoing.")
    document_id = _uuid(args.document_id, "document id")
    document_entity = DOCUMENT_ENTITIES[direction[0]]
    try:
        files = [
            *_new_files(config, credentials, document_id, document_entity),
            *_old_files(config, credentials, document_id, document_entity),
        ]
        save_access_state(identity, config, "connected")
    except AuthenticationError:
        _mark_auth_failure(identity, config)
        raise
    return {
        "direction": direction[0],
        "documentId": document_id,
        "files": files,
        "count": len(files),
    }


def command_download_file(args: argparse.Namespace) -> dict[str, Any]:
    identity, config, credentials = _connected_context()
    url = _file_url(config, args.scheme, args.file_id)
    destination = Path(args.output).expanduser().resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{destination.name}.",
        suffix=".part",
        dir=destination.parent,
    )
    temporary = Path(temporary_name)
    digest = hashlib.sha256()
    total = 0
    try:
        response = _http_open(
            "GET",
            url,
            credentials=credentials,
            timeout=config.request_timeout_seconds,
            x_odata=None,
        )
        with response, os.fdopen(descriptor, "wb") as output:
            content_length = response.headers.get("Content-Length")
            if content_length:
                try:
                    declared_size = int(content_length)
                except ValueError as error:
                    raise OneCEdoError(
                        "invalid_file_response",
                        "Файловый endpoint вернул некорректный Content-Length.",
                    ) from error
                if declared_size < 0 or declared_size > config.max_file_bytes:
                    raise OneCEdoError("file_too_large", "Файл превышает company limit.")
            while True:
                chunk = response.read(min(1024 * 1024, config.max_file_bytes - total + 1))
                if not chunk:
                    break
                total += len(chunk)
                if total > config.max_file_bytes:
                    raise OneCEdoError("file_too_large", "Файл превышает company limit.")
                output.write(chunk)
                digest.update(chunk)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, destination)
        save_access_state(identity, config, "connected")
    except AuthenticationError:
        with contextlib.suppress(OSError):
            os.close(descriptor)
        _mark_auth_failure(identity, config)
        raise
    finally:
        with contextlib.suppress(OSError):
            os.close(descriptor)
        with contextlib.suppress(FileNotFoundError):
            temporary.unlink()
    return {
        "path": str(destination),
        "sizeBytes": total,
        "sha256": digest.hexdigest(),
        "scheme": args.scheme,
        "fileId": _uuid(args.file_id, "file id"),
    }


def command_forget_credentials(_: argparse.Namespace) -> dict[str, Any]:
    identity = load_identity()
    config = load_company_config()
    removed = _delete_private_file(credentials_path(identity))
    save_access_state(identity, config, "unknown")
    return {"status": "unknown", "credentialsRemoved": removed}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="trelio-1c-edo",
        description="Read-only local 1C EDO runtime.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    connect = subparsers.add_parser("connect")
    connect.set_defaults(handler=command_connect)
    doctor = subparsers.add_parser("doctor")
    doctor.set_defaults(handler=command_doctor)

    access = subparsers.add_parser("access-status")
    access_subparsers = access.add_subparsers(dest="access_command", required=True)
    access_show = access_subparsers.add_parser("show")
    access_show.set_defaults(handler=command_access_show)
    access_set = access_subparsers.add_parser("set")
    access_set.add_argument("status", choices=["no-access"])
    access_set.add_argument("--confirmed", action="store_true")
    access_set.set_defaults(handler=command_access_no_access)
    access_reset = access_subparsers.add_parser("reset")
    access_reset.set_defaults(handler=command_access_reset)

    search = subparsers.add_parser("search-documents")
    search.add_argument("--direction", choices=["incoming", "outgoing", "both"], default="both")
    search.add_argument("--query", default="")
    search.set_defaults(handler=command_search_documents)

    get_document = subparsers.add_parser("get-document")
    get_document.add_argument("--direction", choices=["incoming", "outgoing"], required=True)
    get_document.add_argument("--document-id", required=True)
    get_document.set_defaults(handler=command_get_document)

    list_files = subparsers.add_parser("list-files")
    list_files.add_argument("--direction", choices=["incoming", "outgoing"], required=True)
    list_files.add_argument("--document-id", required=True)
    list_files.set_defaults(handler=command_list_files)

    download = subparsers.add_parser("download-file")
    download.add_argument("--scheme", choices=["new", "old"], required=True)
    download.add_argument("--file-id", required=True)
    download.add_argument("--output", required=True)
    download.set_defaults(handler=command_download_file)

    forget = subparsers.add_parser("forget-credentials")
    forget.set_defaults(handler=command_forget_credentials)
    return parser


def _safe_message(error: BaseException) -> str:
    message = str(error).replace("\r", " ").replace("\n", " ").strip()
    return message[:MAX_ERROR_MESSAGE_CHARS] or "Неизвестная ошибка runtime."


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    try:
        args = parser.parse_args(argv)
        result = args.handler(args)
        print(json.dumps({"ok": True, **result}, ensure_ascii=False, separators=(",", ":")))
        return 0
    except OneCEdoError as error:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": {"code": error.code, "message": _safe_message(error)},
                },
                ensure_ascii=False,
                separators=(",", ":"),
            ),
        )
        return error.exit_code
    except KeyboardInterrupt:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": {"code": "cancelled", "message": "Операция отменена."},
                },
                ensure_ascii=False,
                separators=(",", ":"),
            ),
        )
        return 130
    except Exception:
        # Unexpected library/platform failures must not emit a traceback that
        # could contain a local path, URL or credential-bearing header. The
        # detailed exception remains deliberately outside agent-visible output.
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": {
                        "code": "internal_error",
                        "message": "Runtime завершился с безопасной внутренней ошибкой.",
                    },
                },
                ensure_ascii=False,
                separators=(",", ":"),
            ),
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
