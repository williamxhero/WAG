import { createArtifactStore } from './artifact-store.mjs';

try {
  const store = createArtifactStore({ root: process.env.ARTIFACT_DIR ?? '/data/web-access-gateway/artifacts' });
  console.log(JSON.stringify(await store.cleanup()));
} catch (error) {
  console.error(`Artifact cleanup failed: ${error.kind ?? error.code ?? 'artifact_cleanup_error'}`);
  process.exitCode = 1;
}
