#!/usr/bin/env python3
"""Separate grouping subprocess fixture; main runtime uses the existing fixture."""
import json
import os
import pathlib
import runpy
import sys
import time

root = pathlib.Path(__file__).parent
if "--no-session" not in sys.argv:
    runpy.run_path(str(root / "runtime_mock.py"), run_name="__main__")
    sys.exit(0)

mode = (root / "group-mode").read_text() if (root / "group-mode").exists() else "valid"
(root / "group-launch.json").write_text(json.dumps({"args": sys.argv[1:], "cwd": os.getcwd(), "pid": os.getpid(), "mode": mode}))

def emit(value):
    print(json.dumps(value), flush=True)

for line in sys.stdin:
    command = json.loads(line)
    with (root / "group-commands.jsonl").open("a") as log:
        log.write(json.dumps(command) + "\n")
    kind = command["type"]
    data = None
    if kind == "get_state":
        data = {"model": {"provider": "fixture", "id": "different" if mode == "mismatch" else "fixture-model"}}
    emit({"type": "response", "id": command["id"], "command": kind, "success": True, "data": data})
    if kind == "prompt":
        if mode == "hang":
            time.sleep(60)
        if mode == "large":
            emit({"type": "message_update", "padding": "x" * (1024 * 1024)})
            continue
        if mode == "total":
            for _ in range(8):
                emit({"type": "message_update", "padding": "x" * (600 * 1024)})
            continue
        files = json.loads(command["message"].split("\n", 1)[1])["files"]
        paths = ["unknown"] if mode == "unknown" else [files[0]["path"]]
        if mode == "duplicate":
            paths.append("a")
        text = json.dumps({"groups": [{"title": "Change", "reason": "Related edits", "paths": paths}]})
        if mode == "invalid-json":
            text = "Here are the groups: " + text
        message = {"role": "assistant", "stopReason": "error" if mode == "error" else "stop", "content": [{"type": "text", "text": text}]}
        if mode == "tool":
            message["content"].append({"type": "toolCall", "id": "bad", "name": "bash", "arguments": {}})
        emit({"type": "message_end", "message": message})
        emit({"type": "agent_end", "messages": [message], "willRetry": False})
        emit({"type": "agent_settled", "aborted": mode == "aborted"})
