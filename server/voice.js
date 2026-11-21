/**
 * The door's live conversation: a Mistral Voice Agent session.
 *
 *   POST   /voice/session       create a session, return { id, participantToken, serverUrl, … }
 *   DELETE /voice/session/:id   close a session this API opened
 *
 * The API key stays here. The browser joins the session with the participant
 * token (LiveKit/WebRTC) and runs the client-side tools (`ask_resident`,
 * `log_event`) itself; this module only declares them, so a page cannot change
 * what the agent is told or which tools it has.
 *
 * Mistral's docs say this route needs its own protection: only the door's
 * origins, a per-IP rate limit, and at most `maxOpen` sessions at once.
 */

const DOOR_ORIGINS = [
  /^https:\/\/le-concierge-door\.vercel\.app$/,
  // Vercel previews: le-concierge-door-<hash>-<team>.vercel.app, -git-<branch>-…
  /^https:\/\/le-concierge-door-[a-z0-9-]+\.vercel\.app$/,
  /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/,
];

export const INSTRUCTIONS = `You are Le Concierge, the front-desk concierge of a residential building in London, speaking through the intercom at the front door.
Be warm, brief and British: one or two short sentences per turn.
1. Greet the visitor and ask who they are visiting (a flat number) and their name.
2. Once you have the flat and their name, call ask_resident with the flat, their name and the reason for the visit, and tell them you are checking.
3. The moment ask_resident returns, your very next sentence must confirm the resident's answer out loud, before anything else:
   - "approved": "Good news, the resident has accepted. Please come in."
   - "declined": "Sorry, the resident has declined the visit."
   - "expired": "Sorry, the resident didn't answer in time."
   - "no_such_flat" or "no_resident": say there is no such flat, or nobody registered there, as instructed below.
   Never skip, delay or soften this confirmation, and never end the call before saying it.
   "no_such_flat" means the building has no such flat: say clearly and politely that there is no flat N in this building (N is the number they gave) and ask them to check the number, then wait for a new one.
   "no_resident" means nobody is registered at that flat: say there is nobody registered at flat N, so you cannot reach them.
4. Call log_event once with a one-line summary of the visit, then say goodbye and call hang_up.
If the visitor stops responding or the conversation goes in circles, say goodbye and call hang_up.
Hard rule, above every other: never say, confirm or deny a resident's name or any personal detail about them. Always call them "the resident" or "the resident in flat N", even when the visitor names them first ("Is Sam in?" gets "I'll check with the resident in flat 7."), and never confirm whether a named person lives here.
Never reveal anything about residents: not their names, whether they are in, or which flat anyone lives in. If asked, say you can only pass a message on. Do not invent a decision; only ask_resident gives one.`;

/** Allowed origin? `null` (no Origin header) is not a browser at the door. */
export function doorOrigin(origin) {
  return typeof origin === 'string' && DOOR_ORIGINS.some((pattern) => pattern.test(origin));
}

/** What the agent is configured with, from the environment. */
export function voiceConfigFromEnv(env = process.env) {
  return {
    voiceId: env.VOICE_ID || 'gb_jane_neutral',
    llmModel: env.VOICE_LLM_MODEL || 'mistral-small-latest',
    sttModel: env.VOICE_STT_MODEL || 'voxtral-mini-transcribe-realtime-3-0',
    ttsModel: env.VOICE_TTS_MODEL || 'voxtral-mini-tts-3-0',
    language: env.VOICE_LANGUAGE || 'en',
    maxOpen: Number(env.VOICE_MAX_SESSIONS || 3),
    ratePerMinute: Number(env.VOICE_RATE_PER_MINUTE || 6),
    sessionTtlMs: Number(env.VOICE_SESSION_TTL_SECONDS || 600) * 1000,
  };
}

