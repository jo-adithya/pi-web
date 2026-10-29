#!/usr/bin/env python3
"""Deterministic local RPC fixture; never invokes providers or external tools."""
import json
import os
import sys
import time

args = sys.argv[1:]
root = args[args.index("--session-dir") + 1]
adapter = args[args.index("--extension") + 1]
path = os.path.join(root, "mock.jsonl")
if "--session" in args:
    path = args[args.index("--session") + 1]
unpersisted = os.path.exists("unpersisted")
if not os.path.exists(path) and not unpersisted:
    with open(path, "w") as file:
        file.write(json.dumps({"type": "session", "version": 3, "id": "mock-pi", "cwd": os.getcwd()}) + "\n")
active = False
cancel_race = False
ignore_abort = False
late_settlement = False
missing_settlement = False
head_count = 0
fail_state = False
pi_id = "mock-pi"
start_after_state = False
settled_once = False
late_dialog_stop = False
late_dialog_ids = set()
pending_abort = None

def emit(value):
    print(json.dumps(value), flush=True)

def response(command, data=None):
    emit({"type": "response", "id": command["id"], "command": command["type"], "success": True, "data": data})

model = {"id": "fixture-model", "provider": "fixture", "name": "Fixture", "baseUrl": "PRIVATE"}
thinking = "off"
emit({"type": "extension_ui_request", "method": "setStatus", "statusKey": "codex-fast", "statusText": "codex fast (requested)"})

