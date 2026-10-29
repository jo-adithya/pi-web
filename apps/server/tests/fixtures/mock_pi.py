"""Deterministic local RPC peer; never loads Pi or provider configuration."""
import json
import os
import signal
import sys
import time

mode = sys.argv[1]


def emit(value, fragmented=False):
    data = (json.dumps(value, ensure_ascii=False) + "\r\n").encode()
    if fragmented:
        for byte in data:
            os.write(1, bytes([byte]))
    else:
        os.write(1, data)


def reply(command, **fields):
    emit(dict(type="response", id=command["id"], command=command["type"], success=True, data=fields))


if mode in ("stall", "descendant"):
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    if mode == "descendant":
        # The child reaps its descendant on TERM, but itself requires KILL.
        pid = os.fork()
        if pid == 0:
            signal.signal(signal.SIGTERM, signal.SIG_DFL)
            while True:
                time.sleep(1)
        def reap(signum, frame):
            os.waitpid(pid, 0)
        signal.signal(signal.SIGTERM, reap)
        emit(dict(type="ready", pid=os.getpid(), descendant=pid))
    else:
        emit(dict(type="ready", pid=os.getpid()))
    while True:
        time.sleep(1)

if mode == "broken_stdin":
    os.close(0)
    emit(dict(type="ready"))
    while True:
        time.sleep(1)

if mode == "eof":
    emit(dict(type="agent_settled"))
    sys.exit(0)

first = None
for line in sys.stdin:
    command = json.loads(line)
    if mode == "echo":
        emit(dict(type="message_update", text="héllo\u2028world"), True)
        reply(command, disposition="started")
    elif mode == "order":
        if first is None:
            first = command
        else:
            reply(command, name=command["type"])
            emit(dict(type="agent_settled"))
            reply(first, name=first["type"])
    elif mode == "reject":
        emit(dict(type="response", id=command["id"], command=command["type"], success=False, error="rejected"))
    elif mode == "late":
        if first is None:
            first = command
            emit(dict(type="ready"))
        else:
            reply(first, stale=True)
            reply(dict(id="unknown", type="get_state"), stale=True)
            reply(command, current=True)
    elif mode == "noise":
        os.write(2, b"x" * 200000)
        reply(command, ok=True)
    elif mode == "flood":
        reply(command, ok=True)
        for i in range(1000):
            emit(dict(type="message_update", text="x" * 100))
    elif mode == "ui":
        if command["type"] == "extension_ui_response":
            emit(dict(type="ui_seen", reply=command))
        else:
            reply(command, ok=True)
    elif mode == "silent":
        emit(dict(type="received", command=command["type"]))
    elif mode == "priority":
        if command["type"] == "prompt":
            emit(dict(type="received", command=command["type"]))
        else:
            reply(command, ok=True)
    elif mode == "malformed":
        os.write(1, b"{no}\n")
    elif mode == "utf8":
        os.write(1, b'{"type":"\xff"}\n')
    elif mode == "partial":
        os.write(1, b'{"type":"unfinished"}')
        sys.exit(0)
    elif mode == "oversize":
        os.write(1, b"x" * 4096)
    elif mode == "deep":
        os.write(1, b'{"type":"x","v":' + b"[" * 70 + b"0" + b"]" * 70 + b"}\n")
    elif mode == "nodes":
        emit(dict(type="x", v=[0] * 200))
    elif mode == "mismatch":
        emit(dict(type="response", id=command["id"], command="abort", success=True))
    elif mode == "crash":
        sys.exit(7)
    elif mode == "missing_id":
        emit(dict(type="response", command="get_state", success=True))
