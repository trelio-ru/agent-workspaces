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
import contextlib
import getpass
import json
import os
import re
import subprocess
import sys
import venv
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator


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


class TelegramRuntimeError(RuntimeError):
    """Expected, user-safe configuration or protocol error."""


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
        raise TelegramRuntimeError("Local Telegram session is not authorized. Run login in a visible terminal.")


async def command_login_async(args: argparse.Namespace, identity: Identity) -> dict[str, Any]:
    _, SessionPasswordNeededError = import_telethon()
    client = build_client(args, identity)
    await client.connect()
    try:
        if await client.is_user_authorized():
            me = await client.get_me()
            return {"authorized": True, "userId": me.id, "username": me.username}
        if not sys.stdin.isatty():
            raise TelegramRuntimeError("Login requires a visible interactive terminal.")
        phone = input("Телефон Telegram: ").strip()
        if not phone:
            raise TelegramRuntimeError("Phone is required.")
        sent = await client.send_code_request(phone)
        code = input("Код Telegram: ").strip()
        try:
            await client.sign_in(phone=phone, code=code, phone_code_hash=sent.phone_code_hash)
        except SessionPasswordNeededError:
            password = getpass.getpass("Пароль 2FA Telegram: ")
            await client.sign_in(password=password)
        me = await client.get_me()
        session_file = session_path(identity).with_suffix(".session")
        if session_file.exists() and os.name == "posix":
            session_file.chmod(0o600)
        return {"authorized": True, "userId": me.id, "username": me.username}
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
    commands.add_parser("login", help="Authorize the personal session in a visible terminal")
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
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 2
    print(json.dumps({"ok": True, **result}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
