# Plant Care

A private, self-hosted plant-care routine for a single trusted household. It highlights each pot when its individually scheduled check is due while keeping the complete collection visible in your chosen order.

## What it records

- Individual plants (species, nickname, location, permanent care routine)
- Per-pot check intervals based on the last watering or a selected recheck date
- **Watered** and **Not watered** actions, with quick recheck choices
- Dated journal notes, occasional photos, fertilizer products and applications
- Full timeline and self-contained SQLite backup/restore

The app does not judge pot weight or make automatic horticultural decisions. It records your care decisions and shows when a pot is due for its configured check interval.

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

Expose it only through your trusted LAN or Tailscale Serve/ACLs; it has no user accounts and must not be port-forwarded to the public internet. Before an update, download an in-app backup or copy `data/plant_care.sqlite3`. A container recreation does not remove the mounted data.

## Backup and restore

Settings provides a SQLite download containing plants, histories, notes, fertilizer records, and optimized photos. Restore validates the application identity, schema compatibility, SQLite integrity, and foreign keys, and writes a pre-restore snapshot inside the data directory before replacing the live database.
