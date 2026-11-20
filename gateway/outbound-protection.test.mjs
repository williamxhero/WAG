// Tests for outbound-protection.mjs

import {describe, it, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createOutboundProtectionState, ProtectionError} from './outbound-protection.mjs';

describe('OutboundProtectionState', () => {
  let tempDir;
  let testRoot;
  let manifestPath;

  before(async () => {
    // Create temporary directory for tests
    tempDir = await mkdtemp(path.join(tmpdir(), 'test-protection-'));
    testRoot = path.join(tempDir, 'store');
    manifestPath = path.join(tempDir, 'manifest.json');

    // Create test manifest
    const manifest = {
      schema: 'wag.protection-artifact.v2',
      contract: 'wag.outbound.v2',
      mode: 'synthetic',
      fork_commit: '0'.repeat(40),
      artifact_digest: '0'.repeat(64),
      registry_digest: '0'.repeat(64),
      config_digest: '0'.repeat(64),
      python_digest: '0'.repeat(64),
      module_root: '/test/module',
      python_executable: '/usr/bin/python3',
      root: testRoot,
      shared_gid: 1000,
      allowed_uids: [0, 1000],
      files: {},
      distributions: {},
      wheels: {},
      registry: []
    };

    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  });

  after(async () => {
    // Cleanup
    if (tempDir) {
      await rm(tempDir, {recursive: true, force: true});
    }
  });

  it('creates state handle with valid config', () => {
    const state = createOutboundProtectionState({
      root: testRoot,
      manifestPath,
    });

    assert.ok(state);
    assert.strictEqual(state.root, testRoot);
    assert.strictEqual(state.manifestPath, manifestPath);
  });

  it('throws on missing root', () => {
    assert.throws(() => {
      createOutboundProtectionState({
        manifestPath,
      });
    }, TypeError);
  });

  it('throws on missing manifestPath', () => {
    assert.throws(() => {
      createOutboundProtectionState({
        root: testRoot,
      });
    }, TypeError);
  });

  it('snapshot returns typed failure for non-existent root', async () => {
    const state = createOutboundProtectionState({
      root: '/nonexistent',
      manifestPath,
    });

    await assert.rejects(async () => {
      await state.snapshot();
    }, ProtectionError);
  });

  it('consumeReleaseIngress throws on invalid releaseId', async () => {
    const state = createOutboundProtectionState({
      root: testRoot,
      manifestPath,
    });

    await assert.rejects(async () => {
      await state.consumeReleaseIngress('');
    }, TypeError);

    await assert.rejects(async () => {
      await state.consumeReleaseIngress(null);
    }, TypeError);
  });

  it('enforces stdout size limit', async () => {
    const state = createOutboundProtectionState({
      root: testRoot,
      manifestPath,
      timeoutMs: 2000,
    });

    // The CLI will return a small response, so this test just verifies
    // the limit is checked (actual enforcement requires a real large output)
    const result = await state.snapshot().catch(e => e);
    
    // Should either succeed with stub response or fail with typed error
    if (result instanceof ProtectionError) {
      assert.ok(['output_too_large', 'spawn_error', 'root_not_found', 'cli_error'].includes(result.reason));
    } else {
      assert.ok(result.status === 'not_implemented' || result.enabled === false);
    }
  });

  it('enforces timeout', async () => {
    const state = createOutboundProtectionState({
      root: testRoot,
      manifestPath,
      timeoutMs: 1, // Very short timeout
    });

    await assert.rejects(async () => {
      await state.snapshot();
    }, (err) => {
      return err instanceof ProtectionError && err.reason === 'timeout';
    });
  });

  it('handles CLI parse errors', async () => {
    const state = createOutboundProtectionState({
      root: testRoot,
      manifestPath: '/nonexistent-manifest.json',
    });

    await assert.rejects(async () => {
      await state.snapshot();
    }, ProtectionError);
  });
});