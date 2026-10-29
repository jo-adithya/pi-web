"""No-process regression tests for the opt-in smoke harness cleanup."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import subprocess
import sys
import unittest
from unittest.mock import Mock, patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('rpc_probe', Path(__file__).with_name('m0-rpc-smoke.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class CleanupTests(unittest.TestCase):
    """A reaped empty group is clean; permission denial for live members remains a failure."""

    def probe(self):
        probe = module.Probe.__new__(module.Probe)
        probe.closed = False
        probe.p = SimpleNamespace(pid=123, returncode=0, wait=Mock(), stdin=Mock(), stdout=Mock(), stderr=Mock())
        probe.sel = Mock()
        return probe

    def test_permission_denied_for_absent_group_is_already_clean(self):
        probe = self.probe()
        with patch.object(module.os, 'killpg', side_effect=PermissionError), patch.object(
            module.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, '10 10\n')
        ):
            self.assertEqual(probe.close(), 0)
        probe.sel.close.assert_called_once()
        probe.p.stdout.close.assert_called_once()
        probe.p.stderr.close.assert_called_once()

    def test_permission_denied_for_remaining_group_is_reported(self):
        probe = self.probe()
        with patch.object(module.os, 'killpg', side_effect=PermissionError), patch.object(
            module.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, '124 123\n')
        ):
            with self.assertRaises(PermissionError):
                probe.close()


if __name__ == '__main__':
    unittest.main()
