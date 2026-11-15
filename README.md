# Fleet Pulse

Fleet Pulse is a real-time operations dashboard and mock API for the Frontend Developer take-home assignment. The frontend is Angular 21 with strict TypeScript, Signals, RxJS, Angular Material, CDK virtual scrolling, and lazily loaded Chart.js charts. The mock API runs on Node.js 22 and implements the assignment endpoints and chaos controls.

> **Verification honesty:** do not submit performance figures until you measure them with the Chrome DevTools procedure below. The README intentionally does not invent benchmark results. The unit tests cover the pure retry, ordering, fallback, validation, data-reduction, rule-comparison, and single-flight helpers; the backend tests exercise auth, snapshots, authorization, and idempotent rule creation. Manual chaos drills and browser performance measurements remain submission checks.

## Setup

### Prerequisites

- Node.js 22 LTS (Node 20 or later is supported by the mock).
- npm 10 or later.
- Docker Compose v2 is optional.

### Run locally

Terminal 1, start the mock API:

```powershell
cd backend
npm ci
npm start
```

The API listens on `http://localhost:4000`; its read-only circuit-breaker secondary listener is on `http://localhost:4001`.

Terminal 2, start the frontend:

```powershell
cd frontend
npm ci
npm start
```

Open `http://localhost:4200`. The frontend defaults to the API at `http://localhost:4000`. To use another API origin, set `globalThis.FLEET_API_URL` before loading the app.

Demo accounts (password for both: `pulse123`):

| Email | Role |
|---|---|
| `operator@pulse.dev` | Operator; may create, edit, and delete alert rules |
| `viewer@pulse.dev` | Viewer; read-only access and route-level rules protection |

### Tests, lint, and build

```powershell
cd backend
npm test

cd ..\frontend
npm test
npm run build
npm run lint
```

`npm run lint` uses the Angular CLI lint target. On a clean clone, run all four checks before submission.

### Docker Compose

From the repository root:

```powershell
docker compose up --build
```

Open `http://localhost:4200`; the API is at `http://localhost:4000`, with secondary reads at `http://localhost:4001`. The backend health check gates frontend startup.

### Chaos controls

Use the unauthenticated API to inspect, merge, or reset global switches:

```powershell
curl.exe http://localhost:4000/chaos
curl.exe -X POST http://localhost:4000/chaos -H "Content-Type: application/json" -d "{\"ws\":\"down\",\"rate\":2000}"
curl.exe -X DELETE http://localhost:4000/chaos
```

The same connection-level switches can be supplied as query parameters to `/stream` or `/stream/sse`. Supported global switches:

| Switch | Behavior |
|---|---|
| `rate=1..5000` | Total generated metric events per second; default 500 |
| `ws=down`, `sse=down` | Refuse new connections and close existing connections on that transport |
| `ws=silent` | Keep WebSocket open but suppress event and ping delivery |
| `ws=drop:<pct>` | Drop a percentage of delivered metric events; offsets/sequences remain consumed |
| `chaos=shuffle,dupe` | Reorder events within a short window and duplicate about 10% |
| `chaos=garbage:<pct>` | Send malformed JSON or incomplete metric frames |
| `token_ttl=<seconds>` | Change the lifetime of newly issued access tokens |
| `http=500:<pct>` | Return simulated REST server errors at the requested rate |
| `http=slow:<ms>` | Delay REST responses |
| `http=429` | Return 429 with `Retry-After: 2` |
| `kill=<seconds>` | Periodically close active WebSocket and SSE connections |

Switches combine, for example `{"rate":2000,"chaos":"shuffle,dupe"}`. Use `DELETE /chaos` between drills.

## Architecture

```text
WebSocket (primary) ─┐
SSE (fallback) ──────┼─> MetricsService ─> validate / reorder / deduplicate
Snapshot polling ────┘                       │
                                             ├─> gap recovery: replay -> snapshot on 410
                                             ├─> Signals -> virtualized fleet table
                                             ├─> Signals -> service detail charts (<=300 points)
                                             └─> Signals -> browser alert evaluation / incidents

Angular routes
  ├─ /login                 Reactive Form; in-memory access + rotating refresh token
  ├─ /                      Fleet list; query-backed filters/sort/search
  ├─ /services/:id          Lazy-loaded history and Chart.js module
  ├─ /rules                 Operator-only route, Reactive Form, async name validator
  └─ /settings              Template-driven Form
```

The frontend is split into `core` (auth, HTTP policy, metrics/transport state, shared API contracts) and lazy-loaded route features. Components consume the same metrics Signals regardless of which transport is active. The dashboard renders the list through CDK virtual scrolling; the charts and rule editor are route-level lazy chunks.

## Resilience decisions

### R1 — transports and reconnect

