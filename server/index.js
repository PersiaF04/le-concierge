#!/usr/bin/env node

/**
 * Le Concierge API.
 *
 * The bridge between the workflows worker and the two apps:
 *
 *   POST /arrivals              start a visitor-arrival execution
 *   POST /visits                worker -> store the visit, push it to /live
 *   POST /visits/:id/decision   app -> answer the door, signal the execution
 *   POST /intercom/speak        worker -> what the door said, pushed to /live
 *
 * Everything the worker writes to `/visits` and `/intercom/speak` is broadcast
 * to the resident app on `ws://…/live?flat=12`, so the phone follows the
 * execution rather than a fixture. State is in memory on purpose: this is the
 * demo API, and `docs/demo.md` says so.
 */

import express from 'express';
import { WebSocket as Socket, WebSocketServer } from 'ws';
import { createServer } from 'node:http';

const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const MISTRAL_API_URL = (process.env.MISTRAL_API_URL || 'https://api.mistral.ai').replace(/\/$/, '');
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY || '';
const WORKFLOW_NAME = process.env.VISITOR_WORKFLOW || 'visitor-arrival';
const DECISION_TIMEOUT_SECONDS = Number(process.env.VISITOR_DECISION_TIMEOUT_SECONDS || 60);

if (!MISTRAL_API_KEY && NODE_ENV !== 'test') {
  console.warn('⚠️  MISTRAL_API_KEY is not set: POST /arrivals and decision signals will fail.');
}

// ============================================================================
// State
// ============================================================================

/** @type {Map<string, object>} visit_id -> visit in the apps' shape */
const visits = new Map();
/** @type {Map<string, object>} resident_id -> resident */
const residents = new Map();
/** @type {object[]} append-only timeline */
const events = [];
/** @type {object[]} parcels at the desk */
const parcels = [];
/** @type {Set<import('ws').WebSocket>} */
const clients = new Set();

// ============================================================================
// Helpers
// ============================================================================

const nowIso = () => new Date().toISOString();

function newVisitId() {
  return `visit_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Push a visit to every resident watching that flat (and to the log). */
function broadcast(visit) {
  const frame = JSON.stringify({ type: 'visit', visit });
  for (const socket of clients) {
    if (!socket.isAlive) continue;
    const flat = socket.flat;
    if (flat && visit.flat && String(flat) !== String(visit.flat)) continue;
    if (socket.readyState === Socket.OPEN) socket.send(frame);
  }
}

function publicVisit(visit) {
  return {
    id: visit.id,
    flat: visit.flat,
    residentId: visit.residentId ?? null,
    status: visit.status,
    at: visit.at,
    timeoutSeconds: visit.timeoutSeconds ?? DECISION_TIMEOUT_SECONDS,
    transcript: visit.transcript ?? '',
    confidence: visit.confidence ?? null,
    faceDistance: visit.faceDistance ?? null,
    reply: visit.reply ?? '',
    executionId: visit.executionId ?? null,
    parcel: visit.parcel ?? null,
    snapshot: visit.snapshot ?? null,
    decidedAt: visit.decidedAt ?? null,
    speech: visit.speech ?? null,
    mode: 'workflow',
  };
}

async function mistral(path, body) {
  if (!MISTRAL_API_KEY) throw new Error('MISTRAL_API_KEY is not set on the server');
  const response = await fetch(`${MISTRAL_API_URL}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${MISTRAL_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text.slice(0, 400) };
  }
  if (!response.ok) {
    throw new Error(`${path} -> ${response.status}: ${JSON.stringify(parsed).slice(0, 400)}`);
  }
  return parsed;
}

/** Start one execution and keep hold of its id, which is what the signal needs. */
async function startArrival({ flat = null, visitId, snapshotUrl, audioUrl, face = {} }) {
  const execution = await mistral(`/v1/workflows/${WORKFLOW_NAME}/execute`, {
    input: {
      visit_id: visitId,
      snapshot_url: snapshotUrl,
      flat,
      audio_url: audioUrl ?? null,
      face,
      decision_timeout_seconds: DECISION_TIMEOUT_SECONDS,
    },
  });
  const executionId =
    execution?.execution_id ?? execution?.id ?? execution?.run_id ?? execution?.execution?.id ?? null;
  return { execution, executionId };
}

// ============================================================================
// App
// ============================================================================

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/live' });

app.use((req, res, next) => {
  if (req.path !== '/health') {
    console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  }
  next();
});
app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'content-type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: nowIso(),
    version: process.env.npm_package_version || '0.1.0',
    node: process.version,
    env: NODE_ENV,
    workflow: WORKFLOW_NAME,
    key: MISTRAL_API_KEY ? 'set' : 'missing',
    visits: visits.size,
  });
});

// ── the door starts a visit ─────────────────────────────────────────────────

