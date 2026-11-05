# Sentinel Production Infrastructure & Nginx Reverse Proxy Guide

This document defines the production reverse proxy architecture, stream latency tuning, security hardening, and Proxmox host optimization for **Sentinel** (`sentinel.chriskendall.media`).

---

## 1. Architecture Overview

```
[ Browser / Mobile Client ]
             │
             │ HTTPS (TLS 1.3) / WSS (fMP4 WebSocket)
             ▼
      [ Nginx Reverse Proxy ]
             │
             │ HTTP/1.1 (proxy_buffering off, low-latency zero-copy)
             ▼
    [ Sentinel FastAPI Backend ] (Port 8000)
       ├── /cameras, /recordings, /events, /system/live (SSE)
       └── /go2rtc/api/ws ──► [ go2rtc fMP4 Engine ] (127.0.0.1:1984)
                                    │
                                    │ RTSP (TCP)
                                    ▼
                         [ IP Cameras (LAN) ]
```

### Critical Security Boundaries
- **Never expose port 1984 (go2rtc admin API) directly to the WAN.** The go2rtc admin API permits registering shell and pipeline sources.
- **Port 8000 (FastAPI)** terminates all client traffic. The FastAPI gateway verifies session tokens before proxying the fMP4 WebSocket `/go2rtc/api/ws` or API routes `/go2rtc/{path:path}`.
- **Postgres (5432)** and **MQTT (1883)** bind exclusively to `127.0.0.1`.

---

## 2. Production Nginx Reverse Proxy Configuration

Create or update `/etc/nginx/sites-available/sentinel.conf`:

```nginx
# Rate-limiting zones for auth endpoints (Fail2ban & anti-bruteforce)
limit_req_zone $binary_remote_addr zone=sentinel_auth:10m rate=5r/m;
limit_req_zone $binary_remote_addr zone=sentinel_api:10m rate=60r/s;

# Upstream Sentinel application server
upstream sentinel_backend {
    server 127.0.0.1:8000;
    keepalive 32;
}

# Redirect HTTP to HTTPS
server {
    listen 80;
    listen [::]:80;
    server_name sentinel.chriskendall.media;

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

# Primary HTTPS & WebSocket Server
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name sentinel.chriskendall.media;

    # SSL / TLS Modern Parameters
    ssl_certificate /etc/letsencrypt/live/sentinel.chriskendall.media/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/sentinel.chriskendall.media/privkey.pem;
    ssl_session_timeout 1d;
    ssl_session_cache shared:SSL:10m;
    ssl_session_tickets off;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers off;

    # Security Headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;

    # Client payload bounds (for video file exports and map uploads)
    client_max_body_size 500M;
    client_body_buffer_size 1M;

    # 1. Login rate limiting against credential stuffing
    location /auth/token {
        limit_req zone=sentinel_auth burst=10 nodelay;
        proxy_pass http://sentinel_backend;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }

    # 2. Live fMP4 WebSocket Streaming (Zero Buffering, Long Timeout)
    location /go2rtc/api/ws {
        proxy_pass http://sentinel_backend;
        proxy_http_version 1.1;
        
        # WebSocket Upgrade Headers
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        
        # Identity Headers
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;

        # Critical: Disable proxy buffering to prevent frame jitter and latency accumulation
        proxy_buffering off;
        proxy_cache off;
        chunked_transfer_encoding on;

        # Keep socket open across camera idle periods
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }

    # 3. Server-Sent Events (SSE) System Live Metrics
    location /system/live {
        proxy_pass http://sentinel_backend;
        proxy_http_version 1.1;
        proxy_set_header Connection '';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;

        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 86400s;
    }

    # 4. General API & Static UI Web App
    location / {
        limit_req zone=sentinel_api burst=120 nodelay;
        proxy_pass http://sentinel_backend;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;

        proxy_buffering off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}

# Map for WebSocket Connection Header
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
```

---

## 3. Fail2ban Integration (Defensive Boundary)

Protect against brute-force login attempts in `/etc/fail2ban/jail.d/sentinel.conf`:

```ini
[sentinel-auth]
enabled  = true
port     = http,https
filter   = sentinel-auth
logpath  = /var/log/nginx/access.log
maxretry = 5
findtime = 600
bantime  = 3600
```

And `/etc/fail2ban/filter.d/sentinel-auth.conf`:

```ini
[Definition]
failregex = ^<HOST> - .* "(?:POST) /auth/token.*" 401
ignoreregex =
```

---

## 4. Proxmox Host & VM Resource Optimization

To run continuous 2688x1520 ingestion and real-time YOLO object detection with minimal CPU utilization:

### 1. Hardware Video Acceleration Passthrough
- **Intel QuickSync / VA-API (LXC or QEMU):**
  Pass `/dev/dri/renderD128` into the container or VM.
  In LXC config (`/etc/pve/lxc/<VMID>.conf`):
  ```
  lxc.cgroup2.devices.allow: c 226:128 rwm
  lxc.mount.entry: /dev/dri/renderD128 dev/dri/renderD128 none bind,optional,create=file
  ```
- **NVIDIA GPU (NVENC / CUDA):**
  Use `docker-compose.gpu.yml` with the NVIDIA Container Toolkit. Ensure `NVIDIA_VISIBLE_DEVICES=all` and `NVIDIA_DRIVER_CAPABILITIES=compute,video,utility`.

### 2. Stream Architecture Best Practice
- **Dual-Stream Configuration:**
  Always configure your cameras with **Main Stream** (2688x1520 H.264/H.265) for recording and full-view inspection, and **Sub Stream** (640x360 or 704x576) for grid viewing and AI motion detection.
  - Recording: `-c:v copy` directly records the stream without re-encoding, consuming < 1% CPU.
  - Substream Detection: The detector connects to `{cid}_sub` instead of 2688x1520, reducing pixel decode volume by **~94%**.
- **Buffer Bloat Elimination:**
  With MSE fMP4 sub-second catch-up enabled in `LivePlayer.tsx`, streams sync to within 0.15s of the live edge automatically.
