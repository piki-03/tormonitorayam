
// ── KONFIGURASI ────────────────────────────────────────────────
const SB_URL = "https://iypfmqutatzkaiuebnrb.supabase.co";

// ⚠️ GANTI DENGAN ANON KEY ASLI DARI:
// Supabase Dashboard → Project Settings → API → anon public
// Key asli berbentuk JWT panjang dimulai: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
const SB_KEY = "sb_publishable_1EB2aj89OPPBFpTc8f9vuw_5nzuIclm";

const CFG = {
  suhu:  { min: 24, max: 30 },
  humid: { max_ideal: 75 },
  pakan: { kosong: 5.0, penuh: 0.5, kritis: 15 },
};

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// ── ROUTER ─────────────────────────────────────────────────────
export default {
  async fetch(req) {
    const url    = new URL(req.url);
    const method = req.method;
    const path   = url.pathname;

    if (method === "OPTIONS") return resp(null, 204);

    try {
      if (path === "/pins" && method === "POST") return await sensorWrite(req);
      if (path === "/pins" && method === "GET")  return await allPinsRead();

      if (path.startsWith("/pin/")) {
        const pin = path.split("/")[2]?.toUpperCase();
        if (!pin?.match(/^V\d+$/)) return resp({ error: "Pin tidak valid" }, 400);
        if (method === "GET")  return await pinRead(pin);
        if (method === "POST") return await pinWrite(pin, req);
      }

      if (path === "/control") {
        if (method === "GET")  return await legacyControlRead();
        if (method === "POST") return await legacyControlWrite(req);
      }

      return resp({ error: "Not found" }, 404);
    } catch (e) {
      console.error("[Worker] Unhandled error:", e.message, e.stack);
      return resp({ error: e.message }, 500);
    }
  },
};

// ── POST /pins — Terima V1, V2, V3 dari ESP32 ─────────────────
async function sensorWrite(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return resp({ error: "Body bukan JSON valid" }, 400);
  }

  const suhu       = parseFloat(body.V1);
  const kelembapan = parseFloat(body.V2);
  const jarak_cm   = parseFloat(body.V3);

  // Validasi: V1 & V2 wajib ada dan valid. V3 boleh NaN (sensor rusak → stok_pakan = 0)
  if (isNaN(suhu) || isNaN(kelembapan)) {
    return resp({ error: "V1 (suhu) dan V2 (kelembapan) wajib ada dan berupa angka" }, 400);
  }

  // Hitung stok pakan dari jarak (jika V3 tidak valid, set 0)
  let stok_pakan = 0;
  if (!isNaN(jarak_cm)) {
    const { kosong, penuh } = CFG.pakan;
    stok_pakan = ((kosong - jarak_cm) / (kosong - penuh)) * 100;
    stok_pakan = +Math.min(100, Math.max(0, stok_pakan)).toFixed(2);
  }

  // INSERT hanya kolom yang ADA di schema SQL Anda
  // Jika Anda sudah jalankan ALTER TABLE (tambah jarak_cm, status_*),
  // uncomment bagian opsional di bawah
  const log = {
    suhu:       +suhu.toFixed(2),
    kelembapan: +kelembapan.toFixed(2),
    stok_pakan,
    // ── Uncomment jika sudah ALTER TABLE ──────────────────────
    // jarak_cm:          isNaN(jarak_cm) ? null : +jarak_cm.toFixed(2),
    // status_suhu:       suhu < CFG.suhu.min ? "rendah" : suhu <= CFG.suhu.max ? "optimal" : "panas",
    // status_kelembapan: kelembapan <= CFG.humid.max_ideal ? "ideal" : "lembap",
    // status_pakan:      stok_pakan <= CFG.pakan.kritis ? "kritis" : "tersedia",
  };

  console.log("[sensorWrite] Mencoba INSERT:", JSON.stringify(log));

  const r = await sb("/rest/v1/tormonitor_ayam_logs", "POST", log);

  if (!r.ok) {
    const detail = await r.text();
    console.error("[sensorWrite] Supabase INSERT gagal:", r.status, detail);
    return resp({ error: "Supabase insert gagal", sb_status: r.status, detail }, 502);
  }

  console.log("[sensorWrite] INSERT sukses. suhu=" + suhu + " humid=" + kelembapan);

  // Kirim balik status semua saklar ke ESP32
  const pins = await getPinsMap();
  return resp({
    ok: true,
    stok_pakan,
    status_suhu:       suhu < CFG.suhu.min ? "rendah" : suhu <= CFG.suhu.max ? "optimal" : "panas",
    status_kelembapan: kelembapan <= CFG.humid.max_ideal ? "ideal" : "lembap",
    status_pakan:      stok_pakan <= CFG.pakan.kritis ? "kritis" : "tersedia",
    pins,
  }, 201);
}

