/**
 * TORMONITOR AYAM — script.js (Supabase Integrated)
 * IoT Poultry Monitoring Dashboard
 */

"use strict";

const SUPABASE_URL = "https://gppdlvfxmecnheumjtat.supabase.co";
const SUPABASE_KEY = "sb_publishable_imMN2v1DCxlnfmmGO-q8eQ_aJi9j9p-";

// Perbaikan Error: Menggunakan nama variabel yang berbeda dari library global
const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

const state = {
  isOnline: false,
  suhu: 0,
  kelembapan: 0,
  stokPakan: 0,
  lampu: false,
  kipas: false,
  startTime: Date.now(),
};

const DOM = {
  badge:         document.getElementById("connection-badge"),
  statusLabel:   document.getElementById("status-label"),
  currentTime:   document.getElementById("current-time"),
  tickerText:    document.getElementById("ticker-text"),
  uptimeDisp:    document.getElementById("uptime-display"),
  tempValue:     document.getElementById("temp-value"),
  tempBar:       document.getElementById("temp-bar"),
  tempStatus:    document.getElementById("temp-status"),
  cardSuhu:      document.getElementById("card-suhu"),
  humidValue:    document.getElementById("humid-value"),
  humidBar:      document.getElementById("humid-bar"),
  humidStatus:   document.getElementById("humid-status"),
  cardHumid:     document.getElementById("card-humid"),
  feedValue:     document.getElementById("feed-value"),
  feedGauge:     document.getElementById("feed-gauge-fill"),
  feedLabel:     document.getElementById("feed-label"),
  feedStatus:    document.getElementById("feed-status"),
  cardFeed:      document.getElementById("card-feed"),
  btnLampu:      document.getElementById("btn-lampu"),
  stateLampu:    document.getElementById("state-lampu"),
  iconLampu:     document.getElementById("icon-lampu"),
  cardLampu:     document.getElementById("card-lampu"),
  btnKipas:      document.getElementById("btn-kipas"),
  stateKipas:    document.getElementById("state-kipas"),
  iconKipas:     document.getElementById("icon-kipas"),
  fanIconSvg:    document.getElementById("fan-icon-svg"),
  cardKipas:     document.getElementById("card-kipas"),
  activityLog:   document.getElementById("activity-log"),
  btnClearLog:   document.getElementById("btn-clear-log"),
};

async function fetchLatestData() {
  const { data, error } = await supabaseClient
    .from('tormonitor_ayam_logs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(1);

  if (error) {
    console.error("Error fetching logs:", error);
  } else if (data && data.length > 0) {
    updateMonitoringUI(data[0]);
    addLog(`Data terakhir berhasil disinkronkan.`, "system");
  }
}

async function fetchControlStatus() {
  const { data, error } = await supabaseClient
    .from('tormonitor_ayam_controls')
    .select('*');

  if (error) {
    console.error("Error fetching controls:", error);
  } else {
    data.forEach(item => {
      if (item.id === 'lampu') updateSwitchUI('lampu', item.status);
      if (item.id === 'kipas') updateSwitchUI('kipas', item.status);
    });
  }
}

async function updateDatabaseControl(id, status) {
  const { error } = await supabaseClient
    .from('tormonitor_ayam_controls')
    .update({ status: status })
    .eq('id', id);

  if (error) {
    addLog(`Gagal kontrol ${id}: ${error.message}`, "warn");
  }
}

function subscribeRealtime() {
  supabaseClient
    .channel('public:tormonitor_ayam_logs')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'tormonitor_ayam_logs' }, payload => {
      updateMonitoringUI(payload.new);
      addLog(`Update: Suhu=${payload.new.suhu}°C Pakan=${payload.new.stok_pakan}%`, "data");
    })
    .subscribe();

  supabaseClient
    .channel('public:tormonitor_ayam_controls')
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'tormonitor_ayam_controls' }, payload => {
      updateSwitchUI(payload.new.id, payload.new.status);
      addLog(`${payload.new.id.toUpperCase()} sekarang ${payload.new.status ? 'ON' : 'OFF'}`, "system");
    })
    .subscribe();
}

