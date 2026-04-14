/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║          W-Broadcaster-Bot  —  Production v2.0               ║
 * ║   Node.js + Baileys + Firebase Realtime Database             ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 *  ENV required: FIREBASE_URL
 *  Designed for 24/7 deployment on Render.com
 */

"use strict";

// ─── Core Imports ───────────────────────────────────────────────
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  isJidUser,
  makeInMemoryStore,
  Browsers,
} = require("@whiskeysockets/baileys");

const admin  = require("firebase-admin");
const fs     = require("fs");
const path   = require("path");
const http   = require("http");
const pino   = require("pino");
const qrcode = require("qrcode");
const { Boom } = require("@hapi/boom");

// ─── Anti-Crash Handlers ─────────────────────────────────────────
process.on("uncaughtException",  (err) => console.error("[CRASH] uncaughtException:", err));
process.on("unhandledRejection", (err) => console.error("[CRASH] unhandledRejection:", err));

// ─── Firebase Init ───────────────────────────────────────────────
const FIREBASE_URL = process.env.FIREBASE_URL;
if (!FIREBASE_URL) {
  console.error("[FATAL] FIREBASE_URL environment variable is not set.");
  process.exit(1);
}

admin.initializeApp({ databaseURL: FIREBASE_URL });
const db = admin.database();

// ─── Constants ───────────────────────────────────────────────────
const SESSIONS_DIR      = path.join(__dirname, "sessions");
const MSG_INTERVAL_MIN  = 15 * 60 * 1000;   // 15 minutes
const MSG_INTERVAL_MAX  = 20 * 60 * 1000;   // 20 minutes
const DAILY_LIMIT       = 35;
const PAIRING_RETRY_MAX = 5;
const PAIRING_RETRY_GAP = 8000;             // 8 s between retries
const RECONNECT_DELAY   = 5000;

// ─── Runtime state ───────────────────────────────────────────────
const activeSockets  = new Map();   // phoneNumber → socket
const msgTimers      = new Map();   // phoneNumber → timeout handle
const reconnectFlags = new Map();   // phoneNumber → boolean

// ─── Logger (silent for production, errors only) ─────────────────
const logger = pino({ level: "silent" });

// ════════════════════════════════════════════════════════════════
//   UTILITY HELPERS
// ════════════════════════════════════════════════════════════════

function sessionDir(phone) {
  return path.join(SESSIONS_DIR, `session_${phone}`);
}

function cleanSession(phone) {
  const dir = sessionDir(phone);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`[SESSION] Cleaned old session for ${phone}`);
  }
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function randomInterval() {
  return Math.floor(Math.random() * (MSG_INTERVAL_MAX - MSG_INTERVAL_MIN + 1)) + MSG_INTERVAL_MIN;
}

function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function jidFromPhone(phone) {
  // Normalise: strip +, spaces, dashes  → append @s.whatsapp.net
  const cleaned = phone.replace(/[^0-9]/g, "");
  return `${cleaned}@s.whatsapp.net`;
}

async function isValidWhatsApp(sock, phone) {
  try {
    const jid     = jidFromPhone(phone);
    const [result] = await sock.onWhatsApp(jid);
    return result?.exists === true;
  } catch {
    return false;
  }
}

// ════════════════════════════════════════════════════════════════
//   FIREBASE HELPERS
// ════════════════════════════════════════════════════════════════

async function fbSet(path_, data)   { await db.ref(path_).set(data); }
async function fbUpdate(path_, data){ await db.ref(path_).update(data); }
async function fbGet(path_)         { return (await db.ref(path_).once("value")).val(); }

async function updateDeviceStatus(phone, fields) {
  await fbUpdate(`devices/${phone}`, { ...fields, updatedAt: Date.now() });
}

async function getDailyCount(phone) {
  const key   = todayKey();
  const count = await fbGet(`sent_history/${phone}/${key}/count`);
  return count || 0;
}

