"""Opt-in real-Pi migration/empty-session probe on tiny disposable fixtures; no inference."""
import argparse
import importlib.util
import json
import pathlib
import sys
import tempfile


def records(version, cwd, assistant=True):
    """Build a tiny historical format fixture; only Pi may migrate it after launch."""
    header = {'type':'session','version':version,'id':'00000000-0000-4000-8000-000000000001',
              'timestamp':'2026-10-29T00:00:00.000Z','cwd':str(cwd)}
    user = {'type':'message','timestamp':header['timestamp'],
            'message':{'role':'user','content':'ORIGINAL_HISTORY','timestamp':1793232000000}}
    answer = {'type':'message','timestamp':header['timestamp'],
              'message':{'role':'assistant','content':[{'type':'text','text':'SAVED_ANSWER'}],
                         'api':'openai-codex-responses','provider':'openai-codex','model':'gpt-6-astra',
                         'stopReason':'stop','timestamp':1793232000000,
                         'usage':{'input':0,'output':0,'cacheRead':0,'cacheWrite':0,'totalTokens':0,
                                  'cost':{'input':0,'output':0,'cacheRead':0,'cacheWrite':0,'total':0}}}}
    entries = [user,answer] if assistant else [user]
    if version >= 2:
        for i,entry in enumerate(entries):
            entry['id'] = f'{i+1:08x}'
            entry['parentId'] = f'{i:08x}' if i else None
    if version == 2:
        entries.append({'type':'message','id':'00000003','parentId':'00000002','timestamp':header['timestamp'],
                        'message':{'role':'hookMessage','customType':'fixture','content':'LEGACY_CUSTOM',
                                   'display':True,'timestamp':1793232000000}})
    return [header,*entries]


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--run',action='store_true',help='Launch Pi on temporary historical session files')
args = parser.parse_args()
if not args.run: parser.error('explicit --run required')
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('rpc_probe',pathlib.Path(__file__).with_name('m0-rpc-smoke.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
report = {}
with tempfile.TemporaryDirectory(prefix='pi-web-lifecycle-') as directory:
    root = pathlib.Path(directory)
    for name,version,assistant in [('v1',1,True),('v2',2,True),('no_assistant',3,False),('new_empty',None,False)]:
        path = root/(name+'.jsonl')
        if version is not None:
            path.write_text(''.join(json.dumps(e)+'\n' for e in records(version,root,assistant)))
        probe = module.Probe(root,path,['--no-extensions'])
        case = {}
        try:
            state = probe.response(probe.send('get_state'),40)
            assert not state['isStreaming'] and not state['isCompacting']
            # This aggregate command is restricted to these tiny fixed fixtures, never production history.
            entries = probe.response(probe.send('get_entries'),10)
            assert len(entries['entries']) < 20
            case['file_exists_after_ready'] = path.exists()
            disk = []
            if path.exists():
                assert path.stat().st_size < 64*1024
                disk = [json.loads(line) for line in path.read_text().splitlines()]
            case['disk_version_after_ready'] = disk[0].get('version') if disk else None
            case['disk_entry_count'] = len(disk)-1 if disk else 0
            case['memory_entry_count'] = len(entries['entries'])
            case['leaf_persisted'] = any(e.get('id') == entries['leafId'] for e in disk[1:])
            case['entry_types'] = [e['type'] for e in entries['entries']]
            if version in (1,2):
                assert case['disk_version_after_ready'] == 3
                assert all('id' in e and 'parentId' in e for e in disk[1:])
                assert disk[1]['message']['content'] == 'ORIGINAL_HISTORY'
                assert case['leaf_persisted']
                if version == 2:
                    assert disk[3]['message']['role'] == 'custom'
                case['migration_verified_before_projection'] = True
            elif version == 3:
                assert case['disk_entry_count'] == case['memory_entry_count'], case
                assert case['leaf_persisted'], case
                assert disk[1]['message']['content'] == 'ORIGINAL_HISTORY'
            else:
                assert not path.exists()
                assert not case['leaf_persisted']
            assert not any(e.get('type') == 'agent_start' for e in probe.events)
        finally:
            case['exit_code'] = probe.close()
        assert case['exit_code'] == 0, case
        report[name] = case
    report['provider_requests'] = 0
    print(json.dumps(report,indent=2))
