/*
 * TORMONITOR AYAM — Cloudflare Worker
 * Handles: sensor ingestion, calculation, control relay
 */

const SUPABASE_URL = "https://gppdlvfxmecnheumjtat.supabase.co";
const SUPABASE_KEY = "sb_publishable_imMN2v1DCxlnfmmGO-q8eQ_aJi9j9p-";

// Konfigurasi perhitungan sensor
const CONFIG = {
  suhu: {
    min_optimal: 24,
    max_optimal: 30,
  },
  kelembapan: {
    max_ideal: 75,
  },
  pakan: {
    jarak_kosong: 30.0,  // cm = 0%
    jarak_penuh:   5.0,  // cm = 100%
    kritis: 15,          // % threshold
  },
};

// ============================================================
// ROUTER UTAMA
// ============================================================

export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const method = request.method;

    // CORS headers
    const cors = {
      "Access-Control-Allow-Origin":  "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Device-Key",
    };

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      // POST /sensor  — ESP32 kirim data mentah
      if (url.pathname === "/sensor" && method === "POST") {
        return await handleSensor(request, env, cors);
      }

      // GET /control  — ESP32 polling status lampu & kipas
      if (url.pathname === "/control" && method === "GET") {
        return await handleControl(request, env, cors);
      }

      // POST /control — Dashboard web update status
      if (url.pathname === "/control" && method === "POST") {
        return await handleControlUpdate(request, env, cors);
      }

      return jsonResponse({ error: "Not found" }, 404, cors);

    } catch (err) {
      return jsonResponse({ error: err.message }, 500, cors);
    }
  },
};

// ============================================================
// HANDLER: ESP32 kirim data sensor mentah
// POST /sensor
// Body: { "suhu": 29.5, "kelembapan": 68.2, "jarak_cm": 12.3 }
// ============================================================

async function handleSensor(request, env, cors) {
  const body = await request.json();

  const { suhu, kelembapan, jarak_cm } = body;

  // Validasi input
  if (suhu === undefined || kelembapan === undefined || jarak_cm === undefined) {
    return jsonResponse({ error: "Field suhu, kelembapan, jarak_cm wajib diisi" }, 400, cors);
  }

  // ── Kalkulasi stok pakan dari jarak ultrasonik ──
  const { jarak_kosong, jarak_penuh } = CONFIG.pakan;
  let stok_pakan = ((jarak_kosong - jarak_cm) / (jarak_kosong - jarak_penuh)) * 100;
  stok_pakan = Math.min(100, Math.max(0, stok_pakan));
  stok_pakan = Math.round(stok_pakan * 100) / 100;

  // ── Status suhu ──
  let status_suhu;
  if (suhu < CONFIG.suhu.min_optimal)       status_suhu = "rendah";
  else if (suhu <= CONFIG.suhu.max_optimal)  status_suhu = "optimal";
  else                                        status_suhu = "panas";

  // ── Status kelembapan ──
  const status_kelembapan = kelembapan <= CONFIG.kelembapan.max_ideal ? "ideal" : "lembap";

  // ── Status pakan ──
  const status_pakan = stok_pakan <= CONFIG.pakan.kritis ? "kritis" : "tersedia";

  // ── Simpan ke Supabase ──
  const payload = {
    suhu:              Math.round(suhu * 100) / 100,
    kelembapan:        Math.round(kelembapan * 100) / 100,
    jarak_cm:          Math.round(jarak_cm * 100) / 100,
    stok_pakan,
    status_suhu,
    status_kelembapan,
    status_pakan,
  };

  const res = await supabaseFetch(
    "/rest/v1/tormonitor_ayam_logs",
    "POST",
    payload
  );

  if (!res.ok) {
    const err = await res.text();
    return jsonResponse({ error: "Supabase error", detail: err }, 502, cors);
  }

  return jsonResponse({
    success: true,
    kalkulasi: {
      stok_pakan,
      status_suhu,
      status_kelembapan,
      status_pakan,
    },
  }, 201, cors);
}

// ============================================================
// HANDLER: ESP32 polling status kontrol
// GET /control
// Response: { "lampu": true, "kipas": false }
// ============================================================

async function handleControl(request, env, cors) {
  const res = await supabaseFetch(
    "/rest/v1/tormonitor_ayam_controls?select=id,status",
    "GET"
  );

  if (!res.ok) {
    return jsonResponse({ error: "Gagal ambil data kontrol" }, 502, cors);
  }

  const data = await res.json();

  const result = { lampu: false, kipas: false };
  data.forEach(item => {
    if (item.id === "lampu") result.lampu = item.status;
    if (item.id === "kipas") result.kipas = item.status;
  });

  return jsonResponse(result, 200, cors);
}

// ============================================================
// HANDLER: Dashboard update status kontrol
// POST /control
// Body: { "id": "lampu", "status": true }
// ============================================================

async function handleControlUpdate(request, env, cors) {
  const { id, status } = await request.json();

  if (!["lampu", "kipas"].includes(id)) {
    return jsonResponse({ error: "id harus 'lampu' atau 'kipas'" }, 400, cors);
  }

  const res = await supabaseFetch(
    `/rest/v1/tormonitor_ayam_controls?id=eq.${id}`,
    "PATCH",
    { status }
  );

  if (!res.ok) {
    return jsonResponse({ error: "Gagal update kontrol" }, 502, cors);
  }

  return jsonResponse({ success: true, id, status }, 200, cors);
}

// ============================================================
// HELPER: Supabase REST call
// ============================================================

async function supabaseFetch(path, method, body = null) {
  const headers = {
    "Content-Type":  "application/json",
    "apikey":        SUPABASE_KEY,
    "Authorization": `Bearer ${SUPABASE_KEY}`,
    "Prefer":        "return=minimal",
  };

  return fetch(`${SUPABASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

// ============================================================
// HELPER: JSON Response
// ============================================================

function jsonResponse(data, status = 200, cors = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}