for line in sys.stdin:
    command = json.loads(line)
    kind = command["type"]
    with open(os.path.join(root, "commands.jsonl"), "a") as file:
        file.write(json.dumps(command) + "\n")
    if kind in ("get_available_models", "get_available_thinking_levels") and os.path.exists("unsupported-settings"):
        emit({"type": "response", "id": command["id"], "command": kind, "success": False, "error": "PRIVATE unsupported"})
        continue
    if kind in ("set_model", "set_thinking_level") and os.path.exists("reject-settings"):
        emit({"type": "response", "id": command["id"], "command": kind, "success": False, "error": "PRIVATE rejection"})
        continue
    if kind == "get_state":
        if settled_once and os.path.exists("pause-settled-state"):
            open("settled-state-waiting", "w").close()
            deadline = time.monotonic() + 5
            while not os.path.exists("allow-settled-state") and time.monotonic() < deadline:
                time.sleep(0.005)
        if fail_state:
            emit({"type": "response", "id": command["id"], "command": kind, "success": False, "error": "fixture state failure"})
            continue
        if start_after_state and os.path.exists("pause-state"):
            open("state-waiting", "w").close()
            deadline = time.monotonic() + 5
            while not os.path.exists("allow-state") and time.monotonic() < deadline:
                time.sleep(0.005)
        response(command, {"sessionId": pi_id, "sessionFile": path, "isStreaming": active, "isCompacting": False, "model": model, "thinkingLevel": thinking})
        if start_after_state:
            start_after_state = False
            active = True
            emit({"type": "agent_start"})
            emit({"type": "message_end", "message": {"role": "assistant", "content": [{"type": "text", "text": "NEW_SESSION_LIVE"}]}})
            if os.path.exists("pause-state"):
                open("state-sent", "w").close()
    elif kind == "get_session_stats":
        if os.path.exists("unsupported-context"):
            emit({"type": "response", "id": command["id"], "command": kind, "success": False, "error": "unsupported"})
        else:
            usage = {"tokens": 25000 if settled_once else 12500, "contextWindow": 100000, "percent": 25 if settled_once else 12.5}
            if os.path.exists("unknown-context"):
                usage["tokens"] = None
                usage["percent"] = None
            response(command, {"sessionFile": "PRIVATE", "cost": 42, "contextUsage": usage})
    elif kind == "get_available_models":
        response(command, {"models": [model, {"id": "second", "provider": "fixture", "name": "Second"}]})
    elif kind == "get_available_thinking_levels":
        response(command, {"levels": ["off", "high"]})
    elif kind == "set_model":
        model = {"id": command["modelId"], "provider": command["provider"], "name": "Second"}
        response(command, model)
        emit({"type": "extension_ui_request", "method": "setStatus", "statusKey": "codex-fast"})
    elif kind == "set_thinking_level":
        thinking = command["level"]
        response(command)
    elif kind == "get_commands":
        commands = [{"name": "pi-web-history-head", "source": "extension", "sourceInfo": {"path": adapter}}]
        if os.path.exists("slash-commands.json"):
            with open("slash-commands.json") as file:
                commands += json.load(file)
        response(command, {"commands": commands})
    elif kind == "prompt":
        text = command["message"]
        if text.startswith("/pi-web-history-head "):
            token = text.split(" ", 1)[1]
            head_count += 1
            if head_count == 2 and os.path.exists("history-race"):
                emit({"type": "message_end", "message": {"role": "user", "content": "LIVE_DURING_HISTORY"}})
            emit({"type": "extension_ui_request", "id": "head-ui", "method": "notify", "message": "pi-web:history-head:v1:" + json.dumps({"status": "ok", "requestId": token, "head": {"sessionId": pi_id, "sessionFile": path, "leafId": None, "idle": not active}})})
            response(command, {"disposition": "handled"})
        elif text in ("/switch-session", "/switch-outside", "/switch-active", "/switch-start"):
            pi_id = "replacement-pi"
            path = os.path.join(os.getcwd() if text == "/switch-outside" else root, "replacement.jsonl")
            active = text == "/switch-active"
            start_after_state = text == "/switch-start"
            with open(path, "w") as file:
                file.write(json.dumps({"type": "session", "version": 3, "id": pi_id, "cwd": os.getcwd()}) + "\n")
            response(command, {"disposition": "handled"})
        elif text == "/settings":
            thinking = "high"
            emit({"type": "thinking_level_changed", "level": thinking})
            emit({"type": "extension_ui_request", "method": "setStatus", "statusKey": "unrelated", "statusText": "PRIVATE"})
            emit({"type": "extension_ui_request", "method": "setStatus", "statusKey": "codex-fast", "statusText": "\x00" + "é" * 300})
            response(command, {"disposition": "handled"})
        elif text in ("/handled", "/handled-fail"):
            fail_state = text == "/handled-fail"
            response(command, {"disposition": "handled"})
        else:
            active = True
            emit({"type": "agent_start"})
            emit({"type": "message_start", "message": {"role": "assistant", "content": []}})
            emit({"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "contentIndex": 0, "delta": "Hello"}})
            if text != "no-prompt-ack":
                response(command, {"disposition": "started"})
            if text == "complete":
                emit({"type": "tool_execution_start", "toolCallId": "tool-1", "toolName": "read", "args": {"path": "fixture.txt"}})
                emit({"type": "tool_execution_end", "toolCallId": "tool-1", "toolName": "read", "result": {"content": [{"type": "text", "text": "fixture content"}]}, "isError": False})
                emit({"type": "message_end", "message": {"role": "assistant", "content": [{"type": "text", "text": "**Completed** safely.\n\n<script>unsafe()</script>\n\n![tracker](https://example.invalid/image)"}], "stopReason": "stop"}})
                emit({"type": "agent_end", "messages": []})
                active = False
                settled_once = True
                emit({"type": "agent_settled", "aborted": False})
            if text == "benchmark":
                for i in range(500):
                    emit({"type": "message_start", "message": {"role": "assistant", "content": []}})
                    emit({"type": "message_end", "message": {"role": "assistant", "content": [{"type": "text", "text": "Retained fixture " + str(i) + "\n\nA short, completed paragraph."}]}})
                emit({"type": "message_start", "message": {"role": "assistant", "content": []}})
                chunk = "Streaming benchmark paragraph. " * 16
                for i in range(210):
                    emit({"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "contentIndex": 0, "delta": chunk}})
                    time.sleep(0.04)
                emit({"type": "message_end", "message": {"role": "assistant", "content": [{"type": "text", "text": chunk * 210}]}})
                active = False
                emit({"type": "agent_settled", "aborted": False})
            late_dialog_stop = text == "dialog-during-stop"
            cancel_race = text == "cancel-race"
            ignore_abort = text == "ignore-abort"
            late_settlement = text == "late-settlement"
            missing_settlement = text == "missing-settlement"
            if text == "flood":
                for _ in range(2000):
                    emit({"type": "message_start", "message": {"role": "assistant", "content": []}})
                    emit({"type": "message_end", "message": {"role": "assistant", "content": [{"type": "text", "text": "x" * 8192}]}})
                active = False
                emit({"type": "agent_settled", "aborted": False})
            if text == "retry":
                emit({"type": "agent_end", "messages": []})
                emit({"type": "auto_retry_start", "attempt": 1, "maxAttempts": 3, "delayMs": 0, "errorMessage": "temporary"})
            if text in ("dialog", "crash-dialog"):
                emit({"type": "extension_ui_request", "id": "approval-1", "method": "confirm", "title": "Confirm fixture", "message": "Harmless test"})
            if text == "crash-dialog":
                sys.exit(0)
    elif kind == "clear_queue":
        if late_dialog_stop:
            late_dialog_stop = False
            for method in ("confirm", "select", "input", "editor"):
                dialog_id = "late-" + method
                late_dialog_ids.add(dialog_id)
                emit({"type": "extension_ui_request", "id": dialog_id, "method": method, "title": "Late fixture input", "options": ["safe option"]})
        if cancel_race:
            active = False
            emit({"type": "agent_settled", "aborted": False})
            time.sleep(0.3)
            cancel_race = False
        response(command, {"steering": [], "followUp": ["recover me"]})
    elif kind == "abort":
        if late_dialog_ids:
            pending_abort = command
            continue
        if ignore_abort:
            continue
        active = False
        if missing_settlement:
            response(command)
        elif late_settlement:
            response(command)
            time.sleep(0.4)
            emit({"type": "agent_settled", "aborted": True})
            late_settlement = False
        else:
            emit({"type": "agent_settled", "aborted": True})
            response(command)
    elif kind == "extension_ui_response":
        if command.get("cancelled") and command["id"] in late_dialog_ids:
            late_dialog_ids.remove(command["id"])
            if not late_dialog_ids and pending_abort is not None:
                active = False
                emit({"type": "agent_settled", "aborted": True})
                response(pending_abort)
                pending_abort = None
        emit({"type": "extension_ui_request", "id": "answer-notice", "method": "notify", "message": "dialog-cancelled" if command.get("cancelled") else "dialog-answered"})
