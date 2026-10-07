export function waitForListening(child, { marker = 'web-access-gateway listening', timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    let stdout = ''; let stderr = ''; let settled = false;
    const timer = setTimeout(() => finish(new Error(`gateway did not start: ${stdout}${stderr}`)), timeoutMs);
    const onOutput = chunk => {
      stdout = (stdout + chunk).slice(-65536);
      if (stdout.includes(marker)) finish();
    };
    const onErrorOutput = chunk => { stderr = (stderr + chunk).slice(-65536); };
    const onExit = (code, signal) => finish(new Error(`gateway exited during startup (${code ?? signal}): ${stdout}${stderr}`));
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.off('data', onOutput);
      child.stderr.off('data', onErrorOutput);
      child.off('exit', onExit);
      child.off('error', finish);
      error ? reject(error) : resolve();
    };
    child.stdout.on('data', onOutput);
    child.stderr.on('data', onErrorOutput);
    child.once('exit', onExit);
    child.once('error', finish);
    if (child.exitCode !== null || child.signalCode !== null) onExit(child.exitCode, child.signalCode);
  });
}