async function incrementDailyCount(phone) {
  const key   = todayKey();
  const ref   = db.ref(`sent_history/${phone}/${key}/count`);
  const snap  = await ref.once("value");
  await ref.set((snap.val() || 0) + 1);
}

async function logSentMessage(phone, toNumber, status, template) {
  const key = `${Date.now()}_${toNumber}`;
  await fbSet(`sent_history/${phone}/messages/${key}`, {
    to: toNumber,
    status,
    template: template?.slice(0, 80) || "",
    sentAt: Date.now(),
  });
}

// ════════════════════════════════════════════════════════════════
//   MESSAGING LOOP
// ════════════════════════════════════════════════════════════════

async function sendMessages(phone, sock) {
  try {
    const dailyCount = await getDailyCount(phone);
    if (dailyCount >= DAILY_LIMIT) {
      console.log(`[MSG] ${phone} — daily limit (${DAILY_LIMIT}) reached.`);
      scheduleNextSend(phone, sock);
      return;
    }

    const template  = await fbGet("settings/messageTemplate");
    const numbersRaw = await fbGet("numbers");

    if (!template) {
      console.warn(`[MSG] No messageTemplate in settings.`);
      scheduleNextSend(phone, sock);
      return;
    }

    if (!numbersRaw) {
      console.warn(`[MSG] No numbers found in Firebase.`);
      scheduleNextSend(phone, sock);
      return;
    }

    const numbers = Array.isArray(numbersRaw)
      ? numbersRaw.filter(Boolean)
      : Object.values(numbersRaw).filter(Boolean);

    let sent = dailyCount;

    for (const num of numbers) {
      if (sent >= DAILY_LIMIT) break;

      const valid = await isValidWhatsApp(sock, num);
      if (!valid) {
        console.log(`[MSG] ${num} — skipped (not on WhatsApp)`);
        await logSentMessage(phone, num, "skipped_invalid", null);
        await fbUpdate(`numbers/${num}`, { status: "invalid", checkedAt: Date.now() });
        continue;
      }

      try {
        const jid = jidFromPhone(num);
        await sock.sendMessage(jid, { text: template });
        console.log(`[MSG] ✓ ${phone} → ${num}`);
        await logSentMessage(phone, num, "sent", template);
        await incrementDailyCount(phone);
        await fbUpdate(`numbers/${num}`, { lastSentAt: Date.now(), status: "sent" });
        sent++;

        // Small polite delay between each message (2–4 s)
        await new Promise(r => setTimeout(r, 2000 + Math.random() * 2000));
      } catch (err) {
        console.error(`[MSG] Failed to send to ${num}:`, err.message);
        await logSentMessage(phone, num, "failed", template);
      }
    }

    await updateDeviceStatus(phone, { lastSentAt: Date.now(), dailySentCount: sent });

  } catch (err) {
    console.error(`[MSG] sendMessages error for ${phone}:`, err.message);
  }

  scheduleNextSend(phone, sock);
}

function scheduleNextSend(phone, sock) {
  if (msgTimers.has(phone)) clearTimeout(msgTimers.get(phone));
  const delay = randomInterval();
  console.log(`[SCHED] ${phone} — next send in ${Math.round(delay / 60000)} min`);
  const t = setTimeout(() => sendMessages(phone, sock), delay);
  msgTimers.set(phone, t);
}

function cancelSendTimer(phone) {
  if (msgTimers.has(phone)) {
    clearTimeout(msgTimers.get(phone));
    msgTimers.delete(phone);
  }
}

// ════════════════════════════════════════════════════════════════
//   PAIRING CODE FLOW
// ════════════════════════════════════════════════════════════════

