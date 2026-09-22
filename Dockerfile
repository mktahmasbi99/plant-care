FROM node:24-alpine AS frontend-build
WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM python:3.13-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends libheif1 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY backend/pyproject.toml ./backend/
COPY backend/app ./backend/app
RUN pip install --no-cache-dir ./backend
COPY --from=frontend-build /build/frontend/dist ./frontend/dist
RUN useradd --create-home --uid 1000 appuser && mkdir -p /data && chown -R appuser:appuser /app /data
USER appuser
ENV PLANT_CARE_DB=/data/plant_care.sqlite3 TZ=Europe/Warsaw PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
VOLUME ["/data"]
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s --start-period=8s --retries=3 CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=2)" || exit 1
CMD ["uvicorn", "app.main:app", "--app-dir", "backend", "--host", "0.0.0.0", "--port", "8000"]
