// Read-only tools over the Le Concierge API (docs/api.md).
// No MCP SDK import here, so the tests run with only Node and a mocked fetch.

export const DEFAULT_API_URL = 'https://harmony.tailb80b97.ts.net:10000';

// CCTV kinds the cctv-event workflow can log that a manager should see first.
const SUSPICIOUS_KINDS = new Set(['tailgate']);
const CONTACT_KEYS = new Set(['email', 'phone', 'whatsapp', 'preferred', 'recipients']);

const flatProp = { type: 'string', description: 'Flat number, e.g. "7"' };
const dayProp = { type: 'string', description: 'Day as YYYY-MM-DD (UTC). Defaults to today.' };

export const TOOL_DEFINITIONS = [
  {
    name: 'who_is_in',
    description: 'Residents currently in the building (latest arrival/departure today).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'todays_events',
    description: 'The building event log for a day (visits, decisions, parcels, CCTV), oldest first.',
    inputSchema: { type: 'object', properties: { flat: flatProp, day: dayProp } },
  },
  {
    name: 'parcels',
    description: 'Parcels for a flat, newest first, with courier and whether collected.',
    inputSchema: { type: 'object', properties: { flat: flatProp }, required: ['flat'] },
  },
  {
    name: 'current_visits',
    description: 'Visitors waiting at the door right now, optionally for one flat.',
    inputSchema: { type: 'object', properties: { flat: flatProp } },
  },
  {
    name: 'cctv_log',
    description: 'CCTV events for a day, suspicious ones (e.g. tailgating) flagged and listed first.',
    inputSchema: { type: 'object', properties: { day: dayProp } },
  },
];

export const today = () => new Date().toISOString().slice(0, 10);

// Drops residents' contact details wherever they appear.
export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).filter(([k]) => !CONTACT_KEYS.has(k)).map(([k, v]) => [k, redact(v)]),
    );
  }
  return value;
}

export function isSuspicious(event) {
  return Boolean(event.suspicious || event.flagged || SUSPICIOUS_KINDS.has(event.kind));
}

const time = (iso) => (typeof iso === 'string' ? iso.slice(11, 16) : '--:--');

function describeEvent(e) {
  const flat = e.flat ? ` flat ${e.flat}` : '';
  const detail = e.text || e.decision || e.status || e.courier || '';
  return `${time(e.at)} ${e.type}${flat}${detail ? ` - ${detail}` : ''}`;
}

export function createApi({ baseUrl = DEFAULT_API_URL, fetchImpl = globalThis.fetch } = {}) {
  const root = baseUrl.replace(/\/+$/, '');
  return async function get(path, query = {}) {
    const url = new URL(root + path);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    const res = await fetchImpl(url, { headers: { accept: 'application/json' } });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`${path} answered ${res.status}: ${body?.error ?? 'no detail'}`);
    return body;
  };
}

const handlers = {
  async who_is_in(get) {
    const data = await get('/presence');
    const people = data.in ?? [];
    const text = people.length
      ? `${people.length} resident(s) in: ` +
        people.map((p) => `${p.name ?? p.residentId} (flat ${p.flat}, since ${time(p.since)})`).join('; ')
      : 'Nobody is marked as in the building today.';
    return { text, data };
  },

  async todays_events(get, { flat, day } = {}) {
    const data = await get('/events', { flat, day: day || today() });
    const events = data.events ?? [];
    const flagged = events.filter(isSuspicious).length;
    const head = `${events.length} event(s) on ${data.day ?? day ?? today()}${flat ? ` for flat ${flat}` : ''}` +
      (flagged ? `, ${flagged} suspicious` : '');
    return { text: [head, ...events.map(describeEvent)].join('\n'), data };
  },

  async parcels(get, { flat } = {}) {
    if (!flat) throw new Error('flat is required');
    const data = await get('/parcels', { flat });
    const waiting = data.filter((p) => p.status !== 'collected');
    const head = `Flat ${flat}: ${waiting.length} parcel(s) at the desk, ${data.length - waiting.length} collected.`;
    const lines = data.map((p) => `${time(p.at)} ${p.courier ?? 'unknown courier'} - ${p.status}${p.label ? ` (${p.label})` : ''}`);
    return { text: [head, ...lines].join('\n'), data };
  },

  async current_visits(get, { flat } = {}) {
    const data = await get('/visits', { waiting: 1, flat });
    const text = data.length
      ? `${data.length} visitor(s) waiting: ` +
        data.map((v) => `flat ${v.flat ?? '?'} since ${time(v.at)} (${v.status})`).join('; ')
      : `No visitors waiting${flat ? ` for flat ${flat}` : ''}.`;
    return { text, data };
  },

  async cctv_log(get, { day } = {}) {
    const all = await get('/events', { day: day || today() });
    const events = (all.events ?? []).filter((e) => String(e.type).startsWith('cctv.'))
      .map((e) => ({ ...e, suspicious: isSuspicious(e) }));
    const suspicious = events.filter((e) => e.suspicious);
    const rest = events.filter((e) => !e.suspicious);
    const lines = [
      `${events.length} CCTV event(s) on ${all.day ?? day ?? today()}, ${suspicious.length} suspicious.`,
      ...suspicious.map((e) => `SUSPICIOUS ${time(e.started_at ?? e.at)} ${e.camera ?? ''} ${e.kind}: ${e.text}`),
      ...rest.map((e) => `${time(e.started_at ?? e.at)} ${e.camera ?? ''} ${e.kind}: ${e.text}`),
    ];
    return { text: lines.join('\n'), data: { day: all.day, suspicious, events } };
  },
};

// Runs one tool and returns an MCP CallToolResult: concise text, then the JSON.
export async function callTool(get, name, args = {}) {
  const handler = handlers[name];
  if (!handler) return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
  try {
    const { text, data } = await handler(get, args);
    return {
      content: [
        { type: 'text', text },
        { type: 'text', text: JSON.stringify(redact(data), null, 2) },
      ],
    };
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `Le Concierge API error: ${err.message}` }] };
  }
}