function updateMonitoringUI(data) {
  state.suhu = data.suhu;
  state.kelembapan = data.kelembapan;
  state.stokPakan = data.stok_pakan;
  DOM.tempValue.textContent = state.suhu.toFixed(1);
  DOM.tempBar.style.width = `${Math.min(100, (state.suhu / 50) * 100)}%`;
  const suhuStat = getSuhuStatus(state.suhu);
  DOM.tempStatus.textContent = suhuStat.text;
  applyAlertClass(DOM.cardSuhu, suhuStat.level);
  DOM.humidValue.textContent = state.kelembapan.toFixed(1);
  DOM.humidBar.style.width = `${state.kelembapan}%`;
  const humidStat = getHumidStatus(state.kelembapan);
  DOM.humidStatus.textContent = humidStat.text;
  applyAlertClass(DOM.cardHumid, humidStat.level);
  const feedPct = state.stokPakan;
  DOM.feedValue.textContent = feedPct.toFixed(0);
  const circumference = 314.16;
  DOM.feedGauge.style.strokeDashoffset = circumference - (feedPct / 100) * circumference;
  DOM.feedLabel.textContent = `${feedPct.toFixed(0)}%`;
  const feedStat = getFeedStatus(feedPct);
  DOM.feedStatus.textContent = feedStat.text;
  applyAlertClass(DOM.cardFeed, feedStat.level);
  DOM.tickerText.textContent = `Suhu: ${state.suhu}°C | Humid: ${state.kelembapan}% | Pakan: ${feedPct}%`;
}

function updateSwitchUI(id, status) {
  if (id === 'lampu') {
    state.lampu = status;
    DOM.btnLampu.checked = status;
    DOM.stateLampu.textContent = status ? "NYALA" : "MATI";
    DOM.iconLampu.classList.toggle("active", status);
    DOM.cardLampu.classList.toggle("is-active", status);
  } else if (id === 'kipas') {
    state.kipas = status;
    DOM.btnKipas.checked = status;
    DOM.stateKipas.textContent = status ? "NYALA" : "MATI";
    DOM.iconKipas.classList.toggle("active", status);
    DOM.cardKipas.classList.toggle("is-active", status);
    if (DOM.fanIconSvg) DOM.fanIconSvg.classList.toggle("fan-spinning", status);
  }
}

function addLog(message, type = "data") {
  const empty = DOM.activityLog.querySelector(".log-box__empty");
  if (empty) empty.remove(); 
  const timeStr = new Date().toTimeString().slice(0, 8);
  const typeMap = { ctrl: "[CTRL]", data: "[DATA]", warn: "[WARN]", system: "[SYS ]" };
  const entry = document.createElement("div");
  entry.className = "log-entry";
  entry.innerHTML = `<span class="log-entry__time">${timeStr}</span> <span class="log-entry__type log-entry__type--${type}">${typeMap[type] || "[INFO]"}</span> <span class="log-entry__msg">${message}</span>`;
  DOM.activityLog.prepend(entry);
}

function getSuhuStatus(v) {
  if (v < 24) return { text: "⬇️ Suhu rendah", level: "low" };
  if (v <= 30) return { text: "✅ Optimal", level: "ok" };
  return { text: "🔴 Suhu Panas!", level: "high" };
}

function getHumidStatus(v) {
  if (v <= 75) return { text: "✅ Ideal", level: "ok" };
  return { text: "⚠️ Lembap", level: "warn" };
}

function getFeedStatus(v) {
  if (v <= 15) return { text: "🔴 KRITIS!", level: "high" };
  return { text: "✅ Tersedia", level: "ok" };
}

function applyAlertClass(card, level) {
  card.classList.remove("monitor-card--alert-high", "monitor-card--alert-low");
  if (level === "high") card.classList.add("monitor-card--alert-high");
  if (level === "low" || level === "warn") card.classList.add("monitor-card--alert-low");
}

DOM.btnLampu.addEventListener("change", (e) => {
  updateDatabaseControl('lampu', e.target.checked);
  addLog(`Request Lampu ${e.target.checked ? 'ON' : 'OFF'}`, "ctrl");
});

DOM.btnKipas.addEventListener("change", (e) => {
  updateDatabaseControl('kipas', e.target.checked);
  addLog(`Request Kipas ${e.target.checked ? 'ON' : 'OFF'}`, "ctrl");
});

DOM.btnClearLog.addEventListener("click", () => {
  DOM.activityLog.innerHTML = '<p class="log-box__empty">Log dibersihkan...</p>';
});

async function init() {
  try {
    addLog("Inisialisasi sistem...", "system");
    await fetchLatestData();
    await fetchControlStatus();
    subscribeRealtime();
    setInterval(() => {
      DOM.currentTime.textContent = new Date().toTimeString().slice(0, 8);
      const elapsed = Math.floor((Date.now() - state.startTime) / 1000);
      const m = String(Math.floor(elapsed / 60)).padStart(2, "0");
      const s = String(elapsed % 60).padStart(2, "0");
      DOM.uptimeDisp.textContent = `Uptime: 00:${m}:${s}`;
    }, 1000);
    DOM.badge.classList.add("online");
    DOM.statusLabel.textContent = "Connected";
  } catch (err) {
    console.error("Init Error:", err);
    DOM.statusLabel.textContent = "Offline / Error";
  }
}

init();