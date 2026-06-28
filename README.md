# minimatrix

## PWA frontend

Tiny Matrix frontend.

### Features

- Single room. No room switching.
- Limited message sending. Only voice notes and emojis (with a custom emoji picker).
- Full message reception, history support, media playback.
- No e2ee.
- Magic link contains homeserver, username, password, roomId (or the user's only room if omitted).
  The link embeds the account password — treat it as a secret; anyone with it has full account
  access. The password is used once to log in, then a per-device access token is persisted and
  reused on later launches (so each install stays on a single device rather than minting a new one
  every time).

## Continuwuity backend

### Local testing

```bash
MATRIX_DOMAIN=localhost docker compose up
```

### Production deployment

Point $MATRIX_DOMAIN to the given server.

```bash
systemctl enable --now docker # daemon starts on boot

apt install -y fail2ban

install -m 644 /dev/stdin /etc/fail2ban/filter.d/continuwuity-login.conf <<'EOF'
[Definition]
failregex = "remote_ip":"<HOST>".*"uri":"/_matrix/client/[^"]*/login".*"status":(401|403|429)
datepattern = "ts":{EPOCH}
EOF

install -m 644 /dev/stdin /etc/fail2ban/jail.d/continuwuity-login.conf <<'EOF'
[continuwuity-login]
enabled  = true
filter   = continuwuity-login
logpath  = /var/log/caddy/access.log
bantime  = 1h
EOF

systemctl restart fail2ban

mkdir -p /var/log/caddy

echo 'MATRIX_DOMAIN=...' > .env
docker compose up -d # caddy will start letsencrypting, as long as DNS works!
docker compose logs continuwuity | grep -i token # grab the registration token
```
