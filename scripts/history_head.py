"""Private history-head client for opt-in M0 probes; never exposes paths in reports."""
import json
import pathlib

EXTENSION = pathlib.Path(__file__).resolve().parents[1] / 'apps/server/pi/history-head.ts'
PREFIX = 'pi-web:history-head:v1:'
COMMAND = 'pi-web-history-head'


def require_head_command(probe):
    """Check command provenance before dispatch; a missing slash command could invoke a model."""
    commands = probe.response(probe.send('get_commands'), 20)['commands']
    matches = [command for command in commands if command.get('name') == COMMAND]
    assert len(matches) == 1, 'private head command missing or ambiguous'
    command = matches[0]
    assert command.get('source') == 'extension'
    assert pathlib.Path(command['sourceInfo']['path']).resolve() == EXTENSION


def request_head(probe, token=None):
    """Return a validated, correlated private reply, bounded to 8 KiB UTF-8.

    Call require_head_command first. Only this smoke client accepts an explicit
    invalid token for negative tests. Sampling is a checkpoint, not a write lock.
    """
    if token is None:
        token = 'head-' + str(probe.counter + 1)
    start = len(probe.events)
    ack = probe.response(probe.send('prompt', message='/' + COMMAND + ' ' + token), 20)
    assert ack['disposition'] == 'handled', 'metadata command must not start inference'
    event = probe.until(lambda event: event.get('type') == 'extension_ui_request'
                        and event.get('method') == 'notify'
                        and event.get('message', '').startswith(PREFIX), 20, start)
    message = event['message']
    assert len(message.encode()) <= 8192
    reply = json.loads(message[len(PREFIX):])
    assert reply['status'] in ('ok', 'error')
    if reply['status'] == 'error':
        assert reply['code'] in ('invalid_request', 'metadata_limit', 'metadata_unavailable')
        assert reply['requestId'] == (None if reply['code'] == 'invalid_request' else token)
    else:
        assert reply['requestId'] == token
        head = reply['head']
        assert type(head['idle']) is bool
        for key, limit, nullable in [('sessionId', 1024, False), ('sessionFile', 4096, True), ('leafId', 1024, True)]:
            value = head[key]
            assert (nullable and value is None) or (isinstance(value, str) and 0 < len(value.encode()) <= limit)
    return reply


def get_head(probe):
    """Sample a successful head; fail explicitly rather than substituting empty history."""
    reply = request_head(probe)
    assert reply['status'] == 'ok', reply
    return reply['head']