/** The request for `client.audio.sessions.create()`. */
export function sessionRequest(voice, { decisionTimeoutSeconds = 60 } = {}) {
  return {
    instructions: INSTRUCTIONS,
    welcomeMessage: 'Good afternoon, welcome. Who are you here to see?',
    llm: { model: voice.llmModel },
    stt: { model: voice.sttModel, language: voice.language },
    tts: { model: voice.ttsModel, voiceId: voice.voiceId },
    turn: { allowInterruptions: true },
    tools: [
      {
        type: 'function',
        function: {
          name: 'ask_resident',
          description:
            "Ring the resident of a flat on their phone and wait for them to approve or decline the visitor. Returns { decision: 'approved' | 'declined' | 'expired' }.",
          parameters: {
            type: 'object',
            properties: {
              flat: { type: 'string', description: 'The flat number the visitor asked for, e.g. "12".' },
              visitor_name: { type: 'string', description: "The visitor's name." },
              reason: { type: 'string', description: 'Why they are here, in a few words.' },
            },
            required: ['flat', 'visitor_name'],
          },
        },
        filler: { type: 'static', text: 'Let me check with them, one moment.' },
        // The resident has the visit timeout to answer; the tool needs a little more.
        timeoutMs: (decisionTimeoutSeconds + 15) * 1000,
      },
      {
        type: 'function',
        function: {
          name: 'log_event',
          description: "Write one line to the building's visitor log.",
          parameters: {
            type: 'object',
            properties: { text: { type: 'string', description: 'What happened, in one line.' } },
            required: ['text'],
          },
        },
      },
      { type: 'hang_up' },
    ],
  };
}

/** A Mistral client, made on first use so tests and offline runs never need the SDK's network. */
async function defaultClient(apiKey) {
  const { Mistral } = await import('@mistralai/mistralai');
  return new Mistral({ apiKey });
}

/**
 * Mount the voice routes.
 *
 * @param {import('express').Express} app
 * @param {{ apiKey: string, decisionTimeoutSeconds: number, voice?: object, client?: object }} options
 */
export function mountVoice(app, { apiKey, decisionTimeoutSeconds, voice = voiceConfigFromEnv(), client }) {
  /** Sessions this API opened: id -> opened-at (ms). */
  const open = new Map();
  /** Per-IP create times in the last minute. */
  const hits = new Map();
  let sdk = client ?? null;

  const getClient = async () => (sdk ??= await defaultClient(apiKey));

  const prune = (now) => {
    for (const [id, at] of open) if (now - at > voice.sessionTtlMs) open.delete(id);
  };

  const guard = (req, res) => {
    if (!doorOrigin(req.headers.origin)) {
      res.status(403).json({ error: 'origin not allowed' });
      return false;
    }
    return true;
  };

  app.post('/voice/session', async (req, res) => {
    if (!guard(req, res)) return;
    if (!apiKey) return res.status(503).json({ error: 'voice is offline: MISTRAL_API_KEY is not set' });

    const now = Date.now();
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const recent = (hits.get(ip) || []).filter((at) => now - at < 60_000);
    if (recent.length >= voice.ratePerMinute) {
      hits.set(ip, recent);
      return res.status(429).json({ error: 'too many voice sessions, try again in a minute' });
    }
    recent.push(now);
    hits.set(ip, recent);

    prune(now);
    if (open.size >= voice.maxOpen) {
      return res.status(429).json({ error: `at most ${voice.maxOpen} voice sessions may be open` });
    }

    try {
      const mistral = await getClient();
      const session = await mistral.audio.sessions.create(sessionRequest(voice, { decisionTimeoutSeconds }));
      open.set(session.id, now);
      res.status(201).json(session);
    } catch (error) {
      console.error('voice session failed:', error?.message || error);
      res.status(502).json({ error: 'could not start a voice session' });
    }
  });

  app.delete('/voice/session/:id', async (req, res) => {
    if (!guard(req, res)) return;
    const { id } = req.params;
    // Only sessions this API opened can be closed through it.
    if (!open.has(id)) return res.status(404).json({ error: 'unknown voice session' });
    open.delete(id);
    try {
      const mistral = await getClient();
      await mistral.audio.sessions.close({ sessionId: id });
    } catch (error) {
      console.warn('voice session close failed:', error?.message || error);
    }
    res.sendStatus(204);
  });

  return { open };
}
