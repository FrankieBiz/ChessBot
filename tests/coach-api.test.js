import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AI_PRESETS, coachEndpoint, coachRequestBody, migrateCoachSettings } from '../coach-api.js';

test('migrates saved defaults while preserving user-selected models and custom URLs', () => {
  const previous = { ...AI_PRESETS.openai, preset: 'openai', model: 'gpt-4o-mini', apiKey: 'test' };
  assert.deepEqual(migrateCoachSettings(previous), { ...previous, model: 'gpt-6.2-sol' });
  for (const settings of [{ ...previous, endpoint: 'https://example.com/chat' }, { ...previous, model: 'my-model' }]) {
    assert.deepEqual(migrateCoachSettings(settings), settings);
  }
});

test('puts provider-specific controls and selected-move evidence in the request body', () => {
  const evidence = { played: 'Nf6', bestLine: 'g6 Qf3', playedLine: 'Nf6 Qxf7#' };
  const openai = coachRequestBody(AI_PRESETS.openai, evidence);
  assert.equal(openai.reasoning_effort, 'low');
  assert.ok(openai.max_completion_tokens > 0);
  assert.equal(openai.max_tokens, undefined);
  assert.deepEqual(JSON.parse(openai.messages[1].content), evidence);
  const deepseek = coachRequestBody(AI_PRESETS.deepseek, evidence);
  assert.deepEqual(deepseek.thinking, { type: 'disabled' });
  assert.ok(deepseek.max_tokens > 0);
  const gemini = coachRequestBody(AI_PRESETS.gemini, evidence);
  assert.equal(gemini.reasoning_effort, 'low');
  assert.ok(gemini.max_tokens > 0);
});

test('requires HTTPS for remote providers and permits HTTP local inference', () => {
  assert.throws(() => coachEndpoint('http://example.com/v1/chat/completions'));
  assert.throws(() => coachEndpoint('https://user:password@example.com/chat'));
  assert.equal(coachEndpoint('http://127.0.0.1:1234/chat').hostname, '127.0.0.1');
});
