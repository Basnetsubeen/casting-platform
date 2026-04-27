import Fastify from "fastify";
import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import jwt from "@fastify/jwt";
import { nanoid } from "nanoid";
import { prisma } from "./db.js";
import { z } from "zod";

const app = Fastify({ logger: true });
const port = Number(process.env.BACKEND_PORT ?? 4000);
const pairingCodeTtlSeconds = Number(process.env.PAIRING_CODE_TTL_SECONDS ?? 300);
const sessionTtlMinutes = Number(process.env.SESSION_TTL_MINUTES ?? 720);
const jwtSecret = process.env.JWT_SECRET ?? "change-me-in-production";
const adminUsername = process.env.ADMIN_USERNAME ?? "admin";
const adminPassword = process.env.ADMIN_PASSWORD ?? "admin123";
const cleanupIntervalSeconds = Number(process.env.SESSION_CLEANUP_INTERVAL_SECONDS ?? 60);
const castingProxyUrl = process.env.CASTING_PROXY_URL ?? "http://casting-proxy:4100";
const proxySharedSecret = process.env.PROXY_SHARED_SECRET ?? "proxy-secret";

const roomCreateSchema = z.object({
  roomNumber: z.string().min(1),
  chromecastIp: z.string().ip(),
  brandTheme: z.string().optional()
});

const pairSchema = z.object({
  pairingCode: z.string().length(4),
  guestDeviceId: z.string().min(4)
});

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1)
});

const proxyAuthorizeSchema = z.object({
  guestDeviceId: z.string().min(4)
});

function generatePairingCode(): string {
  return `${Math.floor(1000 + Math.random() * 9000)}`;
}

async function rotateCodeByRoomNumber(roomNumber: string) {
  const code = generatePairingCode();
  const pairingCodeUntil = new Date(Date.now() + pairingCodeTtlSeconds * 1000);
  return prisma.room.update({
    where: { roomNumber },
    data: { pairingCode: code, pairingCodeUntil }
  });
}

app.register(cors, { origin: true });
app.register(sensible);
app.register(jwt, { secret: jwtSecret });

type AdminJwtPayload = { sub: string; role: "admin" };
type GuestProxyJwtPayload = {
  sid: string;
  gdid: string;
  roomNumber: string;
  scope: "cast:proxy";
};

async function verifyAdmin(req: any, reply: any) {
  try {
    await req.jwtVerify<AdminJwtPayload>();
    if (req.user?.role !== "admin") return reply.forbidden("Admin role required");
  } catch {
    return reply.unauthorized("Invalid or missing admin token");
  }
}

app.get("/health", async () => ({ ok: true }));

app.post("/api/auth/login", async (req, reply) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return reply.badRequest(parsed.error.flatten());
  if (parsed.data.username !== adminUsername || parsed.data.password !== adminPassword) {
    return reply.unauthorized("Invalid credentials");
  }

  const token = app.jwt.sign({ sub: adminUsername, role: "admin" } satisfies AdminJwtPayload, {
    expiresIn: "12h"
  });
  return { token };
});

app.post("/api/rooms", { preHandler: verifyAdmin }, async (req, reply) => {
  const parsed = roomCreateSchema.safeParse(req.body);
  if (!parsed.success) return reply.badRequest(parsed.error.flatten());

  const room = await prisma.room.create({
    data: {
      ...parsed.data,
      pairingCode: generatePairingCode(),
      pairingCodeUntil: new Date(Date.now() + pairingCodeTtlSeconds * 1000)
    }
  });
  return reply.code(201).send(room);
});

app.get("/api/rooms", { preHandler: verifyAdmin }, async () =>
  prisma.room.findMany({ orderBy: { roomNumber: "asc" } })
);

app.get("/api/rooms/:roomNumber/pairing-code", async (req, reply) => {
  const roomNumber = (req.params as { roomNumber: string }).roomNumber;
  const room = await prisma.room.findUnique({ where: { roomNumber } });
  if (!room) return reply.notFound("Room not found");

  if (!room.isActive) return reply.forbidden("Room is inactive");
  if (room.pairingCodeUntil.getTime() < Date.now()) {
    const rotated = await rotateCodeByRoomNumber(roomNumber);
    return { roomNumber, pairingCode: rotated.pairingCode, expiresAt: rotated.pairingCodeUntil };
  }
  return { roomNumber, pairingCode: room.pairingCode, expiresAt: room.pairingCodeUntil };
});

