"""Opt-in M0 late-history/continuation experiment; --provider additionally uses one Codex prompt."""
import argparse
import importlib.util
import json
import pathlib
import subprocess
import sys
import tempfile


def fixture(path, cwd):
    """Write 600 active tiny messages plus a 32 MiB abandoned sibling, before Pi starts."""
    stamp = '2026-10-29T00:00:00.000Z'
    with path.open('w') as stream:
        def entry(value):
            stream.write(json.dumps(value, separators=(',', ':')) + '\n')
        entry({'type':'session', 'version':3, 'id':'00000000-0000-4000-8000-000000000001', 'timestamp':stamp, 'cwd':str(cwd)})
        for i in range(600):
            parent = f'{i-1:08x}' if i else None
            if i == 599:
                stream.write('{"type":"message","id":"deadbeef","parentId":"00000256","timestamp":"' + stamp + '","message":{"role":"user","content":"')
                for _ in range(8192):
                    stream.write('x' * 4096)
                stream.write('","timestamp":1793232000000}}\n')
            entry({'type':'message', 'id':f'{i:08x}', 'parentId':parent, 'timestamp':stamp,
                   'message':{'role':'user', 'content':f'ROW_{i}', 'timestamp':1793232000000}})


def stamp(path):
    """Capture file identity and mutation indicators, not just the pathname."""
    state = path.stat()
    return tuple(getattr(state, key) for key in ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns'))


def project(binary, path, head):
    """Project only the fixed synthetic fixture through the release-built Rust experiment."""
    run = subprocess.run([str(binary), str(path), head['leafId']], capture_output=True, text=True, timeout=60, check=True)
    assert len(run.stdout.encode()) < 8 * 1024 * 1024
    return json.loads(run.stdout)


def occurrences(projection, marker):
    """Count visible fixture markers in projected entries independently of their message shape."""
    return sum(marker in json.dumps(entry) for entry in projection['entries'])


def main():
    """Observe invalidation signals before adopting stale data, then optionally continue via Codex."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', action='store_true', help='Launch disposable Pi fixture with explicitly loaded test writer')
    parser.add_argument('--provider', action='store_true', help='Additionally authorize one configured Codex prompt')
    parser.add_argument('--probe', type=pathlib.Path, required=True, help='Release-built history_probe executable')
    args = parser.parse_args()
    if not args.run or not args.probe.is_file():
        parser.error('--run and an existing --probe are required')
    sys.dont_write_bytecode = True
    from history_head import EXTENSION, get_head, require_head_command
    spec = importlib.util.spec_from_file_location('rpc_probe', pathlib.Path(__file__).with_name('m0-rpc-smoke.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    writer = pathlib.Path(__file__).resolve().parents[1] / 'fixtures/pi/history-writer.ts'
    report = {'provider_requests': 0}
    with tempfile.TemporaryDirectory(prefix='pi-web-handoff-') as directory:
        root = pathlib.Path(directory)
        path = root / 'session.jsonl'
        fixture(path, root)
        report['initial_file_bytes'] = path.stat().st_size
        # The configured user extensions remain loaded, as in the intended profile.
        probe = module.Probe(root, path, ['--extension', str(EXTENSION), '--extension', str(writer), '--session-dir', str(root / 'sessions')])
        try:
            state = probe.response(probe.send('get_state'), 60)
            require_head_command(probe)
            commands = probe.response(probe.send('get_commands'), 20)['commands']
            matches = [command for command in commands if command.get('name') == 'pi-web-test-append']
            assert len(matches) == 1 and pathlib.Path(matches[0]['sourceInfo']['path']).resolve() == writer
            before = get_head(probe)
            with path.open('rb') as stream:
                stream.seek(-4096, 2)
                tail = [json.loads(line) for line in stream.read().splitlines()[1:]]
            controls = [entry for entry in tail if entry.get('type') == 'custom' and entry.get('customType') == 'pi-web-test-startup']
            assert len(controls) == 1 and controls[0]['data']['marker'] == 'STARTUP_CONTROL'
            assert before['leafId'] == tail[-1]['id'] and before['leafId'] != '00000257'
            report['startup_hook_control_persisted_before_checkpoint'] = True
            before_stamp = stamp(path)
            start = len(probe.events)
            stale = project(args.probe.resolve(), path, before)
            assert [entry['id'] for entry in stale['entries']] == [f'{i:08x}' for i in range(100, 600)]
            assert stale['older_history'] and occurrences(stale, 'LATE_VISIBLE') == 0
            # Deterministic worst case: worker has finished, but its result has not been adopted.
            ack = probe.response(probe.send('prompt', message='/pi-web-test-append'), 20)
            assert ack['disposition'] == 'handled'
            event = probe.until(lambda event: event.get('type') == 'message_end'
                                and event.get('message', {}).get('content') == 'LATE_VISIBLE', 20, start)
            assert event['message']['role'] == 'custom'
            after = get_head(probe)
            assert after['sessionId'] == before['sessionId'] and after['leafId'] != before['leafId']
            assert stamp(path) != before_stamp
            assert not any(event.get('type') == 'agent_start' for event in probe.events)
            # Every signal independently says to discard the stale result. Do not install it.
            report['late_history_invalidation_signals'] = ['live_message_end', 'changed_leaf', 'changed_file_stamp']
            refreshed_stamp = stamp(path)
            fresh = project(args.probe.resolve(), path, after)
            assert get_head(probe) == after and stamp(path) == refreshed_stamp
            assert occurrences(fresh, 'LATE_VISIBLE') == 1 and fresh['older_history']
            report['fresh_projection_contains_late_message_once'] = True
            if args.provider:
                assert state.get('model', {}).get('provider') == 'openai-codex', 'configured provider is not authorized Codex'
                report['model'] = {key:state['model'][key] for key in ('id', 'provider')}
                start = len(probe.events)
                report['provider_requests'] = 1
                ack = probe.response(probe.send('prompt', message='Reply with exactly LARGE_HISTORY_CONTINUED. Do not use tools.'), 120)
                assert ack['disposition'] == 'started'
                settled = probe.until(lambda event: event.get('type') == 'agent_settled', 120, start)
                assert not settled['aborted']
                finals = [event['message'] for event in probe.events[start:]
                          if event.get('type') == 'message_end' and event.get('message', {}).get('role') == 'assistant']
                assert any(message.get('stopReason') == 'stop' and any('LARGE_HISTORY_CONTINUED' in block.get('text', '')
                           for block in message.get('content', [])) for message in finals)
                assert not any(event.get('type') == 'tool_execution_start' for event in probe.events[start:])
                head = get_head(probe)
                assert head['idle'] and head['sessionId'] == before['sessionId']
                continued = project(args.probe.resolve(), path, head)
                assert occurrences(continued, 'LARGE_HISTORY_CONTINUED') == 2  # user request + assistant answer
                assert occurrences(continued, 'LATE_VISIBLE') == 1
                assert continued['older_history'] and len(continued['entries']) <= 500
                report['large_history_provider_continuation'] = True
            assert not any(event.get('type') == 'extension_error' for event in probe.events)
        finally:
            report['exit_code'] = probe.close()
        assert report['exit_code'] == 0
    report['coverage_limit'] = 'Native signals and projection experiment only; production runtime adoption/reconnect is not implemented.'
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
