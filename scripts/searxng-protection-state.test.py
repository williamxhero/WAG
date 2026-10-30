#!/usr/bin/env python3
"""
Tests for searxng-protection-state.py CLI adapter
"""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


class TestProtectionStateCli(unittest.TestCase):
    """Test the CLI adapter's command-line interface"""

    def setUp(self):
        """Create temporary directories for testing"""
        self.temp_dir = tempfile.mkdtemp()
        self.test_root = Path(self.temp_dir) / 'store'
        self.test_root.mkdir()
        
        self.manifest_path = Path(self.temp_dir) / 'manifest.json'
        manifest = {
            'schema': 'wag.protection-artifact.v2',
            'contract': 'wag.outbound.v2',
            'mode': 'synthetic',
            'fork_commit': '0' * 40,
            'artifact_digest': '0' * 64,
            'registry_digest': '0' * 64,
            'config_digest': '0' * 64,
            'python_digest': '0' * 64,
            'module_root': '/test/module',
            'python_executable': sys.executable,
            'root': str(self.test_root),
            'shared_gid': 1000,
            'allowed_uids': [0, 1000],
            'files': {},
            'distributions': {},
            'wheels': {},
            'registry': []
        }
        self.manifest_path.write_text(json.dumps(manifest, indent=2))

    def tearDown(self):
        """Clean up temporary directories"""
        import shutil
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_cli_requires_command(self):
        """CLI should require a command"""
        result = subprocess.run(
            [sys.executable, 'scripts/searxng-protection-state.py'],
            capture_output=True,
            text=True
        )
        self.assertEqual(result.returncode, 2)

    def test_snapshot_requires_root(self):
        """snapshot command should require --root"""
        result = subprocess.run(
            [sys.executable, 'scripts/searxng-protection-state.py', 'snapshot'],
            capture_output=True,
            text=True
        )
        self.assertEqual(result.returncode, 2)

    def test_snapshot_requires_manifest(self):
        """snapshot command should require --manifest"""
        result = subprocess.run(
            [
                sys.executable, 
                'scripts/searxng-protection-state.py', 
                'snapshot',
                '--root', str(self.test_root)
            ],
            capture_output=True,
            text=True
        )
        self.assertEqual(result.returncode, 2)

    def test_snapshot_with_valid_inputs(self):
        """snapshot should accept valid inputs and return JSON"""
        result = subprocess.run(
            [
                sys.executable,
                'scripts/searxng-protection-state.py',
                'snapshot',
                '--root', str(self.test_root),
                '--manifest', str(self.manifest_path)
            ],
            capture_output=True,
            text=True
        )
        
        # Should succeed (exit 0 or 1 for typed failure)
        self.assertIn(result.returncode, [0, 1])
        
        # Should return valid JSON
        try:
            response = json.loads(result.stdout)
            self.assertIsInstance(response, dict)
        except json.JSONDecodeError:
            self.fail(f'Invalid JSON output: {result.stdout}')

    def test_snapshot_nonexistent_root(self):
        """snapshot should return typed failure for nonexistent root"""
        result = subprocess.run(
            [
                sys.executable,
                'scripts/searxng-protection-state.py',
                'snapshot',
                '--root', '/nonexistent',
                '--manifest', str(self.manifest_path)
            ],
            capture_output=True,
            text=True
        )
        
        self.assertEqual(result.returncode, 1)
        response = json.loads(result.stdout)
        self.assertTrue(response.get('error'))
        self.assertEqual(response.get('reason'), 'root_not_found')

    def test_consume_release_ingress_requires_release_id(self):
        """consume-release-ingress should require --release-id"""
        result = subprocess.run(
            [
                sys.executable,
                'scripts/searxng-protection-state.py',
                'consume-release-ingress',
                '--root', str(self.test_root),
                '--manifest', str(self.manifest_path)
            ],
            capture_output=True,
            text=True
        )
        self.assertEqual(result.returncode, 2)

    def test_consume_release_ingress_with_valid_inputs(self):
        """consume-release-ingress should accept valid inputs"""
        result = subprocess.run(
            [
                sys.executable,
                'scripts/searxng-protection-state.py',
                'consume-release-ingress',
                '--root', str(self.test_root),
                '--manifest', str(self.manifest_path),
                '--release-id', 'test-release-123'
            ],
            capture_output=True,
            text=True
        )
        
        # Should succeed (exit 0 or 1 for typed failure)
        self.assertIn(result.returncode, [0, 1])
        
        # Should return valid JSON
        try:
            response = json.loads(result.stdout)
            self.assertIsInstance(response, dict)
        except json.JSONDecodeError:
            self.fail(f'Invalid JSON output: {result.stdout}')


if __name__ == '__main__':
    unittest.main()