import assert from 'node:assert/strict';
import test from 'node:test';
import { releaseFixture } from './test-fixtures/release-rehearsal.mjs';

test('complete deterministic release traverses real gateway/proxy and retains scoped gate, deadline and recovery evidence', { timeout: 45000 }, async t => {
  const fixture = await releaseFixture(t);
  const first = await fixture.evaluate();
  assert.equal(first.report.status, 'passed');
  assert.equal(first.report.cases.length, 15, 'no required release case is hidden or skip-passed');
  assert.ok(first.report.cases.every(item => item.status === 'passed'), JSON.stringify(first.report.cases));
  assert.ok(first.report.cases.some(item => item.id === 'gateway-public' && item.dimension === 'connectivity'), 'public readiness is graded as connectivity, not core');
  assert.ok(Object.values(first.report.gates).every(gate => gate.passed), JSON.stringify(first.report.gates));
  const timeout = first.report.cases.find(item => item.id === 'read-timeout');
  assert.equal(timeout.error.kind, 'egress_timeout');
  assert.equal(timeout.expectation, 'expected_timeout');
  assert.equal(first.report.summary.timeout_rate_pct, 0, 'deliberate deadline is not operational timeout');
  assert.ok(fixture.received.some(item => item.url === '/stall' && item.host === 'deadline.fixture.test'));
  assert.ok(fixture.received.filter(item => item.url === '/').length >= 3, 'subsequent concurrent valid reads recover');
  assert.ok(fixture.authorities.every(authority => authority.startsWith('93.184.216.34:')));
  assert.ok(fixture.browserCalls.some(call => call.name === 'browser_click'));
  assert.ok(fixture.counts().crawlCalls >= 3, 'render/screenshot/PDF traverse the production crawler adapter');
  const cached = await (await fixture.request('/readyz')).json();
  assert.equal(cached.ok, true);
  assert.equal(fixture.counts().readyCalls, 1, 'capability readiness is cached');
  assert.equal((await fixture.request('/api/evals', false)).status, 401);
  assert.equal((await fixture.request('/api/evals')).status, 200);
  for (const artifact of first.report.artifacts) {
    const route = `/artifacts/${encodeURIComponent(artifact.artifact_id)}`;
    assert.equal((await fixture.request(route, false)).status, 401);
    const response = await fixture.request(route);
    assert.equal(response.status, 200);
    assert.equal((await response.arrayBuffer()).byteLength, 256);
  }
  const breached = await fixture.evaluate({ concurrency_degradation_pct: 99.99 }, 1);
  assert.equal(breached.report.status, 'failed');
  assert.deepEqual(breached.report.failing_gates, ['concurrency_degradation_pct']);
  assert.equal(breached.report.gates.concurrency_degradation_pct.value, 100);
  fixture.failure.search = true;
  const unavailable = await fixture.evaluate({}, 1);
  assert.equal(unavailable.report.status, 'failed');
  assert.deepEqual(unavailable.report.failing_gates, ['success_rate_pct', 'quality_rate_pct']);
  const degraded = await fixture.evaluate({ success_rate_pct: 90, quality_rate_pct: 90 }, 1);
  assert.equal(degraded.report.status, 'degraded');
  assert.deepEqual(degraded.report.failing_gates, []);
  assert.ok(degraded.report.reasons.some(reason => reason.gate === 'connectivity'));
  fixture.failure.search = false;
  assert.equal((await fixture.evaluate()).report.status, 'passed', 'negative runs do not poison subsequent release execution');
});
