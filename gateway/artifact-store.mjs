import crypto from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

// Completed artifacts expire when mtime <= now - seven elapsed 24-hour days.
export const ARTIFACT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const gatewayArtifact = /^\d{4}-\d{2}-\d{2}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|pdf)$/;
function isOwnedCompleted(relative) {
  // Namespace plus final extension establish ownership; temporary names never do.
  if (relative.split('/').some(part => part.startsWith('.') ||
    /(^|[._-])(tmp|temp|temporary|part|partial|in-progress)([._-]|$)/i.test(part) || part.endsWith('~'))) return false;
  return gatewayArtifact.test(relative) || /^(playwright|crawl4ai)\/.+\.(png|pdf|html)$/.test(relative);
}
function artifactError(message, kind) {
  return Object.assign(new Error(message), { kind });
}
const disappeared = error => error.code === 'ENOENT';

export function createArtifactStore({ root, clock = Date.now, maxBytes = 25 * 1024 * 1024,
  quotaBytes = 1024 * 1024 * 1024, io = fs }) {
  root = path.resolve(root);
  let usageBytes = null;
  let pending = Promise.resolve();
  const serialized = job => {
    const result = pending.then(job);
    pending = result.catch(() => {});
    return result;
  };
  async function directory(target, job) {
    const stat = await io.lstat(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw artifactError('artifact directory must not be a symlink', 'artifact_root_unsafe');
    if (process.platform !== 'linux') return job(target);
    // Anchor operations to an open directory on the deployment platform. A concurrent
    // rename/symlink replacement cannot redirect traversal or unlink outside the root.
    const handle = await io.open(target, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      if (stat.dev !== opened.dev || stat.ino !== opened.ino) throw artifactError('artifact directory changed', 'artifact_root_unsafe');
      return await job(`/proc/self/fd/${handle.fd}`);
    } finally { await handle.close(); }
  }
  async function atRoot(job) {
    if (root === path.parse(root).root) throw artifactError('filesystem root is not an artifact root', 'artifact_root_unsafe');
    // Reject aliases in the configured path as well as the final root itself.
    const canonical = await io.realpath(root);
    if (canonical !== root) throw artifactError('artifact root must be a canonical directory', 'artifact_root_unsafe');
    return directory(root, job);
  }
  async function scan(current, relative, job) {
    for (const entry of await io.readdir(current, { withFileTypes: true })) {
      const name = path.posix.join(relative, entry.name);
      const target = path.join(current, entry.name);
      try {
        const stat = await io.lstat(target);
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) await directory(target, anchored => scan(anchored, name, job));
        else if (stat.isFile()) await job({ target, relative: name, stat });
      } catch (error) {
        // External cleanup/deletion is normal; permission and I/O errors must fail closed.
        if (!disappeared(error)) throw error;
      }
    }
  }
  async function usage(current) {
    let total = 0;
    await scan(current, '', async file => { total += file.stat.size; });
    return total;
  }
  return {
    get usageBytes() { return usageBytes; },
    reconcile() {
      return serialized(() => atRoot(async current => (usageBytes = await usage(current))));
    },
    async save(content, extension) {
      if (!Buffer.isBuffer(content) || !['png', 'pdf'].includes(extension)) throw artifactError('invalid artifact', 'artifact_invalid');
      if (content.length > maxBytes) throw artifactError(`artifact exceeds ${maxBytes} bytes`, 'artifact_too_large');
      return serialized(async () => {
        await io.mkdir(root, { recursive: true, mode: 0o750 });
        return atRoot(async current => {
          // Scan on every admission: external publishers can increase usage too.
          usageBytes = await usage(current);
          if (usageBytes + content.length > quotaBytes) throw artifactError('artifact quota exceeded', 'artifact_quota_exceeded');
          const day = new Date(clock()).toISOString().slice(0, 10);
          const name = `${crypto.randomUUID()}.${extension}`;
          const relative = path.posix.join(day, name);
          const folder = path.join(current, day);
          await io.mkdir(folder, { mode: 0o750 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
          return directory(folder, async anchored => {
            const target = path.join(anchored, name);
            const temporary = `${target}.${crypto.randomUUID()}.tmp`;
            try {
              await io.writeFile(temporary, content, { mode: 0o640, flag: 'wx' });
              // Retention starts at completed publication, not when a slow write began.
              const completedAt = new Date(clock());
              await io.utimes(temporary, completedAt, completedAt);
              await io.rename(temporary, target);
              usageBytes += content.length;
              return { id: relative, bytes: content.length,
                content_type: extension === 'png' ? 'image/png' : 'application/pdf',
                content_hash: crypto.createHash('sha256').update(content).digest('hex') };
            } finally {
              await io.unlink(temporary).catch(error => { if (!disappeared(error)) throw error; });
            }
          });
        });
      });
    },
    cleanup() {
      return serialized(() => atRoot(async current => {
        let deleted = 0;
        let reclaimedBytes = 0;
        const cutoff = clock() - ARTIFACT_RETENTION_MS;
        await scan(current, '', async file => {
          if (!isOwnedCompleted(file.relative) || file.stat.mtimeMs > cutoff || file.stat.nlink !== 1) return;
          const latest = await io.lstat(file.target);
          if (!latest.isFile() || latest.nlink !== 1 || latest.mtimeMs > cutoff ||
            latest.dev !== file.stat.dev || latest.ino !== file.stat.ino) return;
          await io.unlink(file.target);
          deleted++;
          reclaimedBytes += latest.size;
        });
        usageBytes = await usage(current);
        return { deleted, reclaimedBytes, usageBytes };
      }));
    },
  };
}
