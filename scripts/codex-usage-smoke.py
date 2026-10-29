"""Opt-in native private-command smoke; non-Codex model, offline, no provider requests."""
import argparse
import importlib.util
import json
import pathlib
import sys
import tempfile


def main():
    """Verify canonical registration, private reply and handled disposition without inference."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', action='store_true')
    if not parser.parse_args().run:
        parser.error('explicit --run required')
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location('rpc_probe', pathlib.Path(__file__).with_name('m0-rpc-smoke.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    adapter = pathlib.Path(__file__).resolve().parents[1] / 'apps/server/pi/codex-usage.ts'
    with tempfile.TemporaryDirectory(prefix='pi-web-quota-') as directory:
        root = pathlib.Path(directory)
        probe = module.Probe(root, root / 'session.jsonl', [
            '--no-extensions', '--extension', str(adapter), '--session-dir', str(root / 'sessions'),
            '--provider', 'anthropic', '--model', 'claude-sonnet-4-5',
        ])
        try:
            state = probe.response(probe.send('get_state'), 40)
            # Gate before invoking the private command: this provider never enters the OAuth/fetch branch.
            assert state['model']['provider'] == 'anthropic'
            catalog = probe.response(probe.send('get_commands'), 10)
            commands = [c for c in catalog['commands'] if c['name'] == 'pi-web-codex-usage']
            assert len(commands) == 1 and commands[0]['source'] == 'extension'
            assert pathlib.Path(commands[0]['sourceInfo']['path']).resolve() == adapter.resolve()
            entries = probe.response(probe.send('get_entries'), 10)
            response = probe.response(probe.send('prompt', message='/pi-web-codex-usage smoke'), 10)
            assert response['disposition'] == 'handled'
            prefix = 'pi-web:codex-usage:v1:'
            event = probe.until(lambda e: e.get('method') == 'notify' and e.get('message', '').startswith(prefix), 10)
            assert json.loads(event['message'][len(prefix):]) == {'requestId': 'smoke', 'status': 'unavailable', 'clear': True}
            assert probe.response(probe.send('get_entries'), 10) == entries
            assert not any(e.get('type') in ('agent_start', 'message_start', 'extension_error') for e in probe.events)
        finally:
            exit_code = probe.close()
        assert exit_code == 0
    print(json.dumps({'registration': 'verified', 'private_reply': 'unavailable', 'disposition': 'handled', 'transcript_unchanged': True, 'provider_requests': 0, 'exit_code': exit_code}))


if __name__ == '__main__':
    main()
