"""Opt-in native Pi history-head contract checks on disposable sessions, without inference."""
import argparse
import hashlib
import importlib.util
import json
import pathlib
import sys
import tempfile


def digest(path):
    """Return the test file hash or absence, without treating a configured path as persisted."""
    if not path.exists():
        return None
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    """Verify private replies, identity changes, persistence and read-only behavior on native Pi."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', action='store_true', help='Launch local Pi on temporary fixtures; no model requests')
    args = parser.parse_args()
    if not args.run:
        parser.error('explicit --run required')
    sys.dont_write_bytecode = True
    from history_head import EXTENSION, get_head, request_head, require_head_command
    spec = importlib.util.spec_from_file_location('rpc_probe', pathlib.Path(__file__).with_name('m0-rpc-smoke.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    report = {'provider_requests': 0, 'profiles': {}}
    with tempfile.TemporaryDirectory(prefix='pi-web-head-') as directory:
        root = pathlib.Path(directory)
        for profile in ('isolated', 'user_extensions'):
            path = root / (profile + '.jsonl')
            stamp = '2026-10-29T00:00:00.000Z'
            path.write_text('\n'.join(json.dumps(entry) for entry in [
                {'type':'session', 'version':3, 'id':'00000000-0000-4000-8000-000000000001', 'timestamp':stamp, 'cwd':str(root)},
                {'type':'message', 'id':'00000001', 'parentId':None, 'timestamp':stamp,
                 'message':{'role':'user', 'content':'SAVED_FIXTURE', 'timestamp':1793232000000}},
            ]) + '\n')
            extra = ['--no-extensions'] if profile == 'isolated' else []
            probe = module.Probe(root, path, [*extra, '--extension', str(EXTENSION), '--session-dir', str(root / 'sessions')])
            case = {}
            try:
                state = probe.response(probe.send('get_state'), 40)
                require_head_command(probe)
                before = digest(path)
                head = get_head(probe)
                assert head['sessionId'] == state['sessionId']
                assert pathlib.Path(head['sessionFile']).resolve() == path.resolve()
                assert head['idle'] is True
                # Tiny fixture only: the aggregate is an oracle, never the production strategy.
                entries = probe.response(probe.send('get_entries'), 10)
                assert len(entries['entries']) < 20 and head['leafId'] == entries['leafId']
                for token in ('', 'bad token', 'x' * 65):
                    assert request_head(probe, token) == {'status':'error', 'requestId':None, 'code':'invalid_request'}
                assert digest(path) == before, 'head command changed the session file'
                assert get_head(probe) == head
                case['identity_and_leaf_match'] = True
                case['invalid_tokens_rejected'] = True
                case['head_commands_read_only'] = True
                if profile == 'isolated':
                    # Native Pi owns these deliberate test mutations. The adapter only samples them.
                    level = 'low' if state['thinkingLevel'] != 'low' else 'high'
                    probe.response(probe.send('set_thinking_level', level=level), 10)
                    changed = get_head(probe)
                    assert changed['leafId'] != head['leafId'] and changed['sessionId'] == head['sessionId']
                    case['changed_leaf_invalidates_checkpoint'] = True
                    result = probe.response(probe.send('new_session'), 20)
                    assert result['cancelled'] is False
                    state = probe.response(probe.send('get_state'), 10)
                    empty = get_head(probe)
                    assert empty['sessionId'] != head['sessionId'] and empty['sessionId'] == state['sessionId']
                    assert empty['sessionFile'] == state.get('sessionFile')
                    assert empty['sessionFile'] is None or not pathlib.Path(empty['sessionFile']).exists()
                    assert get_head(probe) == empty
                    case['new_unpersisted_session_identity'] = True
                assert not any(event.get('type') in ('agent_start', 'extension_error') for event in probe.events)
            finally:
                case['exit_code'] = probe.close()
            assert case['exit_code'] == 0
            report['profiles'][profile] = case
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
