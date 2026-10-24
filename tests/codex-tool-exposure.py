"""Exercise the real Codex plugin/reload/model-request boundary in isolation.

Both HTTP peers are loopback fixtures. No user config, model catalogue, OAuth,
hooks or Trelio content is loaded. The assertion examines the request sent to
the model, because a successful tools/list is not evidence of model exposure.
Run with --codex-bin pointing to an explicitly selected Codex executable.
"""

import argparse
import http.server
import json
import os
from pathlib import Path
import queue
import re
import subprocess
import tempfile
import threading
import time
import unittest


REPOSITORY = Path(__file__).resolve().parents[1]
MANIFEST = REPOSITORY / "plugins/trelio-agent-workspaces/.codex-plugin/plugin.json"
NAMESPACES = {"trelio": "mcp__trelio", "trelio-remote-skills": "mcp__trelio_remote_skills"}


def synthetic_model(lite):
    # These are public ModelInfo protocol fields, not a copied user's model
    # record. CodeModeOnly is essential: direct-mode models hide this defect.
    return {
        "slug": "fixture", "display_name": "Fixture", "description": None,
        "supported_reasoning_levels": [], "shell_type": "unified_exec",
        "visibility": "list", "supported_in_api": True, "priority": 0,
        "support_verbosity": False, "experimental_supported_tools": [],
        "truncation_policy": {"mode": "tokens", "limit": 10000},
        "context_window": 100000, "tool_mode": "code_mode_only",
        "supports_search_tool": True, "use_responses_lite": lite,
        "model_messages": {"instructions_template": "Synthetic protocol test."},
    }


