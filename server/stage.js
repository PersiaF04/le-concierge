/**
 * The demo stage's data: one visit's workflow steps, read from Mistral's
 * execution history.
 *
 *   GET /executions/:id/steps
 *     -> { executionId, steps: [{ activity, status, at, model? }], waiting, finished }
 *
 * `status` is scheduled | started | completed | failed. `waiting` is true while
 * the run sits in the `resident-decision` wait (a TIMER_STARTED with no signal
 * and no fired timer after it). Answers are cached for ~700 ms per execution so
 * a stage polling every second cannot hammer the Mistral API.
 */

const CACHE_MS = 700;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const DONE = new Set([
  'WORKFLOW_EXECUTION_COMPLETED',
  'WORKFLOW_EXECUTION_FAILED',
  'WORKFLOW_EXECUTION_TERMINATED',
  'WORKFLOW_EXECUTION_TIMED_OUT',
  'WORKFLOW_EXECUTION_CANCELED',
]);

/** The model each activity uses when its result does not name one. */
const DEFAULT_MODELS = {
  describe_snapshot: 'mistral-small-latest',
  match_face: 'face-api.js',
  transcribe_intercom_audio: 'voxtral-mini-latest',
  decide_visit: 'mistral-small-latest',
  speak_reply: 'voxtral-mini-tts',
};

/** "ActivityTaskScheduled", "EVENT_TYPE_ACTIVITY_TASK_SCHEDULED" -> "ACTIVITY_TASK_SCHEDULED". */
export function eventType(event) {
  const raw = String(event?.eventType ?? event?.event_type ?? event?.type ?? '');
  return raw
    .replace(/^EVENT_TYPE_/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toUpperCase();
}

/** The `…Attributes` object an event carries, whatever its casing. */
function attributesOf(event) {
  for (const [key, value] of Object.entries(event ?? {})) {
    if (/attributes$/i.test(key) && value && typeof value === 'object') return value;
  }
  return event?.attributes ?? {};
}

/** A `model` string anywhere shallow in an activity result. */
function findModel(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 5) return null;
  if (typeof value.model === 'string' && value.model) return value.model;
  for (const child of Object.values(value)) {
    const found = findModel(child, depth + 1);
    if (found) return found;
  }
  return null;
}

/** Turn a history response into the stage's steps. */
export function stepsFromHistory(history) {
  const events = Array.isArray(history)
    ? history
    : history?.events ?? history?.history?.events ?? history?.data ?? [];
  const byScheduled = new Map();
  const steps = [];
  let waiting = false;
  let finished = false;

  for (const event of events) {
    const type = eventType(event);
    const attrs = attributesOf(event);
    const id = String(event.eventId ?? event.event_id ?? event.id ?? steps.length);
    const at = event.eventTime ?? event.event_time ?? event.timestamp ?? event.at ?? null;

    if (type === 'ACTIVITY_TASK_SCHEDULED') {
      const activity = attrs.activityType?.name ?? attrs.activity_type?.name ?? attrs.activity_name ?? 'activity';
      const step = { activity, status: 'scheduled', at };
      if (DEFAULT_MODELS[activity]) step.model = DEFAULT_MODELS[activity];
      byScheduled.set(id, step);
      steps.push(step);
      continue;
    }

    const ref = attrs.scheduledEventId ?? attrs.scheduled_event_id;
    const step = ref !== undefined ? byScheduled.get(String(ref)) : undefined;
    if (type === 'ACTIVITY_TASK_STARTED' && step) {
      step.status = 'started';
      step.at = at ?? step.at;
    } else if (type === 'ACTIVITY_TASK_COMPLETED' && step) {
      step.status = 'completed';
      step.at = at ?? step.at;
      const model = findModel(attrs.result);
      if (model) step.model = model;
    } else if (/^ACTIVITY_TASK_(FAILED|TIMED_OUT|CANCELED)$/.test(type) && step) {
      step.status = 'failed';
      step.at = at ?? step.at;
    } else if (type === 'TIMER_STARTED') {
      waiting = true;
    } else if (type === 'TIMER_FIRED' || type === 'TIMER_CANCELED' || type === 'WORKFLOW_EXECUTION_SIGNALED') {
      waiting = false;
    } else if (DONE.has(type)) {
      finished = true;
      waiting = false;
    }
  }
  return { steps, waiting, finished };
}

/** Mount `GET /executions/:id/steps` on an Express app. */
export function mountStage(app, { config, fetch: fetchImpl = globalThis.fetch, cacheMs = CACHE_MS }) {
  const cache = new Map();

  app.get('/executions/:id/steps', async (req, res) => {
    const { id } = req.params;
    if (!ID.test(id)) return res.status(400).json({ error: 'Bad execution id' });
    if (!config.mistralApiKey) return res.status(503).json({ error: 'MISTRAL_API_KEY is not set' });

    const hit = cache.get(id);
    const fresh = hit && Date.now() - hit.at < cacheMs;
    const body = fresh ? hit.body : (async () => {
      const response = await fetchImpl(
        `${config.mistralApiUrl}/v1/workflows/executions/${encodeURIComponent(id)}/history`,
        { headers: { authorization: `Bearer ${config.mistralApiKey}`, accept: 'application/json' } },
      );
      if (!response.ok) throw Object.assign(new Error(`Mistral answered ${response.status}`), { status: response.status });
      return { executionId: id, ...stepsFromHistory(await response.json()) };
    })();
    if (!fresh) {
      cache.set(id, { at: Date.now(), body });
      if (cache.size > 50) cache.delete(cache.keys().next().value);
    }

    try {
      res.json(await body);
    } catch (error) {
      cache.delete(id);
      res.status(error.status === 404 ? 404 : 502).json({ error: error.message });
    }
  });
}
