# Deploying Le Concierge

Two of the three pieces can live on Vercel. The third one cannot, and this file
says why rather than pretending.

| Piece | Host | Why |
|---|---|---|
| `apps/resident` (the phone) | **Vercel**, static | a Vite build with no server side |
| `apps/concierge` (the door and the log) | **Vercel**, static | same |
| `server/index.js` (the API) | a host that keeps a process and a socket open | it holds in-memory state and a WebSocket at `/live`; Vercel functions are request-scoped and have no sockets |
| `workflows/apps/worker` (the worker) | any always-on machine | it dials out to Mistral's Temporal and executes the activities; a function cannot stay alive for that |

## The live deployment

```
https://le-concierge-resident.vercel.app     the phone
https://le-concierge-concierge.vercel.app    the door (#door) and the log (#ledger)
```

Both are built with no `VITE_API_URL`, so they run the recorded execution and
say `RECORDED RUN` in the badge. Nothing that shows a number there is invented:
those values were taken from real executions.

## How these were deployed

Vercel's builder insists on running `npm install` when it finds a repository, and
these apps are npm workspaces (`@le-concierge/ui` is a workspace package), so the
build happens locally and Vercel only serves the result:

```bash
npm run build:apps
mkdir -p .deploy/resident .deploy/concierge
cp -r apps/resident/dist/. .deploy/resident/
cp -r apps/concierge/dist/. .deploy/concierge/
# each folder needs a vercel.json that asks for the static builder and no build:
#   { "version": 2,
#     "builds": [{ "src": "**/*", "use": "@vercel/static" }],
#     "routes": [{ "src": "/assets/(.*)", "dest": "/assets/$1" },
#                { "src": "/(.*)", "dest": "/index.html" }] }

cd .deploy/resident  && npx vercel deploy --prod --yes --name le-concierge-resident
cd .deploy/concierge && npx vercel deploy --prod --yes --name le-concierge-concierge
```

`.deploy/` is ignored by git: it is a copy of `dist/`, not a source tree.

## Pointing a deployed build at an API

The apps read the API address in this order:

1. `?api=https://…` on the URL, which is remembered in `localStorage`;
2. `le-concierge:api` in `localStorage`;
3. `VITE_API_URL` at build time.

So a deployment can be pointed at a public API without being rebuilt:

```
https://le-concierge-concierge.vercel.app/?api=https://le-concierge-api.example.com
```

The WebSocket follows the API's origin (`https` → `wss`), unless
`VITE_WS_URL` says otherwise.

## Known limit: a local API cannot serve a deployed page

Pointing the Vercel build at `http://localhost:3000` **does not work**, and not
because of a bug here. Chrome refuses a public, https origin reaching into the
private network: the request fails before it leaves the browser. The API already
answers `Access-Control-Allow-Private-Network: true`, and the fetch is still
refused, so a real deployment needs a really public API.

## Going fully live

1. Run the API where it can keep a process and a socket: a small VM, Fly.io,
   Render, Railway. It needs `MISTRAL_API_KEY`, and it should not keep state in
   memory for anything but the demo.
2. Run one worker next to it (`uv run python -m worker.entrypoints.worker` with
   `LE_CONCIERGE_API_URL` pointing at that API). It needs no inbound port: it
   dials out to Mistral.
3. Redeploy the apps with `VITE_API_URL` set, or open them with `?api=`.

The workflow itself is already deployed in the Mistral workspace: deployment
`visitor-arrival`, and `GET /v1/workflows/deployments` shows it active whenever a
worker is connected to it.
