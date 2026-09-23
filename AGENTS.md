# Repository Guidelines

## Project Structure & Architecture

Plant Care is a self-hosted FastAPI/SQLite application with a React PWA.

- `backend/app/` contains the FastAPI routes, SQLite schema migrations, and care-scheduling logic.
- `backend/tests/` contains API and migration tests using pytest.
- `frontend/src/` contains React views, API types/client, and global CSS.
- `frontend/tests/` contains Vitest unit tests; `frontend/e2e/` contains Playwright flows.
- `deploy/docker-compose.yml` and `Dockerfile` define the production container. SQLite data is intentionally kept outside source control in `data/`.

Server dates use `Europe/Warsaw`; preserve date-only scheduling semantics rather than adding timestamps.

## Build, Test, and Development Commands

Install dependencies once:

```sh
python3 -m venv .venv
.venv/bin/pip install -e './backend[dev]'
cd frontend && npm install
```

- `TZ=Europe/Warsaw PLANT_CARE_DB=./data/dev.sqlite3 .venv/bin/uvicorn app.main:app --app-dir backend --reload --port 8000` — run the API locally.
- `cd frontend && npm run dev` — run Vite; it proxies API requests to port 8000.
- `PYTHONPATH=backend .venv/bin/python -m pytest backend/tests -q` — run backend tests.
- `PYTHONPATH=backend .venv/bin/python -m ruff check backend` — lint Python.
- `cd frontend && npm run typecheck && npm run lint && npm test && npm run build` — validate and build the frontend.
- `cd frontend && npm run test:e2e` — run browser tests.

Run `git diff --check` before handing off changes.

## Coding Style & Naming Conventions

Use four spaces for Python and the repository’s existing Prettier-style formatting for TypeScript/CSS. Prefer typed API contracts in `frontend/src/api.ts`, `PascalCase` React components, and `camelCase` functions/state. Keep database migrations additive and preserve existing care history during upgrades or backup restores. Use accessible labels for icon-only controls and keep status meaning available in text, not color alone.

## Testing Guidelines

Add focused pytest coverage for API validation, migration behavior, and scheduling changes. Add Vitest tests for component behavior and Playwright coverage for user-visible workflows such as adding, watering, deferring, editing, reordering, and reloading plants. Name tests after the expected behavior, for example `test_recheck_date_must_be_after_care_date`.

## Commit & Pull Request Guidelines

Use a short imperative subject followed by an explanatory body, for example:

```text
Refine plant care controls

Keep plant editing one tap away and make watering-history corrections clear.
```

Keep commits scoped. Pull requests should explain the behavior change, note any schema migration or backup impact, list validation performed, and include screenshots for visible UI changes. Do not commit database files, backups, or private photos.
