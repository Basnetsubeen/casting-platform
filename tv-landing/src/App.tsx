import { useEffect, useMemo, useState } from "react";
import { QRCodeSVG } from "qrcode.react";

type PairingPayload = {
  roomNumber: string;
  pairingCode: string;
  expiresAt: string;
};

const ROOM_NUMBER = new URLSearchParams(window.location.search).get("room") ?? "101";
const API_BASE = import.meta.env.VITE_BACKEND_URL ?? "http://localhost:4000";
const CASTING_PROXY_BASE = import.meta.env.VITE_CASTING_PROXY_URL ?? "http://localhost:4100";
const PATHNAME = window.location.pathname;

function generateGuestDeviceId() {
  const cached = window.localStorage.getItem("guestDeviceId");
  if (cached) return cached;
  const newId = `${crypto.randomUUID()}`;
  window.localStorage.setItem("guestDeviceId", newId);
  return newId;
}

function PairPage() {
  const params = new URLSearchParams(window.location.search);
  const [roomNumber, setRoomNumber] = useState(params.get("room") ?? "");
  const [pairingCode, setPairingCode] = useState(params.get("code") ?? "");
  const [status, setStatus] = useState<string>("");

  const onPair = async () => {
    setStatus("Pairing in progress...");
    const guestDeviceId = generateGuestDeviceId();
    const pairRes = await fetch(`${API_BASE}/api/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairingCode, guestDeviceId })
    });
    const pairPayload = await pairRes.json();
    if (!pairRes.ok) {
      setStatus(pairPayload.message ?? "Pairing failed");
      return;
    }

    const discoveryRes = await fetch(`${CASTING_PROXY_BASE}/api/proxy/discovery/${pairPayload.guestSessionId}`, {
      headers: {
        Authorization: `Bearer ${pairPayload.proxyToken}`,
        "x-guest-device-id": guestDeviceId
      }
    });

    if (!discoveryRes.ok) {
      setStatus("Paired, but discovery authorization failed");
      return;
    }
    const discoveryPayload = await discoveryRes.json();
    setStatus(
      `Paired to Room ${discoveryPayload.roomNumber}. Chromecast target: ${discoveryPayload.chromecastIp}. You can cast now.`
    );
  };

  return (
    <div style={{ maxWidth: 460, margin: "0 auto", padding: 20, fontFamily: "Inter, Arial, sans-serif" }}>
      <h1>Pair This Device</h1>
      <p>Enter the room details shown on the TV.</p>
      <label style={{ display: "block", marginBottom: 10 }}>
        Room Number
        <input
          value={roomNumber}
          onChange={(e) => setRoomNumber(e.target.value)}
          style={{ display: "block", width: "100%", marginTop: 6, padding: 8 }}
        />
      </label>
      <label style={{ display: "block", marginBottom: 12 }}>
        Pairing Code
        <input
          value={pairingCode}
          onChange={(e) => setPairingCode(e.target.value)}
          style={{ display: "block", width: "100%", marginTop: 6, padding: 8 }}
        />
      </label>
      <button onClick={onPair} style={{ padding: "10px 14px" }}>
        Pair and Enable Cast
      </button>
      <p style={{ marginTop: 14 }}>{status}</p>
    </div>
  );
}

export function App() {
  if (PATHNAME.startsWith("/pair")) return <PairPage />;

  const [pairing, setPairing] = useState<PairingPayload | null>(null);

  useEffect(() => {
    const load = async () => {
      const res = await fetch(`${API_BASE}/api/rooms/${ROOM_NUMBER}/pairing-code`);
      const payload = await res.json();
      setPairing(payload);
    };
    load();
    const interval = setInterval(load, 30_000);
    return () => clearInterval(interval);
  }, []);

  const qrPayload = useMemo(() => {
    if (!pairing) return "";
    const query = new URLSearchParams({
      room: pairing.roomNumber,
      code: pairing.pairingCode
    }).toString();
    return `${window.location.origin}/pair?${query}`;
  }, [pairing]);

  return (
    <div
      style={{
        width: 1920,
        height: 1080,
        margin: "0 auto",
        display: "grid",
        placeItems: "center",
        background: "#0b1020",
        color: "#fff",
        fontFamily: "Inter, Arial, sans-serif"
      }}
    >
      <div style={{ textAlign: "center" }}>
        <h1>Welcome - Room {ROOM_NUMBER}</h1>
        <p>Scan QR with your phone to pair and cast.</p>
        <div style={{ margin: "20px auto", width: 260, background: "#fff", padding: 16, borderRadius: 12 }}>
          <QRCodeSVG value={qrPayload || "pending"} size={228} />
        </div>
        <h2 style={{ fontSize: 80, letterSpacing: 10 }}>{pairing?.pairingCode ?? "----"}</h2>
        <p>Use your remote D-pad to navigate menu and Cast button.</p>
      </div>
    </div>
  );
}
