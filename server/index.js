#!/usr/bin/env node

/**
 * Le Concierge API: entry point.
 *
 * Opens the SQLite database and starts the API from `app.js`. Routes are
 * documented in docs/api.md.
 */

import 'dotenv/config';
import { createApp, configFromEnv } from './app.js';
import { openDb, seedDemo } from './db.js';

const PORT = process.env.PORT || 3000;
const DATABASE_PATH = process.env.DATABASE_PATH || 'data/le-concierge.db';

const config = configFromEnv();
const db = openDb(DATABASE_PATH);
if (process.env.SEED_DEMO === '1') seedDemo(db);

if (!config.mistralApiKey && config.nodeEnv !== 'test') {
  console.warn('MISTRAL_API_KEY is not set: running offline, no workflow executions are started.');
}

const { server } = createApp({ db, config });

server.listen(PORT, () => {
  console.log('Le Concierge API is running');
  console.log(`  environment: ${config.nodeEnv}`);
  console.log(`  url:         http://localhost:${PORT}`);
  console.log(`  websocket:   ws://localhost:${PORT}/live?flat=12`);
  console.log(`  database:    ${DATABASE_PATH}`);
  console.log(`  workflows:   ${config.offline ? 'offline (replay)' : 'live'}`);
});

export default server;
