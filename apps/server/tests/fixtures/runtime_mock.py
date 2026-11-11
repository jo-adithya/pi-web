#!/usr/bin/env python3
"""Deterministic local RPC fixture; never invokes providers or external tools."""
import json
import os
import sys
import time

args = sys.argv[1:]
if "--no-session" in args:
    # Tool-free response formatter fixture, isolated from the coding transcript.
    fixture = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(fixture, "formatter-launch.json"), "w") as file:
        file.write(json.dumps({"pid": os.getpid(), "cwd": os.getcwd()}))
    for line in sys.stdin:
        command = json.loads(line)
        data = {"model": {"provider": args[args.index("--provider") + 1], "id": args[args.index("--model") + 1]}}
        timed = os.path.exists(os.path.join(fixture, "formatter-timing-delays"))
        if command["type"] == "get_state" and timed:
            time.sleep(0.04)
        if command["type"] == "prompt":
            with open(os.path.join(fixture, "formatter-calls.jsonl"), "a") as file:
                file.write(json.dumps({"args": args, "input": json.loads(command["message"])}) + "\n")
            deadline = time.monotonic() + 5
            while os.path.exists(os.path.join(fixture, "formatter-hold")) and time.monotonic() < deadline:
                time.sleep(0.005)
            data = {"disposition": "started"}
        print(json.dumps({"type": "response", "id": command["id"], "command": command["type"], "success": True, "data": data}), flush=True)
        if command["type"] == "prompt":
            if os.path.exists(os.path.join(fixture, "formatter-tool")):
                print(json.dumps({"type": "tool_execution_start", "toolName": "bash"}), flush=True)
            answer = "not valid JSON" if os.path.exists(os.path.join(fixture, "formatter-invalid")) else json.dumps({"summary": "I finished the work.", "blocks": [{"type": "checklist", "title": "Changes", "items": ["Updated the response"]}, {"type": "note", "title": "Next step", "text": "Review the original if needed."}]})
            response_path = os.path.join(fixture, "formatter-response.json")
            if os.path.exists(response_path):
                with open(response_path, encoding="utf-8") as file:
                    answer = file.read()
            if timed:
                time.sleep(0.05)
                midpoint = len(answer) // 2
                print(json.dumps({"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "contentIndex": 0, "delta": answer[:midpoint]}}), flush=True)
                time.sleep(0.06)
                print(json.dumps({"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "contentIndex": 0, "delta": answer[midpoint:]}}), flush=True)
            print(json.dumps({"type": "message_end", "message": {"role": "assistant", "stopReason": "stop", "content": [{"type": "text", "text": answer}]}}), flush=True)
            print(json.dumps({"type": "agent_settled", "aborted": False}), flush=True)
    sys.exit(0)
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
compacted = False
compact_after_settlement = False
late_dialog_stop = False
late_dialog_ids = set()
pending_abort = None

def emit(value):
    print(json.dumps(value), flush=True)

def response(command, data=None):
    emit({"type": "response", "id": command["id"], "command": command["type"], "success": True, "data": data})

model = {"id": "fixture-model", "provider": "openai-codex" if os.path.exists("codex-usage") else "fixture", "name": "Fixture", "baseUrl": "PRIVATE"}
if os.path.exists("supports-images"):
    model["input"] = ["text", "image"]
thinking = "off"
emit({"type": "extension_ui_request", "method": "setStatus", "statusKey": "codex-fast", "statusText": "codex fast (requested)"})

if os.path.exists("lsp-status"):
    emit({"type": "extension_ui_request", "method": "setStatus", "statusKey": "lsp", "statusText": "\x1b[36mLSP: 1/2 servers\x1b[39m"})

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
        if compact_after_settlement:
            compact_after_settlement = False
            emit({"type": "compaction_start", "reason": "manual"})
            compacted = True
            emit({"type": "compaction_end", "reason": "manual", "result": {"summary": "Summary"}, "aborted": False, "willRetry": False})
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
            if compacted:
                usage = {"tokens": 4000, "contextWindow": 100000, "percent": 4}
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
        extensions = [args[i + 1] for i, arg in enumerate(args) if arg == "--extension"]
        if os.path.exists("codex-usage") and len(extensions) > 1:
            commands.append({"name": "pi-web-codex-usage", "source": "extension", "sourceInfo": {"path": "/wrong/path" if os.path.exists("wrong-quota-path") else extensions[1]}})
        if os.path.exists("slash-commands.json"):
            with open("slash-commands.json") as file:
                commands += json.load(file)
        response(command, {"commands": commands})
    elif kind == "steer":
        response(command, {"disposition": "queued"})
        emit({"type": "message_end", "message": {"role": "user", "content": command["message"]}})
    elif kind == "prompt":
        text = command["message"]
        if command.get("images"):
            emit({"type": "message_end", "message": {"role": "user", "content": [{"type": "text", "text": text}] + command["images"]}})
            emit({"type": "message_end", "message": {"role": "toolResult", "content": [{"type": "text", "text": "PRIVATE_TOOL_TEXT"}] + command["images"]}})
            response(command, {"disposition": "handled"})
        elif text.startswith("/pi-web-codex-usage "):
            token = text.split(" ", 1)[1]
            reply = {"requestId": token, "status": "unavailable", "clear": False} if os.path.exists("quota-fail") else {"requestId": token, "status": "ok", "clear": False, "observedAt": 1800000000, "windows": [{"identity": "primary", "durationSeconds": 18000, "usedPercent": 72.5, "resetsAt": 1800003600}]}
            emit({"type": "extension_ui_request", "method": "notify", "message": "pi-web:codex-usage:v1:" + json.dumps(reply)})
            response(command, {"disposition": "handled"})
        elif text.startswith("/pi-web-history-head "):
            token = text.split(" ", 1)[1]
            head_count += 1
            if head_count == 2 and os.path.exists("history-race"):
                emit({"type": "message_end", "message": {"role": "user", "content": "LIVE_DURING_HISTORY"}})
            leaf_id = None
            if os.path.exists("formatter-history-leaf"):
                with open("formatter-history-leaf") as file:
                    leaf_id = file.read()
            emit({"type": "extension_ui_request", "id": "head-ui", "method": "notify", "message": "pi-web:history-head:v1:" + json.dumps({"status": "ok", "requestId": token, "head": {"sessionId": pi_id, "sessionFile": path, "leafId": leaf_id, "idle": not active}})})
            response(command, {"disposition": "handled"})
        elif text in ("/switch-session", "/switch-outside", "/switch-active", "/switch-start"):
            pi_id = "replacement-pi"
            path = os.path.join(os.getcwd() if text == "/switch-outside" else root, "replacement.jsonl")
            active = text == "/switch-active"
            start_after_state = text == "/switch-start"
            with open(path, "w") as file:
                file.write(json.dumps({"type": "session", "version": 3, "id": pi_id, "cwd": os.getcwd()}) + "\n")
            response(command, {"disposition": "handled"})
        elif text in ("/lsp-update", "/lsp-clear"):
            status = {"type": "extension_ui_request", "method": "setStatus", "statusKey": "lsp"}
            if text == "/lsp-update":
                status["statusText"] = "\x1b[33mLSP: 2/2 servers, 1 warning(s)\x1b[39m"
            emit(status)
            emit({"type": "extension_ui_request", "method": "setStatus", "statusKey": "unrelated", "statusText": "PRIVATE"})
            response(command, {"disposition": "handled"})
        elif text in ("/background-launch", "/background-complete"):
            if text == "/background-launch":
                emit({"type": "tool_execution_start", "toolName": "Agent", "toolCallId": "background-call", "args": {"prompt": "PRIVATE_PROMPT"}})
                emit({"type": "tool_execution_end", "toolName": "Agent", "toolCallId": "background-call", "isError": False, "result": {"content": [{"text": "PRIVATE_PATH"}], "details": {"agentId": "12345678-abcd-1234", "status": "background", "displayName": "Scout", "description": "Inspect events"}}})
            else:
                emit({"type": "entry_appended", "entry": {"type": "custom", "customType": "subagents:record", "data": {"id": "12345678-abcd-1234", "status": "completed", "result": "Verified result", "startedAt": 1000, "completedAt": 2000}}})
            response(command, {"disposition": "handled"})
        elif text in ("/workflow-launch", "/workflow-complete"):
            if text == "/workflow-launch":
                emit({"type": "tool_execution_end", "toolName": "SubagentWorkflow", "toolCallId": "workflow-call", "isError": False, "result": {"content": [{"text": "PRIVATE_SCRIPT"}], "details": {"taskId": "wf_012345abcdef"}}})
            else:
                emit({"type": "message_end", "message": {"role": "custom", "customType": "subagent-notification", "content": "PRIVATE_NOTIFICATION", "display": True, "details": {"id": "wf_012345abcdef", "description": "Workflow Review", "status": "completed", "resultPreview": "Workflow verified"}}})
            response(command, {"disposition": "handled"})
        elif text == "/background-crash":
            emit({"type": "tool_execution_end", "toolName": "Agent", "toolCallId": "crash-call", "isError": False, "result": {"details": {"agentId": "crash-agent", "status": "background", "displayName": "Worker"}}})
            sys.exit(0)
        elif text == "/settings":
            thinking = "high"
            emit({"type": "thinking_level_changed", "level": thinking})
            emit({"type": "extension_ui_request", "method": "setStatus", "statusKey": "unrelated", "statusText": "PRIVATE"})
            emit({"type": "extension_ui_request", "method": "setStatus", "statusKey": "codex-fast", "statusText": "\x00" + "é" * 300})
            response(command, {"disposition": "handled"})
        elif text == "compact-after-settlement":
            emit({"type": "agent_start"})
            response(command, {"disposition": "started"})
            active = False
            settled_once = True
            compact_after_settlement = True
            emit({"type": "agent_settled", "aborted": False})
        elif text in ("/compact", "compact-overflow", "compact-active"):
            manual = text == "/compact"
            active = not manual
            reason = "manual" if manual else "threshold" if text == "compact-active" else "overflow"
            if active:
                emit({"type": "agent_start"})
            emit({"type": "compaction_start", "reason": reason})
            compacted = True
            emit({"type": "compaction_end", "reason": reason, "result": {"summary": "Summary", "tokensBefore": 12500}, "aborted": False, "willRetry": text == "compact-overflow"})
            response(command, {"disposition": "handled" if manual else "started"})
        elif text in ("/handled", "/handled-fail"):
            fail_state = text == "/handled-fail"
            response(command, {"disposition": "handled"})
        else:
            if os.path.exists("history-pages"):
                user = {"role": "user", "content": text}
                emit({"type": "message_start", "message": user})
                emit({"type": "message_end", "message": user})
            active = True
            if os.path.exists("work-timing-delays"):
                time.sleep(0.08)
            emit({"type": "agent_start"})
            emit({"type": "message_start", "message": {"role": "assistant", "content": []}})
            emit({"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "contentIndex": 0, "delta": "Hello"}})
            if text != "no-prompt-ack":
                response(command, {"disposition": "started"})
            if text in ("format-multiple", "format-duplicate"):
                if text == "format-multiple":
                    emit({"type": "message_end", "message": {"role": "assistant", "stopReason": "toolUse", "content": [{"type": "thinking", "thinking": "PRIVATE_THINKING"}, {"type": "text", "text": "Earlier finding: restart is required."}]}})
                    emit({"type": "agent_end", "willRetry": True, "messages": []})
                    if os.path.exists("retry-agent-start"):
                        emit({"type": "agent_start"})
                    if os.path.exists("work-timing-delays"):
                        time.sleep(0.08)
                    emit({"type": "message_start", "message": {"role": "assistant", "content": []}})
                text = "complete"
            if text == "complete":
                emit({"type": "tool_execution_start", "toolCallId": "tool-1", "toolName": "read", "args": {"path": "fixture.txt"}})
                deadline = time.monotonic() + 5
                while os.path.exists("pause-tool") and time.monotonic() < deadline:
                    time.sleep(0.005)
                emit({"type": "tool_execution_end", "toolCallId": "tool-1", "toolName": "read", "result": {"content": [{"type": "text", "text": "fixture content"}]}, "isError": False})
                answer = "**Completed** safely.\n\n<script>unsafe()</script>\n\n![tracker](https://example.invalid/image)"
                if os.path.exists("coding-response.txt"):
                    with open("coding-response.txt", encoding="utf-8") as file:
                        answer = file.read()
                message = {"role": "assistant", "content": [{"type": "text", "text": answer}], "stopReason": "stop"}
                if os.path.exists("formatter-persist-history"):
                    stamp = time.time_ns() // 1_000_000
                    message["timestamp"] = stamp
                    user_id, answer_id = "user-" + str(stamp), "answer-" + str(stamp)
                    previous = None
                    if os.path.exists("formatter-history-leaf"):
                        with open("formatter-history-leaf") as file:
                            previous = file.read()
                    with open(path, "a") as file:
                        file.write(json.dumps({"type": "message", "id": user_id, "parentId": previous, "message": {"role": "user", "content": command["message"]}}) + "\n")
                        file.write(json.dumps({"type": "message", "id": answer_id, "parentId": user_id, "message": message}) + "\n")
                    with open("formatter-history-leaf", "w") as file:
                        file.write(answer_id)
                emit({"type": "message_end", "message": message})
                emit({"type": "agent_end", "messages": []})
                if os.path.exists("pause-final-settlement"):
                    open("final-answer-waiting", "w").close()
                    deadline = time.monotonic() + 5
                    while os.path.exists("pause-final-settlement") and time.monotonic() < deadline:
                        time.sleep(0.005)
                active = False
                settled_once = True
                emit({"type": "agent_settled", "aborted": False})
                if command["message"] == "format-duplicate":
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
