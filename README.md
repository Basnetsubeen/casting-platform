# Hospitality Casting Platform (Phase 1 Scaffold)

Multi-tenant hospitality TV management system inspired by Nonius.

## Services

- `backend`: Fastify + Prisma + PostgreSQL API for room/menu/pairing/session lifecycle.
- `cms`: Next.js + shadcn/ui-ready admin shell for operations and room reset actions.
- `tv-landing`: React TV web app (1080p-focused) with rotating pairing code + QR.
- `casting-proxy`: Node.js multicast DNS discovery proxy for room-scoped Chromecast ads.

## Quick Start

1. Copy `.env.example` to `.env` and adjust values.
2. Start stack:

```bash
docker compose up --build
```

3. Apply Prisma migrations from backend container or host:

```bash
cd backend
npm install
npx prisma migrate dev --name init
```

### Production-ish compose profile

Use base + prod override:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

## Pairing Flow

1. TV landing page requests `/api/rooms/:roomNumber/pairing-code`.
2. Backend rotates and stores a 4-digit code with short expiration.
3. TV shows code + QR payload (`roomNumber`, `pairingCode`).
4. Guest scans QR to open `/pair` page with prefilled room/code, then app calls `POST /api/pair` with `pairingCode` + `guestDeviceId`.
5. Backend binds guest session to room + Chromecast IP and returns a scoped `proxyToken`.
6. Casting proxy validates `guestSessionId` + `guestDeviceId` + `proxyToken` against backend before discovery response.
7. On checkout/end-session, backend revokes active sessions and rotates pairing code.

## Admin/Auth Notes

- Admin endpoints require JWT role `admin`:
  - `POST /api/rooms`
  - `GET /api/rooms`
  - `POST /api/rooms/:roomNumber/end-session`
  - `GET /api/ops/active-sessions`
- Fetch token via `POST /api/auth/login` using `ADMIN_USERNAME` / `ADMIN_PASSWORD`.

## Proxmox Notes

- Use VM when VLAN segmentation/mDNS reflection is required.
- Use Avahi/mDNS reflector on gateway to bridge discovery where needed.
- Keep one Chromecast target mapped per room to prevent cross-room casting.
- Full runbook: `deployment/proxmox-runbook.md`