app.post('/arrivals', async (req, res) => {
  const flat = req.body?.flat ? String(req.body.flat) : null;
  const visitId = newIdOr(req.body?.visit_id);
  const visit = {
    id: visitId,
    flat,
    status: 'arriving',
    at: nowIso(),
    timeoutSeconds: DECISION_TIMEOUT_SECONDS,
    transcript: '',
    reply: '',
    mode: 'workflow',
  };
  visits.set(visitId, visit);
  broadcast(publicVisit(visit));

  try {
    const { execution, executionId } = await startArrival({
      flat,
      visitId,
      snapshotUrl: req.body?.snapshot_url || 'https://picsum.photos/seed/le-concierge/640/480',
      audioUrl: req.body?.audio_url,
      face: req.body?.face || {},
    });
    visit.executionId = executionId;
    broadcast(publicVisit(visit));
    res.status(201).json({ visit_id: visitId, execution_id: executionId, execution });
  } catch (error) {
    visit.status = 'fallback';
    broadcast(publicVisit(visit));
    res.status(502).json({ visit_id: visitId, error: String(error.message || error) });
  }
});

function newIdOr(value) {
  return typeof value === 'string' && value.length > 0 ? value : newVisitId();
}

// ── what the worker tells us ────────────────────────────────────────────────

app.post('/visits', (req, res) => {
  const body = req.body || {};
  const id = body.visit_id || body.id;
  if (!id) return res.status(400).json({ error: 'visit_id is required' });

  const existing = visits.get(id) || {
    id,
    at: nowIso(),
    timeoutSeconds: DECISION_TIMEOUT_SECONDS,
  };
  const transcript = typeof body.transcript === 'string' ? body.transcript : body.transcript?.text || '';
  const visit = {
    ...existing,
    flat: body.flat ? String(body.flat) : existing.flat ?? null,
    residentId: body.resident_id ?? existing.residentId ?? null,
    executionId: body.execution_id ?? existing.executionId ?? null,
    transcript,
    confidence: typeof body.confidence === 'number' ? body.confidence : existing.confidence ?? null,
    faceDistance:
      typeof body.face_distance === 'number' ? body.face_distance : existing.faceDistance ?? null,
    reply: body.proposed_reply || existing.reply || '',
    parcel: body.parcel ?? existing.parcel ?? null,
    recognition: body.recognition ?? existing.recognition ?? null,
    status: body.status || 'pending_decision',
    mode: 'workflow',
  };
  visits.set(id, visit);
  events.push({ type: 'visit.posted', visit_id: id, at: nowIso(), flat: visit.flat });
  broadcast(publicVisit(visit));
  res.status(201).json({ stored: true, visit: publicVisit(visit) });
});

app.post('/intercom/speak', (req, res) => {
  const body = req.body || {};
  const visitId = body.visit_id || body.id || null;
  const speech = {
    text: body.text ?? '',
    model: body.model ?? null,
    voiceId: body.voice_id ?? null,
    transport: body.transport ?? null,
    streamingMode: body.streaming_mode ?? null,
    chunks: body.chunks ?? null,
    firstChunkMs: body.first_chunk_ms ?? null,
    audioBytes: body.audio_bytes ?? null,
    played: true,
    // Voxtral did not report a duration, so it is derived from the wav it
    // streamed: 24 kHz, 16-bit, mono = 48,000 bytes per second.
    durationMs:
      typeof body.duration_ms === 'number'
        ? body.duration_ms
        : typeof body.audio_bytes === 'number'
          ? Math.round(body.audio_bytes / 48)
          : null,
    at: nowIso(),
  };
  if (visitId && visits.has(visitId)) {
    const visit = visits.get(visitId);
    visit.speech = speech;
    visits.set(visitId, visit);
    events.push({ type: 'visit.spoken', visit_id: visitId, at: speech.at, model: speech.model });
    broadcast(publicVisit(visit));
  }
  res.json({ played: true, duration_ms: speech.durationMs ?? 0 });
});

// ── the resident answers ────────────────────────────────────────────────────

app.post('/visits/:id/decision', async (req, res) => {
  const visit = visits.get(req.params.id);
  if (!visit) return res.status(404).json({ error: 'unknown visit' });

  const decision = String(req.body?.decision || '').toLowerCase() === 'approve' ? 'approve' : 'decline';
  visit.status = decision === 'approve' ? 'approved' : 'declined';
  visit.decidedAt = nowIso();
  visits.set(visit.id, visit);
  events.push({ type: 'visit.decision', visit_id: visit.id, decision, at: visit.decidedAt });
  broadcast(publicVisit(visit));

  if (!visit.executionId) {
    return res.json({ ok: true, signalled: false, reason: 'no execution id on this visit' });
  }
  try {
    await mistral(`/v1/workflows/executions/${visit.executionId}/signals`, {
      name: 'resident-decision',
      input: {
        decision,
        resident_id: req.body?.resident_id || visit.residentId || null,
        note: req.body?.note || null,
      },
    });
    res.json({ ok: true, signalled: true, execution_id: visit.executionId });
  } catch (error) {
    res.status(502).json({ ok: false, signalled: false, error: String(error.message || error) });
  }
});

// ── reads the apps and the worker need ─────────────────────────────────────

