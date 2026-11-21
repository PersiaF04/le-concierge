/**
 * API tests: every route, against a temporary SQLite file, in offline mode
 * unless a test injects a fake Mistral to check the live calls.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

import { createApp, configFromEnv, normalizeFlat, parseFlats } from '../server/app.js';
import { openDb } from '../server/db.js';

const dirs = [];

/** Flats the tests ring; each gets an anonymous resident so arrivals are accepted. */
const RINGED = ['12', '60', '61', '80'];

async function start({ env = { WORKFLOWS_REPLAY: "1", NODE_ENV: "test" }, fetch: mistralFetch } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lcv-api-'));
  dirs.push(dir);
  const db = openDb(join(dir, 'test.db'));
  const api = createApp({ db, config: configFromEnv({ BUILDING_FLATS: '1-99,PH', ...env }), fetch: mistralFetch });
  await new Promise((resolve) => api.server.listen(0, '127.0.0.1', resolve));
  const { port } = api.server.address();
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, path, body) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const type = response.headers.get('content-type') || '';
    const data = type.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer());
    return { status: response.status, data };
  };
  for (const flat of RINGED) await call('POST', '/residents', { flat, anonymous: true });
  return {
    base,
    ws: `ws://127.0.0.1:${port}`,
    get: (path) => call('GET', path),
    post: (path, body = {}) => call('POST', path, body),
    put: (path, body = {}) => call('PUT', path, body),
    close: async () => {
      await api.close();
      db.close();
    },
  };
}



after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** Open a socket and collect its frames. */
function listen(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const frames = [];
    socket.on('message', (data) => frames.push(JSON.parse(String(data))));
    socket.on('open', () => resolve({ socket, frames }));
    socket.on('error', reject);
  });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

