# Sentinel nginx proxy

The dashboard and media stay on the API. go2rtc listens on 127.0.0.1 and its admin API can register streams, so nginx must not publish port 1984. The API already proxies the stream paths the player uses and refuses the rest.

```nginx
server {
    listen 443 ssl;
    http2 on;

    server_name sentinel.example.com;

    ssl_certificate /etc/letsencrypt/live/sentinel.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/sentinel.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
    }
}
```

Do not add a `location /go2rtc/` that points at port 1984. The browser uses `/go2rtc/` on the API, which is the allow-listed proxy.
