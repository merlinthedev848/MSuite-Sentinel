FROM python:3.13-slim-bookworm
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libgl1 \
    libglib2.0-0 \
    gcc \
    python3-dev \
    && rm -rf /var/lib/apt/lists/*

COPY api/requirements.txt ./api/
RUN pip install uv && uv pip install --system --no-cache -r api/requirements.txt

COPY api /app/api
COPY web/dist /app/web/dist
COPY docker/entrypoint-api.sh /entrypoint-api.sh
RUN chmod 755 /entrypoint-api.sh

ENTRYPOINT ["/entrypoint-api.sh"]
CMD ["uvicorn", "api.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