async function requestPairingCode(sock, phone) {
  for (let attempt = 1; attempt <= PAIRING_RETRY_MAX; attempt++) {
    try {
      await new Promise(r => setTimeout(r, PAIRING_RETRY_GAP));
      const code = await sock.requestPairingCode(phone.replace(/[^0-9]/g, ""));
      const formatted = code.match(/.{1,4}/g)?.join("-") || code;
      console.log(`[PAIR] ${phone} — code: ${formatted} (attempt ${attempt})`);
      await updateDeviceStatus(phone, {
        pairingCode: formatted,
        pairingRequestedAt: Date.now(),
        status: "awaiting_pairing",
      });
      return formatted;
    } catch (err) {
      console.warn(`[PAIR] Attempt ${attempt} failed for ${phone}: ${err.message}`);
      if (attempt === PAIRING_RETRY_MAX) throw err;
      await new Promise(r => setTimeout(r, PAIRING_RETRY_GAP * attempt));
    }
  }
}

// ════════════════════════════════════════════════════════════════
//   MAIN SOCKET FACTORY
// ════════════════════════════════════════════════════════════════

async function startDevice(phone, options = {}) {
  const { usePairing = false, cleanBefore = false } = options;

  if (cleanBefore) cleanSession(phone);

  const dir = sessionDir(phone);
  ensureDir(dir);

  const { state, saveCreds } = await useMultiFileAuthState(dir);
  const { version }          = await fetchLatestBaileysVersion();

  // Prevent zombie: close existing socket
  if (activeSockets.has(phone)) {
    try { activeSockets.get(phone).end(undefined); } catch {}
    activeSockets.delete(phone);
  }

  const sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,
    auth: state,
    browser: Browsers.ubuntu("Chrome"),
    connectTimeoutMs: 60_000,
    keepAliveIntervalMs: 25_000,
    retryRequestDelayMs: 250,
    maxMsgRetryCount: 5,
    fireInitQueries: true,
    shouldIgnoreJid: jid => !isJidUser(jid),
  });

  activeSockets.set(phone, sock);

  // ── QR Event ──
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // QR generated → save to Firebase
    if (qr && !usePairing) {
      try {
        const qrDataUrl = await qrcode.toDataURL(qr);
        await updateDeviceStatus(phone, {
          qr: qrDataUrl,
          status: "qr_ready",
          qrGeneratedAt: Date.now(),
        });
        console.log(`[QR] ${phone} — QR updated in Firebase`);
      } catch (err) {
        console.error(`[QR] Failed to encode QR for ${phone}:`, err.message);
      }
    }

    if (connection === "open") {
      console.log(`[CONN] ✓ ${phone} connected`);
      reconnectFlags.set(phone, false);
      await updateDeviceStatus(phone, {
        status: "connected",
        connectedAt: Date.now(),
        qr: null,
        pairingCode: null,
      });
      scheduleNextSend(phone, sock);
    }

    if (connection === "close") {
      cancelSendTimer(phone);
      activeSockets.delete(phone);

      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      console.warn(`[CONN] ${phone} closed — reason: ${reason}`);

      if (reason === DisconnectReason.loggedOut) {
        console.log(`[CONN] ${phone} logged out — cleaning session`);
        cleanSession(phone);
        await updateDeviceStatus(phone, { status: "logged_out" });
        return; // Don't reconnect logged-out sessions
      }

      if (reason === DisconnectReason.badSession) {
        console.log(`[CONN] ${phone} bad session — cleaning`);
        cleanSession(phone);
        await updateDeviceStatus(phone, { status: "bad_session" });
        return;
      }

      // All other cases: reconnect
      if (!reconnectFlags.get(phone)) {
        reconnectFlags.set(phone, true);
        await updateDeviceStatus(phone, { status: "reconnecting" });
        console.log(`[CONN] ${phone} reconnecting in ${RECONNECT_DELAY / 1000}s…`);
        setTimeout(() => startDevice(phone, { usePairing: false }), RECONNECT_DELAY);
      }
    }
  });

  // ── Credentials Persistence ──
  sock.ev.on("creds.update", saveCreds);

  // ── Request pairing code (if chosen over QR) ──
  if (usePairing && !sock.authState.creds.registered) {
    // Wait briefly for socket to stabilise before requesting
    setTimeout(() => requestPairingCode(sock, phone).catch(err => {
      console.error(`[PAIR] Final failure for ${phone}:`, err.message);
      updateDeviceStatus(phone, { status: "pairing_failed" });
    }), 3000);
  }

  return sock;
}

