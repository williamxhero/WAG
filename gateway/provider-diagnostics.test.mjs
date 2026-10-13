import assert from 'node:assert/strict';
import test from 'node:test';
import { createProviderAdapter } from './provider-adapters.mjs';
import { projectProviderDiagnostic } from './provider-contract.mjs';

const response = value => ({ status: 200, body: JSON.stringify(value) });
const adapter = transport => createProviderAdapter({ name: 'tencent', enabled: true, transport });
const validPage = JSON.stringify({ title: 'Synthetic title', url: 'https://example.test/article', date: null, passage: '', site: null });

const failures = [
  ['invalid JSON', { status: 200, body: '{ private body sentinel' }, 'response_json'],
  ['missing envelope', response({}), 'response_envelope'],
  ['missing version', response({ Response: { Pages: [] } }), 'version_validation'],
  ['unsupported version', response({ Response: { Version: 'future', Pages: [] } }), 'version_validation'],
  ['API error', response({ Response: { Error: { Code: 'UnauthorizedOperation', Message: 'private message sentinel' } } }), 'response_envelope'],
  ['missing Pages', response({ Response: { Version: 'lite' } }), 'pages_array'],
  ['null Pages', response({ Response: { Version: 'lite', Pages: null } }), 'pages_array'],
  ['non-string page', response({ Response: { Version: 'lite', Pages: [{}] } }), 'pages_array'],
  ['malformed page JSON', response({ Response: { Version: 'lite', Pages: [validPage, 'private page sentinel'] } }), 'page_json'],
  ['mixed valid and invalid records', response({ Response: { Version: 'lite', Pages: [validPage, JSON.stringify({ title: 'private title sentinel' })] } }), 'record_validation'],
];

test('Tencent response failures expose only the last allowlisted stage and never claim completion', async () => {
  for (const [name, reply, stage] of failures) {
    const instance = adapter(async () => reply);
    await assert.rejects(instance.search({ query: 'private query sentinel' }), error => {
      assert.equal(error.kind, ['unsupported version', 'missing version'].includes(name) ? 'provider_version_mismatch' :
        name === 'API error' ? 'authentication' : 'invalid_response');
      assert.equal(error.diagnostic?.stage, stage);
      if (name === 'malformed page JSON') assert.equal(error.diagnostic?.parsed_page_count, 1);
      if (name === 'non-string page') assert.equal(error.diagnostic?.page_type, 'object');
      if (name === 'null Pages') assert.equal(error.diagnostic?.pages_type, 'null');
      assert.notEqual(error.diagnostic?.auth_success, true);
      assert.equal(JSON.stringify({ message: error.message, diagnostic: error.diagnostic }).includes('sentinel'), false);
      return true;
    });
    assert.equal(instance.posteriorVersion, null);
  }
});

test('only fully normalized Tencent responses publish completion and posterior version', async () => {
  const instance = adapter(async () => response({ Response: { Version: 'lite', Pages: [validPage] } }));
  const results = await instance.search({ query: 'private query sentinel' });
  assert.equal(results.length, 1);
  assert.deepEqual(results.diagnostic, { stage: 'complete', auth_success: true, page_count: 1, parsed_page_count: 1, result_count: 1 });
  assert.equal(instance.posteriorVersion, 'lite');
  assert.equal(JSON.stringify(results.diagnostic).includes('sentinel'), false);
});

test('valid responses retain diagnostic page counts above the result cap', async () => {
  const instance = adapter(async () => response({ Response: { Version: 'lite', Pages: Array(51).fill(validPage) } }));
  const results = await instance.search({ query: 'private query sentinel' });
  assert.equal(results.length, 10);
  assert.deepEqual(results.diagnostic, { stage: 'complete', auth_success: true,
    page_count: 51, parsed_page_count: 51, result_count: 10 });
});

test('diagnostic projector rejects poisoned fields, stage mismatch, invalid types and unbounded counts', () => {
  for (const value of [
    { stage: 'complete', auth_success: true, result_count: 1, body: 'private sentinel' },
    { stage: 'complete', auth_success: true, result_count: 1, page_type: 'private sentinel' },
    { stage: 'complete', auth_success: true, result_count: 1, nested: { title: 'private sentinel' } },
    { stage: 'record_validation', auth_success: true, record_type: 'object' },
    { stage: 'complete', auth_success: true, result_count: 1_048_577 },
    { stage: 'complete', auth_success: 'true', result_count: 1 },
  ]) assert.equal(projectProviderDiagnostic(value), null);
});
