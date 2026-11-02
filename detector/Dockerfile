FROM python:3.13-slim-bookworm

# Install system dependencies required for OpenCV and ONNX
RUN apt-get update && apt-get install -y \
    libgl1 \
    libglib2.0-0 \
    gcc \
    python3-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy dependencies first to cache the pip install layer
COPY requirements.txt .
RUN pip install uv && uv pip install --system --no-cache -r requirements.txt --extra-index-url https://download.pytorch.org/whl/cpu --index-strategy unsafe-best-match

# Copy source code
COPY . .
RUN chmod 755 /app/entrypoint.sh

ENTRYPOINT ["/app/entrypoint.sh"]