// ════════════════════════════════════════════════════════════════
//   BOT REQUESTS LISTENER
// ════════════════════════════════════════════════════════════════

function listenBotRequests() {
  const ref = db.ref("bot_requests");

  ref.on("child_added", async (snap) => {
    const reqId   = snap.key;
    const request = snap.val();
    if (!request || request.processed) return;

    const { phone, method } = request; // method: "qr" | "pairing"
    if (!phone) {
      await fbUpdate(`bot_requests/${reqId}`, { processed: true, error: "no phone" });
      return;
    }

    console.log(`[REQ] New bot_request: phone=${phone} method=${method || "qr"}`);

    // Mark as processing
    await fbUpdate(`bot_requests/${reqId}`, { processed: true, startedAt: Date.now() });
    await updateDeviceStatus(phone, { status: "initialising", method: method || "qr" });

    try {
      await startDevice(phone, {
        usePairing: method === "pairing",
        cleanBefore: true,
      });
    } catch (err) {
      console.error(`[REQ] Failed to start device ${phone}:`, err.message);
      await updateDeviceStatus(phone, { status: "error", error: err.message });
    }
  });

  console.log("[FB] Listening on bot_requests…");
}

// ════════════════════════════════════════════════════════════════
//   RESTORE CONNECTED DEVICES ON BOOT
// ════════════════════════════════════════════════════════════════

async function restoreDevices() {
  try {
    const devices = await fbGet("devices");
    if (!devices) return;

    for (const [phone, info] of Object.entries(devices)) {
      if (["connected", "reconnecting"].includes(info?.status)) {
        const sessDir = sessionDir(phone);
        if (fs.existsSync(sessDir)) {
          console.log(`[BOOT] Restoring session for ${phone}`);
          await startDevice(phone, { usePairing: false });
          // Stagger restores to avoid flooding
          await new Promise(r => setTimeout(r, 3000));
        }
      }
    }
  } catch (err) {
    console.error("[BOOT] restoreDevices error:", err.message);
  }
}

// ════════════════════════════════════════════════════════════════
//   HTTP KEEP-ALIVE SERVER  (prevents Render sleep)
// ════════════════════════════════════════════════════════════════

function startHttpServer() {
  const port = process.env.PORT || 3000;

  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status : "ok",
        uptime : process.uptime(),
        devices: activeSockets.size,
        time   : new Date().toISOString(),
      }));
    } else {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("W-Broadcaster-Bot is running ✓");
    }
  });

  server.listen(port, () => console.log(`[HTTP] Keep-alive server on port ${port}`));

  // Self-ping every 14 minutes to prevent cold starts on Render free tier
  const selfUrl = process.env.RENDER_EXTERNAL_URL;
  if (selfUrl) {
    setInterval(() => {
      http.get(`${selfUrl}/health`, (r) => {
        console.log(`[PING] Self-ping → ${r.statusCode}`);
      }).on("error", () => {});
    }, 14 * 60 * 1000);
  }
}

// ════════════════════════════════════════════════════════════════
//   BOOTSTRAP
// ════════════════════════════════════════════════════════════════

async function main() {
  console.log("╔══════════════════════════════════════╗");
  console.log("║   W-Broadcaster-Bot  v2.0 starting   ║");
  console.log("╚══════════════════════════════════════╝");

  ensureDir(SESSIONS_DIR);
  startHttpServer();
  await restoreDevices();
  listenBotRequests();

  console.log("[BOOT] Bot is fully operational.");
}

main().catch(err => {
  console.error("[FATAL] main() crashed:", err);
  process.exit(1);
});
