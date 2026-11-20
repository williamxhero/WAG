#!/usr/bin/env python3
"""
SearXNG protection state CLI adapter.

Provides snapshot and consume-release-ingress commands for WAG to interface
with fork #1's wag_protection package. This adapter only imports from the
批准 artifact's wag_protection package and emits JSON to stdout.

Usage:
  searxng-protection-state.py snapshot --root <path> --manifest <path>
  searxng-protection-state.py consume-release-ingress --root <path> --manifest <path> --release-id <id>

Exit codes:
  0: success
  1: typed failure (JSON error on stdout)
  2: CLI usage error
"""

import argparse
import json
import sys
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(
        description='SearXNG protection state CLI adapter'
    )
    subparsers = parser.add_subparsers(dest='command', required=True)

    # snapshot command
    snapshot_parser = subparsers.add_parser('snapshot', help='Read protection snapshot')
    snapshot_parser.add_argument('--root', required=True, help='Protection store root path')
    snapshot_parser.add_argument('--manifest', required=False, help='Artifact manifest path (optional for off mode)')

    # consume-release-ingress command
    consume_parser = subparsers.add_parser('consume-release-ingress', help='Consume release ingress')
    consume_parser.add_argument('--root', required=True, help='Protection store root path')
    consume_parser.add_argument('--manifest', required=False, help='Artifact manifest path (optional for off mode)')
    consume_parser.add_argument('--release-id', required=True, help='Release ID to consume')

    args = parser.parse_args()

    try:
        if args.command == 'snapshot':
            result = handle_snapshot(args.root, args.manifest)
        elif args.command == 'consume-release-ingress':
            result = handle_consume_release_ingress(
                args.root, args.manifest, args.release_id
            )
        else:
            emit_error('unknown_command', f'Unknown command: {args.command}')
            return 1

        # Check if result is a typed failure
        if isinstance(result, dict) and result.get('error'):
            print(json.dumps(result, ensure_ascii=False, separators=(',', ':')))
            return 1

        # Emit success result as JSON
        print(json.dumps(result, ensure_ascii=False, separators=(',', ':')))
        return 0

    except Exception as e:
        emit_error('internal_error', str(e))
        return 1


def handle_snapshot(root: str, manifest_path: str):
    """Handle snapshot command."""
    try:
        # Validate inputs
        root_path = Path(root)
        if not root_path.exists():
            return emit_typed_failure('root_not_found', f'Root not found: {root}')
        if not root_path.is_dir():
            return emit_typed_failure('root_not_directory', f'Root is not a directory: {root}')

        manifest_file = Path(manifest_path)
        if not manifest_file.exists():
            return emit_typed_failure('manifest_not_found', f'Manifest not found: {manifest_path}')

        # TODO: Import wag_protection and call open_store + snapshot
        # For now, return a stub response
        return {
            'status': 'not_implemented',
            'message': 'snapshot not yet implemented',
            'root': str(root_path.resolve()),
            'manifest': str(manifest_file.resolve())
        }

    except Exception as e:
        return emit_typed_failure('snapshot_error', str(e))


def handle_consume_release_ingress(root: str, manifest_path: str, release_id: str):
    """Handle consume-release-ingress command."""
    try:
        # Validate inputs
        root_path = Path(root)
        if not root_path.exists():
            return emit_typed_failure('root_not_found', f'Root not found: {root}')
        if not root_path.is_dir():
            return emit_typed_failure('root_not_directory', f'Root is not a directory: {root}')

        manifest_file = Path(manifest_path)
        if not manifest_file.exists():
            return emit_typed_failure('manifest_not_found', f'Manifest not found: {manifest_path}')

        if not release_id or not isinstance(release_id, str):
            return emit_typed_failure('invalid_release_id', 'Release ID must be a non-empty string')

        # TODO: Import wag_protection and call consume_release_ingress
        # For now, return a stub response
        return {
            'status': 'not_implemented',
            'message': 'consume-release-ingress not yet implemented',
            'root': str(root_path.resolve()),
            'manifest': str(manifest_file.resolve()),
            'release_id': release_id
        }

    except Exception as e:
        return emit_typed_failure('consume_error', str(e))


def emit_typed_failure(reason: str, message: str):
    """Return a typed failure dict."""
    return {
        'error': True,
        'reason': reason,
        'message': message
    }


def emit_error(reason: str, message: str):
    """Emit an error to stdout."""
    print(json.dumps({
        'error': True,
        'reason': reason,
        'message': message
    }, ensure_ascii=False, separators=(',', ':')))


if __name__ == '__main__':
    sys.exit(main())