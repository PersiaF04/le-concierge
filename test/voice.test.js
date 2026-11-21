/**
 * The door's voice session routes, with the Mistral SDK client mocked.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp, configFromEnv } from '../server/app.js';
import { openDb } from '../server/db.js';
import { doorOrigin } from '../server/voice.js';

const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const DOOR = 'https://le-concierge-door.vercel.app';

function fakeMistral() {
  const created = [];
  const closed = [];
  let n = 0;
  return {
    created,
    closed,
    fail: false,
    audio: {
      sessions: {
        async create(request) {
          if (this.parent.fail) throw new Error('boom');
          created.push(request);
          n += 1;
          return { id: `sess_${n}`, participantToken: `tok_${n}`, serverUrl: 'wss://rtc.example' };
        },
        async close(request) {
          closed.push(request);
        },
      },
    },
  };
}

async function start(env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lcv-voice-'));
  dirs.push(dir);
  const db = openDb(join(dir, 'test.db'));
  const mistral = fakeMistral();
  mistral.audio.sessions.parent = mistral;
  const api = createApp({
    db,
    config: configFromEnv({ WORKFLOWS_REPLAY: '1', NODE_ENV: 'test', MISTRAL_API_KEY: 'test-key', ...env }),
    voiceClient: mistral,
  });
  await new Promise((resolve) => api.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${api.server.address().port}`;
  const call = async (method, path, origin = DOOR) => {
    const headers = { 'content-type': 'application/json' };
    if (origin) headers.origin = origin;
    const response = await fetch(`${base}${path}`, { method, headers, body: method === 'POST' ? '{}' : undefined });
    const text = await response.text();
    return { status: response.status, data: text ? JSON.parse(text) : null };
  };
  return {
    mistral,
    create: (origin) => call('POST', '/voice/session', origin),
    remove: (id, origin) => call('DELETE', `/voice/session/${id}`, origin),
    close: async () => {
      await api.close();
      db.close();
    },
  };
}

test('door origins: production, previews and localhost only', () => {
  assert.ok(doorOrigin('https://le-concierge-door.vercel.app'));
  assert.ok(doorOrigin('https://le-concierge-door-git-feat-voice-persia.vercel.app'));
  assert.ok(doorOrigin('http://localhost:5174'));
  assert.ok(doorOrigin('http://127.0.0.1:4174'));
  assert.ok(!doorOrigin('https://evil.example'));
  assert.ok(!doorOrigin('https://le-concierge-door.vercel.app.evil.example'));
  assert.ok(!doorOrigin('https://le-concierge-resident.vercel.app'));
  assert.ok(!doorOrigin(undefined));
});

test('POST /voice/session creates a configured session', async () => {
  const api = await start();
  try {
    const { status, data } = await api.create();
    assert.equal(status, 201);
    assert.deepEqual(data, { id: 'sess_1', participantToken: 'tok_1', serverUrl: 'wss://rtc.example' });
    const [request] = api.mistral.created;
    assert.match(request.instructions, /Le Concierge/);
    assert.match(request.instructions, /Never reveal/);
    assert.equal(request.llm.model, 'mistral-small-latest');
    assert.equal(request.stt.model, 'voxtral-mini-transcribe-realtime-3-0');
    assert.equal(request.stt.language, 'en');
    assert.equal(request.tts.model, 'voxtral-mini-tts-3-0');
    // One voice everywhere: the workflow's SPEECH_VOICE_ID default.
    assert.equal(request.tts.voiceId, 'gb_jane_neutral');
    const names = request.tools.map((tool) => tool.function?.name ?? tool.type);
    assert.deepEqual(names, ['ask_resident', 'log_event', 'hang_up']);
    assert.equal(request.tools[0].timeoutMs, 75_000);
  } finally {
    await api.close();
  }
});

test('VOICE_ID picks the voice', async () => {
  const api = await start({ VOICE_ID: 'gb_oliver_neutral' });
  try {
    await api.create();
    assert.equal(api.mistral.created[0].tts.voiceId, 'gb_oliver_neutral');
  } finally {
    await api.close();
  }
});

test('other origins and requests without one are refused', async () => {
  const api = await start();
  try {
    assert.equal((await api.create('https://evil.example')).status, 403);
    assert.equal((await api.create(null)).status, 403);
    assert.equal(api.mistral.created.length, 0);
  } finally {
    await api.close();
  }
});

test('at most three sessions are open at once', async () => {
  const api = await start();
  try {
    for (let i = 0; i < 3; i += 1) assert.equal((await api.create()).status, 201);
    assert.equal((await api.create()).status, 429);
    assert.equal((await api.remove('sess_1')).status, 204);
    assert.deepEqual(api.mistral.closed, [{ sessionId: 'sess_1' }]);
    assert.equal((await api.create()).status, 201);
  } finally {
    await api.close();
  }
});

test('per-IP rate limit', async () => {
  const api = await start({ VOICE_RATE_PER_MINUTE: '2', VOICE_MAX_SESSIONS: '10' });
  try {
    assert.equal((await api.create()).status, 201);
    assert.equal((await api.create()).status, 201);
    assert.equal((await api.create()).status, 429);
  } finally {
    await api.close();
  }
});

test('DELETE only closes sessions this API opened', async () => {
  const api = await start();
  try {
    assert.equal((await api.remove('sess_someone_else')).status, 404);
    assert.equal(api.mistral.closed.length, 0);
  } finally {
    await api.close();
  }
});

test('no key means 503, a Mistral failure means 502', async () => {
  const offline = await start({ MISTRAL_API_KEY: '' });
  try {
    assert.equal((await offline.create()).status, 503);
  } finally {
    await offline.close();
  }
  const api = await start();
  try {
    api.mistral.fail = true;
    assert.equal((await api.create()).status, 502);
  } finally {
    await api.close();
  }
});
