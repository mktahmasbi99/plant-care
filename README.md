# Plant Care

A private, self-hosted plant-care routine for a single trusted household. It keeps every pot visible in your chosen order and shows gentle signals based on its watering history.

## What it records

- Individual plants (species, nickname, location, permanent care routine)
- Last watered dates and approximate intervals learned from recent watering history
- **Watered** and **Snooze** actions, with quick snooze choices
- Dated journal notes, occasional photos, fertilizer products and applications
- Full timeline and self-contained SQLite backup/restore

The app does not judge pot weight or make automatic horticultural decisions. Amber signals indicate that more time has passed than usual; you decide whether conditions call for water.

## Local development

Requires Python 3.13+ and Node 24+.

```sh
python3 -m venv .venv
.venv/bin/pip install -e './backend[dev]'
cd frontend && npm install
```

In one terminal:

```sh
cd frontend && npm run dev
```

In another:

```sh
TZ=Europe/Warsaw PLANT_CARE_DB=./data/dev.sqlite3 .venv/bin/uvicorn app.main:app --app-dir backend --reload --port 8000
```

The Vite server proxies API calls to port 8000. For a production-like preview, run `npm run build` inside `frontend/`, then open FastAPI on port 8000.

## NAS deployment

The supplied [Compose file](deploy/docker-compose.yml) persists its complete application database in `./data`.

```sh
mkdir -p plant-care && cd plant-care
# copy deploy/docker-compose.yml here
docker compose pull
docker compose up -d
curl --fail http://127.0.0.1:8000/api/health
```

Expose it only through your trusted LAN or Tailscale Serve/ACLs; it has no user accounts and must not be port-forwarded to the public internet. Before an update, use the in-app backup feature rather than copying a live SQLite main file; WAL sidecar files can make a raw copy incomplete. A container recreation does not remove the mounted data.

## Backup and restore

Settings creates self-contained SQLite backups containing plants, histories, notes, fertilizer records, and optimized photos. They are retained in `data/backups/`, marked with the Plant Care backup identity, and can be downloaded, restored, or deleted with typed confirmation. Daily (01:00, keep 7) and weekly (Sunday 01:00, keep 8) schedules are configurable in Settings; the server runs a single missed backup after it returns from downtime.

Restores accept only marked Plant Care backups, stage and validate SQLite integrity/foreign keys/schema compatibility, create a `pre-restore` safety snapshot, then atomically replace the live database. The existing backup schedule is retained. Compatible older Plant Care databases can be handled through the separate typed `IMPORT` flow. Permanent plant deletion also creates a `pre-delete` safety snapshot. Safety backups share their own configurable retention limit.
