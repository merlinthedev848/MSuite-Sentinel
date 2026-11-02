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
COPY docker/serve_api.py /serve_api.py
RUN chmod 755 /entrypoint-api.sh /serve_api.py

ENV PYTHONUNBUFFERED=1
ENTRYPOINT ["/entrypoint-api.sh"]
CMD ["python", "/serve_api.py"]
