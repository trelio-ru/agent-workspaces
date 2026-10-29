"""Real Codex: update main in one App Server without changing hook hashes.

Only disposable HOME/config/Git and a synthetic stdio MCP are used. No model,
account, Trelio request or hook approval is made. Native currentHash is the
fingerprint an actual user approval binds to; the test never writes trust.
"""
import argparse
from contextlib import contextmanager
import json
import os
from pathlib import Path
import queue
import shutil
import subprocess
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parents[1]
MAIN = "trelio-agent-workspaces"
HOOKS = MAIN + "-hooks"
MARKET = "human-update-fixture"


@contextmanager
def fixture_directory():
    temporary = tempfile.TemporaryDirectory(prefix="human-native-hooks-")
    try:
        yield temporary.name
    finally:
        # Native Windows may release its final SQLite/cwd handle just after
        # process exit. Retry ONLY removal of this owned disposable directory,
        # after Native.close; never retry installation, assertions or requests.
        for attempt in range(20):
            try:
                # Keep Python's standard cleanup for Git's Windows read-only
                # pack/index files. Plain rmtree cannot remove those files.
                temporary.cleanup()
                break
            except FileNotFoundError:
                break
            except OSError as error:
                if os.name != "nt" or error.winerror not in (5, 32, 33) or attempt == 19:
                    raise
                time.sleep(.1)


class Native:
    def __init__(self, binary, env, cwd):
        self.process = subprocess.Popen([binary, "app-server", "--listen", "stdio://"],
                                        cwd=cwd, env=env, text=True, encoding="utf-8",
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.DEVNULL)
        self.messages = queue.Queue()
        self.sequence = 0

        def read():
            try:
                for line in self.process.stdout:
                    self.messages.put(json.loads(line))
            finally:
                self.messages.put({"error": "native process closed"})
        threading.Thread(target=read, daemon=True).start()
        self.request("initialize", {"clientInfo": {"name": "human_hook_update_fixture", "version": "1"},
                                    "capabilities": {"experimentalApi": True}})
        self.send({"method": "initialized"})

    def send(self, value):
        self.process.stdin.write(json.dumps(value) + "\n")
        self.process.stdin.flush()

    def request(self, method, params=None):
        self.sequence += 1
        self.send({"id": self.sequence, "method": method, "params": params or {}})
        for _ in range(1000):
            value = self.messages.get(timeout=35)
            if value.get("id") == self.sequence:
                assert "error" not in value, "native RPC refused"
                return value["result"]
            assert "error" not in value, "native process failed"
        raise AssertionError("native frame bound")

    def hooks(self, cwd, component):
        result = self.request("hooks/list", {"cwds": [str(cwd)]})
        assert len(result["data"]) == 1
        row = result["data"][0]
        assert not row["errors"] and not row["warnings"], "native hook discovery failed"
        hooks = row["hooks"]
        assert sorted(h["eventName"] for h in hooks) == ["preToolUse", "sessionEnd", "sessionStart"]
        for hook in hooks:
            assert hook["source"] == "plugin" and hook["pluginId"] == f"{HOOKS}@{MARKET}"
            assert hook["trustStatus"] == "untrusted" and hook["enabled"] and not hook["isManaged"]
            assert Path(hook["sourcePath"]).resolve() == (component / "hooks/hooks.json").resolve()
        return sorted((h["eventName"], h["currentHash"]) for h in hooks)

    def close(self):
        # EOF lets this fixture's App Server close its MCP children before
        # releasing the private HOME. Terminating its parent first can orphan a
        # child holding that cwd on Windows, despite all assertions passing.
        self.process.stdin.close()
        try:
            self.process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            self.process.wait(timeout=10)
            raise AssertionError("isolated native fixture did not close after EOF")


