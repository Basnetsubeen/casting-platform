import Fastify from "fastify";
import mdns from "multicast-dns";

const app = Fastify({ logger: true });
const m = mdns();
const backendUrl = process.env.BACKEND_URL ?? "http://backend:4000";
const proxySharedSecret = process.env.PROXY_SHARED_SECRET ?? "proxy-secret";

type Mapping = {
  roomNumber: string;
  chromecastIp: string;
};

const guestToRoom = new Map<string, Mapping>();

app.post("/api/proxy/register", async (req, reply) => {
  const callerSecret = req.headers["x-proxy-secret"];
  if (callerSecret !== proxySharedSecret) return reply.code(401).send({ error: "Unauthorized proxy registration" });
  const body = req.body as { guestSessionId: string; roomNumber: string; chromecastIp: string };
  guestToRoom.set(body.guestSessionId, { roomNumber: body.roomNumber, chromecastIp: body.chromecastIp });
  return { ok: true };
});

app.get("/api/proxy/discovery/:guestSessionId", async (req, reply) => {
  const guestSessionId = (req.params as { guestSessionId: string }).guestSessionId;
  const mapping = guestToRoom.get(guestSessionId);
  if (!mapping) return reply.code(404).send({ error: "No room mapping for session" });

  const guestDeviceId = req.headers["x-guest-device-id"];
  const authHeader = req.headers.authorization;
  if (typeof guestDeviceId !== "string" || !authHeader) {
    return reply.code(401).send({ error: "Missing guest device or token" });
  }

  const authRes = await fetch(
    `${backendUrl}/api/sessions/${guestSessionId}/authorize-proxy?guestDeviceId=${encodeURIComponent(guestDeviceId)}`,
    {
      headers: { Authorization: authHeader }
    }
  );
  if (!authRes.ok) return reply.code(401).send({ error: "Session token not valid for discovery" });

  return { roomNumber: mapping.roomNumber, chromecastIp: mapping.chromecastIp };
});

// Minimal responder: only answers for registered mapping hostname queries.
m.on("query", (query) => {
  query.questions.forEach((q) => {
    if (q.type !== "A") return;
    guestToRoom.forEach((mapping, guestSessionId) => {
      const expectedName = `chromecast-${mapping.roomNumber}.local`;
      if (q.name === expectedName) {
        m.respond({
          answers: [
            {
              name: expectedName,
              type: "A",
              ttl: 120,
              data: mapping.chromecastIp
            }
          ],
          additionals: [
            {
              name: `session-${guestSessionId}.local`,
              type: "TXT",
              ttl: 120,
              data: Buffer.from(mapping.roomNumber)
            }
          ]
        });
      }
    });
  });
});

app.listen({ port: 4100, host: "0.0.0.0" });
