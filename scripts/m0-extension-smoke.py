"""Opt-in no-model checks of installed extension notifications and demo dialogs."""
import argparse
import importlib.util
import json
import pathlib
import sys
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--run', action='store_true', help='Launch Pi with global extensions')
parser.add_argument('--demo', type=pathlib.Path, required=True,
                    help='Installed Pi-Bolt examples/extensions/rpc-demo.ts')
args = parser.parse_args()
if not args.run or not args.demo.is_file():
    parser.error('--run and an existing --demo file are required')
# Keep this one-shot probe from creating repository-local bytecode artifacts.
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location(
    'rpc_probe', pathlib.Path(__file__).with_name('m0-rpc-smoke.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

report = {}
with tempfile.TemporaryDirectory(prefix='pi-web-extensions-') as directory:
    root = pathlib.Path(directory)
    probe = module.Probe(root, root/'session.jsonl',
                         ['--extension', str(args.demo.resolve())])
    try:
        probe.response(probe.send('get_state'), 40)
        commands = probe.response(probe.send('get_commands'), 10)['commands']
        report['command_sources'] = {
            c['name']: c.get('sourceInfo') for c in commands
            if c['name'] in ('lsp', 'rpc-input', 'rpc-editor')}
        required = {'lsp', 'rpc-input', 'rpc-editor', 'fast', 'notify'}
        assert required <= {c['name'] for c in commands}, 'required commands not loaded'
        report['commands'] = {}
        for command in ('/lsp status', '/lsp', '/fast status', '/notify status',
                        '/rpc-input', '/rpc-editor'):
            start = len(probe.events)
            response = probe.response(probe.send('prompt', message=command), 20)
            records = probe.events[start:]
            assert not any(r.get('type') == 'agent_start' for r in records)
            report['commands'][command] = {
                'response': response,
                'ui_methods': [r.get('method') for r in records
                               if r.get('type') == 'extension_ui_request']}
        start = len(probe.events)
        report['new_session'] = probe.response(probe.send('new_session'), 20)
        report['new_session_ui'] = [
            r.get('method') for r in probe.events[start:]
            if r.get('type') == 'extension_ui_request']
        assert 'input' in report['commands']['/rpc-input']['ui_methods']
        assert 'editor' in report['commands']['/rpc-editor']['ui_methods']
        assert 'confirm' in report['new_session_ui']
        assert report['new_session']['cancelled'] is True
        report['dialog_cancellation_notifications'] = [
            r.get('message') for r in probe.events
            if r.get('type') == 'extension_ui_request' and
            r.get('message') in ('Input cancelled', 'Editor cancelled', 'Clear cancelled')]
        assert len(report['dialog_cancellation_notifications']) == 3
        assert not any(r.get('type') == 'agent_start' for r in probe.events)
        report['passed'] = True
    except Exception as error:
        report['passed'] = False
        report['failure'] = str(error)
    finally:
        report['extension_error_count'] = sum(
            r.get('type') == 'extension_error' for r in probe.events)
        report['exit_code'] = probe.close()
        print(json.dumps(report, indent=2))
sys.exit(0 if report.get('passed') else 1)
