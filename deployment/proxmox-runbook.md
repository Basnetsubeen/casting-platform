# Proxmox Deployment Runbook (Phase 2)

This runbook covers two deployment paths and the networking required for room-isolated casting in hospitality.

## 1) Choose Runtime Model

### Option A: LXC + Docker (lightweight)
- Best for single-property setups with straightforward networking.
- Fast boot, lower overhead.
- Use only if your router/firewall already supports VLAN + mDNS reflection.

### Option B: VM + Docker (recommended)
- Best for multi-VLAN hospitality isolation and long-term maintainability.
- Easier troubleshooting and safer kernel boundary.
- Recommended when each floor/room group maps to separate VLANs.

## 2) Proxmox Host Networking

Use one trunk bridge from your physical NIC and tag VLANs downstream.

Example `/etc/network/interfaces` concept on Proxmox host:

```ini
auto lo
iface lo inet loopback

auto enp3s0
iface enp3s0 inet manual

auto vmbr0
iface vmbr0 inet static
  address 192.168.10.2/24
  gateway 192.168.10.1
  bridge-ports enp3s0
  bridge-stp off
  bridge-fd 0
  bridge-vlan-aware yes
```

Then assign VLAN tags per VM/LXC NIC (for example 20 = guest, 30 = TV/IoT, 40 = ops).

## 3) VM Baseline (Ubuntu/Debian)

Inside VM:

```bash
sudo apt update && sudo apt install -y ca-certificates curl gnupg lsb-release avahi-daemon avahi-utils
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
newgrp docker
docker --version
docker compose version
```

## 4) Platform Deployment

1. Copy project folder to VM.
2. Create env file:

```bash
cp .env.example .env
```

3. Start services:

```bash
docker compose up -d --build
```

4. Apply DB migrations:

```bash
cd backend
npm install
npx prisma migrate dev --name init
```

## 5) VLAN Pattern for Hospitality Isolation

Recommended model:
- VLAN 20: Guest devices (phones/tablets)
- VLAN 30: TV + Chromecast devices
- VLAN 40: Ops/Admin (CMS/backend management)

Firewall policy:
- Allow Guest -> Casting Proxy (`4100/tcp`) and Backend Pair API (`4000/tcp`) only.
- Deny Guest -> direct Chromecast subnet except mDNS relay path.
- Allow TV VLAN -> Backend API for pairing code display.
- Allow Ops VLAN -> CMS (`3000`) + Backend (`4000`) + DB admin path as required.

## 6) mDNS Reflection (Critical)

Chromecast discovery uses mDNS (`224.0.0.251:5353`), which does not cross VLANs by default.

Use Avahi reflector on router/gateway (preferred) or dedicated relay VM:

`/etc/avahi/avahi-daemon.conf` example:

```ini
[server]
use-ipv4=yes
use-ipv6=no
allow-interfaces=eth0.20,eth0.30

[reflector]
enable-reflector=yes
reflect-ipv=no

[publish]
disable-publishing=yes
disable-user-service-publishing=yes
```

Restart:

```bash
sudo systemctl restart avahi-daemon
sudo systemctl enable avahi-daemon
```

## 7) Room-to-Chromecast Safety Controls

The app already binds a guest session to one room and one Chromecast IP.

Operational controls to enforce:
- Maintain one static Chromecast IP per room in backend `Room.chromecastIp`.
- Rotate pairing code every few minutes (already implemented).
- Trigger `end-session` on checkout to revoke active sessions and rotate code.
- Optionally schedule nightly reset for stale sessions.

## 8) Check-in / Check-out Workflow

- Check-in:
  - Ensure room is marked active.
  - TV landing page shows current pairing QR/code.
- During stay:
  - Guest pairs via `/api/pair`.
  - Session remains valid until expiry.
- Check-out:
  - CMS operator runs "End Session".
  - System terminates active room cast sessions and rotates code.

## 9) Validation Checklist

- `docker compose ps` shows all services healthy.
- `GET /health` on backend returns `ok`.
- TV page loads with room query string and shows 4-digit code.
- `/api/pair` accepts valid code and rejects expired code.
- End session invalidates old guest session.
- mDNS relay sees Chromecast services across required VLAN boundary only.

## 10) Hardening Next

- Add JWT auth for CMS/backend admin endpoints.
- Move PostgreSQL to managed/HA design with backups.
- Add TLS reverse proxy (Caddy/Nginx/Traefik) with internal cert policy.
- Add metrics/logging (Prometheus + Grafana or equivalent).
