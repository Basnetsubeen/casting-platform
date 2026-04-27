import AutoRefresh from "./AutoRefresh";

const backendUrl = process.env.BACKEND_URL ?? "http://backend:4000";
const adminUsername = process.env.ADMIN_USERNAME ?? "admin";
const adminPassword = process.env.ADMIN_PASSWORD ?? "admin123";

async function getAdminToken() {
  const loginRes = await fetch(`${backendUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify({ username: adminUsername, password: adminPassword })
  });
  if (!loginRes.ok) throw new Error("Failed to authenticate CMS admin");
  const payload = await loginRes.json();
  return payload.token as string;
}

async function endSession(roomNumber: string) {
  "use server";
  const token = await getAdminToken();
  await fetch(`${backendUrl}/api/rooms/${roomNumber}/end-session`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store"
  });
}

export default async function HomePage() {
  const token = await getAdminToken();
  const roomsRes = await fetch(`${backendUrl}/api/rooms`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store"
  });
  const sessionsRes = await fetch(`${backendUrl}/api/ops/active-sessions`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store"
  });
  const rooms = await roomsRes.json();
  const activeSessions = await sessionsRes.json();

  return (
    <main style={{ padding: 24, fontFamily: "Inter, Arial, sans-serif" }}>
      <AutoRefresh intervalMs={15000} />
      <h1>Hospitality TV CMS</h1>
      <p>Room management, pairing lifecycle, and menu administration shell.</p>
      <div style={{ marginTop: 24, display: "grid", gap: 12 }}>
        {rooms.map((room: any) => (
          <div key={room.id} style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12 }}>
            <p>
              <strong>Room:</strong> {room.roomNumber}
            </p>
            <p>
              <strong>Chromecast IP:</strong> {room.chromecastIp}
            </p>
            <form action={endSession.bind(null, room.roomNumber)}>
              <button type="submit">End Session (Checkout Reset)</button>
            </form>
          </div>
        ))}
      </div>

      <h2 style={{ marginTop: 36 }}>Live Cast Sessions</h2>
      <p>Cast-ready visibility for front desk and support teams.</p>
      <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
        {activeSessions.length === 0 ? (
          <div style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12 }}>No active cast sessions.</div>
        ) : (
          activeSessions.map((session: any) => (
            <div key={session.guestSessionId} style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12 }}>
              <p>
                <strong>Room:</strong> {session.roomNumber}
              </p>
              <p>
                <strong>Chromecast:</strong> {session.chromecastIp}
              </p>
              <p>
                <strong>Guest Session:</strong> {session.guestSessionId}
              </p>
              <p>
                <strong>Expires:</strong> {new Date(session.expiresAt).toLocaleString()}
              </p>
            </div>
          ))
        )}
      </div>
    </main>
  );
}
