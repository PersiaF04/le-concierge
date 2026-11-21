/**
 * GET /executions/:id/steps: Mistral's execution history, mocked, turned into
 * the stage's workflow steps.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { mountStage, stepsFromHistory } from '../server/stage.js';

const scheduled = (id, name, at) => ({
  eventId: String(id),
  eventTime: at,
  eventType: 'EVENT_TYPE_ACTIVITY_TASK_SCHEDULED',
  activityTaskScheduledEventAttributes: { activityType: { name } },
});
const done = (id, ref, at, result) => ({
  eventId: String(id),
  eventTime: at,
  eventType: 'EVENT_TYPE_ACTIVITY_TASK_COMPLETED',
  activityTaskCompletedEventAttributes: { scheduledEventId: String(ref), result },
});

/** A visit paused on the resident's answer. */
const pausedHistory = {
  events: [
    { eventId: '1', eventType: 'EVENT_TYPE_WORKFLOW_EXECUTION_STARTED', eventTime: 't0' },
    scheduled(2, 'describe_snapshot', 't1'),
    done(3, 2, 't2', { model: 'pixtral-large-latest' }),
    scheduled(4, 'match_face', 't3'),
    done(5, 4, 't4', { matched: true }),
    scheduled(6, 'transcribe_intercom_audio', 't5'),
    { eventId: '7', eventType: 'ActivityTaskStarted', activityTaskStartedEventAttributes: { scheduledEventId: '6' } },
    done(8, 6, 't6', { payloads: [{ text: 'hello', model: 'voxtral-mini-latest' }] }),
    scheduled(9, 'decide_visit', 't7'),
    done(10, 9, 't8', {}),
    scheduled(11, 'post_visit', 't9'),
    done(12, 11, 't10', {}),
    { eventId: '13', eventType: 'EVENT_TYPE_TIMER_STARTED', timerStartedEventAttributes: { timerId: '1' } },
  ],
};

test('stepsFromHistory: activities, models and the resident-decision wait', () => {
  const { steps, waiting, finished } = stepsFromHistory(pausedHistory);
  assert.equal(waiting, true);
  assert.equal(finished, false);
  assert.deepEqual(
    steps.map((s) => [s.activity, s.status]),
    [
      ['describe_snapshot', 'completed'],
      ['match_face', 'completed'],
      ['transcribe_intercom_audio', 'completed'],
      ['decide_visit', 'completed'],
      ['post_visit', 'completed'],
    ],
  );
  assert.equal(steps[0].model, 'pixtral-large-latest');
  assert.equal(steps[2].model, 'voxtral-mini-latest');
  assert.equal(steps[3].model, 'mistral-small-latest');
  assert.equal(steps[0].at, 't2');
});

test('stepsFromHistory: a signal ends the wait, completion finishes the run', () => {
  const events = [
    ...pausedHistory.events,
    { eventId: '14', eventType: 'EVENT_TYPE_WORKFLOW_EXECUTION_SIGNALED' },
    scheduled(15, 'speak_reply', 't11'),
    { eventId: '16', eventType: 'EVENT_TYPE_ACTIVITY_TASK_FAILED', activityTaskFailedEventAttributes: { scheduledEventId: '15' } },
    { eventId: '17', eventType: 'EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED' },
  ];
  const { steps, waiting, finished } = stepsFromHistory({ events });
  assert.equal(waiting, false);
  assert.equal(finished, true);
  assert.equal(steps.at(-1).status, 'failed');
});

async function serve(fetchImpl, key = 'test-key') {
  const app = express();
  mountStage(app, { config: { mistralApiKey: key, mistralApiUrl: 'https://mistral.test' }, fetch: fetchImpl });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('GET /executions/:id/steps reads the history once per ~700 ms', async () => {
  const calls = [];
  const api = await serve(async (url, init) => {
    calls.push({ url, auth: init.headers.authorization });
    return new Response(JSON.stringify(pausedHistory), { status: 200 });
  });
  try {
    const first = await (await fetch(`${api.base}/executions/exec_1/steps`)).json();
    const second = await (await fetch(`${api.base}/executions/exec_1/steps`)).json();
    assert.equal(first.executionId, 'exec_1');
    assert.equal(first.waiting, true);
    assert.equal(first.steps.length, 5);
    assert.deepEqual(second, first);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://mistral.test/v1/workflows/executions/exec_1/history');
    assert.equal(calls[0].auth, 'Bearer test-key');
  } finally {
    await api.close();
  }
});

test('GET /executions/:id/steps reports Mistral errors and a missing key', async () => {
  const api = await serve(async () => new Response('{}', { status: 404 }));
  const nokey = await serve(async () => assert.fail('no call without a key'), '');
  try {
    assert.equal((await fetch(`${api.base}/executions/missing/steps`)).status, 404);
    assert.equal((await fetch(`${api.base}/executions/bad%20id/steps`)).status, 400);
    assert.equal((await fetch(`${nokey.base}/executions/exec_1/steps`)).status, 503);
  } finally {
    await api.close();
    await nokey.close();
  }
});
