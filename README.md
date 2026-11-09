# Task Assignment App

Assigns tasks to developers by skill and tracks task status through nested subtasks.
The requirements are in [docs/requirement.md](docs/requirement.md), the system design in [docs/design.md](docs/design.md), and the frontend design in [docs/frontend.md](docs/frontend.md).

## Running

Docker Compose runs the PostgreSQL database, loaded with the schema and seed data, and the API on `localhost:3000`.

| Goal | Command |
| --- | --- |
| Start | `docker compose up --build -d` (or `docker-compose up --build -d`) |
| Check it is up | `curl localhost:3000/api/health` returns `{"ok":true}` (use your port if `API_PORT` is set) |
| Reset all data to the seed | `docker compose down -v`, then start again. This deletes every task. |

Configuration comes from a `.env` file next to `docker-compose.yml`. Copy `.env.example` to start one. Every value is optional.

No skill identifier is connected to the API. A task saved without skills gets `"skillSource": "FAILED"`, and a person sets its skills with `PUT /api/tasks/:id/skills`.

For example, list the seeded developers and create a task with a subtask:

```sh
curl localhost:3000/api/developers
curl -X POST localhost:3000/api/tasks -H 'content-type: application/json' \
  -d '{"title":"Profile update","skillIds":["01a1bd9a-c800-7000-8000-000000000001"],"subtasks":[{"title":"Avatar UI"}]}'
```

The routes and error codes are in [docs/design.md → API contract](docs/design.md#api-contract).

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

The `until` line waits for PostgreSQL to accept connections. Run both `npm` commands: vitest does not check types. Set `TEST_DATABASE_URL` to use another PostgreSQL.

`npm test` skips `test/e2e.test.ts`, the end-to-end flows over HTTP. Run them after each change, from the repo root, with `npm ci` done in `backend/`:

```sh
scripts/e2e.sh
```

It needs `docker compose` (v2) and `curl`. It builds the API image and starts a separate stack (compose project `taskapp-e2e-3100`, API on port 3100), runs the flows, then deletes that stack's containers, data and built image. The app's own stack and data are not touched. Set `E2E_API_PORT` if 3100 is taken; the project name follows the port.

## Changing backend code

For a server that restarts on every edit, stop the compose `api` service and run the backend directly against the test database:

```sh
docker compose stop api
docker compose --profile test up -d test-db
until docker compose exec -T test-db pg_isready -q -h 127.0.0.1 -U postgres; do sleep 1; done
cat db/init/001_schema.sql db/init/002_seed.sql | docker compose exec -T test-db psql -U postgres -q
cd backend
DATABASE_URL=postgres://postgres:test@127.0.0.1:55433/postgres npm run dev
```

The `cat` line loads the schema and seed, because the test database starts empty. Run it once after each start of `test-db`.