class Peer(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def reply(self, status, obj):
        data = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self.reply(405, {})

    def do_DELETE(self):
        self.reply(200, {})

    def do_POST(self):
        obj = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or "{}")
        fixture = self.server.fixture
        if self.path.startswith("/mcp/"):
            server_name = self.path.removeprefix("/mcp/")
            method = obj.get("method")
            result = {}
            if method == "initialize":
                result = {"protocolVersion": "2025-03-26", "capabilities": {"tools": {}},
                          "serverInfo": {"name": server_name, "version": "1"}}
            elif method == "tools/list":
                fixture.list_counts[server_name] += 1
                if fixture.list_counts[server_name] == 1:
                    # The first client exceeds its startup budget. A later
                    # successful client must repopulate the same thread.
                    time.sleep(3)
                    return
                result = {"tools": [{"name": "read_probe", "description": "Synthetic read only.",
                                     "inputSchema": {"type": "object", "properties": {}}}]}
            elif method == "tools/call":
                raise AssertionError("No business operation is part of this schema fixture")
            if "id" not in obj:
                self.reply(202, {})
            else:
                self.reply(200, {"jsonrpc": "2.0", "id": obj["id"], "result": result})
            return
        if self.path.endswith("/responses"):
            # Responses Lite delivers schemas in an additional_tools item,
            # whereas the ordinary protocol uses top-level tools. Discard
            # all message bodies; retain only the structural evidence needed.
            specs = obj.get("tools") or next((item.get("tools", []) for item in obj.get("input", [])
                                             if item.get("type") == "additional_tools"), [])
            fixture.captured.append({
                spec.get("name"): {tool.get("name") for tool in spec.get("tools", [])}
                for spec in specs if spec.get("type") == "namespace"
            })
            index = len(fixture.captured)
            response_id = f"resp_fixture_{index}"
            item = {"id": f"msg_fixture_{index}", "type": "message", "role": "assistant",
                    "content": [{"type": "output_text", "text": "Fixture complete."}], "phase": "final"}
            events = [
                {"type": "response.created", "response": {"id": response_id, "status": "in_progress", "output": []}},
                {"type": "response.output_item.added", "output_index": 0, "item": item},
                {"type": "response.output_item.done", "output_index": 0, "item": item},
                {"type": "response.completed", "response": {"id": response_id, "status": "completed", "output": [item],
                 "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2}}},
            ]
            data = "".join("data: " + json.dumps(event) + "\n\n" for event in events).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        self.reply(404, {})


class Fixture:
    def initialize(self, root, binary, lite, server_policy):
        self.root = root
        self.captured = []
        self.list_counts = dict.fromkeys(NAMESPACES, 0)
        self.messages = queue.Queue()
        self.pending_events = []
        self.sequence = 0
        self.proc = None
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Peer)
        self.server.daemon_threads = True
        self.server.fixture = self
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        for name in ("home", "codex", "cwd"):
            (root / name).mkdir()
        # Allowlist environment so an unrelated credential or endpoint cannot
        # reach the client. HOME and CODEX_HOME are private temporary roots.
        self.env = {key: os.environ[key] for key in ("PATH", "SystemRoot", "WINDIR", "PATHEXT", "TEMP", "TMP")
                    if key in os.environ}
        self.env.update(HOME=str(root / "home"), USERPROFILE=str(root / "home"), CODEX_HOME=str(root / "codex"))
        self.binary = binary
        (root / "catalog.json").write_text(json.dumps({"models": [synthetic_model(lite)]}))
        self.config = root / "codex/config.toml"
        self.config.write_text(f'''model="fixture"
model_provider="fixture"
model_catalog_json={json.dumps(str(root / "catalog.json"))}
[model_providers.fixture]
name="Loopback fixture"
base_url="http://127.0.0.1:{self.server.server_port}/v1"
wire_api="responses"
requires_openai_auth=false
[features]
apps=false
plugins=true
[features.code_mode]
direct_only_tool_namespaces=[]
''')
        market = root / "marketplace"
        plugin = market / "plugin"
        (market / ".agents/plugins").mkdir(parents=True)
        (plugin / ".codex-plugin").mkdir(parents=True)
        (market / ".agents/plugins/marketplace.json").write_text(json.dumps({"name": "fixture-market", "plugins": [
            {"name": "fixture", "source": {"source": "local", "path": "./plugin"}}]}))
        registrations = {}
        declaration = json.loads(MANIFEST.read_text())["mcpServers"]
        for name in NAMESPACES:
            registrations[name] = {"url": f"http://127.0.0.1:{self.server.server_port}/mcp/{name}",
                                   "startup_timeout_sec": 1}
            if server_policy:
                # Test the shipped policy, not a hardcoded passing fixture.
                registrations[name]["omit_tools_from"] = declaration[name].get("omit_tools_from", [])
        (plugin / ".codex-plugin/plugin.json").write_text(json.dumps({
            "name": "fixture", "version": "1.0.0", "description": "Isolated protocol fixture",
            "mcpServers": registrations}))
        for args in (["plugin", "marketplace", "add", str(market), "--json"],
                     ["plugin", "add", "fixture@fixture-market", "--json"]):
            result = subprocess.run([binary, *args], env=self.env, cwd=root / "cwd", capture_output=True, timeout=30)
            if result.returncode:
                raise AssertionError("Isolated plugin setup failed: " + result.stderr.decode(errors="replace"))

    def start(self):
        self.proc = subprocess.Popen([self.binary, "app-server", "--listen", "stdio://"],
                                     cwd=self.root / "cwd", env=self.env, text=True, bufsize=1,
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        def read():
            for line in self.proc.stdout:
                self.messages.put(json.loads(line))
        threading.Thread(target=read, daemon=True).start()
        self.request("initialize", {"clientInfo": {"name": "schema_fixture", "version": "1"},
                                    "capabilities": {"experimentalApi": True}})
        self.send({"method": "initialized"})
        return self.request("thread/start", {"cwd": str(self.root / "cwd"), "ephemeral": True,
                                             "approvalPolicy": "never", "sandbox": "read-only",
                                             "model": "fixture", "modelProvider": "fixture"})["thread"]["id"]

    def send(self, message):
        self.proc.stdin.write(json.dumps(message) + "\n")
        self.proc.stdin.flush()

    def request(self, method, params=None):
        self.sequence += 1
        self.send({"id": self.sequence, "method": method, "params": params or {}})
        deadline = time.monotonic() + 40
        while time.monotonic() < deadline:
            message = self.messages.get(timeout=max(.1, deadline - time.monotonic()))
            if message.get("id") == self.sequence:
                if "error" in message:
                    raise AssertionError(message["error"])
                return message["result"]
            self.pending_events.append(message)
        raise AssertionError("App Server request timed out")

    def turn(self, thread):
        result = self.request("turn/start", {"threadId": thread, "input": [
            {"type": "text", "text": "Synthetic schema probe", "text_elements": []}]})
        turn_id = result["turn"]["id"]
        deadline = time.monotonic() + 40
        while time.monotonic() < deadline:
            message = self.pending_events.pop(0) if self.pending_events else self.messages.get(
                timeout=max(.1, deadline - time.monotonic()))
            if message.get("method") == "turn/completed" and message["params"]["turn"]["id"] == turn_id:
                assert message["params"]["turn"]["status"] == "completed", message
                return
        raise AssertionError("Synthetic turn timed out")

    def reconnect(self, thread, add_global_routing):
        config = self.config.read_text()
        assert re.search(r"enabled\s*=\s*true", config), "CLI must have installed the fixture plugin"
        self.config.write_text(re.sub(r"enabled\s*=\s*true", "enabled = false", config))
        self.request("config/mcpServer/reload")
        for name in NAMESPACES:
            self.request("mcpServerStatus/list", {"threadId": thread, "serverName": name, "detail": "toolsAndAuthOnly"})
        if add_global_routing:
            config = config.replace("direct_only_tool_namespaces=[]",
                                    "direct_only_tool_namespaces=" + json.dumps(list(NAMESPACES.values())))
        self.config.write_text(config)
        self.request("config/mcpServer/reload")
        for name in NAMESPACES:
            status = self.request("mcpServerStatus/list", {"threadId": thread, "serverName": name, "detail": "toolsAndAuthOnly"})
            entry = next(item for item in status["data"] if item["name"] == name)
            assert len(entry["tools"]) == 1 and not entry.get("toolsError"), entry

    def close(self):
        if self.proc:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(timeout=5)
            self.proc.stdin.close()
            self.proc.stdout.close()
        self.server.shutdown()
        self.server.server_close()


class ExposureTests(unittest.TestCase):
    def test_same_thread_after_startup_timeout(self):
        for lite in (False, True):
            for server_policy in (False, True):
                with self.subTest(responses_lite=lite, manifest_policy=server_policy), tempfile.TemporaryDirectory(
                        prefix="trelio-codex-exposure-") as directory:
                    fixture = None
                    try:
                        fixture = Fixture()
                        fixture.initialize(Path(directory), CODEX_BINARY, lite, server_policy)
                        thread = fixture.start()
                        fixture.turn(thread)
                        self.assertTrue(set(NAMESPACES.values()).isdisjoint(fixture.captured[-1]))
                        # Control: changing global Code Mode config alone does
                        # not refresh the active session. The fixed manifest
                        # must work with that global override entirely absent.
                        fixture.reconnect(thread, add_global_routing=not server_policy)
                        fixture.turn(thread)
                        self.assertEqual(len(fixture.captured), 2)
                        for name, namespace in NAMESPACES.items():
                            # A status read may build an independent catalogue;
                            # only the captured model request proves exposure.
                            self.assertGreaterEqual(fixture.list_counts[name], 2)
                            self.assertEqual(fixture.captured[-1].get(namespace), {"read_probe"} if server_policy else None)
                    finally:
                        if fixture:
                            fixture.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--codex-bin", required=True)
    arguments = parser.parse_args()
    CODEX_BINARY = str(Path(arguments.codex_bin).absolute())
    unittest.main(argv=[__file__], verbosity=2)
