/**
 * Le Concierge API.
 *
 * The bridge between the workflows worker and the two apps:
 *
 *   POST /arrivals              start a visitor-arrival execution
 *   POST /parcels               start a parcel-arrival execution
 *   POST /visits                worker -> store the visit, push it to /live
 *   POST /visits/:id/decision   app -> answer the door, signal the execution
 *   POST /intercom/speak        worker -> what the door said, pushed to /live
 *   POST /voice/session         door -> start a Mistral Voice Agent session (voice.js)
 *
 * Everything the worker writes to `/visits` and `/intercom/speak` is broadcast
 * to the resident app on `ws://…/live?flat=12`, so the phone follows the
 * execution rather than a fixture. State lives in SQLite (see `db.js`).
 *
 * Offline mode: with WORKFLOWS_REPLAY=1, or no MISTRAL_API_KEY, the API never
 * calls Mistral. Arrivals become local visits with `execution_id: null`, and a
 * decision only updates the visit, so the apps and the tests run without a
 * network. docs/api.md documents every route.
 */

import express from 'express';
import { WebSocket as Socket, WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import { mountVoice, voiceConfigFromEnv } from './voice.js';

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const PENDING = new Set(['arriving', 'pending_decision']);
const PRESENCE_IN = 'resident.arrival';
const PRESENCE_OUT = 'resident.departure';

/** Read the API's settings from an environment object. */
export function configFromEnv(env = process.env) {
  const key = env.MISTRAL_API_KEY || '';
  const replay =
    TRUTHY.has(String(env.WORKFLOWS_REPLAY || '').toLowerCase()) ||
    String(env.REPLAY_MODE || '').toLowerCase() === 'replay';
  return {
    nodeEnv: env.NODE_ENV || 'development',
    mistralApiUrl: (env.MISTRAL_API_URL || 'https://api.mistral.ai').replace(/\/$/, ''),
    mistralApiKey: key,
    offline: replay || !key,
    visitorWorkflow: env.VISITOR_WORKFLOW || 'visitor-arrival',
    parcelWorkflow: env.PARCEL_WORKFLOW || 'parcel-arrival',
    decisionTimeoutSeconds: Number(env.VISITOR_DECISION_TIMEOUT_SECONDS || 60),
    faceMatchThreshold: Number(env.FACE_MATCH_THRESHOLD || 0.5),
    // Two deployments can register the same workflow name; this picks one.
    deploymentName: env.WORKFLOW_DEPLOYMENT_NAME || undefined,
    // A visit still waiting long after its own timeout is swept to "expired".
    visitTtlSeconds: Number(env.VISIT_TTL_SECONDS || 300),
    retryBaseMs: Number(env.MISTRAL_RETRY_BASE_MS || 600),
    voice: voiceConfigFromEnv(env),
  };
}

const nowIso = () => new Date().toISOString();
const newId = (prefix) =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const str = (value) => (value === undefined || value === null || value === '' ? null : String(value));
const fail = (res, status, error) => res.status(status).json({ error });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A door page's id (a UUID from the browser), or null when absent or malformed. */
const doorIdFrom = (value) =>
  typeof value === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(value) ? value : null;

/** A face-api.js descriptor: a non-empty array of finite numbers. */
function isDescriptor(value) {
  return Array.isArray(value) && value.length > 0 && value.every((n) => Number.isFinite(n));
}

function euclidean(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += (a[i] - b[i]) ** 2;
  return Math.sqrt(sum);
}

/**
 * Build the API around an open database. Nothing listens until the caller
 * calls `server.listen`, so tests can start it on a random port.
 *
 * @param {{ db: import('node:sqlite').DatabaseSync, config?: object, fetch?: typeof fetch, voiceClient?: object }} options
 *   `voiceClient` stands in for the Mistral SDK client in tests.
 */
export function createApp({ db, config = configFromEnv(), fetch: fetchImpl = globalThis.fetch, voiceClient }) {
  // ==========================================================================
  // Storage
  // ==========================================================================

  const sql = {
    getVisit: db.prepare('SELECT doc FROM visits WHERE id = ?'),
    putVisit: db.prepare(
      `INSERT INTO visits (id, flat, status, at, execution_id, doc) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET flat = excluded.flat, status = excluded.status,
         execution_id = excluded.execution_id, doc = excluded.doc`,
    ),
    countVisits: db.prepare('SELECT count(*) AS n FROM visits'),
    getResident: db.prepare('SELECT doc, confirmed_at FROM residents WHERE id = ?'),
    residentsInFlat: db.prepare('SELECT doc FROM residents WHERE flat = ?'),
    countResidents: db.prepare('SELECT count(*) AS n FROM residents'),
    putResident: db.prepare(
      `INSERT INTO residents (id, flat, anonymous, confirmed_at, created_at, doc) VALUES (?, ?, ?, NULL, ?, ?)`,
    ),
    confirmResident: db.prepare(
      'UPDATE residents SET confirmed_at = coalesce(confirmed_at, ?) WHERE id = ?',
    ),
    putFace: db.prepare(
      `INSERT INTO faces (resident_id, descriptor, model, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(resident_id) DO UPDATE SET descriptor = excluded.descriptor,
         model = excluded.model, created_at = excluded.created_at`,
    ),
    confirmedFaces: db.prepare(
      `SELECT f.resident_id, f.descriptor FROM faces f
       JOIN residents r ON r.id = f.resident_id WHERE r.confirmed_at IS NOT NULL`,
    ),
    putDecision: db.prepare(
      'INSERT INTO decisions (visit_id, decision, resident_id, note, signalled, at) VALUES (?, ?, ?, ?, ?, ?)',
    ),
    putEvent: db.prepare(
      'INSERT INTO events (type, flat, visit_id, resident_id, at, doc) VALUES (?, ?, ?, ?, ?, ?)',
    ),
    putParcel: db.prepare(
      `INSERT INTO parcels (id, flat, status, at, doc) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET flat = excluded.flat, status = excluded.status, doc = excluded.doc`,
    ),
    getParcel: db.prepare('SELECT doc FROM parcels WHERE id = ?'),
    parcelsInFlat: db.prepare('SELECT doc FROM parcels WHERE flat = ? ORDER BY at DESC'),
    allParcels: db.prepare('SELECT doc FROM parcels ORDER BY at DESC'),
    putNotification: db.prepare(
      'INSERT INTO notifications (resident_id, flat, at, doc) VALUES (?, ?, ?, ?)',
    ),
    putAudio: db.prepare(
      'INSERT INTO audio (visit_id, wav) VALUES (?, ?) ON CONFLICT(visit_id) DO UPDATE SET wav = excluded.wav',
    ),
    getAudio: db.prepare('SELECT wav FROM audio WHERE visit_id = ?'),
    putSnapshot: db.prepare(
      'INSERT INTO snapshots (flat, at, doc) VALUES (?, ?, ?) ON CONFLICT(flat) DO UPDATE SET at = excluded.at, doc = excluded.doc',
    ),
    getSnapshot: db.prepare('SELECT doc FROM snapshots WHERE flat = ?'),
    countSnapshots: db.prepare('SELECT count(*) AS n FROM snapshots'),
    staleVisits: db.prepare(
      "SELECT doc FROM visits WHERE status IN ('arriving', 'pending_decision') AND at < ?",
    ),
    presenceToday: db.prepare(
      `SELECT resident_id, type, at FROM events
       WHERE type IN ('${PRESENCE_IN}', '${PRESENCE_OUT}') AND resident_id IS NOT NULL AND at >= ?
       ORDER BY at, id`,
    ),
  };

  const parse = (row) => (row ? JSON.parse(row.doc) : null);
  const getVisit = (id) => parse(sql.getVisit.get(id));
  const getResident = (id) => parse(sql.getResident.get(id));

  function saveVisit(visit) {
    sql.putVisit.run(
      visit.id,
      visit.flat ?? null,
      visit.status,
      visit.at,
      visit.executionId ?? null,
      JSON.stringify(visit),
    );
    return visit;
  }

  function saveParcel(parcel) {
    sql.putParcel.run(parcel.id, parcel.flat ?? null, parcel.status, parcel.at, JSON.stringify(parcel));
    return parcel;
  }

  /** Append to the timeline; the flat comes from the visit when not given. */
  function logEvent(body) {
    const event = { ...body, at: body.at || nowIso() };
    const visitId = str(event.visit_id);
    if (!event.flat && visitId) event.flat = getVisit(visitId)?.flat ?? null;
    const flat = str(event.flat);
    const residentId = str(event.resident_id);
    const { lastInsertRowid } = sql.putEvent.run(
      String(event.type),
      flat,
      visitId,
      residentId,
      event.at,
      JSON.stringify(event),
    );
    return { id: Number(lastInsertRowid), event };
  }

  // ==========================================================================
  // Live updates
  // ==========================================================================

  /** @type {Set<import('ws').WebSocket>} */
  const clients = new Set();

  /** Push a visit to the sockets watching its flat, and nobody else. */
  /**
   * Who hears about a visit or a photograph:
   * - a resident socket (`?flat=`), for its own flat;
   * - a door page's socket (`?scope=door&door=<id>`), only for what that page
   *   started, so one door's conversation never plays on another;
   * - the building-wide `?scope=door` socket (the #ledger log), for everything.
   */
  const hears = (socket, flat, doorId) => {
    if (socket.scope === 'door') return socket.doorId ? doorId === socket.doorId : true;
    return flat != null && socket.flat === String(flat);
  };

  /** Push a visit to the sockets watching its flat, and to the door. */
  function broadcast(visit) {
    const frame = JSON.stringify({ type: 'visit', visit: publicVisit(visit) });
    for (const socket of clients) {
      if (!hears(socket, visit.flat, visit.doorId ?? null)) continue;
      if (socket.readyState === Socket.OPEN) socket.send(frame);
    }
  }

  /** Push a photograph to the sockets watching its flat. */
  function broadcastSnapshot(snapshot) {
    const frame = JSON.stringify({ type: 'snapshot', snapshot });
    for (const socket of clients) {
      if (!hears(socket, snapshot.flat, snapshot.doorId ?? null)) continue;
      if (socket.readyState === Socket.OPEN) socket.send(frame);
    }
  }

  /**
   * Expire anything that can no longer be answered, and tell the sockets: an
   * execution that died, or a demo from an hour ago, should not stay queued.
   */
  function sweepStaleVisits() {
    const cutoff = new Date(Date.now() - config.visitTtlSeconds * 1000).toISOString();
    for (const row of sql.staleVisits.all(cutoff)) {
      const visit = parse(row);
      visit.status = 'expired';
      visit.decidedAt = nowIso();
      saveVisit(visit);
      broadcast(visit);
    }
  }

  function publicVisit(visit) {
    return {
      id: visit.id,
      flat: visit.flat ?? null,
      residentId: visit.residentId ?? null,
      status: visit.status,
      at: visit.at,
      timeoutSeconds: visit.timeoutSeconds ?? config.decisionTimeoutSeconds,
      transcript: visit.transcript ?? '',
      confidence: visit.confidence ?? null,
      faceDistance: visit.faceDistance ?? null,
      reply: visit.reply ?? '',
      executionId: visit.executionId ?? null,
      doorId: visit.doorId ?? null,
      parcel: visit.parcel ?? null,
      snapshot: visit.snapshot ?? null,
      decidedAt: visit.decidedAt ?? null,
      speech: visit.speech ?? null,
      mode: 'workflow',
    };
  }

  // ==========================================================================
  // Mistral Workflows
  // ==========================================================================

  /**
   * One call to the Mistral API, with the patience a doorbell needs: the API
   * answers 429 when executions start in a burst, so 429 and 5xx are retried
   * with backoff rather than turning the visit into a silent "fallback".
   */
  async function mistral(path, body, { attempts = 4 } = {}) {
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const response = await fetchImpl(`${config.mistralApiUrl}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.mistralApiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      const text = await response.text();
      let parsed = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = { raw: text.slice(0, 400) };
      }
      if (response.ok) return parsed;

      lastError = new Error(`${path} -> ${response.status}: ${JSON.stringify(parsed).slice(0, 300)}`);
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === attempts) throw lastError;
      console.warn(`retrying ${path} after ${response.status} (attempt ${attempt})`);
      await sleep(config.retryBaseMs * 2 ** (attempt - 1));
    }
    throw lastError ?? new Error(`${path} failed`);
  }

  /** Start one execution and return its id, which is what the signal needs. */
  async function execute(workflow, input) {
    const execution = await mistral(`/v1/workflows/${workflow}/execute`, {
      input,
      deployment_name: config.deploymentName,
    });
    return execution?.execution_id ?? execution?.id ?? null;
  }

  // ==========================================================================
  // App
  // ==========================================================================

  const app = express();
  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: '/live' });

  app.use(express.json({ limit: '8mb' }));
  app.use(express.urlencoded({ extended: true }));

  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'content-type');
    // An https page (the Vercel build) reaching an API on localhost is a
    // "private network" request: Chrome blocks it unless the preflight agrees.
    res.header('Access-Control-Allow-Private-Network', 'true');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      timestamp: nowIso(),
      version: process.env.npm_package_version || '0.1.0',
      node: process.version,
      env: config.nodeEnv,
      workflow: config.visitorWorkflow,
      mode: config.offline ? 'offline' : 'live',
      key: config.mistralApiKey ? 'set' : 'missing',
      visits: sql.countVisits.get().n,
      snapshots: sql.countSnapshots.get().n,
    });
  });

  // ── the door's live conversation (Mistral Voice Agents) ────────────────────

  mountVoice(app, {
    apiKey: config.mistralApiKey,
    decisionTimeoutSeconds: config.decisionTimeoutSeconds,
    voice: config.voice,
    client: voiceClient,
  });

  // ── the door starts a visit ───────────────────────────────────────────────

  app.post('/arrivals', async (req, res) => {
    const body = req.body || {};
    const flat = str(body.flat);
    const visit = saveVisit({
      id: str(body.visit_id) || newId('visit'),
      flat,
      // The door page that rang: only its own socket hears this visit.
      doorId: doorIdFrom(body.door_id),
      residentId: str(body.face?.resident_id),
      // Offline nothing will post the visit later, so it is pending at once.
      status: config.offline ? 'pending_decision' : 'arriving',
      at: nowIso(),
      timeoutSeconds: config.decisionTimeoutSeconds,
      transcript: '',
      reply: '',
      snapshot: str(body.snapshot_url),
      executionId: null,
    });
    logEvent({ type: 'visit.arrival', visit_id: visit.id, flat });
    broadcast(visit);

    if (config.offline) {
      return res.status(201).json({ visit_id: visit.id, execution_id: null });
    }
    try {
      visit.executionId = await execute(config.visitorWorkflow, {
        visit_id: visit.id,
        snapshot_url: body.snapshot_url || 'https://picsum.photos/seed/le-concierge/640/480',
        flat,
        audio_url: body.audio_url ?? null,
        face: body.face || {},
        decision_timeout_seconds: config.decisionTimeoutSeconds,
      });
      saveVisit(visit);
      broadcast(visit);
      res.status(201).json({ visit_id: visit.id, execution_id: visit.executionId });
    } catch (error) {
      visit.status = 'fallback';
      visit.error = String(error.message || error).slice(0, 200);
      saveVisit(visit);
      broadcast(visit);
      res.status(502).json({ visit_id: visit.id, execution_id: null, error: visit.error });
    }
  });

  // ── the desk logs a parcel ────────────────────────────────────────────────

  app.post('/parcels', async (req, res) => {
    const body = req.body || {};
    if (!body.snapshot_url && !body.label_text) {
      return fail(res, 400, 'snapshot_url or label_text is required');
    }
    const parcel = saveParcel({
      id: str(body.parcel_id) || newId('parcel'),
      flat: str(body.flat) ?? '',
      courier: str(body.courier) ?? '',
      label: str(body.label_text) ?? '',
      at: nowIso(),
      status: 'at_desk',
    });

    if (config.offline) {
      logEvent({ type: 'parcel.arrival', parcel_id: parcel.id, flat: parcel.flat || null });
      return res.status(201).json({ parcel_id: parcel.id, execution_id: null, parcel });
    }
    try {
      const executionId = await execute(config.parcelWorkflow, {
        parcel_id: parcel.id,
        snapshot_url: body.snapshot_url || '',
        flat: str(body.flat),
        label_text: str(body.label_text),
        resident_id: str(body.resident_id),
      });
      res.status(201).json({ parcel_id: parcel.id, execution_id: executionId, parcel });
    } catch (error) {
      res.status(502).json({ parcel_id: parcel.id, execution_id: null, error: String(error.message || error) });
    }
  });

  app.get('/parcels', (req, res) => {
    const flat = str(req.query.flat);
    const rows = flat ? sql.parcelsInFlat.all(flat) : sql.allParcels.all();
    res.json(rows.map(parse));
  });

  // ── what the worker tells us ──────────────────────────────────────────────

  app.post('/visits', (req, res) => {
    const body = req.body || {};
    const id = str(body.visit_id || body.id);
    if (!id) return fail(res, 400, 'visit_id is required');

    const existing = getVisit(id) || {
      id,
      at: nowIso(),
      timeoutSeconds: config.decisionTimeoutSeconds,
    };
    const transcript =
      typeof body.transcript === 'string' ? body.transcript : body.transcript?.text ?? existing.transcript ?? '';
    // A visit the resident already answered keeps its answer.
    const status = PENDING.has(existing.status) || !existing.status
      ? body.status || 'pending_decision'
      : existing.status;
    const visit = saveVisit({
      ...existing,
      flat: str(body.flat) ?? existing.flat ?? null,
      residentId: body.resident_id ?? existing.residentId ?? null,
      executionId: body.execution_id ?? existing.executionId ?? null,
      transcript,
      confidence: typeof body.confidence === 'number' ? body.confidence : existing.confidence ?? null,
      faceDistance:
        typeof body.face_distance === 'number' ? body.face_distance : existing.faceDistance ?? null,
      reply: body.proposed_reply || existing.reply || '',
      parcel: body.parcel ?? existing.parcel ?? null,
      recognition: body.recognition ?? existing.recognition ?? null,
      status,
    });
    logEvent({ type: 'visit.posted', visit_id: id, flat: visit.flat });
    broadcast(visit);
    res.status(201).json({
      stored: true,
      visit_id: id,
      execution_id: visit.executionId,
      status: visit.status,
      notified_over: 'ws:/live',
      visit: publicVisit(visit),
    });
  });

  app.post('/intercom/speak', (req, res) => {
    const body = req.body || {};
    const visitId = str(body.visit_id || body.id);
    const speech = {
      text: body.text ?? '',
      model: body.model ?? null,
      voiceId: body.voice_id ?? null,
      transport: body.transport ?? null,
      streamingMode: body.streaming_mode ?? null,
      chunks: body.chunks ?? null,
      firstChunkMs: body.first_chunk_ms ?? null,
      audioBytes: body.audio_bytes ?? null,
      gainDb: body.gain_db ?? null,
      peakDbfs: body.peak_dbfs ?? null,
      played: true,
      // Voxtral did not report a duration, so it is derived from the wav it
      // streamed: 24 kHz, 16-bit, mono = 48,000 bytes per second.
      durationMs:
        typeof body.duration_ms === 'number'
          ? body.duration_ms
          : typeof body.audio_bytes === 'number'
            ? Math.round(body.audio_bytes / 48)
            : null,
      audioUrl: null,
      at: nowIso(),
    };
    // The wav never goes into a socket frame: it is stored under the visit and
    // fetched once by the door when it speaks.
    const encoded = typeof body.audio_base64 === 'string' ? body.audio_base64 : '';
    if (visitId && encoded) {
      sql.putAudio.run(visitId, Buffer.from(encoded, 'base64'));
      speech.audioUrl = `/intercom/audio/${visitId}.wav`;
    }

    const visit = visitId ? getVisit(visitId) : null;
    if (visit) {
      visit.speech = speech;
      if (speech.text) visit.reply = speech.text;
      saveVisit(visit);
      logEvent({ type: 'visit.spoken', visit_id: visitId, model: speech.model });
      broadcast(visit);
    }
    res.json({ played: true, duration_ms: speech.durationMs ?? 0, attached: Boolean(visit) });
  });

  app.get('/intercom/audio/:file', (req, res) => {
    const visitId = String(req.params.file).replace(/\.wav$/, '');
    const row = sql.getAudio.get(visitId);
    if (!row) return fail(res, 404, 'no audio for that visit');
    res.setHeader('content-type', 'audio/wav');
    res.setHeader('cache-control', 'no-store');
    res.send(Buffer.from(row.wav));
  });

  // ── the resident answers ──────────────────────────────────────────────────

  app.post('/visits/:id/decision', async (req, res) => {
    const visit = getVisit(req.params.id);
    if (!visit) return fail(res, 404, 'unknown visit');
    const decision = String(req.body?.decision || '').toLowerCase();
    if (decision !== 'approve' && decision !== 'decline') {
      return fail(res, 400, 'decision must be "approve" or "decline"');
    }
    if (!PENDING.has(visit.status)) return fail(res, 409, `visit is already ${visit.status}`);

    const residentId = str(req.body?.resident_id) || visit.residentId || null;
    const note = str(req.body?.note);
    visit.status = decision === 'approve' ? 'approved' : 'declined';
    visit.decidedAt = nowIso();
    saveVisit(visit);
    logEvent({ type: 'visit.decision', visit_id: visit.id, decision, resident_id: residentId, at: visit.decidedAt });
    broadcast(visit);

    if (config.offline || !visit.executionId) {
      sql.putDecision.run(visit.id, decision, residentId, note, 0, visit.decidedAt);
      return res.json({ ok: true, signalled: false });
    }
    try {
      await mistral(`/v1/workflows/executions/${visit.executionId}/signals`, {
        name: 'resident-decision',
        input: { decision, resident_id: residentId, note },
      });
      sql.putDecision.run(visit.id, decision, residentId, note, 1, visit.decidedAt);
      res.json({ ok: true, signalled: true, execution_id: visit.executionId });
    } catch (error) {
      sql.putDecision.run(visit.id, decision, residentId, note, 0, visit.decidedAt);
      res.status(502).json({ ok: false, signalled: false, error: String(error.message || error) });
    }
  });

  // ── reads the apps need ───────────────────────────────────────────────────

  app.get('/visits', (req, res) => {
    sweepStaleVisits();
    const flat = str(req.query.flat);
    // ?waiting=1 is the whole queue; ?status=pending is the single current visit.
    const waiting = req.query.waiting === '1';
    const asList = waiting || req.query.list === '1';
    const status = waiting ? 'pending' : str(req.query.status);
    const where = [];
    const args = [];
    if (flat) {
      where.push('flat = ?');
      args.push(flat);
    }
    if (status === 'pending') where.push(`status IN ('arriving', 'pending_decision')`);
    else if (status) {
      where.push('status = ?');
      args.push(status);
    }
    const rows = db
      .prepare(`SELECT doc FROM visits ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY at DESC`)
      .all(...args);
    const list = rows.map((row) => publicVisit(parse(row)));
    // The apps ask for "the visit at my door": one visit, or null.
    if (status === 'pending' && !asList) return res.json(list[0] ?? null);
    res.json(list);
  });

  app.get('/visits/:id', (req, res) => {
    const visit = getVisit(req.params.id);
    if (!visit) return fail(res, 404, 'unknown visit');
    res.json(publicVisit(visit));
  });

  // ── the timeline ──────────────────────────────────────────────────────────

  app.post('/events', (req, res) => {
    const body = req.body || {};
    if (!body.type) return fail(res, 400, 'type is required');
    const { id, event } = logEvent(body);

    // The workflow reports its outcome as an event, so the visit closes here
    // too: without this the door would keep claiming a decision is pending.
    if (event.type === 'visit.decision' && event.visit_id) {
      const visit = getVisit(event.visit_id);
      if (visit) {
        visit.status =
          event.decision === 'approve' ? 'approved' : event.automatic ? 'expired' : 'declined';
        visit.decidedAt = visit.decidedAt || event.at;
        visit.transcript = event.transcript || visit.transcript;
        saveVisit(visit);
        broadcast(visit);
      }
    }
    // parcel-arrival ends by logging what it read off the label.
    if (event.type === 'parcel.arrival' && event.parcel_id) {
      const known = parse(sql.getParcel.get(String(event.parcel_id)));
      saveParcel({
        id: String(event.parcel_id),
        flat: str(event.flat) ?? known?.flat ?? '',
        courier: str(event.courier) ?? known?.courier ?? '',
        label: str(event.label_text) ?? known?.label ?? '',
        at: known?.at ?? event.at,
        status: known?.status ?? 'at_desk',
      });
    }
    res.status(201).json({ stored: true, event_id: `evt_${id}`, event });
  });

  app.get('/events', (req, res) => {
    const flat = str(req.query.flat);
    const day = str(req.query.day);
    if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) return fail(res, 400, 'day must be YYYY-MM-DD');
    const where = [];
    const args = [];
    if (flat) {
      where.push('flat = ?');
      args.push(flat);
    }
    if (day) {
      where.push('substr(at, 1, 10) = ?');
      args.push(day);
    }
    const rows = db
      .prepare(`SELECT doc FROM events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY at, id`)
      .all(...args);
    res.json({ day, flat, events: rows.map(parse) });
  });

  // ── notifications: in-app always, the resident's own channels when known ─

  app.post('/notifications', (req, res) => {
    const body = req.body || {};
    if (!body.resident_id && !body.flat) return fail(res, 400, 'resident_id or flat is required');
    const resident = body.resident_id ? getResident(String(body.resident_id)) : null;
    const recipients = resident ? [resident] : body.flat ? sql.residentsInFlat.all(String(body.flat)).map(parse) : [];

    // Anonymous residents left no contact details, so they only get in-app.
    // Email, SMS and WhatsApp are recorded as the resident's preference; no
    // provider is wired up, so only in-app is ever delivered.
    const preferred = new Set();
    for (const who of recipients) {
      if (who.anonymous) continue;
      if (who.email) preferred.add('email');
      if (who.phone) preferred.add('sms');
      if (who.whatsapp) preferred.add('whatsapp');
    }
    const at = nowIso();
    const notification = {
      ...body,
      flat: str(body.flat) ?? resident?.flat ?? null,
      delivered: ['in_app'],
      preferred: [...preferred],
      at,
    };
    const { lastInsertRowid } = sql.putNotification.run(
      str(body.resident_id),
      notification.flat,
      at,
      JSON.stringify(notification),
    );
    if (body.parcel_id && !sql.getParcel.get(String(body.parcel_id))) {
      saveParcel({
        id: String(body.parcel_id),
        flat: notification.flat ?? '',
        courier: '',
        label: '',
        at,
        status: 'at_desk',
      });
    }
    res.status(201).json({
      delivered: true,
      notification_id: `ntf_${lastInsertRowid}`,
      channels: ['in_app'],
      preferred: [...preferred],
      anonymous_fallback: 'in_app',
      recipients: recipients.length,
    });
  });

  app.get('/notifications', (req, res) => {
    const flat = str(req.query.flat);
    const residentId = str(req.query.resident_id);
    if (!flat && !residentId) return fail(res, 400, 'flat or resident_id is required');
    const rows = db
      .prepare(
        `SELECT doc FROM notifications WHERE ${flat ? 'flat = ?' : 'resident_id = ?'} ORDER BY at DESC, id DESC`,
      )
      .all(flat || residentId);
    res.json(rows.map(parse));
  });

  // ── residents and their faces ─────────────────────────────────────────────

  app.post('/residents', (req, res) => {
    const body = req.body || {};
    const anonymous = Boolean(body.anonymous);
    const flat = str(body.flat);
    if (!flat) return fail(res, 400, 'flat is required');
    if (!anonymous && !str(body.name)) return fail(res, 400, 'name is required unless anonymous');

    const resident = { id: newId(`res_${flat}`), flat, anonymous };
    // An anonymous resident leaves no contact details, even if some were sent.
    if (!anonymous) {
      resident.name = String(body.name);
      for (const field of ['email', 'phone', 'whatsapp']) {
        if (str(body[field])) resident[field] = String(body[field]);
      }
    }
    sql.putResident.run(resident.id, flat, anonymous ? 1 : 0, nowIso(), JSON.stringify(resident));
    res.status(201).json(resident);
  });

  app.post('/residents/:id/confirm', (req, res) => {
    const resident = getResident(req.params.id);
    if (!resident) return fail(res, 404, 'unknown resident');
    sql.confirmResident.run(nowIso(), resident.id);
    logEvent({ type: 'resident.confirmed', resident_id: resident.id, flat: resident.flat });
    res.json({ ok: true });
  });

  /** Enrol a descriptor. Only a resident who tapped "that was me" can be stored. */
  app.post('/residents/:id/face', (req, res) => {
    const row = sql.getResident.get(req.params.id);
    if (!row) return fail(res, 404, 'unknown resident');
    if (!row.confirmed_at) return fail(res, 409, 'resident has not confirmed "that was me"');
    if (!isDescriptor(req.body?.descriptor)) return fail(res, 400, 'descriptor must be an array of numbers');
    sql.putFace.run(req.params.id, JSON.stringify(req.body.descriptor), str(req.body.model), nowIso());
    res.status(201).json({ ok: true, resident_id: req.params.id });
  });

  /**
   * Match a face-api.js descriptor against confirmed residents by Euclidean
   * distance. The nearest one under the threshold wins; otherwise nobody.
   */
  app.post('/faces/match', (req, res) => {
    const descriptor = req.body?.descriptor;
    if (!isDescriptor(descriptor)) {
      return res.json({ matched: false, resident_id: null, distance: null });
    }
    let best = null;
    for (const row of sql.confirmedFaces.all()) {
      const stored = JSON.parse(row.descriptor);
      if (stored.length !== descriptor.length) continue;
      const distance = euclidean(stored, descriptor);
      if (!best || distance < best.distance) best = { residentId: row.resident_id, distance };
    }
    if (!best || best.distance >= config.faceMatchThreshold) {
      return res.json({ matched: false, resident_id: null, distance: null, threshold: config.faceMatchThreshold });
    }
    res.json({
      matched: true,
      resident_id: best.residentId,
      distance: Math.round(best.distance * 10000) / 10000,
      threshold: config.faceMatchThreshold,
    });
  });

  // ── photographs, either direction ─────────────────────────────────────────

  /**
   * The phone and the door publish the picture they just took. The API keeps
   * the last one per flat and pushes it over /live, so the other surface shows
   * it without asking.
   */
  app.post('/snapshots', (req, res) => {
    const body = req.body || {};
    const flat = str(body.flat);
    const dataUrl = typeof body.dataUrl === 'string' ? body.dataUrl : body.data_url;
    if (!flat) return fail(res, 400, 'flat is required');
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
      return fail(res, 400, 'dataUrl must be a data:image URL');
    }
    const snapshot = {
      flat,
      dataUrl,
      // Who took it, in the apps' words: "resident-phone" or "door".
      source: body.source === 'door' ? 'door' : 'resident-phone',
      by: body.by ?? null,
      doorId: doorIdFrom(body.door_id),
      at: nowIso(),
      bytes: Math.round((dataUrl.length * 3) / 4),
    };
    sql.putSnapshot.run(flat, snapshot.at, JSON.stringify(snapshot));
    logEvent({ type: 'snapshot.taken', flat, source: snapshot.source });
    broadcastSnapshot(snapshot);
    res.status(201).json({ stored: true, snapshot: { ...snapshot, dataUrl: undefined } });
  });

  app.get('/snapshots', (req, res) => {
    const flat = str(req.query.flat);
    const snapshot = flat ? parse(sql.getSnapshot.get(flat)) : null;
    if (!snapshot) return fail(res, 404, 'no photograph for that flat yet');
    res.json(snapshot);
  });

  // ── who's in ──────────────────────────────────────────────────────────────

  app.get('/presence', (req, res) => {
    const day = new Date().toISOString().slice(0, 10);
    const last = new Map();
    for (const row of sql.presenceToday.all(`${day}T00:00:00`)) last.set(row.resident_id, row);
    const inside = [];
    for (const [residentId, row] of last) {
      if (row.type !== PRESENCE_IN) continue;
      const resident = getResident(residentId);
      inside.push({
        residentId,
        name: resident?.anonymous ? null : resident?.name ?? null,
        flat: resident?.flat ?? null,
        since: row.at,
      });
    }
    res.json({
      day,
      in: inside,
      residents: sql.countResidents.get().n,
      visits: sql.countVisits.get().n,
      sockets: clients.size,
    });
  });

  // ==========================================================================
  // Live socket
  // ==========================================================================

  wss.on('connection', (socket, req) => {
    const url = new URL(req.url || '/live', 'http://localhost');
    const flat = url.searchParams.get('flat');
    // ?scope=door is the building-wide feed; ?flat= is one resident's flat.
    const door = url.searchParams.get('scope') === 'door';
    // A door page passes its own id; without one, this is the #ledger log.
    const doorId = door ? doorIdFrom(url.searchParams.get('door')) : null;
    if (!flat && !door) {
      socket.close(1008, 'flat or scope=door is required');
      return;
    }
    socket.scope = door ? 'door' : 'flat';
    socket.flat = door ? null : flat;
    socket.doorId = doorId;
    socket.isAlive = true;
    clients.add(socket);

    const current = doorId
      ? db
          .prepare("SELECT doc FROM visits WHERE json_extract(doc, '$.doorId') = ? ORDER BY at DESC LIMIT 1")
          .get(doorId)
      : door
      ? db.prepare('SELECT doc FROM visits ORDER BY at DESC LIMIT 1').get()
      : db.prepare('SELECT doc FROM visits WHERE flat = ? ORDER BY at DESC LIMIT 1').get(flat);
    if (current) socket.send(JSON.stringify({ type: 'visit', visit: publicVisit(parse(current)) }));

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
  const sweeper = setInterval(sweepStaleVisits, 15000);
  sweeper.unref();
  server.on('close', () => {
    clearInterval(heartbeat);
    clearInterval(sweeper);
  });

  // ==========================================================================
  // Errors
  // ==========================================================================

  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error('API error:', err);
    res.status(status).json({ error: status >= 500 ? 'Internal Server Error' : err.message });
  });

  app.use((req, res) => fail(res, 404, 'Not found'));

  /** Close every socket and the HTTP server. */
  function close() {
    for (const socket of clients) socket.terminate();
    wss.close();
    return new Promise((resolve) => server.close(() => resolve()));
  }

  return { app, server, wss, close };
}
