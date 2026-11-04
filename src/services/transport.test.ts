import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  chooseTransport,
  shouldContactBackend,
  shouldFallbackOnStreamError,
  shouldReportSubmit,
} from './transport.ts';

test('relay stays on the relay only when the read is ready', () => {
  assert.equal(chooseTransport('relay', { ok: true, ready: true, timedOut: false }), 'relay');
});

test('relay falls back when the backend is not ready, fails, or times out', () => {
  assert.equal(chooseTransport('relay', { ok: true, ready: false, timedOut: false }), 'mirror');
  assert.equal(chooseTransport('relay', { ok: false, ready: false, timedOut: false }), 'mirror');
  assert.equal(chooseTransport('relay', { ok: false, ready: true, timedOut: true }), 'mirror');
  assert.equal(chooseTransport('relay', null), 'mirror');
});

test('hedera-only never uses the relay, even if a read would be healthy', () => {
  assert.equal(chooseTransport('hedera-only', { ok: true, ready: true }), 'mirror');
  assert.equal(shouldContactBackend('hedera-only'), false);
  assert.equal(shouldContactBackend('relay'), true);
  assert.equal(shouldReportSubmit('hedera-only', 'mirror'), false);
  assert.equal(shouldReportSubmit('hedera-only', 'relay'), false);
  assert.equal(shouldReportSubmit('relay', 'mirror'), false);
  assert.equal(shouldReportSubmit('relay', 'relay'), true);
  assert.equal(shouldFallbackOnStreamError('hedera-only', 'relay'), false);
  assert.equal(shouldFallbackOnStreamError('relay', 'mirror'), false);
  assert.equal(shouldFallbackOnStreamError('relay', 'relay'), true);
});