describe('offline API', () => {
  let api;
  before(async () => {
    api = await start();
  });
  after(() => api.close());

  test('GET /health reports offline mode', async () => {
    const { status, data } = await api.get('/health');
    assert.equal(status, 200);
    assert.equal(data.status, 'ok');
    assert.equal(data.mode, 'offline');
  });

  test('POST /residents validates and returns a Resident', async () => {
    assert.equal((await api.post('/residents', { name: 'Ada' })).status, 400);
    assert.equal((await api.post('/residents', { flat: '12', anonymous: false })).status, 400);

    const named = await api.post('/residents', {
      name: 'Ada',
      flat: '12',
      email: 'ada@example.invalid',
      whatsapp: '+440000',
      anonymous: false,
    });
    assert.equal(named.status, 201);
    assert.match(named.data.id, /^res_12_/);
    assert.deepEqual(
      { ...named.data, id: undefined },
      { id: undefined, flat: '12', anonymous: false, name: 'Ada', email: 'ada@example.invalid', whatsapp: '+440000' },
    );

    const anon = await api.post('/residents', { flat: '7', anonymous: true, email: 'x@example.invalid' });
    assert.equal(anon.status, 201);
    assert.equal(anon.data.anonymous, true);
    assert.equal(anon.data.email, undefined, 'anonymous residents keep no contact details');
  });

  test('a flat holds one resident: 409 flat_taken, and GET /flats/:flat never says who', async () => {
    assert.deepEqual((await api.get('/flats/60')).data, { flat: '60', taken: false });
    const { data: first } = await api.post('/residents', { name: 'Gil', flat: '60', email: 'gil@example.invalid' });
    assert.deepEqual((await api.get('/flats/60')).data, { flat: '60', taken: true });

    // Named or anonymous, a second resident cannot take the flat.
    const named = await api.post('/residents', { name: 'Hal', flat: '60' });
    assert.equal(named.status, 409);
    assert.deepEqual(named.data, { error: 'flat_taken', flat: '60' });
    const anon = await api.post('/residents', { flat: '60', anonymous: true });
    assert.deepEqual([anon.status, anon.data], [409, { error: 'flat_taken', flat: '60' }]);
    // A taken anonymous flat blocks a named resident too.
    await api.post('/residents', { flat: '61', anonymous: true });
    assert.equal((await api.post('/residents', { name: 'Ivy', flat: '61' })).status, 409);
    // An id that is not someone's own does not get past the check.
    assert.equal((await api.post('/residents', { id: 'nobody', name: 'Jo', flat: '60' })).status, 409);

    // The resident's own id re-registers: an edit keeps the id.
    const edited = await api.post('/residents', { id: first.id, name: 'Gil B', flat: '60' });
    assert.equal(edited.status, 200);
    assert.deepEqual(edited.data, { id: first.id, flat: '60', anonymous: false, name: 'Gil B' });
  });

  test('changing flat needs a free flat and frees the old one', async () => {
    const { data: me } = await api.post('/residents', { name: 'Kit', flat: '70' });
    await api.post('/residents', { name: 'Lou', flat: '71' });

    const blocked = await api.post('/residents', { id: me.id, name: 'Kit', flat: '71' });
    assert.deepEqual([blocked.status, blocked.data], [409, { error: 'flat_taken', flat: '71' }]);
    assert.equal((await api.get('/flats/70')).data.taken, true, 'a refused move keeps the old flat');

    const moved = await api.post('/residents', { id: me.id, name: 'Kit', flat: '72' });
    assert.deepEqual([moved.status, moved.data.id, moved.data.flat], [200, me.id, '72']);
    assert.equal((await api.get('/flats/70')).data.taken, false);
    assert.equal((await api.get('/flats/72')).data.taken, true);
    assert.equal((await api.post('/residents', { name: 'Max', flat: '70' })).status, 201);

    // PUT /residents/:id does the same, and 404s for nobody.
    const put = await api.put(`/residents/${me.id}`, { flat: '73', anonymous: true });
    assert.deepEqual([put.status, put.data], [200, { id: me.id, flat: '73', anonymous: true }]);
    assert.equal((await api.get('/flats/72')).data.taken, false);
    assert.equal((await api.put('/residents/nobody', { flat: '74', anonymous: true })).status, 404);
  });

  test('POST /residents/:id/confirm returns {ok}', async () => {
    const { data: resident } = await api.post('/residents', { name: 'Bo', flat: '3' });
    const confirmed = await api.post(`/residents/${resident.id}/confirm`, { thatWasMe: true });
    assert.equal(confirmed.status, 200);
    assert.deepEqual(confirmed.data, { ok: true });
    assert.equal((await api.post('/residents/nobody/confirm')).status, 404);
  });

  test('POST /residents/:id/face needs a confirmed resident, then /faces/match finds them', async () => {
    const descriptor = Array.from({ length: 128 }, (_, i) => Math.sin(i) / 10);
    const { data: resident } = await api.post('/residents', { name: 'Cy', flat: '5' });

    const early = await api.post(`/residents/${resident.id}/face`, { descriptor });
    assert.equal(early.status, 409, 'no enrolment before "that was me"');
    const unmatched = await api.post('/faces/match', { descriptor });
    assert.equal(unmatched.data.matched, false);

    await api.post(`/residents/${resident.id}/confirm`);
    assert.equal((await api.post(`/residents/${resident.id}/face`, { descriptor: ['x'] })).status, 400);
    assert.equal((await api.post('/residents/nobody/face', { descriptor })).status, 404);
    const enrolled = await api.post(`/residents/${resident.id}/face`, { descriptor });
    assert.equal(enrolled.status, 201);

    // Shift every component by d: the distance is d * sqrt(128).
    const near = descriptor.map((v) => v + 0.4 / Math.sqrt(128));
    const far = descriptor.map((v) => v + 0.6 / Math.sqrt(128));
    const hit = await api.post('/faces/match', { descriptor: near });
    assert.equal(hit.data.matched, true);
    assert.equal(hit.data.resident_id, resident.id);
    assert.ok(Math.abs(hit.data.distance - 0.4) < 1e-3);

    const miss = await api.post('/faces/match', { descriptor: far });
    assert.deepEqual(
      { matched: miss.data.matched, resident_id: miss.data.resident_id, distance: miss.data.distance },
      { matched: false, resident_id: null, distance: null },
    );
    assert.equal((await api.post('/faces/match', {})).data.matched, false);
  });

  test('POST /arrivals creates a local pending visit; GET /visits returns it', async () => {
    const created = await api.post('/arrivals', { flat: '12', snapshot_url: 'data:image/jpeg;base64,AA', face: {} });
    assert.equal(created.status, 201);
    assert.equal(created.data.execution_id, null);
    assert.match(created.data.visit_id, /^visit_/);

    const current = await api.get('/visits?flat=12&status=pending');
    assert.equal(current.status, 200);
    const visit = current.data;
    assert.equal(visit.id, created.data.visit_id);
    assert.equal(visit.status, 'pending_decision');
    assert.equal(visit.snapshot, 'data:image/jpeg;base64,AA');
    for (const key of [
      'id', 'flat', 'residentId', 'status', 'at', 'timeoutSeconds', 'transcript', 'confidence',
      'faceDistance', 'reply', 'executionId', 'parcel', 'snapshot', 'decidedAt', 'speech', 'mode',
    ]) {
      assert.ok(key in visit, `Visit has ${key}`);
    }
    assert.equal((await api.get('/visits?flat=99&status=pending')).data, null);
    assert.equal((await api.get(`/visits/${visit.id}`)).data.id, visit.id);
    assert.equal((await api.get('/visits/nope')).status, 404);
    assert.ok(Array.isArray((await api.get('/visits?flat=12')).data));
  });

  test('POST /visits/:id/decision validates and updates the visit offline', async () => {
    const { data } = await api.post('/arrivals', { flat: '12' });
    assert.equal((await api.post(`/visits/${data.visit_id}/decision`, { decision: 'maybe' })).status, 400);
    assert.equal((await api.post('/visits/nope/decision', { decision: 'approve' })).status, 404);

    const ok = await api.post(`/visits/${data.visit_id}/decision`, { decision: 'approve' });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.ok, true);
    assert.equal(ok.data.signalled, false);
    assert.equal((await api.get(`/visits/${data.visit_id}`)).data.status, 'approved');
    assert.equal((await api.post(`/visits/${data.visit_id}/decision`, { decision: 'decline' })).status, 409);
  });

  test('POST /visits from the worker, then /intercom/speak attaches speech and the wav', async () => {
    assert.equal((await api.post('/visits', {})).status, 400);
    const posted = await api.post('/visits', {
      visit_id: 'visit_worker_1',
      execution_id: 'exec_1',
      flat: '8',
      resident_id: 'res_8',
      transcript: { text: 'Parcel for flat eight' },
      face_distance: 0.31,
      confidence: 0.86,
      proposed_reply: 'One moment please.',
      parcel: { courier: 'DPD', label: 'FLAT 8' },
    });
    assert.equal(posted.status, 201);
    assert.equal(posted.data.visit_id, 'visit_worker_1');
    assert.equal(posted.data.status, 'pending_decision');
    assert.equal(posted.data.visit.transcript, 'Parcel for flat eight');
    assert.equal(posted.data.visit.faceDistance, 0.31);

    const wav = Buffer.from('RIFF....WAVEfake');
    const spoken = await api.post('/intercom/speak', {
      visit_id: 'visit_worker_1',
      text: 'Come in, 8.',
      model: 'voxtral-mini-tts-3-0-13',
      voice_id: 'voice_447',
      transport: 'realtime',
      chunks: 5,
      first_chunk_ms: 1004,
      audio_bytes: 96044,
      gain_db: 6.1,
      peak_dbfs: -1,
      audio_base64: wav.toString('base64'),
    });
    assert.equal(spoken.data.played, true);
    assert.equal(spoken.data.duration_ms, 2001);

    const visit = (await api.get('/visits/visit_worker_1')).data;
    assert.equal(visit.reply, 'Come in, 8.');
    assert.equal(visit.speech.model, 'voxtral-mini-tts-3-0-13');
    assert.equal(visit.speech.voiceId, 'voice_447');
    assert.equal(visit.speech.audioUrl, '/intercom/audio/visit_worker_1.wav');

    const audio = await api.get(visit.speech.audioUrl);
    assert.equal(audio.status, 200);
    assert.deepEqual(audio.data, wav);
    assert.equal((await api.get('/intercom/audio/nope.wav')).status, 404);
  });

  test('POST /events logs; GET /events filters by flat and day; a decision event closes the visit', async () => {
    assert.equal((await api.post('/events', {})).status, 400);
    await api.post('/visits', { visit_id: 'visit_ev', flat: '20' });
    const logged = await api.post('/events', {
      type: 'visit.decision',
      visit_id: 'visit_ev',
      decision: 'decline',
      automatic: true,
    });
    assert.equal(logged.status, 201);
    assert.equal(logged.data.stored, true);
    assert.match(logged.data.event_id, /^evt_/);
    assert.equal((await api.get('/visits/visit_ev')).data.status, 'expired');

    const day = new Date().toISOString().slice(0, 10);
    const listed = await api.get(`/events?flat=20&day=${day}`);
    assert.equal(listed.data.flat, '20');
    assert.equal(listed.data.day, day);
    assert.ok(listed.data.events.some((e) => e.type === 'visit.decision' && e.flat === '20'));
    assert.equal((await api.get('/events?flat=20&day=2001-01-01')).data.events.length, 0);
    assert.equal((await api.get('/events?day=yesterday')).status, 400);
  });

  test('POST /parcels and the parcel-arrival event fill GET /parcels', async () => {
    assert.equal((await api.post('/parcels', {})).status, 400);
    const created = await api.post('/parcels', { flat: '12', snapshot_url: 'https://example.invalid/p.jpg' });
    assert.equal(created.status, 201);
    assert.equal(created.data.execution_id, null);

    await api.post('/events', {
      type: 'parcel.arrival',
      parcel_id: created.data.parcel_id,
      flat: '12',
      courier: 'DPD',
      label_text: 'FLAT 12 - HANDLE WITH CARE',
    });
    const parcels = (await api.get('/parcels?flat=12')).data;
    const parcel = parcels.find((p) => p.id === created.data.parcel_id);
    assert.deepEqual(Object.keys(parcel).sort(), ['at', 'courier', 'flat', 'id', 'label', 'status']);
    assert.equal(parcel.courier, 'DPD');
    assert.equal(parcel.label, 'FLAT 12 - HANDLE WITH CARE');
    assert.equal(parcel.status, 'at_desk');
    assert.deepEqual((await api.get('/parcels?flat=404')).data, []);
  });

  test('POST /notifications is in-app, and in-app only for anonymous residents', async () => {
    assert.equal((await api.post('/notifications', { title: 'x' })).status, 400);
    const { data: named } = await api.post('/residents', { name: 'Di', flat: '30', email: 'di@example.invalid' });
    const { data: anon } = await api.post('/residents', { flat: '31', anonymous: true });

    const toNamed = await api.post('/notifications', { resident_id: named.id, title: 'Parcel waiting', body: 'Hi' });
    assert.equal(toNamed.status, 201);
    assert.deepEqual(toNamed.data.channels, ['in_app']);
    assert.deepEqual(toNamed.data.preferred, ['email']);

    const toAnon = await api.post('/notifications', { resident_id: anon.id, title: 'Parcel waiting' });
    assert.deepEqual(toAnon.data.channels, ['in_app']);
    assert.deepEqual(toAnon.data.preferred, []);

    const inbox = await api.get('/notifications?flat=30');
    assert.equal(inbox.data[0].title, 'Parcel waiting');
    assert.equal((await api.get('/notifications')).status, 400);
  });

  test('GET /presence lists residents who arrived and have not left today', async () => {
    const { data: a } = await api.post('/residents', { name: 'Eve', flat: '40' });
    const { data: b } = await api.post('/residents', { name: 'Fin', flat: '41' });
    await api.post('/events', { type: 'resident.arrival', resident_id: a.id });
    await api.post('/events', { type: 'resident.arrival', resident_id: b.id });
    await api.post('/events', { type: 'resident.departure', resident_id: b.id });

    const { data } = await api.get('/presence');
    const ids = data.in.map((p) => p.residentId);
    assert.ok(ids.includes(a.id));
    assert.ok(!ids.includes(b.id));
    assert.equal(data.in.find((p) => p.residentId === a.id).flat, '40');
  });

  test('WS /live pushes visit frames for its own flat only', async () => {
    const twelve = await listen(`${api.ws}/live?flat=12`);
    const nine = await listen(`${api.ws}/live?flat=9`);
    await settle();
    twelve.frames.length = 0;
    nine.frames.length = 0;

    await api.post('/visits', { visit_id: 'visit_ws_9', flat: '9', proposed_reply: 'Hello' });
    await settle();
    assert.equal(twelve.frames.length, 0, 'flat 12 hears nothing about flat 9');
    assert.equal(nine.frames.length, 1);
    assert.equal(nine.frames[0].type, 'visit');
    assert.equal(nine.frames[0].visit.id, 'visit_ws_9');

    await api.post('/intercom/speak', { visit_id: 'visit_ws_9', text: 'Hello' });
    await settle();
    assert.equal(nine.frames.at(-1).visit.speech.text, 'Hello');
    assert.equal(twelve.frames.length, 0);

    twelve.socket.close();
    nine.socket.close();
  });

  test('GET /visits?waiting=1 is the whole queue', async () => {
    await api.post('/arrivals', { flat: '60' });
    await api.post('/arrivals', { flat: '61' });
    const all = (await api.get('/visits?waiting=1')).data;
    assert.ok(Array.isArray(all));
    assert.ok(all.some((v) => v.flat === '60') && all.some((v) => v.flat === '61'));
    assert.ok(all.every((v) => v.status === 'arriving' || v.status === 'pending_decision'));
    const one = (await api.get('/visits?waiting=1&flat=60')).data;
    assert.deepEqual(one.map((v) => v.flat), ['60']);
  });

  test('POST /snapshots stores the photograph and pushes it to that flat only', async () => {
    const twelve = await listen(`${api.ws}/live?flat=12`);
    const nine = await listen(`${api.ws}/live?flat=9`);
    await settle();
    twelve.frames.length = 0;
    nine.frames.length = 0;

    assert.equal((await api.post('/snapshots', { flat: '12', dataUrl: 'http://x' })).status, 400);
    assert.equal((await api.post('/snapshots', { dataUrl: 'data:image/png;base64,AA' })).status, 400);
    assert.equal((await api.get('/snapshots?flat=77')).status, 404);

    const stored = await api.post('/snapshots', { flat: '12', dataUrl: 'data:image/png;base64,AAAA', source: 'door' });
    assert.equal(stored.status, 201);
    assert.equal(stored.data.snapshot.dataUrl, undefined);
    const fetched = (await api.get('/snapshots?flat=12')).data;
    assert.equal(fetched.dataUrl, 'data:image/png;base64,AAAA');
    assert.equal(fetched.source, 'door');

    await settle();
    assert.equal(twelve.frames.length, 1);
    assert.equal(twelve.frames[0].type, 'snapshot');
    assert.equal(twelve.frames[0].snapshot.flat, '12');
    assert.equal(nine.frames.length, 0);
    twelve.socket.close();
    nine.socket.close();
  });

  test('WS /live?scope=door hears every flat, and visits with no flat yet', async () => {
    const door = await listen(`${api.ws}/live?scope=door`);
    const resident = await listen(`${api.ws}/live?flat=70`);
    await settle();
    assert.equal(door.frames.length, 1, 'the door gets the newest visit on connect');
    door.frames.length = 0;
    resident.frames.length = 0;

    await api.post('/visits', { visit_id: 'visit_door_70', flat: '70' });
    await api.post('/visits', { visit_id: 'visit_door_71', flat: '71' });
    await api.post('/arrivals', { flat: null });
    await settle();

    const seen = door.frames.filter((f) => f.type === 'visit').map((f) => f.visit.flat);
    assert.ok(seen.includes('70') && seen.includes('71'));
    assert.ok(seen.includes(null), 'a visit with no flat still reaches the door');
    assert.deepEqual(
      resident.frames.map((f) => f.visit.id),
      ['visit_door_70'],
      'a resident still hears only their own flat',
    );

    await api.post('/snapshots', { flat: '71', dataUrl: 'data:image/png;base64,AA' });
    await settle();
    assert.equal(door.frames.at(-1).type, 'snapshot');
    assert.equal(resident.frames.length, 1);

    door.socket.close();
    resident.socket.close();
  });

  test('WS /live?scope=door&door= hears only that door page', async () => {
    const A = 'door-aaaa-1111';
    const B = 'door-bbbb-2222';
    const a = await listen(`${api.ws}/live?scope=door&door=${A}`);
    const b = await listen(`${api.ws}/live?scope=door&door=${B}`);
    const ledger = await listen(`${api.ws}/live?scope=door`);
    await settle();
    assert.equal(a.frames.length, 0, 'a fresh door page gets no old visit on connect');
    assert.equal(b.frames.length, 0);
    ledger.frames.length = 0;

    const { data } = await api.post('/arrivals', { flat: '80', door_id: B });
    // The worker's later updates keep the door id from the arrival.
    await api.post('/visits', { visit_id: data.visit_id, flat: '80', proposed_reply: 'One moment.' });
    await api.post('/intercom/speak', { visit_id: data.visit_id, text: 'One moment.' });
    await api.post(`/visits/${data.visit_id}/decision`, { decision: 'approve' });
    await api.post('/snapshots', { flat: '80', dataUrl: 'data:image/png;base64,AA', source: 'door', door_id: B });
    await settle();

    assert.equal(a.frames.length, 0, "door A never hears door B's visit");
    const mine = b.frames.filter((f) => f.type === 'visit');
    assert.ok(mine.length >= 3 && mine.every((f) => f.visit.id === data.visit_id && f.visit.doorId === B));
    assert.equal(mine.at(-1).visit.status, 'approved');
    assert.ok(mine.some((f) => f.visit.speech?.text === 'One moment.'));
    assert.ok(b.frames.some((f) => f.type === 'snapshot'));
    assert.ok(ledger.frames.some((f) => f.visit?.id === data.visit_id), 'the ledger still sees everything');

    // Reconnecting door B gets its own latest visit back; A still gets nothing.
    const b2 = await listen(`${api.ws}/live?scope=door&door=${B}`);
    const a2 = await listen(`${api.ws}/live?scope=door&door=${A}`);
    await settle();
    assert.equal(b2.frames[0]?.visit.id, data.visit_id);
    assert.equal(a2.frames.length, 0);
    for (const s of [a, b, ledger, a2, b2]) s.socket.close();
  });

  test('WS /live without a flat or scope=door is refused with 1008', async () => {
    for (const path of ['/live', '/live?scope=lobby']) {
      const code = await new Promise((resolve) => {
        const socket = new WebSocket(`${api.ws}${path}`);
        socket.on('close', (c) => resolve(c));
      });
      assert.equal(code, 1008, path);
    }
  });
});

