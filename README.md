# Task Assignment App

A web app that assigns tasks to developers by skill and tracks status through nested subtasks.
When a task is saved without skills, the backend asks Google Gemini to identify them from the title.

Details: [requirements](docs/requirement.md), [system design](docs/design.md), [frontend design](docs/frontend.md).

## What it does

| Capability | Effect |
| --- | --- |
| Task List page | Shows every task with its subtasks indented below. Each row has a status dropdown, an assignee dropdown and a skill editor. |
| Task Creation page | Builds a task with up to two levels of subtasks and saves the whole tree at once. |
| Assignment rule | A developer can take a task only if they have every skill it needs. |
| Done rule | A task can be Done only when all its subtasks are Done. Reopening a subtask moves its Done ancestors back to In Progress. |
| Skill identification | Tasks saved without skills get them from Gemini, in one call per Save. If Gemini names none or fails, the task shows "Skills needed" and a person picks its skills. |
| Packaging | `docker compose up` runs the database with seed data, the API and the web app. |

Out of scope: login, deleting tasks, editing titles, and managing developers or skills ([full list](docs/requirement.md#out-of-scope)).

### What it looks like

The Task List. "(LLM)" marks skills Gemini identified. "Plan the team offsite" got no skill, so a person picks one.

![Task List with a three-level task tree](docs/images/task-list.png)

A skill change that leaves the assignee unqualified asks before unassigning them.

![Confirm dialog: Alice lacks Backend](docs/images/confirm-unassign.png)

Task Creation. The subtask has no skills, so Gemini identifies them on Save.

![Task Creation form with one subtask](docs/images/create-task.png)

## Usage

### Start the app

You need Docker with Compose v2 (`docker compose`), or the legacy `docker-compose` 1.28 or later.

```sh
cp .env.example .env        # optional: every value has a default
docker compose up --build -d
```

Open http://localhost:8080. The database starts with four developers (Alice, Bob, Carol, Dave), two skills (Frontend, Backend) and no tasks, loaded from `db/init/*.sql` on first start.

| Goal | Command |
| --- | --- |
| Check the API is up | `curl localhost:3000/api/health` (or your `API_PORT`) returns `{"ok":true}` |
| Inspect the database (read only) | `psql postgres://taskapp:taskapp@127.0.0.1:15432/taskapp` (or your `DB_PORT` and `POSTGRES_PASSWORD`), or `docker compose exec db psql -U taskapp taskapp` |
| Read the API's logs | `docker compose logs api` |
| Stop | `docker compose down` |
| Reset all data to the seed | `docker compose down -v`, then start again |

Writes made directly in the database skip the backend's rules; guarding against them is [out of scope](docs/requirement.md#out-of-scope).

### Settings

Settings come from `.env` next to `docker-compose.yml`; a missing `.env` is not an error.

| Key | What it does | Default | If missing or wrong |
| --- | --- | --- | --- |
| `GEMINI_API_KEY` | Turns on skill identification; get one at https://aistudio.google.com/apikey | (empty) | Tasks without skills save as "Skills needed". A wrong key fails each call, logged at `error`, and those tasks save the same way. |
| `GEMINI_MODEL` | Gemini model | `gemini-3.5-flash-lite` | An unknown model fails each call, logged at `error`. |
| `LLM_TIMEOUT_MS` | Time limit per Gemini attempt | `20000` | Not a whole number from 1 to 25000: the API refuses to start. |
| `LOG_LEVEL` | API log level | `info` | Not a pino level: the API refuses to start. |
| `WEB_PORT` | Host port for the web app | `8080` | Port taken: `web` fails to start. |
| `API_PORT` | Host port for the API | `3000` | Port taken: `api` fails to start, so `web` does not start either. |
| `DB_PORT` | Host port for a database client | `15432` | Port taken: `db` fails to start, so `api` and `web` do not start either. |
| `POSTGRES_PASSWORD` | Database password | `taskapp` | Letters and digits only: it goes unencoded into the API's database URL. Applied only when the data volume is created. A character that breaks a URL (such as `#`, `/`, `?` or `%`), or a change after the volume exists, makes the API refuse to start. To change it, run `docker compose down -v` (deletes all data). |

When the API refuses to start, Compose keeps restarting it and the web app never comes up; `docker compose logs api` shows why.

Without a key, the app spends nothing and sends nothing off your machine. With one, use a key from a Google Cloud project with no billing account, so it stays on the free tier. That tier allows roughly 10 to 15 requests a minute; past that, Saves show "Skills needed" until the minute passes.

## System design

```mermaid
flowchart LR
    browser([Browser]) -->|:8080| web[web: nginx<br/>static SPA + /api proxy]
    web -->|/api/*| api[api: Fastify, Node 24]
    api -->|SQL, row locks| db[(db: PostgreSQL 17)]
    api -->|1 call per Save| llm[Gemini API]
```

nginx serves the React app and forwards `/api`, so the browser sees one origin and needs no CORS.

### Where the rules live

| Layer | Enforces |
| --- | --- |
| Backend (`backend/src/tasks/rules.ts`, run by `service.ts`) | Every business rule: assignment, Done and reopening, allowed statuses, 3 levels, 50 tasks per tree. A broken rule returns an error naming it, such as "Bob cannot take 'Avatar UI': it requires Frontend, and Bob lacks Frontend." |
| Database (`db/init/001_schema.sql`) | Data integrity only: references exist, required fields are set, and a task has at most one parent and one assignee. |
| Frontend | Nothing it relies on. Hiding choices the backend would reject is a convenience. |

Every change runs in one transaction that first locks the top-level task of its tree. So two changes to one tree run one after the other, and a Done task can never end up above an unfinished subtask.

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

- Gemini is called before the transaction, so no database lock or connection is held while waiting.
- A JSON schema limits Gemini's answer to existing skill names, and the reply is checked again.
- The API refuses to start if the skill names in `backend/src/llm/prompt.json` differ from the `skill` table; `docker compose logs api` shows why.

Retries, logging and limits: [design.md → LLM integration](docs/design.md#llm-integration).

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

A subtask is a `task` row with a `parent_id`. `root_id` names the tree's top-level task, the row the transaction locks. `skill_source` is `USER`, `LLM` or `FAILED` ("Skills needed"). Column-by-column reasons: [design.md → Schema](docs/design.md#schema).

## API

Routes are under `/api` and use JSON. Errors look like `{ "error": { "code", "message", "requestId", "details"? } }`.

| Method and path | Does |
| --- | --- |
| `GET /api/tasks` | List all tasks, subtasks nested |
| `GET /api/tasks/:id` | One task with its subtree |
| `POST /api/tasks` | Create a task with its subtasks |
| `PUT /api/tasks/:id/status` | Change status; the reply lists Done ancestors moved back to In Progress |
| `PUT /api/tasks/:id/assignee` | Assign a qualified developer, or `null` to unassign |
| `PUT /api/tasks/:id/skills` | Replace skills; `unassignIfUnqualified: true` confirms unassigning |
| `GET /api/developers[/:id]` | Developers, or one with skills and assigned tasks |
| `GET /api/skills[/:id]` | Skills, or one |
| `GET /api/meta` | Limits and statuses for the frontend |
| `GET /api/health` | `200 {"ok":true}`, or `503 {"ok":false}` when the database is down |

Example: a task with a subtask whose skills Gemini will identify.

```sh
curl -X POST localhost:3000/api/tasks -H 'content-type: application/json' \
  -d '{"title":"Profile update","skillIds":["01a1bd9a-c800-7000-8000-000000000001"],"subtasks":[{"title":"Avatar UI"}]}'
```

Full contract: [design.md → API contract](docs/design.md#api-contract).

## Libraries and why

| Layer | Choice | Why |
| --- | --- | --- |
| Frontend | Vite, React 19, TypeScript | Standard for a single-page app; two pages need no server rendering. |
| Routing | React Router | Two client routes. |
| Server data | TanStack Query | Caching, refetch after changes, loading and error states. |
| Styling | Plain CSS | Two pages do not justify a component library. |
| Backend | Fastify 5, TypeScript | Built-in structured logging and in-process request tests. |
| Validation | zod | One schema gives runtime checks and types, including the recursive tree. |
| Database access | `pg`, plain SQL | The fixed lock order is the core of the design; an ORM would hide it. |
| Ids | `uuid` (version 7) | Generated in the app, so a whole tree inserts in one statement; Node has no built-in version 7. |
| LLM | Gemini via `fetch` | One endpoint needs no SDK, and `fetch` gives exact control of the time limit. |
| Tests | Vitest, Testing Library, jsdom | One runner for both halves; API tests use a real PostgreSQL. |
| Lint | ESLint, `eslint-plugin-import` | Stops frontend features importing each other, and shared code importing a feature. |
| Packaging | Docker Compose, nginx, PostgreSQL 17 | One command runs everything. |

Versions are pinned exactly in each `package.json`.

## Tests

Backend tests need a PostgreSQL; Compose starts one on port 55433, separate from the app's:

```sh
docker compose --profile test up -d test-db
until docker compose exec -T test-db pg_isready -q -h 127.0.0.1 -U postgres; do sleep 1; done
cd backend
npm ci
npm test            # unit and API tests
npm run typecheck   # vitest does not check types
```

No test calls Gemini; the Gemini tests stub `fetch`. `TEST_DATABASE_URL` points the tests at another PostgreSQL. `npm test` skips `test/e2e.test.ts`, which `scripts/e2e.sh` runs.

Frontend tests need no database:

```sh
cd frontend
npm ci --ignore-scripts
npm test && npm run typecheck && npm run lint
```

End-to-end flows, from the repo root after `npm ci` in `backend/` (needs `docker compose` v2 and `curl`):

```sh
scripts/e2e.sh
```

It builds a separate, throwaway stack (compose project `taskapp-e2e-<API port>`; API on 3100, web on 8180, database on 5532) and runs the flows through nginx without a Gemini key, even when `.env` has one. Your own stack and data are untouched. If a port is taken, set `E2E_API_PORT`, `E2E_WEB_PORT` or `E2E_DB_PORT`.

## Changing the code

To run the backend with restart-on-edit against the test database:

```sh
docker compose stop api
docker compose --profile test up -d test-db
until docker compose exec -T test-db pg_isready -q -h 127.0.0.1 -U postgres; do sleep 1; done
cat db/init/001_schema.sql db/init/002_seed.sql | docker compose exec -T test-db psql -U postgres -q   # once per test-db start
cd backend
DATABASE_URL=postgres://postgres:test@127.0.0.1:55433/postgres npm run dev
```

For the frontend, `npm run dev` in `frontend/` serves http://localhost:5173 with hot reload and forwards `/api` to port 3000.