app.get('/visits', (req, res) => {
  const flat = req.query.flat ? String(req.query.flat) : null;
  const status = req.query.status ? String(req.query.status) : null;
  const wanted = status === 'pending' ? new Set(['pending_decision', 'arriving']) : null;

  const list = [...visits.values()]
    .filter((visit) => (flat ? String(visit.flat) === flat : true))
    .filter((visit) => (wanted ? wanted.has(visit.status) : true))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .map(publicVisit);

  if (req.query.status === 'pending') {
    return res.json(list[0] ?? null);
  }
  res.json(list);
});

app.get('/visits/:id', (req, res) => {
  const visit = visits.get(req.params.id);
  if (!visit) return res.status(404).json({ error: 'unknown visit' });
  res.json(publicVisit(visit));
});

app.get('/parcels', (req, res) => {
  const flat = req.query.flat ? String(req.query.flat) : null;
  res.json(parcels.filter((parcel) => (flat ? String(parcel.flat) === flat : true)));
});

app.get('/events', (req, res) => {
  const flat = req.query.flat ? String(req.query.flat) : null;
  const list = events.filter((event) => (flat ? String(event.flat) === flat : true));
  res.json(list);
});

app.post('/events', (req, res) => {
  const event = { ...req.body, at: req.body?.at || nowIso() };
  events.push(event);

  // The workflow reports its outcome as an event, so the visit closes here as
  // well: without this the door would keep claiming a decision is pending.
  if (event.type === 'visit.decision' && event.visit_id) {
    const visit = visits.get(event.visit_id);
    if (visit) {
      const decision = event.decision;
      visit.status =
        decision === 'approve' ? 'approved' : event.automatic ? 'expired' : 'declined';
      visit.decidedAt = visit.decidedAt || event.at;
      visit.transcript = event.transcript || visit.transcript;
      broadcast(publicVisit(visit));
    }
  }

  res.status(201).json({ stored: true, event });
});

app.get('/presence', (req, res) => {
  res.json({ residents: residents.size, visits: visits.size, sockets: clients.size });
});

app.post('/residents', (req, res) => {
  const flat = req.body?.flat ? String(req.body.flat) : null;
  if (!flat) return res.status(400).json({ error: 'flat is required' });
  const id = req.body?.id || `res_${flat}_${Math.random().toString(36).slice(2, 7)}`;
  const resident = { ...req.body, id, flat, createdAt: nowIso() };
  residents.set(id, resident);
  res.status(201).json(resident);
});

app.post('/residents/:id/confirm', (req, res) => {
  const resident = residents.get(req.params.id);
  if (resident) resident.confirmedAt = nowIso();
  res.json({ ok: true, resident_id: req.params.id, confirmed: Boolean(resident) });
});

/**
 * Stand-in for the descriptor store: the doorstep app sends a face-api.js
 * descriptor, and this answers which opted-in resident it is. Real matching is
 * issue #8; until then it is deliberately naive and says so in the response.
 */
app.post('/faces/match', (req, res) => {
  const hasDescriptor = Array.isArray(req.body?.descriptor) && req.body.descriptor.length > 0;
  if (!hasDescriptor) {
    return res.json({ matched: false, resident_id: null, distance: null, stub: true });
  }
  res.json({
    matched: true,
    resident_id: req.body?.resident_id || 'res_12_persia',
    distance: 0.31,
    stub: true,
    note: 'placeholder match: one known resident, fixed distance',
  });
});

// ============================================================================
// Live updates
// ============================================================================

wss.on('connection', (socket, req) => {
  const url = new URL(req.url || '/live', 'http://localhost');
  socket.flat = url.searchParams.get('flat');
  socket.isAlive = true;
  clients.add(socket);

  const current = [...visits.values()]
    .filter((visit) => (socket.flat ? String(visit.flat) === socket.flat : true))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))[0];
  if (current) socket.send(JSON.stringify({ type: 'visit', visit: publicVisit(current) }));

  socket.on('pong', () => {
    socket.isAlive = true;
  });
  socket.on('close', () => clients.delete(socket));
  socket.on('error', () => clients.delete(socket));
});

const heartbeat = setInterval(() => {
  for (const socket of clients) {
    if (!socket.isAlive) {
      socket.terminate();
      clients.delete(socket);
      continue;
    }
    socket.isAlive = false;
    socket.ping();
  }
}, 30000);
heartbeat.unref();

// ============================================================================
// Errors and start
// ============================================================================

app.use((err, req, res, next) => {
  console.error('⚠️  Error:', err);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: err.message || 'Internal Server Error' });
});

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

server.listen(PORT, () => {
  console.log('═══════════════════════════════════════════════════════');
  console.log('✅ Le Concierge API is running');
  console.log(`📍 Environment: ${NODE_ENV}`);
  console.log(`🌐 URL: http://localhost:${PORT}`);
  console.log(`🔌 WebSocket: ws://localhost:${PORT}/live?flat=12`);
  console.log(`🤖 Workflow: ${WORKFLOW_NAME} (key ${MISTRAL_API_KEY ? 'set' : 'missing'})`);
  console.log('═══════════════════════════════════════════════════════');
});

export default server;
