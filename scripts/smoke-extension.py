#!/usr/bin/env python3
"""Real Pi extension and terminal handoff; temporary state, no model requests."""
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pty
import select
import signal
import struct
import subprocess
import tempfile
import termios
import time

repo = Path(__file__).resolve().parent.parent
with tempfile.TemporaryDirectory(prefix="pi-codex-agents-extension-") as temp:
    root = Path(temp)
    agent, alpha, beta = root / "agent", root / "alpha", root / "beta"
    for directory in (agent, alpha, beta):
        directory.mkdir()
    (agent / "settings.json").write_text(json.dumps({"quietStartup": True, "tui": {"mode": "fullscreen"}}))
    # These scenarios start in ordinary Pi and enter the host by key press, so the
    # launch attachment default is switched off here. scripts/smoke-launch.py covers it on.
    (agent / "pi-codex-agents").mkdir()
    (agent / "pi-codex-agents" / "config.json").write_text(json.dumps({"autoAttach": False}))
    env = {**os.environ, "PI_CODING_AGENT_DIR": str(agent), "PI_CODEX_AGENTS_NATIVE_DIR": str(root / "host"),
           "PI_CODEX_AGENTS_IDLE_MS": "1500", "PI_OFFLINE": "1", "TERM": "xterm-256color"}
    # Smoke runs launch real Pi frontends. A marker inherited from a session that is
    # already managed would make the extension stay out of the way.
    for marker in ("PI_CODEX_AGENTS_NATIVE_DAEMON", "PI_AGENTS_NATIVE_DAEMON"):
        env.pop(marker, None)

    cli = Path(os.environ.get("PI_CODEX_AGENTS_TEST_PI_CLI", str(repo / "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js")))
    tarball = os.environ.get("PI_CODEX_AGENTS_TEST_TARBALL")
    package = json.loads((repo / "package.json").read_text())["name"]
    if tarball:
        subprocess.run(["node", str(cli), "install", "npm:" + package + "@file:" + tarball], cwd=alpha, env=env, check=True, timeout=120)
        package_root = agent / "npm/node_modules" / package
        assert not (package_root / "node_modules/typescript").exists(), "Package must work without a local compiler"
        assert not (package_root / "node_modules/@earendil-works/pi-coding-agent").exists(), "Pi provides its SDK"
    else:
        package_root = repo

    def control(command):
        resolver = ("import {registerHooks} from 'node:module';"
                    f"const piURL={json.dumps((cli.parents[1] / 'index.js').as_uri())};"
                    "registerHooks({resolve(s,c,n){return n(s,s.startsWith('@earendil-works/pi-')||s==='typebox'||s.startsWith('typebox/')?{...c,parentURL:piURL}:c)}});") if tarball else ""
        script = (resolver + f"const {{ensureNativeConnection}}=await import({json.dumps((package_root / 'dist/pi/client.js').as_uri())});"
                  "const c=await ensureNativeConnection(process.cwd(),false);"
                  "try{console.log(JSON.stringify(await c.request(process.argv[1])))}finally{c.socket.end()}")
        state = json.loads(subprocess.check_output(["node", "--input-type=module", "-e", script, command],
                                                cwd=repo, env=env, stderr=subprocess.PIPE, timeout=15))
        if command == "status" and state.get("pid"):
            host_pids.add(state["pid"])   # every host this harness starts, including replacements
        return state

    host_pids = set()

    def host_alive(pid):
        try:
            os.kill(pid, 0)
            return True
        except OSError:
            return False

    def host_survivors():
        rows = subprocess.run(["ps", "-eo", "pid,args"], capture_output=True, text=True).stdout.splitlines()
        return [int(row.split()[0]) for row in rows if str(root) in row and "host-entry.js" in row]

    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
    args = ["node", str(cli)] + ([] if tarball else ["-e", str(repo / "dist/extension.js")])
    child = subprocess.Popen(args, cwd=alpha,
                             stdin=slave, stdout=slave, stderr=slave, env=env, start_new_session=True)
    os.close(slave)
    output = bytearray()

    def read_for(seconds):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            if select.select([master], [], [], min(.05, max(0, end - time.monotonic())))[0]:
                try:
                    chunk = os.read(master, 65536)
                except OSError as error:
                    if error.errno == errno.EIO:
                        return
                    raise
                if not chunk:
                    return
                output.extend(chunk)

    def expect(text, start=0):
        end = time.monotonic() + 20
        while time.monotonic() < end:
            if text.encode() in output[start:]:
                return
            read_for(.1)
        raise AssertionError(f"Missing {text!r}; terminal tail:\n{output[-6500:].decode(errors='replace')}")

    def send(data):
        os.write(master, data.encode())
        read_for(.2)

    def detach():
        mark = len(output)
        send("\x07")
        expect("Agent command center", mark)
        send("\x1a")                        # Ctrl+Z: back to the Pi editor that was launched
        expect("Leave command center?", mark)
        send("\r")
        expect("Open /agents to reconnect", mark)

    try:
        read_for(2)
        # Ordinary Pi can initialize its own defaults on first startup. Compare
        # after that bootstrap, before the extension attaches or creates runtimes.
        original_settings = (agent / "settings.json").read_bytes()
        mark = len(output)
        send("\x1b[D")
        expect("Agent command center", mark)
        host_pid = control("status")["pid"]
        send("\x1b")
        send("home-draft-proof")
        mark = len(output)
        send("\x07")
        expect("Agent command center", mark)
        send("\x10")                       # Ctrl+P: a new session in another directory
        expect("New native session", mark)
        send(str(beta))
        mark = len(output)
        send("\r")
        expect(str(beta), mark)
        send("child-draft-proof")
        child_state = next(row for row in control("status")["sessions"] if row["id"] != "home")
        child_id, session_file = child_state["id"], child_state["sessionFile"]
        detach()
        assert child.poll() is None, "Detaching must return to Pi, not exit it"
        assert control("status")["attached"] is False
        print("PASS extension: Left Arrow entry, native creation, detach back to original Pi")

        # A draft keeps Left Arrow as cursor movement. Ctrl+G can still open agents.
        send("parent-draft-proof")
        send("\x1b[D")
        assert control("status")["attached"] is False
        mark = len(output)
        send("\x07")
        expect("Agent command center", mark)
        assert control("status")["pid"] == host_pid
        send("\x1b[A")
        send("\r")
        expect("home-draft-proof", mark)
        end = time.monotonic() + 10
        while time.monotonic() < end:
            state = next(row for row in control("status")["sessions"] if row["id"] == child_id)
            if state["activity"] == "inactive":
                break
            read_for(.2)
        assert state["activity"] == "inactive", state
        assert "draft" not in state, "status must not transmit editor contents"
        draft_path = root / "host" / "drafts" / (hashlib.sha256(child_id.encode()).hexdigest() + ".json")
        assert json.loads(draft_path.read_text()) == "child-draft-proof"
        mark = len(output)
        send("\x07")
        expect("Agent command center", mark)
        # The command center opens on Active; an unloaded session is on Inactive.
        send("\t")
        expect("Inactive", mark)
        send("\r")
        expect("child-draft-proof", mark)
        state = next(row for row in control("status")["sessions"] if row["id"] == child_id)
        assert state["sessionFile"] == session_file
        assert state["activity"] == "ready"
        # The native status line uses the same activity vocabulary as the chips.
        expect("sessions 2 · 0 running · 0 needs input · 2 ready", mark)
        print("PASS extension: idle session becomes inactive and resumes the same history and draft on entry")
        detach()
        expect("parent-draft-proof")
        print("PASS extension: original Pi draft survives attachment and return")

        # /agents restart replaces the host with the current build in one command.
        mark = len(output)
        send("\x15")
        send("/agents restart")
        send("\r")
        expect("Agent host restarted with the current build.", mark)
        expect("Agent command center", mark)
        send("\x1b")                      # close the board that restart reopened
        detach()
        assert child.poll() is None
        print("PASS extension: /agents restart replaces the host in one command")

        # The same command typed inside a managed view: the host replaces itself and the
        # frontend starts the installed build and reconnects.
        mark = len(output)
        send("\x07")
        expect("Agent command center", mark)
        send("\x1b")                      # close the board, stay attached in the managed view
        send("\x15")
        send("/agents status")
        send("\r")
        expect("running or waiting", mark)
        send("/agents takeover")
        send("\r")
        expect("already owns the managed session view", mark)
        restart_mark = len(output)
        send("/agents restart")
        send("\r")
        expect("Agent host restarted with the current build.", restart_mark)
        expect("Agent command center", restart_mark)
        send("\x1b")
        detach()
        assert child.poll() is None
        print("PASS extension: /agents restart works inside a managed view")

        mark = len(output)
        send("\x15")
        send("/agents stop")
        send("\r")
        expect("Stop managed agents?", mark)
        send("\r")
        expect("Managed agent host is stopping", mark)
        assert child.poll() is None
        assert (agent / "settings.json").read_bytes() == original_settings
        print("PASS extension: explicit host shutdown preserves parent Pi and user settings")

        mark = len(output)
        send("\x07")
        expect("Agent command center", mark)
        send("\x1b")
        send("\x15/agents stop")
        send("\r")
        expect("Stop managed agents?", mark)
        send("\r")
        expect("Managed sessions stopped. Returned to Pi.", mark)
        assert child.poll() is None
        print("PASS extension: managed status, takeover notice, and confirmed stop return to ordinary Pi")

        # /quit typed inside a managed view is handled by the host's mode. It offers a
        # quit choice and ends Pi in the same press while the host keeps running.
        mark = len(output)
        send("\x07")
        expect("Agent command center", mark)
        send("\x1b")                      # close the board; stay in the managed view
        send("\x15")                      # Home resumes with a saved draft; clear it
        send("/quit")
        send("\r")
        expect("Quit the managed session?", mark)
        send("\r")                        # keep sessions running and quit Pi
        child.wait(timeout=15)
        assert child.returncode == 0, "quitting from a managed view must end Pi"
        assert control("status")["sessions"], "the host must outlive Pi"
        print("PASS extension: /quit in a managed view quits Pi while the host keeps running")

        # Coming back to a host that was left running in the background: a settled session
        # must be resumable, never recorded as an explicit Stopped.
        os.close(master)
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
        child = subprocess.Popen(args, cwd=alpha, stdin=slave, stdout=slave, stderr=slave,
                                 env=env, start_new_session=True)
        os.close(slave)
        output = bytearray()
        read_for(2)
        states = {row["id"]: row["activity"] for row in control("status")["sessions"]}
        assert not any(activity == "stopped" for activity in states.values()), states
        mark = len(output)
        send("\x07")
        expect("Agent command center", mark)
        expect("Active", mark)
        expect("Ctrl+Q quit Pi", mark)      # full-screen board, no framed box
        assert "\u256d" not in output[mark:].decode(errors="replace"), "full-screen board draws edge to edge"
        send("\x1b")                       # close the board, then leave through Ctrl+Z
        detach()
        assert child.poll() is None
        print("PASS extension: a host left running in the background comes back without a Stopped session")

        # Ctrl+Q in the command center mirrors /quit: Pi ends in one press, host keeps running.
        mark = len(output)
        send("\x07")
        expect("Agent command center", mark)
        send("\x11")
        expect("Quit the managed session?", mark)
        send("\r")
        child.wait(timeout=15)
        assert child.returncode == 0, "Ctrl+Q in the command center must quit Pi"
        assert control("status")["sessions"], "the host must outlive Pi"
        print("PASS extension: Ctrl+Q in the command center quits Pi like /quit")
        if tarball:
            subprocess.run(["node", str(cli), "remove", "npm:" + package + "@file:" + tarball], cwd=alpha, env=env, check=True, timeout=120)
            assert not package_root.exists(), "Pi uninstall must remove the package"
            assert Path(session_file).exists(), "Uninstall must preserve native conversation history"
            print("PASS installed package: normal Pi loading, no bundled SDK/compiler, uninstall preserves history")
    finally:
        try:
            control("stop")
        except Exception:
            pass
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=5)
        # The host outlives Pi by design, so the harness must reap every host it started
        # before its temporary agent directory disappears.
        for pid in sorted(host_pids):
            deadline = time.monotonic() + 5
            while host_alive(pid) and time.monotonic() < deadline:
                time.sleep(.05)
            if host_alive(pid):
                os.kill(pid, signal.SIGTERM)
                deadline = time.monotonic() + 5
                while host_alive(pid) and time.monotonic() < deadline:
                    time.sleep(.05)
        leaked = [pid for pid in host_pids if host_alive(pid)]
        # A host that failed to exit after stop is a product bug, so sweep anything still
        # running from this harness's temporary directory and prove none survive.
        for pid in host_survivors():
            print(f"FAIL: host {pid} did not exit after stop; harness terminated it")
            try:
                os.kill(pid, signal.SIGTERM)
            except OSError:
                pass
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and (host_survivors() or leaked):
            leaked = [pid for pid in host_pids if host_alive(pid)]
            time.sleep(.2)
        leaked += host_survivors()
        assert not leaked, f"harness leaked agent hosts: {leaked}"
        os.close(master)