describe('live API with a fake Mistral', () => {
  const calls = [];
  let busy = 0;
  let refuse = false;
  const fakeMistral = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body), auth: init.headers.authorization });
    if (refuse) return new Response(JSON.stringify({ detail: 'no such workflow' }), { status: 404 });
    if (busy > 0) {
      busy -= 1;
      return new Response('{}', { status: 429 });
    }
    return new Response(JSON.stringify({ execution_id: 'exec_live_1' }), { status: 200 });
  };
  let api;
  before(async () => {
    api = await start({
      env: {
        MISTRAL_API_KEY: 'test-key',
        MISTRAL_API_URL: 'https://mistral.invalid',
        WORKFLOW_DEPLOYMENT_NAME: 'le-concierge-test',
        MISTRAL_RETRY_BASE_MS: '1',
        NODE_ENV: 'test',
      },
      fetch: fakeMistral,
    });
  });
  after(() => api.close());

  test('POST /arrivals starts visitor-arrival and the decision signals it', async () => {
    const created = await api.post('/arrivals', { flat: '12', snapshot_url: 'https://example.invalid/s.jpg', face: { descriptor: [0.1] } });
    assert.equal(created.status, 201);
    assert.equal(created.data.execution_id, 'exec_live_1');
    const start = calls.at(-1);
    assert.equal(start.url, 'https://mistral.invalid/v1/workflows/visitor-arrival/execute');
    assert.equal(start.auth, 'Bearer test-key');
    assert.equal(start.body.input.visit_id, created.data.visit_id);
    assert.equal(start.body.input.flat, '12');
    assert.deepEqual(start.body.input.face, { descriptor: [0.1] });

    // The worker posts the visit before the resident can answer.
    await api.post('/visits', { visit_id: created.data.visit_id, execution_id: 'exec_live_1', flat: '12' });
    const decided = await api.post(`/visits/${created.data.visit_id}/decision`, { decision: 'decline' });
    assert.equal(decided.data.ok, true);
    assert.equal(decided.data.signalled, true);
    const signal = calls.at(-1);
    assert.equal(signal.url, 'https://mistral.invalid/v1/workflows/executions/exec_live_1/signals');
    assert.equal(signal.body.name, 'resident-decision');
    assert.equal(signal.body.input.decision, 'decline');
  });

  test('POST /parcels starts parcel-arrival', async () => {
    const created = await api.post('/parcels', { snapshot_url: 'https://example.invalid/p.jpg', flat: '12' });
    assert.equal(created.status, 201);
    assert.equal(created.data.execution_id, 'exec_live_1');
    assert.equal(calls.at(-1).url, 'https://mistral.invalid/v1/workflows/parcel-arrival/execute');
    assert.equal(calls.at(-1).body.input.parcel_id, created.data.parcel_id);
  });

  test('the execute call names the deployment and retries a 429', async () => {
    busy = 2;
    const before = calls.length;
    const created = await api.post('/arrivals', { flat: '12' });
    assert.equal(created.status, 201);
    assert.equal(calls.length - before, 3, 'two 429s, then the start');
    assert.equal(calls.at(-1).body.deployment_name, 'le-concierge-test');
  });

  test('a refused start marks the visit fallback', async () => {
    refuse = true;
    const created = await api.post('/arrivals', { flat: '12' });
    refuse = false;
    assert.equal(created.status, 502);
    const visit = (await api.get(`/visits/${created.data.visit_id}`)).data;
    assert.equal(visit.status, 'fallback');
  });
});

