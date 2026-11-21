import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApi, callTool, TOOL_DEFINITIONS, today } from '../src/tools.js';

// A fetch that answers from a route table and records every URL asked for.
function mockFetch(routes) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const body = routes[url.pathname];
    if (body === undefined) return new Response(JSON.stringify({ error: 'nope' }), { status: 404 });
    return new Response(JSON.stringify(typeof body === 'function' ? body(url) : body), { status: 200 });
  };
  return { get: createApi({ baseUrl: 'http://api.test/', fetchImpl }), calls };
}

const json = (result) => JSON.parse(result.content[1].text);

test('lists the five read-only tools', () => {
  assert.deepEqual(TOOL_DEFINITIONS.map((t) => t.name),
    ['who_is_in', 'todays_events', 'parcels', 'current_visits', 'cctv_log']);
});

test('who_is_in summarises presence and drops contact details', async () => {
  const { get, calls } = mockFetch({
    '/presence': { day: '2026-11-21', in: [{ residentId: 'r1', name: 'Sam', flat: '7', since: '2026-11-21T09:30:00Z', email: 'sam@x.test', phone: '+44' }] },
  });
  const result = await callTool(get, 'who_is_in');
  assert.equal(calls[0].href, 'http://api.test/presence');
  assert.match(result.content[0].text, /1 resident\(s\) in: Sam \(flat 7, since 09:30\)/);
  assert.equal(json(result).in[0].email, undefined);
  assert.equal(json(result).in[0].phone, undefined);
  assert.doesNotMatch(result.content[1].text, /sam@x\.test/);
});

test('todays_events defaults to today and passes the flat', async () => {
  const { get, calls } = mockFetch({
    '/events': (url) => ({ day: url.searchParams.get('day'), flat: '7', events: [{ type: 'visit.decision', flat: '7', decision: 'approve', at: '2026-11-21T10:00:00Z' }] }),
  });
  const result = await callTool(get, 'todays_events', { flat: '7' });
  assert.equal(calls[0].searchParams.get('day'), today());
  assert.equal(calls[0].searchParams.get('flat'), '7');
  assert.match(result.content[0].text, /1 event\(s\).*flat 7\n10:00 visit.decision flat 7 - approve/);
});

test('parcels counts what is waiting at the desk', async () => {
  const { get, calls } = mockFetch({
    '/parcels': [
      { id: 'p1', flat: '7', courier: 'DPD', label: 'Flat 7', at: '2026-11-21T11:00:00Z', status: 'at_desk' },
      { id: 'p2', flat: '7', courier: 'Royal Mail', at: '2026-11-20T11:00:00Z', status: 'collected' },
    ],
  });
  const result = await callTool(get, 'parcels', { flat: '7' });
  assert.equal(calls[0].search, '?flat=7');
  assert.match(result.content[0].text, /^Flat 7: 1 parcel\(s\) at the desk, 1 collected\./);
});

test('parcels without a flat lists the whole building', async () => {
  const { get, calls } = mockFetch({ '/parcels': [{ id: 'p3', flat: '12', courier: 'Evri', at: '2026-11-21T12:00:00Z', status: 'at_desk' }] });
  const result = await callTool(get, 'parcels', {});
  assert.equal(calls[0].search, '');
  assert.match(result.content[0].text, /^Building: 1 parcel\(s\) at the desk, 0 collected\.\n12:00 flat 12 Evri - at_desk/);
});

test('current_visits asks for the waiting queue', async () => {
  const { get, calls } = mockFetch({
    '/visits': [{ id: 'v1', flat: '12', status: 'pending_decision', at: '2026-11-21T15:00:00Z' }],
  });
  const result = await callTool(get, 'current_visits', { flat: '12' });
  assert.equal(calls[0].searchParams.get('waiting'), '1');
  assert.equal(calls[0].searchParams.get('flat'), '12');
  assert.match(result.content[0].text, /1 visitor\(s\) waiting: flat 12 since 15:00/);
});

test('cctv_log keeps only cctv events and lists suspicious ones first', async () => {
  const { get } = mockFetch({
    '/events': {
      day: '2026-11-21', flat: null, events: [
        { type: 'visit.arrival', at: '2026-11-21T08:00:00Z' },
        { type: 'cctv.delivery', kind: 'delivery', camera: 'lobby', text: 'A courier left a parcel', started_at: '2026-11-21T09:00:00Z' },
        { type: 'cctv.tailgate', kind: 'tailgate', camera: 'entrance', text: 'Unknown person 4 entered without ringing', started_at: '2026-11-21T14:02:10Z' },
        { type: 'cctv.other', kind: 'other', camera: 'lift', text: 'Someone tried doors', flagged: true, started_at: '2026-11-21T16:00:00Z' },
      ],
    },
  });
  const result = await callTool(get, 'cctv_log', { day: '2026-11-21' });
  const lines = result.content[0].text.split('\n');
  assert.equal(lines[0], '3 CCTV event(s) on 2026-11-21, 2 suspicious.');
  assert.match(lines[1], /^SUSPICIOUS 14:02 entrance tailgate/);
  assert.match(lines[2], /^SUSPICIOUS 16:00 lift other/);
  assert.match(lines[3], /^09:00 lobby delivery/);
  assert.equal(json(result).suspicious.length, 2);
});

test('API errors come back as tool errors', async () => {
  const { get } = mockFetch({});
  const result = await callTool(get, 'who_is_in');
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /\/presence answered 404: nope/);
});