app.post("/api/pair", async (req, reply) => {
  const parsed = pairSchema.safeParse(req.body);
  if (!parsed.success) return reply.badRequest(parsed.error.flatten());

  const room = await prisma.room.findFirst({
    where: {
      pairingCode: parsed.data.pairingCode,
      isActive: true,
      pairingCodeUntil: { gte: new Date() }
    }
  });

  if (!room) return reply.unauthorized("Invalid or expired pairing code");

  const session = await prisma.castSession.create({
    data: {
      guestDeviceId: parsed.data.guestDeviceId,
      guestSessionId: nanoid(16),
      roomId: room.id,
      expiresAt: new Date(Date.now() + sessionTtlMinutes * 60 * 1000)
    }
  });

  const proxyToken = app.jwt.sign(
    {
      sid: session.guestSessionId,
      gdid: parsed.data.guestDeviceId,
      roomNumber: room.roomNumber,
      scope: "cast:proxy"
    } satisfies GuestProxyJwtPayload,
    { expiresIn: `${sessionTtlMinutes}m` }
  );

  try {
    await fetch(`${castingProxyUrl}/api/proxy/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-proxy-secret": proxySharedSecret
      },
      body: JSON.stringify({
        guestSessionId: session.guestSessionId,
        roomNumber: room.roomNumber,
        chromecastIp: room.chromecastIp
      })
    });
  } catch (error) {
    req.log.warn({ error }, "Failed to register session with casting proxy");
  }

  return reply.code(201).send({
    message: "Pairing successful",
    guestSessionId: session.guestSessionId,
    guestDeviceId: session.guestDeviceId,
    proxyToken,
    roomNumber: room.roomNumber,
    chromecastIp: room.chromecastIp,
    expiresAt: session.expiresAt
  });
});

app.post("/api/rooms/:roomNumber/end-session", { preHandler: verifyAdmin }, async (req, reply) => {
  const roomNumber = (req.params as { roomNumber: string }).roomNumber;
  const room = await prisma.room.findUnique({ where: { roomNumber } });
  if (!room) return reply.notFound("Room not found");

  await prisma.castSession.updateMany({
    where: { roomId: room.id, status: "ACTIVE" },
    data: { status: "TERMINATED", endedAt: new Date() }
  });
  const rotated = await rotateCodeByRoomNumber(roomNumber);
  return {
    message: "Room session reset",
    roomNumber,
    newPairingCode: rotated.pairingCode,
    expiresAt: rotated.pairingCodeUntil
  };
});

app.get("/api/ops/active-sessions", { preHandler: verifyAdmin }, async () => {
  const sessions = await prisma.castSession.findMany({
    where: { status: "ACTIVE", expiresAt: { gt: new Date() } },
    include: { room: true },
    orderBy: { expiresAt: "asc" }
  });

  return sessions.map((session) => ({
    guestSessionId: session.guestSessionId,
    guestDeviceId: session.guestDeviceId,
    roomNumber: session.room.roomNumber,
    chromecastIp: session.room.chromecastIp,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt
  }));
});

app.get("/api/sessions/:guestSessionId", async (req, reply) => {
  const guestSessionId = (req.params as { guestSessionId: string }).guestSessionId;
  const session = await prisma.castSession.findUnique({
    where: { guestSessionId },
    include: { room: true }
  });
  if (!session) return reply.notFound("Session not found");

  if (session.status !== "ACTIVE" || session.expiresAt.getTime() < Date.now()) {
    return reply.unauthorized("Session expired or terminated");
  }

  return {
    guestSessionId,
    guestDeviceId: session.guestDeviceId,
    chromecastIp: session.room.chromecastIp,
    roomNumber: session.room.roomNumber
  };
});

app.get("/api/sessions/:guestSessionId/authorize-proxy", async (req, reply) => {
  const guestSessionId = (req.params as { guestSessionId: string }).guestSessionId;
  const parsed = proxyAuthorizeSchema.safeParse(req.query);
  if (!parsed.success) return reply.badRequest(parsed.error.flatten());

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) return reply.unauthorized("Missing proxy token");
  const token = authHeader.slice("Bearer ".length);

  let payload: GuestProxyJwtPayload;
  try {
    payload = app.jwt.verify<GuestProxyJwtPayload>(token);
  } catch {
    return reply.unauthorized("Invalid proxy token");
  }

  if (payload.scope !== "cast:proxy" || payload.sid !== guestSessionId || payload.gdid !== parsed.data.guestDeviceId) {
    return reply.forbidden("Proxy token/session mismatch");
  }

  const session = await prisma.castSession.findUnique({
    where: { guestSessionId },
    include: { room: true }
  });
  if (!session) return reply.notFound("Session not found");
  if (
    session.status !== "ACTIVE" ||
    session.expiresAt.getTime() < Date.now() ||
    session.guestDeviceId !== parsed.data.guestDeviceId
  ) {
    return reply.unauthorized("Session expired or invalid");
  }

  return {
    authorized: true,
    roomNumber: session.room.roomNumber,
    chromecastIp: session.room.chromecastIp
  };
});

setInterval(async () => {
  const now = new Date();
  await prisma.castSession.updateMany({
    where: { status: "ACTIVE", expiresAt: { lt: now } },
    data: { status: "EXPIRED", endedAt: now }
  });
}, cleanupIntervalSeconds * 1000);

app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
