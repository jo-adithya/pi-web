"""Opt-in native standard-dialog acceptance/cancellation; no provider requests or browser runtime."""
import argparse
import importlib.util
import json
import pathlib
import sys
import tempfile


def main():
    """Exercise all standard replies and explicitly cancel a held request as on controller loss."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', action='store_true', help='Launch a disposable Pi with a harmless dialog fixture')
    if not parser.parse_args().run:
        parser.error('explicit --run required')
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location('rpc_probe', pathlib.Path(__file__).with_name('m0-rpc-smoke.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    fixture = pathlib.Path(__file__).resolve().parents[1] / 'fixtures/pi/dialogs.ts'
    prefix = 'pi-web:test-dialog:'
    report = {'provider_requests': 0, 'checks': []}
    with tempfile.TemporaryDirectory(prefix='pi-web-dialog-') as directory:
        root = pathlib.Path(directory)
        probe = module.Probe(root, root / 'session.jsonl', ['--extension', str(fixture), '--session-dir', str(root / 'sessions')])
        try:
            probe.response(probe.send('get_state'), 60)
            commands = probe.response(probe.send('get_commands'), 20)['commands']
            matches = [command for command in commands if command.get('name') == 'pi-web-test-dialog']
            assert len(matches) == 1 and pathlib.Path(matches[0]['sourceInfo']['path']).resolve() == fixture
            for method, value in [('select', 'Second'), ('confirm', True), ('input', 'Hello 🦀'), ('editor', 'One\nTwo')]:
                for cancel in (False, True):
                    response = {'cancelled': True} if cancel else ({'confirmed': value} if method == 'confirm' else {'value': value})
                    probe.dialog_response = lambda request: response
                    start = len(probe.events)
                    ack = probe.response(probe.send('prompt', message='/pi-web-test-dialog ' + method), 20)
                    assert ack['disposition'] == 'handled'
                    notice = probe.until(lambda event: event.get('type') == 'extension_ui_request'
                                         and event.get('method') == 'notify' and event.get('message', '').startswith(prefix), 20, start)
                    reply = json.loads(notice['message'][len(prefix):])
                    expected = (False if method == 'confirm' else None) if cancel else value
                    assert reply == {'method': method, 'value': expected}
                    report['checks'].append(method + (' cancelled' if cancel else ' accepted'))
            # A browser disconnect must not close Pi stdin: cancel the pending ID instead.
            probe.dialog_response = lambda request: None
            start = len(probe.events)
            pending = probe.send('prompt', message='/pi-web-test-dialog input')
            request = probe.until(lambda event: event.get('type') == 'extension_ui_request'
                                  and event.get('method') == 'input', 20, start)
            assert not any(event.get('type') == 'response' and event.get('id') == pending for event in probe.events[start:])
            probe.p.stdin.write((json.dumps({'type':'extension_ui_response', 'id':request['id'], 'cancelled':True}) + '\n').encode())
            probe.p.stdin.flush()
            assert probe.response(pending, 20)['disposition'] == 'handled'
            assert not probe.response(probe.send('get_state'), 20)['isStreaming']
            assert probe.p.poll() is None
            report['held_dialog_cancelled_without_closing_child'] = True
            assert not any(event.get('type') in ('agent_start', 'extension_error') for event in probe.events)
        finally:
            report['exit_code'] = probe.close()
        assert report['exit_code'] == 0
    report['coverage_limit'] = 'RPC dialog behavior, not browser socket disconnect handling; M3 must implement and test that policy.'
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
