/*
 * TORMONITOR AYAM — ESP32 Firmware (FIXED)
 *
 * Perbaikan dari versi sebelumnya:
 * 1. Retry DHT hingga 3x sebelum skip (fix pembacaan NaN di awal)
 * 2. Delay 2 detik setelah WiFi connect sebelum DHT mulai baca
 * 3. Debug Serial lebih lengkap (HTTP code, response body, error detail)
 * 4. V3 (ultrasonik) pakai random karena sensor rusak — mudah diganti nanti
 * 5. Tidak skip kirim jika hanya V3 yang gagal (sensor rusak tidak blokir DHT)
 *
 * Virtual Pin:
 * V1  = suhu        (DHT22, GPIO4)
 * V2  = kelembapan  (DHT22, GPIO4)
 * V3  = jarak_cm    (Ultrasonik, sementara RANDOM karena sensor rusak)
 * V10 = relay GPIO15
 * V11 = relay GPIO2
 * V12 = relay GPIO16
 * V13 = relay GPIO17
 * V14 = relay GPIO5
 * V15 = relay GPIO18
 * V16 = relay GPIO19
 *
 * Library yang dibutuhkan (install via Library Manager):
 * - DHT sensor library (Adafruit)
 * - Adafruit Unified Sensor
 * - ArduinoJson (Benoit Blanchon) v6+
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <DHT.h>

// ═══════════════════════════════════════════════════════════════
// KONFIGURASI — WAJIB DIISI
// ═══════════════════════════════════════════════════════════════

const char* WIFI_SSID = "DJASTIN";
const char* WIFI_PASS = "12345678";
const char* WORKER_URL = "https://tormonitorayam.vickycoba3.workers.dev";

// ── Pin Hardware ───────────────────────────────────────────────
#define DHT_PIN 4  // DHT22 data pin (GPIO4)
#define DHT_TYPE DHT22
#define ULTRA_PIN 14  // HC-SR04 single-pin (saat sensor normal)

// ── Relay 7 channel (active LOW) ──────────────────────────────
#define RELAY_COUNT 8
const int RELAY[RELAY_COUNT] = { 17, 5, 18, 19, 21, 3, 1, 22 };

// ── Interval ──────────────────────────────────────────────────
#define INTERVAL_SENSOR 5000  // kirim sensor tiap 5 detik
#define INTERVAL_POLL 2000    // polling saklar tiap 2 detik

// ── DHT Retry ─────────────────────────────────────────────────
#define DHT_RETRY_MAX 3      // max percobaan baca DHT
#define DHT_RETRY_DELAY 600  // jeda antar retry (ms) — DHT22 butuh min 500ms

// ═══════════════════════════════════════════════════════════════
// GLOBAL
// ═══════════════════════════════════════════════════════════════

DHT dht(DHT_PIN, DHT_TYPE);
unsigned long tSensor = 0, tPoll = 0;
bool relayState[RELAY_COUNT];

// ═══════════════════════════════════════════════════════════════
// SETUP
// ═══════════════════════════════════════════════════════════════

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("\n========================================");
  Serial.println("  TORMONITOR AYAM — ESP32 Booting...");
  Serial.println("========================================");

  // Init relay — semua OFF saat boot (active LOW → HIGH = OFF)
  for (int i = 0; i < RELAY_COUNT; i++) {
    pinMode(RELAY[i], OUTPUT);
    digitalWrite(RELAY[i], HIGH);
    relayState[i] = false;
  }
  Serial.println("[RELAY] Semua relay OFF (boot)");

  // Ultrasonik single-pin: default OUTPUT LOW
  pinMode(ULTRA_PIN, OUTPUT);
  digitalWrite(ULTRA_PIN, LOW);

  // Init DHT
  dht.begin();
  Serial.println("[DHT] Sensor diinisialisasi (GPIO4, DHT22)");

  // Koneksi WiFi
  Serial.printf("[WIFI] Menghubungkan ke: %s\n", WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  int attempt = 0;
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
    if (++attempt > 40) {
      Serial.println("\n[WIFI] Gagal konek setelah 20 detik, restart...");
      ESP.restart();
    }
  }
  Serial.printf("\n[WIFI] Terhubung! IP: %s\n", WiFi.localIP().toString().c_str());
  Serial.printf("[WIFI] Signal RSSI: %d dBm\n", WiFi.RSSI());

  // Tunggu 2 detik setelah konek — beri waktu DHT22 stabilisasi
  Serial.println("[DHT] Menunggu sensor stabilisasi (2 detik)...");
  delay(2000);

  Serial.println("[BOOT] Selesai. Mulai loop...\n");
}

// ═══════════════════════════════════════════════════════════════
// LOOP
// ═══════════════════════════════════════════════════════════════

void loop() {
  unsigned long now = millis();

  if (now - tSensor >= INTERVAL_SENSOR) {
    tSensor = now;
    kirimSensor();
  }

  if (now - tPoll >= INTERVAL_POLL) {
    tPoll = now;
    pollSaklar();
  }
}

// ═══════════════════════════════════════════════════════════════
// BACA DHT DENGAN RETRY
// Mengembalikan true jika berhasil, false jika gagal semua retry
// ═══════════════════════════════════════════════════════════════

bool bacaDHT(float& suhu, float& kelembapan) {
  for (int i = 1; i <= DHT_RETRY_MAX; i++) {
    suhu = dht.readTemperature();
    kelembapan = dht.readHumidity();

    if (!isnan(suhu) && !isnan(kelembapan)) {
      if (i > 1) {
        Serial.printf("[DHT] Berhasil baca pada percobaan ke-%d\n", i);
      }
      return true;
    }

    Serial.printf("[DHT] Percobaan %d/%d gagal (NaN). Tunggu %dms...\n",
                  i, DHT_RETRY_MAX, DHT_RETRY_DELAY);
    delay(DHT_RETRY_DELAY);
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════
// KIRIM SENSOR → POST /pins
// Body: { "V1": suhu, "V2": kelembapan, "V3": jarak_cm }
// ═══════════════════════════════════════════════════════════════

void kirimSensor() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[SENSOR] WiFi tidak terhubung, skip kirim.");
    reconnectWifi();
    return;
  }

  // Baca DHT dengan retry
  float suhu = NAN, kelembapan = NAN;
  if (!bacaDHT(suhu, kelembapan)) {
    Serial.println("[DHT] GAGAL baca setelah semua percobaan!");
    Serial.println("[DHT] Cek: kabel data GPIO4, resistor pull-up 10k, power 3.3V/5V");
    return;  // Jangan kirim jika DHT benar-benar gagal
  }

  Serial.printf("[DHT] Suhu=%.1f°C  Kelembapan=%.1f%%\n", suhu, kelembapan);

  float jarak = bacaUltrasonik();
  if (jarak < 0) {
    Serial.println("[ULTRA] Sensor timeout, skip kirim.");
    return;
  }
  Serial.printf("[ULTRA] Jarak=%.1f cm\n", jarak);

  // Buat JSON body
  StaticJsonDocument<128> doc;
  doc["V1"] = roundf(suhu * 10) / 10.0f;
  doc["V2"] = roundf(kelembapan * 10) / 10.0f;
  doc["V3"] = roundf(jarak * 10) / 10.0f;

  String body;
  serializeJson(doc, body);
  Serial.printf("[SENSOR] Mengirim: %s\n", body.c_str());

  // HTTP POST ke Worker
  HTTPClient http;
  String endpoint = String(WORKER_URL) + "/pins";
  http.begin(endpoint);
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(8000);

  int code = http.POST(body);

  if (code == 200 || code == 201) {
    String raw = http.getString();
    Serial.printf("[SENSOR] ✓ Sukses! HTTP %d\n", code);
    Serial.printf("[SENSOR] Response: %s\n", raw.c_str());

    // Parse response dan terapkan status relay
    StaticJsonDocument<256> res;
    DeserializationError err = deserializeJson(res, raw);
    if (err == DeserializationError::Ok) {
      if (res.containsKey("pins")) {
        terapkanPins(res["pins"].as<JsonObject>());
      }
    } else {
      Serial.printf("[SENSOR] Gagal parse response JSON: %s\n", err.c_str());
    }

  } else if (code < 0) {
    Serial.printf("[SENSOR] ✗ Gagal koneksi ke Worker! Error: %s\n",
                  http.errorToString(code).c_str());
    Serial.println("[SENSOR] Cek: URL Worker benar? Worker aktif?");

  } else {
    String errBody = http.getString();
    Serial.printf("[SENSOR] ✗ HTTP Error %d\n", code);
    Serial.printf("[SENSOR] Detail error: %s\n", errBody.c_str());
  }

  http.end();
}

// ═══════════════════════════════════════════════════════════════
// POLL SAKLAR → GET /pins
// ═══════════════════════════════════════════════════════════════

void pollSaklar() {
  if (WiFi.status() != WL_CONNECTED) return;

  HTTPClient http;
  http.begin(String(WORKER_URL) + "/pins");
  http.setTimeout(5000);
  int code = http.GET();

  if (code == 200) {
    String raw = http.getString();
    StaticJsonDocument<256> doc;
    if (deserializeJson(doc, raw) == DeserializationError::Ok) {
      terapkanPins(doc.as<JsonObject>());
    }
  } else if (code < 0) {
    // Silent fail saat poll — tidak spam Serial
  } else {
    Serial.printf("[POLL] HTTP Error %d\n", code);
  }

  http.end();
}

// ═══════════════════════════════════════════════════════════════
// TERAPKAN VIRTUAL PIN KE RELAY
// ═══════════════════════════════════════════════════════════════

void terapkanPins(JsonObject pins) {
  if (pins.isNull()) return;

  for (int i = 0; i < RELAY_COUNT; i++) {
    String key = "V" + String(10 + i);
    if (!pins.containsKey(key)) continue;

    bool nyala = (pins[key].as<int>() == 1);
    if (nyala != relayState[i]) {
      relayState[i] = nyala;
      digitalWrite(RELAY[i], nyala ? LOW : HIGH);  // active LOW
      Serial.printf("[RELAY] %s → GPIO%d %s\n",
                    key.c_str(), RELAY[i], nyala ? "ON ✓" : "OFF");
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// ULTRASONIK SINGLE-PIN (GPIO23) — Aktifkan jika sensor normal
// ═══════════════════════════════════════════════════════════════

float bacaUltrasonik() {
  // TRIG
  pinMode(ULTRA_PIN, OUTPUT);
  digitalWrite(ULTRA_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(ULTRA_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(ULTRA_PIN, LOW);

  // ECHO
  pinMode(ULTRA_PIN, INPUT);
  long dur = pulseIn(ULTRA_PIN, HIGH, 30000);

  if (dur == 0) {
    Serial.println("[ULTRA] Timeout — cek wiring GPIO14");
    return -1.0f;
  }

  float jarak = (dur * 0.0343f) / 2.0f;
  return jarak;
}

// ═══════════════════════════════════════════════════════════════
// RECONNECT WIFI
// ═══════════════════════════════════════════════════════════════

void reconnectWifi() {
  Serial.println("[WIFI] Putus, mencoba reconnect...");
  WiFi.disconnect();
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  int t = 0;
  while (WiFi.status() != WL_CONNECTED && t++ < 20) delay(500);
  if (WiFi.status() == WL_CONNECTED)
    Serial.printf("[WIFI] Reconnected! IP: %s\n", WiFi.localIP().toString().c_str());
  else
    Serial.println("[WIFI] Gagal reconnect.");
}
