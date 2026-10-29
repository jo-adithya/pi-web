"""Opt-in macOS M0 history experiment: temporary synthetic sessions, no provider calls."""
import argparse
import hashlib
import importlib.util
import json
import pathlib
import re
import subprocess
import sys
import tempfile
import time


def digest(path):
    """Hash a fixture incrementally to detect writes by the projection executable."""
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def fixture(path, cwd, large_bytes, large_metadata=False, dense_blocks=False):
    """Create a v3 tree stressing token sizes or retained decoded-object overhead."""
    stamp = '2026-10-29T00:00:00.000Z'
    with path.open('w') as stream:
        def entry(value):
            stream.write(json.dumps(value, separators=(',', ':'))+'\n')
        entry({'type':'session','version':3,'id':'00000000-0000-4000-8000-000000000001','timestamp':stamp,'cwd':str(cwd)})
        parent = None
        for i in range(600):
            ident = f'{i:08x}'
            if i == 590:
                entry({'type':'message','id':'deadbeef','parentId':parent,'timestamp':stamp,
                       'message':{'role':'user','content':'ABANDONED','timestamp':1793232000000}})
            if i == 595:
                stream.write('{"type":"message","id":')
                if large_metadata:
                    stream.write('"')
                    for _ in range(large_bytes//4096): stream.write('m'*4096)
                    stream.write('","parentId":'+json.dumps(parent)+',"timestamp":'+json.dumps(stamp))
                    stream.write(',"message":{"role":"user","content":"metadata stress","timestamp":1793232000000}}\n')
                    # Keep the stress record abandoned: its enormous ID must never be retained.
                else:
                    stream.write(json.dumps(ident)+',"parentId":'+json.dumps(parent)+',"timestamp":'+json.dumps(stamp))
                    stream.write(',"message":{"role":"user","content":"')
                    for _ in range(large_bytes//4096): stream.write('x'*4096)
                    stream.write('","timestamp":1793232000000}}\n')
                    parent = ident
                    continue
            content = [{'type':'text','text':'x'}]*2000 if dense_blocks else f'ROW_{i} '+'a'*4096
            message = {'role':'user','content':content,'timestamp':1793232000000}
            if i == 0:
                message = {'role':'assistant','content':[{'type':'text','text':'ROW_0'}],
                           'timestamp':1793232000000,'api':'openai-codex-responses',
                           'provider':'openai-codex','model':'gpt-6-astra','stopReason':'stop',
                           'usage':{'input':0,'output':0,'cacheRead':0,'cacheWrite':0,'totalTokens':0,
                                    'cost':{'input':0,'output':0,'cacheRead':0,'cacheWrite':0,'total':0}}}
            entry({'type':'message','id':ident,'parentId':parent,'timestamp':stamp,'message':message})
            parent = ident
    return parent


def preview_nodes(value):
    """Count retained JSON values and object keys independently of serialized size."""
    if isinstance(value,dict): return 1+len(value)+sum(preview_nodes(v) for v in value.values())
    if isinstance(value,list): return 1+sum(preview_nodes(v) for v in value)
    return 1


def measure(binary, path, leaf, expected_start=100):
    """Run only the Rust projection under macOS time; assert ordered active-branch output."""
    before = digest(path)
    started = time.monotonic()
    run = subprocess.run(['/usr/bin/time','-l',str(binary),str(path),leaf],capture_output=True,text=True,timeout=90)
    projection_seconds = time.monotonic() - started
    if run.returncode: raise RuntimeError(run.stderr[-1000:])
    projection = json.loads(run.stdout)
    if expected_start is None: expected_start = 600-len(projection['entries'])
    assert 0 < len(projection['entries']) <= 500
    assert [e['id'] for e in projection['entries']] == [f'{i:08x}' for i in range(expected_start,600)]
    assert sum(len(json.dumps(e,separators=(',',':')).encode()) for e in projection['entries']) <= 8*1024*1024
    nodes = sum(preview_nodes(e) for e in projection['entries'])
    assert nodes <= 16*1024
    assert projection['older_history'] is True
    assert digest(path) == before, 'projection modified the Pi file'
    rss = re.search(r'(\d+)\s+maximum resident set size', run.stderr)
    if not rss: raise RuntimeError('macOS /usr/bin/time RSS format unavailable')
    return {'file_bytes':path.stat().st_size,'projection_seconds':round(projection_seconds,3),
            'projection_peak_rss_bytes':int(rss[1]),'projection_json_bytes':len(run.stdout.encode()),
            'entries':len(projection['entries']),'retained_nodes':nodes,'older_history':True,
            'clipped_records':sum(e.get('truncated',False) for e in projection['entries'])}


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--run',action='store_true',help='Launch local Pi and projection processes on disposable fixtures')
parser.add_argument('--probe',type=pathlib.Path,required=True,help='Release-built history_probe executable')
args = parser.parse_args()
if not args.run or not args.probe.is_file(): parser.error('--run and an existing --probe executable are required')
if sys.platform != 'darwin': parser.error('RSS measurement currently requires macOS /usr/bin/time')
sys.dont_write_bytecode = True
from history_head import EXTENSION, get_head, require_head_command
spec = importlib.util.spec_from_file_location('rpc_probe',pathlib.Path(__file__).with_name('m0-rpc-smoke.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
report = {'cases':{}}
with tempfile.TemporaryDirectory(prefix='pi-web-history-') as directory:
    root = pathlib.Path(directory)
    for name,size,metadata,dense in [('small_payload',512*1024,False,False),('large_payload',32*1024*1024,False,False),('large_metadata',32*1024*1024,True,False),('dense_blocks',0,False,True)]:
        path = root/(name+'.jsonl')
        fixture(path,root,size,metadata,dense)
        result = {}
        # Query bounded identity from the adapter, never a transcript aggregate/cursor.
        before_load = digest(path)
        probe = module.Probe(root,path,['--no-extensions','--extension',str(EXTENSION)])
        try:
            state = probe.response(probe.send('get_state'),60)
            require_head_command(probe)
            head = get_head(probe)
            assert head['idle'] and head['sessionId'] == state['sessionId']
            assert pathlib.Path(head['sessionFile']).resolve() == path.resolve()
            ready_seconds = round(time.monotonic()-probe.started,3)
            before_stat = path.stat()
            result = measure(args.probe.resolve(),path,head['leafId'],None if dense else 100)
            after = get_head(probe)
            after_stat = path.stat()
            assert after == head, 'head changed: discard this projection'
            assert all(getattr(before_stat,key) == getattr(after_stat,key)
                       for key in ('st_dev','st_ino','st_size','st_mtime_ns','st_ctime_ns'))
            result['pi_ready_seconds'] = ready_seconds
            result['pi_message_count'] = state['messageCount']
            result['head_json_bytes'] = len(json.dumps(after).encode())
            result['native_ready_and_leaf_matched'] = True
            result['file_unchanged_after_pi_load'] = digest(path) == before_load
            result['stable_head_and_file_after_projection'] = True
            assert not any(r.get('type') in ('agent_start','extension_error') for r in probe.events)
            assert not any(r.get('command') in ('get_entries','get_messages') for r in probe.events)
        finally:
            result['pi_exit_code'] = probe.close()
        assert result['pi_exit_code'] == 0, result
        report['cases'][name] = result
    report['large_payload_rss_growth_bytes'] = report['cases']['large_payload']['projection_peak_rss_bytes']-report['cases']['small_payload']['projection_peak_rss_bytes']
    report['metadata_rss_growth_bytes'] = report['cases']['large_metadata']['projection_peak_rss_bytes']-report['cases']['small_payload']['projection_peak_rss_bytes']
    report['provider_requests'] = 0
    report['m0_gate_status'] = 'incomplete: concurrent history/live handoff and remaining lifecycle cases require validation'
    print(json.dumps(report,indent=2))
