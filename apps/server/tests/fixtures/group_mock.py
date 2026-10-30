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
        data = {"model": {"provider": sys.argv[sys.argv.index("--provider") + 1], "id": "different" if mode == "mismatch" else sys.argv[sys.argv.index("--model") + 1]}}
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
        paths = ["unknown"] if mode == "unknown" else [files[0]["id"]]
        if mode == "duplicate":
            paths.append(files[0]["id"])
        text = json.dumps({"groups": [{"title": "Change", "reason": "Related edits", "paths": paths}]})
        if mode == "reads":
            text = json.dumps({"readDiffs": [{"path": files[0]["id"], "startLine": 2}]})
        if mode == "lazy-read":
            text = json.dumps({"readDiffs": [{"path": files[-1]["id"], "startLine": 1}]})
        if mode == "global":
            text = json.dumps({"groups": [{"title": "Feature", "reason": "Related across manifest", "paths": [files[0]["id"], files[-1]["id"]]}]})
        if mode == "invalid-json":
            text = "Here are the groups: " + text
        message = {"role": "assistant", "stopReason": "error" if mode == "error" else "stop", "content": [{"type": "text", "text": text}]}
        if mode.startswith("usage"):
            message["usage"] = {"input": 120, "output": 30, "cacheRead": 40, "cacheWrite": 5, "totalTokens": 195}
            if mode == "usage":
                message["usage"]["cost"] = {"input": 0.01, "output": 0.002, "cacheRead": 0, "cacheWrite": 0, "total": 0.012}
            if mode == "usage-invalid-cost":
                message["usage"]["cost"] = {"total": -1}
            if mode == "usage-invalid":
                message["usage"]["input"] = -1
        if mode == "tool":
            message["content"].append({"type": "toolCall", "id": "bad", "name": "bash", "arguments": {}})
        emit({"type": "message_end", "message": message})
        emit({"type": "agent_end", "messages": [message], "willRetry": False})
        emit({"type": "agent_settled", "aborted": mode == "aborted"})