describe('flat validation', () => {
  test('parseFlats reads ranges and names; normalizeFlat ignores case, spaces and leading zeros', () => {
    assert.deepEqual([...parseFlats('1-3, ph ,5')], ['1', '2', '3', 'PH', '5']);
    assert.deepEqual([...parseFlats('3-1')], ['1', '2', '3']);
    assert.equal(normalizeFlat(' 07 '), '7');
    assert.equal(normalizeFlat('ph'), 'PH');
    assert.equal(configFromEnv({}).buildingFlats.size, 20);
  });

  let api;
  let calls;
  before(async () => {
    calls = [];
    const fakeMistral = async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ execution_id: 'exec_flat' }), { status: 200 });
    };
    api = await start({
      env: { MISTRAL_API_KEY: 'test-key', MISTRAL_API_URL: 'https://mistral.invalid', NODE_ENV: 'test', BUILDING_FLATS: '1-20,PH' },
      fetch: fakeMistral,
    });
  });
  after(() => api.close());

  test('POST /arrivals refuses a flat the building does not have, and starts nothing', async () => {
    const before = calls.length;
    const refused = await api.post('/arrivals', { flat: '99' });
    assert.equal(refused.status, 422);
    assert.equal(refused.data.error, 'no_such_flat');
    assert.equal(refused.data.flat, '99');
    assert.match(refused.data.reply, /no flat 99/);
    assert.equal(calls.length, before, 'no workflow started');
    assert.equal(refused.data.visit_id, undefined);
  });

  test('POST /arrivals refuses a flat with nobody registered', async () => {
    const before = calls.length;
    const refused = await api.post('/arrivals', { flat: 'ph' });
    assert.equal(refused.status, 422);
    assert.deepEqual([refused.data.error, refused.data.flat], ['no_resident', 'ph']);
    assert.equal(calls.length, before);
  });

  test('a registered flat, and a null flat, still start the workflow', async () => {
    assert.equal((await api.post('/arrivals', { flat: '012' })).status, 201);
    assert.equal((await api.post('/arrivals', { flat: null })).status, 201);
    await api.post('/residents', { flat: 'PH', anonymous: true });
    assert.equal((await api.post('/arrivals', { flat: 'PH' })).status, 201);
  });

  test('GET /flats/:flat says whether it exists and has a resident', async () => {
    assert.deepEqual((await api.get('/flats/12')).data, { exists: true, hasResident: true });
    assert.deepEqual((await api.get('/flats/3')).data, { exists: true, hasResident: false });
    assert.deepEqual((await api.get('/flats/99')).data, { exists: false, hasResident: false });
  });
});

describe('stale visits', () => {
  let api;
  before(async () => {
    api = await start({ env: { WORKFLOWS_REPLAY: '1', NODE_ENV: 'test', VISIT_TTL_SECONDS: '0' } });
  });
  after(() => api.close());

  test('a visit waiting past VISIT_TTL_SECONDS is swept to expired', async () => {
    const { data } = await api.post('/arrivals', { flat: '12' });
    await settle();
    assert.equal((await api.get('/visits?flat=12&status=pending')).data, null);
    assert.equal((await api.get(`/visits/${data.visit_id}`)).data.status, 'expired');
  });
});

test('WORKFLOWS_REPLAY=1 wins over a key, and the face threshold is configurable', () => {
  const replay = configFromEnv({ MISTRAL_API_KEY: 'k', WORKFLOWS_REPLAY: '1' });
  assert.equal(replay.offline, true);
  assert.equal(configFromEnv({}).offline, true);
  assert.equal(configFromEnv({ MISTRAL_API_KEY: 'k' }).offline, false);
  assert.equal(configFromEnv({}).faceMatchThreshold, 0.5);
  assert.equal(configFromEnv({ FACE_MATCH_THRESHOLD: '0.4' }).faceMatchThreshold, 0.4);
});
