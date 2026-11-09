# Task Assignment App

A web app that assigns tasks to developers by skill and tracks each task's status through nested subtasks.
When a task is saved without skills, the backend asks an LLM (Google Gemini) to identify them from the title.

The full requirements are in [docs/requirement.md](docs/requirement.md), the system design in [docs/design.md](docs/design.md), and the frontend design in [docs/frontend.md](docs/frontend.md).
This README is the entry point and summarises each of them.

## What it does

| Capability | Effect |
| --- | --- |
| Task List page | Lists every task with its subtasks indented under it. Each row has its own status and assignee dropdown and a skill editor. |
| Task Creation page | One form builds a task and up to two levels of subtasks below it (3 levels in total), and saves the whole tree at once. |
| Assignment rule | A task can go only to a developer who has every skill it requires. The assignee dropdown lists only those developers, and the backend rejects any other. |
| Done rule | A task can be Done only when all its subtasks are Done. Reopening a subtask moves the Done tasks above it back to In Progress. |
| Skill identification | A task saved without skills gets them from Gemini in one call per Save. If no key is set, the call fails, or Gemini names no skill for a task, that task shows "Skills needed" and a person picks its skills. |
| Packaging | `docker compose up` runs the database with seed data, the API and the web app. |

Out of scope: login, deleting tasks, editing titles, and adding developers or skills. The full list is in [docs/requirement.md → Out of scope](docs/requirement.md#out-of-scope).

## Usage

### Start the app

You need Docker with Compose v2 (`docker compose`), or the legacy `docker-compose` 1.28 or later.

```sh
cp .env.example .env        # optional: every value has a default
docker compose up --build -d
```

Open http://localhost:8080. The database starts with four developers (Alice, Bob, Carol, Dave) and two skills (Frontend, Backend), and no tasks.

| Goal | Command |
| --- | --- |
| Check the API is up | `curl localhost:3000/api/health` (or your `API_PORT`) returns `{"ok":true}` |
| Read the API's logs | `docker compose logs api` |
| Stop | `docker compose down` |
| Reset all data to the seed | `docker compose down -v`, then start again. This deletes every task. |

Running without a Gemini key spends nothing and sends nothing outside your machine. Tasks saved without skills then show "Skills needed", and you pick their skills on the Task List page.

### Settings

Settings come from a `.env` file next to `docker-compose.yml`. Copy `.env.example` to start one; a missing `.env` is not an error.

| Key | What it does | Example | If missing or wrong |
| --- | --- | --- | --- |
| `GEMINI_API_KEY` | Turns on skill identification | From https://aistudio.google.com/apikey | Missing: tasks without skills save as "Skills needed". Wrong: Gemini refuses each call, the API logs it at `error`, and the tasks save the same way. |
| `GEMINI_MODEL` | Gemini model used | `gemini-3.5-flash-lite` (default) | An unknown model fails each call, logged at `error`; tasks save as "Skills needed". |
| `LLM_TIMEOUT_MS` | Time limit for each Gemini attempt; a failed attempt is retried once, unless it was an HTTP 400, 401, 403 or 404 | `20000` (default) | Not a whole number from 1 to 25000: the API refuses to start. The cap keeps two attempts inside nginx's 60 s proxy timeout. |
| `LOG_LEVEL` | API log level | `info` (default) | Not a pino level: the API refuses to start. |
| `WEB_PORT` | Host port for the web app | `8080` (default) | Port taken: the `web` container fails to start. |
| `API_PORT` | Host port for direct API access | `3000` (default) | Port taken: the `api` container fails to start. |
| `POSTGRES_PASSWORD` | Database password, applied when the data volume is first created | `taskapp` (default) | Use letters and digits only, because it goes unencoded into the API's database URL. Changed after the first start, or holding a character that breaks a URL (such as `#`, `/`, `?` or `%`): the API cannot connect, refuses to start, and Compose keeps restarting it (`docker compose logs api` shows why). To change it, run `docker compose down -v`, which deletes all data. |

Use a Gemini key from a Google Cloud project with no billing account, so it stays on the free tier and cannot be charged. The free tier allows roughly 10 to 15 requests a minute; past that, Saves show "Skills needed" until the minute passes.

## System design

```mermaid
flowchart LR
    browser([Browser]) -->|:8080| web[web: nginx<br/>static SPA + /api proxy]
    web -->|/api/*| api[api: Fastify, Node 24]
    api -->|SQL, row locks| db[(db: PostgreSQL 17)]
    api -->|1 call per Save| llm[Gemini API]
```

| Container | Role |
| --- | --- |
| `web` | nginx serves the built React app and forwards `/api` to the API, so the browser talks to one address and needs no CORS. |
| `api` | The REST API. It owns every business rule and the Gemini call. It starts only after the database is healthy. |
| `db` | PostgreSQL, loaded from `db/init/*.sql` on first start. |

### Where the rules live

The backend enforces every business rule, and the database guards only data integrity.

| Layer | Enforces | Why |
| --- | --- | --- |
| Backend (`backend/src/tasks/rules.ts`, run by `service.ts`) | The assignment rule, the Done rule and reopening, the allowed statuses, the 3-level nesting limit, the 50-task tree limit | A broken rule returns an error that names it, for example "Bob cannot take 'Avatar UI': it requires Frontend, and Bob lacks Frontend." Changing a rule needs no database migration. |
| Database (`db/init/001_schema.sql`) | Rows point at rows that exist, required fields are present, a task has at most one parent and one assignee | These hold whatever code writes the data. |
| Frontend | Nothing it relies on | It lists only qualifying developers and hides "Add Subtask" at the depth limit, as conveniences. The backend's answer is always what the page shows. |

Every change to a task runs in one database transaction that locks the top-level task of its tree first. So two changes to one tree run one after another. For example, marking a parent Done while its subtask is reopened cannot leave a Done task above an unfinished one.

### Saving a task

```mermaid
sequenceDiagram
    participant UI as Create page
    participant API as POST /api/tasks
    participant LLM as Gemini
    participant DB as PostgreSQL
    UI->>API: the whole task tree
    API->>API: validate shape, depth, size, ids, assignees
    opt some tasks have no skills
        API->>LLM: one call with every skill-less title (20 s limit, at most 2 attempts)
        LLM-->>API: skills per title, or failure
    end
    API->>DB: insert the whole tree in one transaction
    API-->>UI: 201 with the created tree
```

Gemini is called before the transaction opens, so no database lock is held while waiting. Gemini may only answer with skill names that exist, enforced by a JSON schema on the request and checked again on the reply. The API refuses to start if the skill names in `backend/src/llm/prompt.json` differ from the `skill` table; Compose then keeps restarting it, and `docker compose logs api` shows why. The full LLM design, including the retry rule and what is logged, is in [docs/design.md → LLM integration](docs/design.md#llm-integration).

### Data model

```mermaid
erDiagram
    developer ||--o{ developer_skill : has
    skill ||--o{ developer_skill : "held by"
    task ||--o{ task_skill : requires
    skill ||--o{ task_skill : "required by"
    developer |o--o{ task : "assignee_id"
    task |o--o{ task : "parent_id"
```

A subtask is a `task` row with a `parent_id`. Every task also stores `root_id`, its tree's top-level task, which the transaction locks. `skill_source` records where a task's skills came from: `USER`, `LLM`, or `FAILED` (shown as "Skills needed"). The schema and the reason for each column are in [docs/design.md → Schema](docs/design.md#schema).

## API

All routes are under `/api` and use JSON. Errors have the shape `{ "error": { "code", "message", "requestId", "details"? } }`, except `GET /api/health`, which answers `503 {"ok":false}`.

| Method and path | Does |
| --- | --- |
| `GET /api/tasks` | List all tasks, with subtasks nested |
| `GET /api/tasks/:id` | Read one task with its subtree |
| `POST /api/tasks` | Create a task with its subtasks |
| `PUT /api/tasks/:id/status` | Change the status; the reply lists any Done ancestors moved back to In Progress |
| `PUT /api/tasks/:id/assignee` | Assign a qualified developer, or unassign with `null` |
| `PUT /api/tasks/:id/skills` | Replace the skills; `unassignIfUnqualified: true` confirms unassigning a developer who no longer qualifies |
| `GET /api/developers`, `GET /api/developers/:id` | List developers, or read one with their skills and assigned tasks |
| `GET /api/skills`, `GET /api/skills/:id` | List skills, or read one |
| `GET /api/meta` | The limits and statuses the frontend uses |
| `GET /api/health` | `200` when the database answers, else `503` |

For example, create a task with a subtask whose skills Gemini will identify (without a key, Avatar UI saves as "Skills needed"):

```sh
curl -X POST localhost:3000/api/tasks -H 'content-type: application/json' \
  -d '{"title":"Profile update","skillIds":["01a1bd9a-c800-7000-8000-000000000001"],"subtasks":[{"title":"Avatar UI"}]}'
```

Every request body, reply shape and error code is in [docs/design.md → API contract](docs/design.md#api-contract).

## Libraries and why

| Layer | Choice | Why this over the alternative |
| --- | --- | --- |
| Frontend build | Vite, React 19, TypeScript | The standard toolchain for a React single-page app. Next.js adds server rendering that two pages do not need. |
| Routing | React Router | Two client routes; the common choice. |
| Server data | TanStack Query | Caching, refetch after each change, and loading and error states, without hand-written fetch effects. |
| Styling | Plain CSS | Two pages do not justify a component library. |
| Backend | Fastify 5, TypeScript | Built-in structured logging (pino) and in-process request tests. Express would need extra packages for both. |
| Validation | zod | One schema gives runtime checks and TypeScript types, including the recursive task tree. |
| Database access | `pg` with plain SQL | The row locks taken in a fixed order are the core of the design; plain SQL keeps them visible, where an ORM would hide them. |
| Ids | `uuid` (version 7) | Ids generated in the app, so a whole tree is inserted in one statement. Node has no built-in version 7. |
| LLM | Gemini `generateContent` via `fetch` | One endpoint does not justify an SDK, and `fetch` gives exact control over the time limit. |
| Tests | Vitest, Testing Library, jsdom | One test runner for both halves. API tests run against a real PostgreSQL. |
| Lint | ESLint with `eslint-plugin-import` | Rejects a frontend feature importing another feature, and shared code importing a feature. |
| Packaging | Docker Compose, nginx, PostgreSQL 17 | One command runs everything. The compose file also works with the legacy `docker-compose`. |

Every dependency version is pinned exactly in `backend/package.json` and `frontend/package.json`.

## Tests

The backend tests run against a real PostgreSQL. Compose starts one for them on port 55433, separate from the app's database:

```sh
docker compose --profile test up -d test-db
until docker compose exec -T test-db pg_isready -q -h 127.0.0.1 -U postgres; do sleep 1; done
cd backend
npm ci
npm test            # unit and API tests (vitest)
npm run typecheck   # TypeScript, including the compile-time transaction check in test/txclient.typecheck.ts
```

The `until` line waits for PostgreSQL to accept connections. Run both `npm` commands: vitest does not check types. Set `TEST_DATABASE_URL` to use another PostgreSQL. No test calls Gemini; the Gemini tests use a stubbed `fetch`.

The frontend tests need no database:

```sh
cd frontend
npm ci --ignore-scripts
npm test && npm run typecheck && npm run lint
```

`npm test` in `backend/` skips `test/e2e.test.ts`, the end-to-end flows over HTTP. Run them from the repo root, after `npm ci` in `backend/`:

```sh
scripts/e2e.sh
```

It needs `docker compose` (v2) and `curl`. It builds the API and web images and starts a separate stack (compose project `taskapp-e2e-3100`, API on port 3100, web on port 8180). It checks nginx's routing and cache headers, runs the flows through nginx, then deletes that stack's containers, data and built images. The app's own stack and data are not touched. It runs with no Gemini key, even when `.env` has one, so it never calls Gemini. Set `E2E_API_PORT` or `E2E_WEB_PORT` if a port is taken; the project name follows the API port.

## Changing the code

For a backend that restarts on every edit, stop the compose `api` service and run the backend directly against the test database:

```sh
docker compose stop api
docker compose --profile test up -d test-db
until docker compose exec -T test-db pg_isready -q -h 127.0.0.1 -U postgres; do sleep 1; done
cat db/init/001_schema.sql db/init/002_seed.sql | docker compose exec -T test-db psql -U postgres -q
cd backend
DATABASE_URL=postgres://postgres:test@127.0.0.1:55433/postgres npm run dev
```

The `cat` line loads the schema and seed, because the test database starts empty. Run it once after each start of `test-db`.

For the frontend, `npm run dev` in `frontend/` serves it on http://localhost:5173 with hot reload, and forwards `/api` to the API on port 3000.
