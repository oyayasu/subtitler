import importlib.util
from pathlib import Path
import unittest

path = Path(__file__).resolve().parents[1] / 'scripts/check_cargo.py'
spec = importlib.util.spec_from_file_location('check_cargo', path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class LockTests(unittest.TestCase):
    def exercise(self, replies):
        calls = []
        def execute(args):
            calls.append(args)
            return replies.pop(0)
        return module.check(execute), calls

    def test_valid_lock_needs_only_locked_check(self):
        code, calls = self.exercise([(0, '')])
        self.assertEqual(code, 0)
        self.assertEqual(len(calls), 1)
        self.assertIn('--locked', calls[0])

    def test_stale_lock_is_repaired_offline_then_verified(self):
        code, calls = self.exercise([(101, 'cannot update the lock file because --locked was passed'), (0, ''), (0, '')])
        self.assertEqual(code, 0)
        self.assertIn('--offline', calls[1])
        self.assertIn('--locked', calls[2])

    def test_real_compiler_error_is_not_retried(self):
        code, calls = self.exercise([(101, 'error[E0308]: mismatched types')])
        self.assertEqual(code, 101)
        self.assertEqual(len(calls), 1)

    def test_missing_cache_can_fetch_then_verify(self):
        code, calls = self.exercise([(101, 'lock file needs to be updated'), (101, 'failed to download dependency: attempting to make an HTTP request, but --offline was specified'), (0, ''), (0, '')])
        self.assertEqual(code, 0)
        self.assertNotIn('--offline', calls[2])
        self.assertIn('--locked', calls[3])

    def test_compiler_error_after_repair_stops(self):
        code, calls = self.exercise([(101, 'cannot update the lock file'), (101, 'error: expected semicolon')])
        self.assertEqual(code, 101)
        self.assertEqual(len(calls), 2)


if __name__ == '__main__':
    unittest.main()
