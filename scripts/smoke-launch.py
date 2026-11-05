#!/usr/bin/env python3
"""Launching Pi in a directory attaches a new managed session for that directory."""
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
with tempfile.TemporaryDirectory(prefix="pi-codex-agents-launch-") as temp:
    root = Path(temp)
    agent, alpha, beta = root / "agent", root / "alpha", root / "beta"
    for directory in (agent, alpha, beta):
        directory.mkdir()
    (agent / "settings.json").write_text(json.dumps({"quietStartup": True, "tui": {"mode": "fullscreen"}}))
    # The default is autoAttach: true. This harness leaves it at the default on purpose.
    env = {**os.environ, "PI_CODING_AGENT_DIR": str(agent), "PI_CODEX_AGENTS_NATIVE_DIR": str(root / "host"),
           "PI_CODEX_AGENTS_IDLE_MS": "0", "PI_OFFLINE": "1", "TERM": "xterm-256color"}
    # Smoke runs launch real Pi frontends. A marker inherited from a session that is
    # already managed would make the extension stay out of the way.
    for marker in ("PI_CODEX_AGENTS_NATIVE_DAEMON", "PI_AGENTS_NATIVE_DAEMON"):
        env.pop(marker, None)

    cli = Path(os.environ.get("PI_CODEX_AGENTS_TEST_PI_CLI", str(repo / "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js")))
    args = ["node", str(cli), "-e", str(repo / "dist/extension.js")]

    def control(command):
        script = (f"const {{ensureNativeConnection}}=await import({json.dumps((repo / 'dist/pi/client.js').as_uri())});"
                  "const c=await ensureNativeConnection(process.cwd(),false);"
                  "try{console.log(JSON.stringify(await c.request(process.argv[1])))}finally{c.socket.end()}")
        state = json.loads(subprocess.check_output(["node", "--input-type=module", "-e", script, command],
                                                cwd=repo, env=env, stderr=subprocess.PIPE, timeout=15))
        if command == "status" and state.get("pid"):
            host_pids.add(state["pid"])
        return state

    host_pids = set()
    children = []
    output = bytearray()
    master = None

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
                if chunk:
                    output.extend(chunk)

    def expect(text, start=0):
        end = time.monotonic() + 25
        while time.monotonic() < end:
            if text.encode() in output[start:]:
                return
            read_for(.1)
        raise AssertionError(f"Missing {text!r}; terminal tail:\n{output[-6500:].decode(errors='replace')}")

    def send(data):
        os.write(master, data.encode())
        read_for(.2)

    def launch(cwd, extra=()):
        global master, output
        if master is not None:
            os.close(master)
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
        child = subprocess.Popen([*args, *extra], cwd=cwd, stdin=slave, stdout=slave, stderr=slave, env=env, start_new_session=True)
        os.close(slave)
        children.append(child)
        output = bytearray()
        read_for(3)
        return child

    def stop_frontend():
        """Leave the managed view, then wait until the host has released its terminal."""
        mark = len(output)
        send("\x1a")
        expect("Leave command center?", mark)
        send("\r")
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if control("status").get("attached") is False:
                return
            time.sleep(.2)
        raise AssertionError("the previous frontend never released the host terminal")

    def foreground(state):
        return next(row for row in state["sessions"] if row["id"] == state["activeId"])

    try:
        # No key press: Pi in a directory attaches itself and shows a session for it.
        launch(alpha)
        expect("sessions 1 ·")
        state = control("status")
        assert state["attached"] is True, "launching Pi must attach its terminal to the host"
        assert "Agent command center" not in output.decode(errors="replace"), \
            "a launch attachment shows a session, not the command center"
        first = foreground(state)
        assert first["cwd"] == str(alpha), first
        first_id, first_file = first["id"], first["sessionFile"]
        print("PASS launch: Pi attaches a managed session for the directory it started in")

        # A draft typed into that session belongs to it, not to the next launch.
        send("keep me")
        # Ctrl+Z leaves that session back to the Pi editor that was launched.
        mark = len(output)
        send("\x1a")
        expect("Leave command center?", mark)
        send("\r")
        expect("Sessions remain running. Open /agents to reconnect.", mark)
        assert control("status")["attached"] is False
        print("PASS launch: leaving the launch session returns to ordinary Pi")

        # A second Pi in another directory gets its own session, not the first one.
        launch(beta)
        expect("sessions 2 ·")
        state = control("status")
        assert foreground(state)["cwd"] == str(beta), foreground(state)
        assert any(row["cwd"] == str(alpha) for row in state["sessions"]), state["sessions"]
        print("PASS launch: a different directory gets its own session instead of the last one")

        mark = len(output)
        send("\x1a")
        expect("Leave command center?", mark)
        send("\r")
        expect("Sessions remain running. Open /agents to reconnect.", mark)

        # Relaunching the first directory starts a new session for it, like a fresh run,
        # and leaves the session that directory was used for before untouched.
        launch(alpha)
        expect("sessions 3 ·")
        state = control("status")
        rows = [row for row in state["sessions"] if row["cwd"] == str(alpha)]
        assert len(rows) == 2, state["sessions"]
        current = foreground(state)
        assert current["cwd"] == str(alpha), current
        assert current["id"] != first_id, f"relaunching a directory must start a new session: {current}"
        assert current["sessionFile"] != first_file, (current["sessionFile"], first_file)
        assert Path(first_file).is_file() and Path(current["sessionFile"]).is_file(), (first_file, current["sessionFile"])
        draft = root / "host" / "drafts" / f"{hashlib.sha256(first_id.encode()).hexdigest()}.json"
        assert draft.is_file() and "keep me" in draft.read_text(), f"the older session draft was not retained: {draft}"
        print("PASS launch: relaunching a directory gets a new session and history, keeping the older one")

        # Launching Pi on a history it names, rather than on a bare directory, shows that session.
        # The Pi id is the suffix of its history file name, exactly as the user would type it.
        stop_frontend()
        resumed_id = Path(first_file).stem.split("_")[-1]
        launch(alpha, ["--session", resumed_id])
        expect("sessions 3 ·")
        state = control("status")
        current = foreground(state)
        assert len(state["sessions"]) == 3, state["sessions"]
        assert current["id"] == first_id, f"launching a named history must show that session, not a new one: {current}"
        assert current["sessionFile"] == first_file, (current["sessionFile"], first_file)
        draft = root / "host" / "drafts" / f"{hashlib.sha256(first_id.encode()).hexdigest()}.json"
        assert draft.is_file() and "keep me" in draft.read_text(), f"the resumed session lost its draft: {draft}"
        print("PASS launch: pi --session <id> shows that session with its history and draft")

        # Continuing the directory reopens a session already in the command center instead of
        # adding a fourth, and never asks the running one to start over.
        stop_frontend()
        launch(alpha, ["--continue"])
        expect("sessions 3 ·")
        state = control("status")
        current = foreground(state)
        assert len(state["sessions"]) == 3, state["sessions"]
        assert current["cwd"] == str(alpha), current
        assert any(row["id"] == first_id for row in state["sessions"]), state["sessions"]
        print("PASS launch: pi --continue reopens a session for the directory instead of adding one")
    finally:
        try:
            control("stop")
        except Exception:
            pass
        for child in children:
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=5)
        if master is not None:
            os.close(master)
        for pid in sorted(host_pids):
            deadline = time.monotonic() + 5
            while True:
                try:
                    os.kill(pid, 0)
                except OSError:
                    break
                if time.monotonic() >= deadline:
                    os.kill(pid, signal.SIGTERM)
                    break
                time.sleep(.05)
