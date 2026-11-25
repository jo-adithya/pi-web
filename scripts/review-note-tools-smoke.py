"""Opt-in no-model probe of the bundled note adapter against installed Pi-Bolt RPC."""
import argparse
import importlib.util
import json
import pathlib
import sys
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--run", action="store_true", help="Launch a disposable offline Pi-Bolt; no model requests")
args = parser.parse_args()
if not args.run:
    parser.error("--run is required")
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("rpc_probe", pathlib.Path(__file__).with_name("m0-rpc-smoke.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
adapter = pathlib.Path(__file__).resolve().parents[1] / "apps/server/pi/review-notes.ts"
report = {}
with tempfile.TemporaryDirectory(prefix="pi-note-tool-smoke-") as directory:
    root = pathlib.Path(directory)
    extension = root / "probe.ts"
    extension.write_text('import register from ' + json.dumps(str(adapter)) + ''';
export default function(pi) {
  const tools = new Map(), events = new Map();
  register({
    registerTool(tool) { tools.set(tool.name, tool); pi.registerTool(tool); },
    getActiveTools: () => pi.getActiveTools(),
    setActiveTools: names => pi.setActiveTools(names),
    on(name, handler) { events.set(name, handler); pi.on(name, handler); },
  });
  pi.registerCommand("pi-web-note-tool-probe", { description: "No-model adapter probe", handler: async (_args, ctx) => {
    if (pi.getActiveTools().some(name => tools.has(name))) throw new Error("Notes initially active");
    await events.get("before_agent_start")({prompt:"Implement\\n[Pi Web review notes turn epoch:1]"});
    if (![...tools.keys()].every(name => pi.getActiveTools().includes(name))) throw new Error("Tools did not activate: " + JSON.stringify({active:pi.getActiveTools(),registered:pi.getAllTools().filter(tool=>tools.has(tool.name)).map(tool=>({name:tool.name,exposure:tool.exposure}))}));
    const result = await tools.get("record_review_note").execute("probe", {
      id:"retry", note:{path:"a.ts",side:"new",line:2,quote:"new",text:"Keep retries."}
    }, undefined, undefined, ctx);
    events.get("agent_settled")();
    if (pi.getActiveTools().some(name => tools.has(name))) throw new Error("Tools remained active");
    ctx.ui.notify("note-probe:" + result.content[0].text, "info");
  }});
}
''')
    def respond(request):
        assert request["method"] == "input"
        assert request.get("timeout") == 15000
        prefix = "pi-web:review-note:v1:"
        assert request["title"].startswith(prefix)
        payload = json.loads(request["title"][len(prefix):])
        assert payload["turn"] == "epoch:1" and payload["operation"]["action"] == "record"
        assert payload["operation"]["note"]["quote"] == "new"
        report["private_round_trip"] = True
        return {"value": json.dumps({"data": {"id": "retry", "version": 1}})}
    probe = module.Probe(root, root / "session.jsonl", ["--no-extensions", "--extension", str(extension)], respond, tools=None)
    try:
        report["stage"] = "startup"
        probe.response(probe.send("get_state"), 40)
        report["stage"] = "commands"
        commands = probe.response(probe.send("get_commands"), 10)["commands"]
        assert any(command["name"] == "pi-web-note-tool-probe" and pathlib.Path(command["sourceInfo"]["path"]).resolve() == extension for command in commands), "Probe command must be loaded before sending any prompt"
        report["stage"] = "tool round trip"
        probe.response(probe.send("prompt", message="/pi-web-note-tool-probe"), 20)
        assert not any(event.get("type") == "extension_error" for event in probe.events), "Native adapter reported an extension error"
        receipt = probe.until(lambda event: event.get("method") == "notify" and event.get("message", "").startswith("note-probe:"), 10)
        assert json.loads(receipt["message"][len("note-probe:"):]) == {"id": "retry", "version": 1}
        assert not any(event.get("type") in ("agent_start", "extension_error") for event in probe.events)
        report.update(passed=True, no_model_calls=True)
    except Exception as error:
        report.update(passed=False, failure=str(error), event_types=[event.get("type") for event in probe.events[-10:]])
        report["extension_errors"] = [str(event.get("error", ""))[:500] for event in probe.events if event.get("type") == "extension_error"]
    finally:
        report["exit_code"] = probe.close()
        print(json.dumps(report, indent=2))
sys.exit(0 if report.get("passed") else 1)