// ── GET /pins — Semua status saklar { V10:1, V11:0, ... } ─────
async function allPinsRead() {
  const pins = await getPinsMap();
  return resp(pins);
}

// ── GET /pin/Vxx ───────────────────────────────────────────────
async function pinRead(pin) {
  const num = parseInt(pin.slice(1));

  if (num >= 1 && num <= 9) {
    const r    = await sb("/rest/v1/tormonitor_ayam_logs?select=suhu,kelembapan,stok_pakan&order=created_at.desc&limit=1", "GET");
    const data = await r.json();
    if (!data.length) return resp({ pin, value: 0 });
    const map = { V1: data[0].suhu, V2: data[0].kelembapan, V3: data[0].stok_pakan };
    return resp({ pin, value: map[pin] ?? 0 });
  }

  const devs = await getControlsOrdered();
  const idx  = num - 10;
  if (!devs[idx]) return resp({ pin, value: 0, note: "Pin tidak ada perangkatnya" });
  return resp({ pin, value: devs[idx].status ? 1 : 0, id: devs[idx].id });
}

// ── POST /pin/Vxx — Toggle satu saklar ────────────────────────
async function pinWrite(pin, req) {
  let body;
  try { body = await req.json(); } catch { return resp({ error: "Body bukan JSON valid" }, 400); }

  const num = parseInt(pin.slice(1));
  if (num < 10) return resp({ error: "Pin sensor V1-V9 tidak bisa ditulis lewat /pin" }, 400);

  const devs = await getControlsOrdered();
  const idx  = num - 10;
  if (!devs[idx]) return resp({ error: `Tidak ada perangkat untuk ${pin}` }, 404);

  const status = body.value === 1 || body.value === true || body.value === "1";
  const r = await sb(
    `/rest/v1/tormonitor_ayam_controls?id=eq.${encodeURIComponent(devs[idx].id)}`,
    "PATCH",
    { status }
  );
  if (!r.ok) return resp({ error: "Gagal update" }, 502);
  return resp({ pin, value: status ? 1 : 0, id: devs[idx].id });
}

// ── Legacy GET /control ────────────────────────────────────────
async function legacyControlRead() {
  const devs   = await getControlsOrdered();
  const result = {};
  devs.forEach(d => { result[d.id] = d.status; });
  return resp(result);
}

// ── Legacy POST /control ───────────────────────────────────────
async function legacyControlWrite(req) {
  let body;
  try { body = await req.json(); } catch { return resp({ error: "Body bukan JSON valid" }, 400); }
  const { id, status } = body;
  const r = await sb(
    `/rest/v1/tormonitor_ayam_controls?id=eq.${encodeURIComponent(id)}`,
    "PATCH",
    { status }
  );
  if (!r.ok) return resp({ error: "Gagal update" }, 502);
  return resp({ ok: true, id, status });
}

// ── HELPERS ────────────────────────────────────────────────────

async function getControlsOrdered() {
  const r = await sb("/rest/v1/tormonitor_ayam_controls?select=id,status&order=id.asc", "GET");
  return r.ok ? await r.json() : [];
}

async function getPinsMap() {
  const devs = await getControlsOrdered();
  const pins = {};
  devs.forEach((d, i) => { pins[`V${10 + i}`] = d.status ? 1 : 0; });
  return pins;
}

async function sb(path, method, body = null) {
  return fetch(`${SB_URL}${path}`, {
    method,
    headers: {
      "Content-Type":  "application/json",
      "apikey":        SB_KEY,
      "Authorization": `Bearer ${SB_KEY}`,
      "Prefer":        method === "POST" ? "return=minimal" : "",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function resp(data, status = 200) {
  return new Response(data === null ? null : JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}