`MetricsService` owns WebSocket, SSE, polling, online/offline listeners, heartbeat timeouts, three-failure fallback, capped exponential delay with jitter, and a 30-second WebSocket climb attempt. Polling requests a full snapshot every two seconds. A status signal is exposed to the toolbar; stale data is marked after ten seconds. Consumers read one shared metrics state rather than branching on transport.

### R2 — ordering and data integrity

Metric frames are parsed and validated before use. A one-second reorder buffer sorts by global offset and removes repeated offsets and per-service sequences. A detected offset gap triggers `/metrics/replay`; a 410 triggers snapshot recovery. Malformed frames increment a visible debug counter and are logged.

### R3 — HTTP behavior

The HTTP interceptor adds the in-memory access token, applies a ten-second response timeout, retries GET only for network errors, 429, 502, 503, and 504 (three total attempts), and honors `Retry-After`. Rule creation carries an `Idempotency-Key`. Concurrent expired-token responses share one refresh Observable; a failed refresh clears auth and returns to login.

### R4 — UI degradation

Fleet-level request errors and stale state are explicit. The service-history chart panel has its own error and Retry action; it does not replace the fleet view. Viewers are redirected by a route guard for `/rules`, and operator edit controls are not rendered for viewers. Rule saves optimistically update the list and roll back on server rejection.

**Production alternatives:** use a managed streaming gateway with a documented replay cursor, persist refresh tokens in a secure same-site cookie, coordinate refresh and stream ownership across tabs, keep a server-side snapshot/version contract, and instrument reconnect/replay behavior with telemetry.

### Optional resilience additions

The read circuit breaker tracks failures per endpoint, opens after five failures in 30 seconds, routes reads to port 4001 for 20 seconds, and permits one half-open trial. The secondary backend shares in-memory data but bypasses HTTP chaos switches. The service detail page supports 5/15/60-minute history windows; the rule form can restore a local draft; unhandled application errors are rate-limited before reporting to `/telemetry`; logout is broadcast between tabs; and the assistant panel streams mock responses over SSE and supports Stop.

## Performance and measurement

No performance measurements are claimed yet. Run these steps before submission and fill in the measured values:

1. Build production with `cd frontend; npm run build`; record the initial JavaScript gzip size from the output artifacts. Confirm chart/rules are separate lazy chunks.
2. Log in and set `rate=2000` with `POST /chaos`. In Chrome DevTools, set CPU throttling to 4× and record a burst. Record fps and long tasks; inspect input response while searching/sorting.
3. Count `<tr>` elements (or virtualized row elements) while scrolling the 2,000 services. The target is fewer than 60 DOM rows.
4. Capture heap snapshots after 5 and 30 minutes at the same event rate. Compare retained heap and note whether growth is below 20%.
5. Use Angular DevTools profiler to confirm unrelated components do not update for metrics they do not display.

| Measure | Target | Measured result |
|---|---:|---|
| Burst frame rate at 4× CPU | >50 fps; no >50 ms long task | Not measured |
| Search/sort input latency during burst | <100 ms | Not measured |
| DOM rows | <60 | Not measured |
| Heap growth, minute 5 to 30 | <20% | Not measured |
| Initial JS bundle, gzipped | <350 kB | `ng build` estimates 115.57 kB transfer (verify gzip artifact before submission) |
| Unrelated component renders | None | Not measured |

Implemented techniques include virtual scrolling, track-by service id, signal-based state, lazy routes for charts and rules, chart point caps, and one-second batching of stream events. **Do not mark the performance targets as passed until the DevTools procedure confirms them.**

## Mock backend

The backend uses Node.js 22, Express, and `ws`. It serves the API on port 4000, the shared-state read-only secondary on port 4001, and generates 2,000 plausible service records. It implements login/rotating refresh tokens, role checks, service/snapshot/history/replay endpoints, rule CRUD and name checks, idempotent rule creation, WebSocket/SSE streams, telemetry, assistant SSE, and chaos switches.

## Trade-offs and known limitations

- Browser-level chaos drills and sustained 2,000-event/second performance runs must still be carried out and recorded; automated tests are not a substitute for those measurements.
- The mock generates approximate history data and in-memory state, not persistent production data. Restarting it resets rules and chaos.
- Access and refresh tokens are held in memory; a page reload requires a new login, as intended for the access-token storage requirement.
- The 30-second transport climb probes SSE from polling and WebSocket from SSE; check transport continuity with the provided chaos drills before submission.
- The settings form persists preferences locally. Its refresh interval preference is informational; the required fallback polling interval remains two seconds.
- Multi-tab stream sharing and a fully authenticated offline cold start are not implemented; cached data stays visible and marked stale during an offline period in an already authenticated session.
- Bundle, frame-rate, memory, accessibility-tool, and Angular DevTools results should be recorded from the submission machine.

## AI usage

AI assistance was used to scaffold the Angular application, draft the API and UI implementation, and help author tests and documentation. The submitter must review, understand, and be able to explain and modify all generated code during the follow-up call.
