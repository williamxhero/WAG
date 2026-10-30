// Gateway outbound protection protocol module
//
// Pure protocol module for interfacing with SearXNG protection state via the
// CLI adapter. This module handles spawning the CLI, parsing responses, and
// converting between the Node.js and Python protection representations.
//
// This module does NOT:
// - Import wag_protection directly
// - Implement SQLite/flock/CAPTCHA/clock logic
// - Create/reset stores or run schema migrations
// - Expose new endpoints or daemons
//
// All protection state operations go through the searxng-protection-state.py
// CLI adapter which imports the批准 artifact's wag_protection package.

import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(moduleDir, '../scripts/searxng-protection-state.py');

// Maximum stdout size (16 KiB as per B1 spec)
const MAX_STDOUT_BYTES = 16 * 1024;

// Default timeout (1s as per B1 spec)
const DEFAULT_TIMEOUT_MS = 1000;

// Protection state handle
export class OutboundProtectionState {
  constructor(config) {
    this.root = config.root;
    this.manifestPath = config.manifestPath;
    this.pythonPath = config.pythonPath ?? 'python3';
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Get protection snapshot
   * @returns {Promise<{enabled: boolean, descriptor?: object, public_snapshot?: object}>}
   */
  async snapshot() {
    const result = await this._runCli('snapshot', []);
    
    if (result.error) {
      throw new ProtectionError(result.reason, result.message);
    }

    // Basic validation
    if (typeof result !== 'object') {
      throw new ProtectionError('invalid_response', 'Response must be an object');
    }

    return result;
  }

  /**
   * Consume release ingress
   * @param {string} releaseId - Release ID to consume
   * @returns {Promise<{success: boolean}>}
   */
  async consumeReleaseIngress(releaseId) {
    if (!releaseId || typeof releaseId !== 'string') {
      throw new TypeError('releaseId must be a non-empty string');
    }

    const result = await this._runCli('consume-release-ingress', [
      '--release-id', releaseId
    ]);

    if (result.error) {
      throw new ProtectionError(result.reason, result.message);
    }

    return result;
  }

  /**
   * Run CLI adapter and parse response
   * @private
   */
  async _runCli(command, extraArgs) {
    const args = [
      CLI_PATH,
      command,
      '--root', this.root,
      '--manifest', this.manifestPath,
      ...extraArgs
    ];

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new ProtectionError('timeout', `CLI timeout after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      let stdout = '';
      let stderr = '';

      const child = spawn(this.pythonPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: this.timeoutMs,
      });

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString('utf8');
        // Enforce stdout size limit
        if (Buffer.byteLength(stdout, 'utf8') > MAX_STDOUT_BYTES) {
          clearTimeout(timeoutId);
          child.kill('SIGTERM');
          reject(new ProtectionError('output_too_large', `stdout exceeded ${MAX_STDOUT_BYTES} bytes`));
        }
      });

      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8');
      });

      child.on('error', (err) => {
        clearTimeout(timeoutId);
        reject(new ProtectionError('spawn_error', err.message));
      });

      child.on('close', (code) => {
        clearTimeout(timeoutId);

        if (code !== 0 && code !== 1) {
          // Exit code 2 is CLI usage error
          return reject(new ProtectionError('cli_error', `CLI exited with code ${code}: ${stderr}`));
        }

        // Parse JSON response
        try {
          const result = JSON.parse(stdout);
          resolve(result);
        } catch (err) {
          reject(new ProtectionError('parse_error', `Failed to parse JSON: ${err.message}`));
        }
      });
    });
  }
}

/**
 * Create protection state handle
 * @param {object} config
 * @param {string} config.root - Protection store root path
 * @param {string} config.manifestPath - Artifact manifest path
 * @param {string} [config.pythonPath] - Python interpreter path
 * @param {number} [config.timeoutMs] - Command timeout in milliseconds
 * @returns {OutboundProtectionState}
 */
export function createOutboundProtectionState(config) {
  if (!config.root) {
    throw new TypeError('config.root is required');
  }
  if (!config.manifestPath) {
    throw new TypeError('config.manifestPath is required');
  }
  return new OutboundProtectionState(config);
}

/**
 * Protection error class
 */
export class ProtectionError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = 'ProtectionError';
    this.reason = reason;
  }
}