def run(binary):
    with fixture_directory() as directory:
        root = Path(directory).resolve()
        home, cwd, repository, market = (root / p for p in ("home", "cwd", "repository", "market"))
        for item in (home, cwd, repository, market / ".agents/plugins"):
            item.mkdir(parents=True)
        env = {key: os.environ[key] for key in ("PATH", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "TEMP", "TMP")
               if key in os.environ}
        env.update(HOME=str(home), USERPROFILE=str(home), CODEX_HOME=str(home),
                   LOCALAPPDATA=str(home / "local"), APPDATA=str(home / "roaming"),
                   XDG_CONFIG_HOME=str(home / "config"), XDG_CACHE_HOME=str(home / "cache"),
                   GIT_CONFIG_NOSYSTEM="1", GIT_TERMINAL_PROMPT="0")
        git_config = root / "git-config"
        git_config.write_text("", encoding="utf-8", newline="\n")
        env["GIT_CONFIG_GLOBAL"] = str(git_config)
        (home / "config.toml").write_text("[features]\nplugins=true\nhooks=true\napps=false\n", encoding="utf-8", newline="\n")

        def command(executable, args, location=cwd):
            result = subprocess.run([executable, *args], cwd=location, env=env, capture_output=True, timeout=40)
            assert result.returncode == 0, "isolated native command failed"
            return result.stdout

        node = shutil.which("node")
        assert node, "fixture Node unavailable"
        command(node, [str(ROOT / "scripts/build-codex-hook-component.mjs"), "--output", str(repository / "plugin")])
        (repository / ".gitattributes").write_text("* -text\n", encoding="utf-8", newline="\n")
        (repository / ".codex-plugin").mkdir()
        # Keep the real main's empty native hook declaration AND conventional
        # Claude file. This proves Codex doesn't discover duplicate legacy hooks.
        (repository / "hooks").mkdir()
        shutil.copyfile(ROOT / "plugins" / MAIN / "hooks/hooks.json", repository / "hooks/hooks.json")
        # Native plugin sources are UTF-8 regardless of the Windows runner's
        # current ANSI code page. Never translate Russian metadata through it.
        manifest = json.loads((ROOT / "plugins" / MAIN / ".codex-plugin/plugin.json").read_text(encoding="utf-8"))
        manifest.pop("skills", None)
        manifest["mcpServers"] = {"human-update-probe": {"command": node,
            "args": [str(root / "probe.mjs")], "env": {"PROBE_VERSION": "1"}}}
        (root / "probe.mjs").write_text('''import readline from "node:readline";
for await (const line of readline.createInterface({input:process.stdin})) {
 const m=JSON.parse(line); if(m.id===undefined)continue;
 const result=m.method==="initialize"?{protocolVersion:"2024-11-05",capabilities:{tools:{}},serverInfo:{name:"fixture",version:process.env.PROBE_VERSION}}
 :m.method==="tools/list"?{tools:[{name:"probe_"+process.env.PROBE_VERSION,description:"Synthetic read",inputSchema:{type:"object",properties:{}}}]}:{};
 process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result})+"\\n");
}
''', encoding="utf-8", newline="\n")
        manifest_path = repository / ".codex-plugin/plugin.json"
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8", newline="\n")

        def git(args):
            return command("git", ["-c", "core.hooksPath=" + str(root / "no-hooks"), *args], repository)

        def commit(message):
            git(["add", "."])
            git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", message])

        git(["init", "-q"])
        commit("Fixed hooks and initial main")
        git(["tag", "fixed-hooks"])
        git(["tag", "main-one"])
        manifest["version"] = "999.0.0"
        manifest["mcpServers"]["human-update-probe"]["env"]["PROBE_VERSION"] = "2"
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8", newline="\n")
        (repository / "README.md").write_text("Changed main instructions\n", encoding="utf-8", newline="\n")
        commit("Main-only update")
        git(["tag", "main-two"])
        catalogue = {"name": MARKET, "plugins": [
            {"name": MAIN, "source": {"source": "url", "url": repository.as_uri(), "ref": "main-one"}},
            {"name": HOOKS, "source": {"source": "git-subdir", "url": repository.as_uri(), "path": "./plugin", "ref": "fixed-hooks"}}]}
        catalogue_path = market / ".agents/plugins/marketplace.json"
        catalogue_path.write_text(json.dumps(catalogue), encoding="utf-8", newline="\n")
        native = lambda args: json.loads(command(binary, args))
        native(["plugin", "marketplace", "add", str(market), "--json"])
        installed = native(["plugin", "add", f"{HOOKS}@{MARKET}", "--json"])
        component = Path(installed["installedPath"])
        assert not (component / ".git").exists(), "hook fingerprint must exclude checkout metadata by native subdir projection"
        native(["plugin", "add", f"{MAIN}@{MARKET}", "--json"])
        owner = Native(binary, env, cwd)
        try:
            pid = owner.process.pid
            before = owner.hooks(cwd, component)
            status = owner.request("mcpServerStatus/list", {"serverName": "human-update-probe", "detail": "toolsAndAuthOnly"})
            assert any("probe_1" in row.get("tools", {}) for row in status["data"]), "initial MCP not connected"
            catalogue["plugins"][0]["source"]["ref"] = "main-two"
            catalogue_path.write_text(json.dumps(catalogue), encoding="utf-8", newline="\n")
            native(["plugin", "add", f"{MAIN}@{MARKET}", "--json"])
            owner.request("config/mcpServer/reload")
            status = owner.request("mcpServerStatus/list", {"serverName": "human-update-probe", "detail": "toolsAndAuthOnly"})
            assert any("probe_2" in row.get("tools", {}) for row in status["data"]), "updated MCP not connected in existing owner"
            assert owner.process.pid == pid and owner.process.poll() is None, "Codex owner was restarted"
            assert owner.hooks(cwd, component) == before, "main update changed native approval fingerprints"
            hook_file = component / "hooks/hooks.json"
            hook = json.loads(hook_file.read_text(encoding="utf-8"))
            hook["hooks"]["PreToolUse"][0]["hooks"][0]["timeout"] += 1
            hook_file.write_text(json.dumps(hook), encoding="utf-8", newline="\n")
            changed = owner.hooks(cwd, component)
            assert changed != before, "actual hook changes must still invalidate trust"
            with (component / "scripts/trelio-host-runtime-loader.mjs").open("a", encoding="utf-8", newline="\n") as output:
                output.write("\n// synthetic executable change\n")
            assert owner.hooks(cwd, component) != changed, "loader changes must still invalidate trust"
            config = (home / "config.toml").read_text(encoding="utf-8")
            assert not any(word in config for word in ("trusted_hash", "trusted_content_hash", "bypass_hook_trust"))
        finally:
            owner.close()
    print("PASS: same Codex owner loads updated main MCP; native hook fingerprints unchanged; real hook/loader changes invalidate them")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--codex-bin", required=True)
    run(parser.parse_args().codex_bin)
