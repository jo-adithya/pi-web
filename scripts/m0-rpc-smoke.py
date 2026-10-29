"""Opt-in disposable Pi RPC contract probe; never prints raw prompts or credentials."""
import argparse, collections, json, os, pathlib, selectors, signal, subprocess, sys, tempfile, time

class Probe:
    """Drain bounded RPC records and stderr while retaining only test-sized event history."""
    def __init__(self, cwd, session, extra_args=(), dialog_response=None):
        """Default to cancelling dialogs; an explicit test responder may return None to hold one."""
        self.dialog_response = dialog_response or (lambda request: {'cancelled': True})
        self.started = time.monotonic()
        self.p = subprocess.Popen(['pi-bolt', '--mode', 'rpc', '--session', str(session), '--no-context-files', '--no-skills', '--no-prompt-templates', '--no-mcp', '--tools', 'read', '--offline', *extra_args], cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        self.sel = selectors.DefaultSelector()
        self.sel.register(self.p.stdout, selectors.EVENT_READ, 'out')
        self.sel.register(self.p.stderr, selectors.EVENT_READ, 'err')
        self.buf = b''; self.err = b''; self.events = []; self.counter = 0; self.total_bytes = 0
        self.closed = False
    def send(self, kind, **data):
        self.counter += 1
        ident = 'probe-' + str(self.counter)
        self.p.stdin.write((json.dumps(dict(type=kind,id=ident,**data))+'\n').encode()); self.p.stdin.flush()
        return ident
    def until(self, predicate, timeout=90, start=0):
        deadline = time.monotonic()+timeout
        checked=start
        while True:
            for record in self.events[checked:]:
                if predicate(record): return record
            checked=len(self.events)
            if time.monotonic() >= deadline: raise TimeoutError('RPC wait deadline exceeded')
            for key,_ in self.sel.select(min(1,max(0,deadline-time.monotonic()))):
                chunk=os.read(key.fileobj.fileno(),65536)
                if not chunk:
                    self.sel.unregister(key.fileobj)
                    if key.data=='out': raise RuntimeError('RPC stdout EOF')
                    continue
                if key.data=='err': self.err=(self.err+chunk)[-65536:]; continue
                self.total_bytes += len(chunk)
                if self.total_bytes > 16*1024*1024: raise RuntimeError('probe total output budget exceeded')
                self.buf+=chunk
                if len(self.buf)>4*1024*1024: raise RuntimeError('probe record budget exceeded')
                while b'\n' in self.buf:
                    line,self.buf=self.buf.split(b'\n',1)
                    r=json.loads(line.rstrip(b'\r'))
                    self.events.append(r)
                    if len(self.events)>10000: raise RuntimeError('probe event budget exceeded')
                    if r.get('type')=='extension_ui_request' and r.get('method') in ('confirm','select','input','editor'):
                        response = self.dialog_response(r)
                        if response is not None:
                            self.p.stdin.write((json.dumps({'type':'extension_ui_response', **response, 'id':r['id']})+'\n').encode());self.p.stdin.flush()
    def response(self, ident, timeout=90):
        r=self.until(lambda r:r.get('type')=='response' and r.get('id')==ident,timeout)
        if not r.get('success'): raise RuntimeError('command rejected: '+str(r.get('command'))+' '+str(r.get('error'))[:300])
        return r.get('data')
    def close(self):
        """Close stdin, reap the child, and terminate remaining test-owned group members."""
        if self.closed: return self.p.returncode
        self.closed = True
        self.p.stdin.close()
        try:self.p.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(self.p.pid,signal.SIGTERM)
            try:self.p.wait(timeout=5)
            except subprocess.TimeoutExpired:os.killpg(self.p.pid,signal.SIGKILL);self.p.wait(timeout=5)
        # Reap the launcher and terminate any remaining descendants in its group.
        try:
            os.killpg(self.p.pid,signal.SIGTERM)
        except ProcessLookupError:
            pass
        except PermissionError:
            # Native Pi can leave an empty group that returns EPERM after reaping.
            # Confirm absence; never swallow a denied signal to surviving members.
            groups = subprocess.run(['ps','-axo','pid=,pgid='],capture_output=True,text=True,check=True,timeout=5)
            if any(int(row.split()[1]) == self.p.pid for row in groups.stdout.splitlines()):
                raise
        finally:
            self.sel.close(); self.p.stdout.close(); self.p.stderr.close()
        return self.p.returncode

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', action='store_true', help='Authorize up to three Codex prompts using subscription quota')
    args = parser.parse_args()
    if not args.run:
        parser.error('explicit --run required; this probe consumes subscription quota')

    report={}
    with tempfile.TemporaryDirectory(prefix='pi-web-m0-') as directory:
        root=pathlib.Path(directory); fixture=root/'fixture.txt'; fixture.write_text('PI_WEB_M0_READ_OK\n'); session=root/'session.jsonl'
        probe=Probe(root,session)
        try:
            state=probe.response(probe.send('get_state'),40)
            report['ready_seconds']=round(time.monotonic()-probe.started,3)
            report['model']={k:state.get('model',{}).get(k) for k in ('id','provider')}
            report['thinkingLevel']=state.get('thinkingLevel')
            if report['model']['provider']!='openai-codex':raise RuntimeError('default provider is not authorized Codex')
            commands=probe.response(probe.send('get_commands'),20)
            report['command_names']=[x.get('name') for x in commands.get('commands',[])]
            start=len(probe.events); t=time.monotonic()
            ack=probe.response(probe.send('prompt',message='Read only ./fixture.txt using the read tool, then reply with the exact marker in that file as one short Markdown bullet. Do not call any other tool or inspect other files.'),120)
            report['prompt_ack']=ack
            settled=probe.until(lambda r:r.get('type')=='agent_settled',120,start)
            first=probe.events[start:]
            report['prompt_seconds']=round(time.monotonic()-t,3)
            report['first_settled']=settled
            report['first_events']=dict(collections.Counter(r.get('type') for r in first))
            report['tools']=[{'name':r.get('toolName'),'isError':r.get('isError')} for r in first if r.get('type')=='tool_execution_end']
            finals=[r['message'] for r in first if r.get('type')=='message_end' and r.get('message',{}).get('role')=='assistant']
            report['assistant_stops']=[r.get('stopReason') for r in finals]
            report['provider_errors']=[r.get('errorMessage','')[:300] for r in finals if r.get('stopReason')=='error']
            assert any(x['name']=='read' and not x['isError'] for x in report['tools']), 'no successful read tool'
            assert any('PI_WEB_M0_READ_OK' in c.get('text','') for r in finals for c in r.get('content',[])), 'marker missing'
            start=len(probe.events)
            probe.response(probe.send('prompt',message='Do not use tools. Start immediately with a numbered list of 300 short sentences about arithmetic, one per line. Continue until all 300 are written.'),120)
            probe.until(lambda r:r.get('type')=='message_update' and r.get('assistantMessageEvent',{}).get('type')=='text_delta',120,start)
            active=probe.response(probe.send('get_state'),10)
            assert active['isStreaming'], 'run ended before active abort'
            probe.response(probe.send('follow_up',message='This queued message should be cleared, never executed.'),10)
            report['clear_queue']=probe.response(probe.send('clear_queue'),10)
            t=time.monotonic(); report['abort_response']=probe.response(probe.send('abort'),45)
            report['abort_settled']=probe.until(lambda r:r.get('type')=='agent_settled',10,start)
            report['abort_seconds']=round(time.monotonic()-t,3)
            assert report['abort_settled']['aborted'] is True
            state=probe.response(probe.send('get_state'),10)
            report['post_abort']={k:state.get(k) for k in ('isStreaming','pendingMessageCount')}
            assert state['isStreaming'] is False and state['pendingMessageCount']==0
            start=len(probe.events)
            probe.response(probe.send('prompt',message='Reply with exactly RECOVERY_OK. Do not use tools.'),120)
            report['recovery_settled']=probe.until(lambda r:r.get('type')=='agent_settled',120,start)
            report['recovery_ok']=any(r.get('type')=='message_end' and r.get('message',{}).get('role')=='assistant' and any('RECOVERY_OK' in c.get('text','') for c in r['message'].get('content',[])) for r in probe.events[start:])
            assert report['recovery_ok']
            report['session_persisted']=session.is_file()
            assert report['session_persisted']
            original_id = state['sessionId']
            probe.close()
            resumed = Probe(root, session)
            try:
                state = resumed.response(resumed.send('get_state'),40)
                assert state['sessionId'] == original_id and not state['isStreaming']
                # This fixture is tiny: never use aggregate messages for production history.
                messages = resumed.response(resumed.send('get_messages'),10)['messages']
                assert any('RECOVERY_OK' in block.get('text','') for message in messages
                           if message.get('role') == 'assistant' for block in message.get('content',[]))
                report['resume_same_session'] = True
                report['resume_message_count'] = state['messageCount']
            finally:
                report['resume_exit_code'] = resumed.close()
            report['passed']=True
        except Exception as e:
            report['passed']=False;report['failure']=str(e)
        finally:
            report['extension_errors']=[{'event':r.get('event'),'error':str(r.get('error'))[:300]} for r in probe.events if r.get('type')=='extension_error']
            report['stderr_bytes_retained']=len(probe.err)
            report['lsp_peer_dependency_warning']=b'Host-provided extension packages must be declared' in probe.err
            report['exit_code']=probe.close()
            report['total_seconds']=round(time.monotonic()-probe.started,3)
            print(json.dumps(report,indent=2))

    sys.exit(0 if report.get('passed') else 1)
