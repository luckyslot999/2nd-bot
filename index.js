/**
 * ============================================================
 *  WhatsApp Bot — @whiskeysockets/baileys + Firebase RTDB
 *  Production-Ready | Pairing Code Fix | 24/7 Broadcast Worker
 * ============================================================
 *
 *  INSTALL DEPENDENCIES:
 *    npm install @whiskeysockets/baileys firebase-admin qrcode axios
 *
 *  ENV VARS REQUIRED:
 *    PORT                  — HTTP keep-alive port (e.g. 3000)
 *    FIREBASE_DATABASE_URL — e.g. https://your-app.firebaseio.com
 *    GOOGLE_APPLICATION_CREDENTIALS — path to serviceAccountKey.json
 *      OR set FIREBASE_SERVICE_ACCOUNT as a JSON string in env
 */

'use strict';

// ─── Core Imports ────────────────────────────────────────────
const http        = require('http');
const fs          = require('fs');
const path        = require('path');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  makeInMemoryStore,
}                 = require('@whiskeysockets/baileys');
const admin       = require('firebase-admin');
const { Boom }    = require('@hapi/boom');
const P           = require('pino');

// ─── Anti-Crash Handlers ─────────────────────────────────────
process.on('uncaughtException',  (err) => console.error('[CRASH GUARD] uncaughtException:', err));
process.on('unhandledRejection', (err) => console.error('[CRASH GUARD] unhandledRejection:', err));

// ─── Firebase Init ───────────────────────────────────────────
function initFirebase() {
  if (admin.apps.length) return; // already initialized

  let credential;
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    // Env var contains the raw JSON string of the service account
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    credential = admin.credential.cert(serviceAccount);
  } else {
    // Falls back to GOOGLE_APPLICATION_CREDENTIALS file path
    credential = admin.credential.applicationDefault();
  }

  admin.initializeApp({
    credential,
    databaseURL: process.env.FIREBASE_DATABASE_URL,
  });

  console.log('[Firebase] Initialized successfully.');
}

initFirebase();
const db = admin.database();

// ─── Helpers ─────────────────────────────────────────────────

/**
 * Sanitize a phone number to international format without '+'.
 * Converts Pakistani 03xx → 923xx, strips spaces, dashes, +.
 * @param {string} raw
 * @returns {string}
 */
function sanitizePhone(raw) {
  let num = String(raw).replace(/[^0-9]/g, ''); // digits only
  // Pakistani local format: 03xxxxxxxxx → 923xxxxxxxxx
  if (num.startsWith('0') && num.length === 11) {
    num = '92' + num.slice(1);
  }
  return num;
}

/**
 * Recursively delete a directory synchronously.
 * @param {string} dirPath
 */
function deleteDirSync(dirPath) {
  if (!fs.existsSync(dirPath)) return;
  fs.rmSync(dirPath, { recursive: true, force: true });
  console.log(`[Session] Deleted: ${dirPath}`);
}

/**
 * Sleep for ms milliseconds.
 * @param {number} ms
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Build a QR image URL from a string using api.qrserver.com.
 * @param {string} data
 * @returns {string}
 */
function buildQRUrl(data) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(data)}`;
}

// ─── Active Sessions Map ──────────────────────────────────────
// Tracks active socket instances keyed by phone number
const activeSessions = new Map();

// ─── Session Directory Helper ─────────────────────────────────
function sessionDir(phoneNumber) {
  return path.join(__dirname, `sessions_${phoneNumber}`);
}

// ═══════════════════════════════════════════════════════════════
//  CORE: Start a WhatsApp connection for a given phone number
// ═══════════════════════════════════════════════════════════════
async function startConnection(phoneNumber, requestData = {}) {
  const phone   = sanitizePhone(phoneNumber);
  const sessDir = sessionDir(phone);

  console.log(`\n[Bot] Starting connection for: ${phone}`);

  // ── STEP 1: Wipe old dirty session ───────────────────────────
  deleteDirSync(sessDir);
  console.log(`[Session] Clean slate for ${phone}`);

  // ── STEP 2: Auth state setup ──────────────────────────────────
  const { state, saveCreds } = await useMultiFileAuthState(sessDir);

  // ── STEP 3: Fetch latest Baileys WA version ───────────────────
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`[Baileys] Using WA v${version.join('.')} — Latest: ${isLatest}`);

  // ── STEP 4: Create socket ─────────────────────────────────────
  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys : makeCacheableSignalKeyStore(state.keys, P({ level: 'silent' })),
    },
    // ▶ Ubuntu/Chrome browser fingerprint prevents WA from rejecting pairing
    browser           : Browsers.ubuntu('Chrome'),
    printQRInTerminal : false,       // we handle QR ourselves
    logger            : P({ level: 'silent' }), // silence noisy logs
    syncFullHistory   : false,
    markOnlineOnConnect: true,
    connectTimeoutMs  : 60_000,
    defaultQueryTimeoutMs: 60_000,
    keepAliveIntervalMs: 25_000,
    retryRequestDelayMs: 2_000,
  });

  // Store reference so broadcast worker can use it
  activeSessions.set(phone, sock);

  // ── STEP 5: Wait for WS to stabilize BEFORE requesting pairing ─
  //    This is the critical fix for "Couldn't link device"
  const PAIRING_DELAY_MS = 4000; // 4 seconds — safe window
  console.log(`[Pairing] Waiting ${PAIRING_DELAY_MS}ms for connection to stabilize…`);
  await sleep(PAIRING_DELAY_MS);

  // ── STEP 6: Request Pairing Code (if not already registered) ──
  let pairingCode = null;
  if (!sock.authState.creds.registered) {
    try {
      pairingCode = await sock.requestPairingCode(phone);
      pairingCode = pairingCode?.match(/.{1,4}/g)?.join('-') ?? pairingCode; // format: XXXX-XXXX
      console.log(`[Pairing] Code for ${phone}: ${pairingCode}`);
    } catch (err) {
      console.error(`[Pairing] Failed to get pairing code for ${phone}:`, err.message);
    }
  }

  // ── STEP 7: Generate QR code URL (using a temp QR data string) ─
  //    We use the phone number as the QR payload placeholder; in real
  //    Baileys flow the QR event provides the actual scan string.
  let qrUrl = null;

  // ── STEP 8: Listen for QR event (for qr-based flow) ──────────
  sock.ev.on('connection.update', async (update) => {
    const { qr } = update;
    if (qr) {
      qrUrl = buildQRUrl(qr);
      console.log(`[QR] Generated QR URL for ${phone}`);

      // Save BOTH pairing code + QR to Firebase simultaneously
      await db.ref(`bot_requests/${phone}`).update({
        pairing_code : pairingCode,
        qr_url       : qrUrl,
        status       : 'code_ready',
        updated_at   : Date.now(),
      });
    }
  });

  // Save pairing code to Firebase right away (even before QR appears)
  if (pairingCode) {
    await db.ref(`bot_requests/${phone}`).update({
      pairing_code : pairingCode,
      status       : 'code_ready',
      updated_at   : Date.now(),
    });
  }

  // ── STEP 9: Main connection event handler ──────────────────────
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    // ── CONNECTED ────────────────────────────────────────────────
    if (connection === 'open') {
      const botNumber = sock.user?.id?.split(':')[0] ?? phone;
      console.log(`[Bot] ✅ Connected: ${botNumber}`);

      // Remove from bot_requests (request fulfilled)
      await db.ref(`bot_requests/${phone}`).remove();

      // Save device record
      await db.ref(`devices/${phone}`).set({
        status     : 'connected',
        phone      : botNumber,
        connected_at: Date.now(),
      });

      // Start broadcast worker after 5-second grace period
      console.log(`[Broadcast] Starting worker for ${phone} in 5s…`);
      await sleep(5000);
      startBroadcastWorker(phone, sock);
    }

    // ── DISCONNECTED ──────────────────────────────────────────────
    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output?.statusCode
        : null;

      console.warn(`[Bot] ⚠️ Disconnected for ${phone} — Code: ${statusCode}`);

      const fatalCodes = [
        DisconnectReason.loggedOut,          // 401
        DisconnectReason.badSession,         // 500
        DisconnectReason.connectionReplaced, // 440
      ];

      const isFatal = fatalCodes.includes(statusCode);

      if (isFatal) {
        // ── Fatal: wipe session, mark device disconnected ────────
        console.error(`[Bot] 🔴 Fatal disconnect for ${phone}. Wiping session.`);
        activeSessions.delete(phone);
        deleteDirSync(sessionDir(phone));

        await db.ref(`devices/${phone}`).update({
          status       : 'disconnected',
          disconnected_at: Date.now(),
          error_code   : statusCode,
        });
      } else {
        // ── Non-fatal: attempt reconnect ─────────────────────────
        console.log(`[Bot] 🔄 Reconnecting for ${phone} in 5s…`);
        await sleep(5000);
        startConnection(phone);
      }
    }
  });

  // ── STEP 10: Save credentials on update ───────────────────────
  sock.ev.on('creds.update', saveCreds);

  return sock;
}

// ═══════════════════════════════════════════════════════════════
//  BROADCAST WORKER — Sends messages 24/7 with 20-min intervals
// ═══════════════════════════════════════════════════════════════
async function startBroadcastWorker(phone, sock) {
  console.log(`[Broadcast] Worker started for ${phone}`);

  // Recursive async loop — runs forever
  async function runLoop() {
    try {
      // ── Fetch message template from settings ──────────────────
      const settingsSnap = await db.ref('settings').once('value');
      const settings     = settingsSnap.val() ?? {};
      const template     = settings.message_template ?? 'Hello! This is a broadcast message.';

      // ── Fetch pending numbers ─────────────────────────────────
      const numbersSnap = await db.ref('numbers').orderByChild('status').equalTo('pending').once('value');
      const numbersData = numbersSnap.val();

      if (!numbersData) {
        // No pending numbers — reset all to pending and loop again
        console.log(`[Broadcast] No pending numbers. Resetting all to pending…`);
        await resetAllNumbersToPending();
        // Small delay before re-looping to avoid hammering Firebase
        await sleep(10_000);
        runLoop();
        return;
      }

      const entries = Object.entries(numbersData); // [[key, {number, status}], ...]

      console.log(`[Broadcast] Found ${entries.length} pending number(s) for ${phone}`);

      // ── Send to each number one by one with 20-min intervals ──
      for (const [key, record] of entries) {
        // Safety check: is socket still alive?
        if (!activeSessions.has(phone)) {
          console.warn(`[Broadcast] Socket gone for ${phone}. Stopping worker.`);
          return;
        }

        const targetNumber = sanitizePhone(record.number ?? record.phone ?? key);
        const jid          = `${targetNumber}@s.whatsapp.net`;

        // Personalize message if template supports it
        const message = template
          .replace(/\{name\}/gi,   record.name   ?? '')
          .replace(/\{number\}/gi, targetNumber);

        try {
          await sock.sendMessage(jid, { text: message });
          console.log(`[Broadcast] ✅ Sent to ${targetNumber}`);

          // Mark number as sent in Firebase
          await db.ref(`numbers/${key}`).update({
            status  : 'sent',
            sent_at : Date.now(),
            sent_by : phone,
          });
        } catch (sendErr) {
          console.error(`[Broadcast] ❌ Failed to send to ${targetNumber}:`, sendErr.message);
          // Mark as failed but continue with others
          await db.ref(`numbers/${key}`).update({
            status  : 'failed',
            error   : sendErr.message,
            failed_at: Date.now(),
          });
        }

        // ── 20-minute wait before next message ────────────────────
        const INTERVAL_MS = 20 * 60 * 1000; // 20 minutes
        console.log(`[Broadcast] ⏳ Waiting 20 minutes before next message…`);
        await sleep(INTERVAL_MS);
      }

      // All numbers processed — loop back immediately (reset handled at top)
      console.log(`[Broadcast] All numbers processed. Looping…`);
      runLoop();

    } catch (err) {
      console.error(`[Broadcast] Worker error for ${phone}:`, err.message);
      // Wait 30 seconds then retry
      await sleep(30_000);
      runLoop();
    }
  }

  runLoop(); // kick off
}

/**
 * Reset all numbers back to 'pending' so the broadcast loop continues forever.
 */
async function resetAllNumbersToPending() {
  const snap = await db.ref('numbers').once('value');
  const data = snap.val();
  if (!data) return;

  const updates = {};
  for (const key of Object.keys(data)) {
    updates[`numbers/${key}/status`] = 'pending';
    updates[`numbers/${key}/reset_at`] = Date.now();
  }
  await db.ref().update(updates);
  console.log('[Broadcast] All numbers reset to pending.');
}

// ═══════════════════════════════════════════════════════════════
//  FIREBASE POLLER — Checks for new pairing/QR requests
// ═══════════════════════════════════════════════════════════════
async function pollFirebase() {
  try {
    const snap = await db.ref('bot_requests').once('value');
    const requests = snap.val();

    if (!requests) return;

    for (const [phone, data] of Object.entries(requests)) {
      const action = data?.action;

      // Only handle new, unprocessed requests
      if (action !== 'generate_code' && action !== 'generate_qr') continue;
      if (data?.status === 'code_ready' || data?.status === 'processing') continue;

      console.log(`[Poller] New request — Phone: ${phone}, Action: ${action}`);

      // Mark as processing immediately to prevent duplicate handling
      await db.ref(`bot_requests/${phone}`).update({
        status    : 'processing',
        updated_at: Date.now(),
      });

      // Don't await — let each connection run independently
      startConnection(phone, data).catch((err) => {
        console.error(`[Poller] startConnection failed for ${phone}:`, err.message);
        db.ref(`bot_requests/${phone}`).update({ status: 'error', error: err.message });
      });
    }
  } catch (err) {
    console.error('[Poller] Firebase poll error:', err.message);
  }
}

// Start polling every 4 seconds
const POLL_INTERVAL_MS = 4000;
setInterval(pollFirebase, POLL_INTERVAL_MS);
console.log(`[Poller] Firebase polling started (every ${POLL_INTERVAL_MS}ms)`);

// ── Also reconnect already-connected devices on server restart ─
async function reconnectExistingDevices() {
  try {
    const snap = await db.ref('devices').orderByChild('status').equalTo('connected').once('value');
    const devices = snap.val();
    if (!devices) return;

    for (const phone of Object.keys(devices)) {
      const sessDir = sessionDir(phone);
      if (fs.existsSync(sessDir)) {
        console.log(`[Boot] Reconnecting existing device: ${phone}`);
        startConnection(phone).catch(console.error);
        await sleep(3000); // stagger reconnects
      }
    }
  } catch (err) {
    console.error('[Boot] Could not reconnect existing devices:', err.message);
  }
}

reconnectExistingDevices();

// ═══════════════════════════════════════════════════════════════
//  HTTP KEEP-ALIVE SERVER (for Render / Railway / Heroku etc.)
// ═══════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;

http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status   : 'running',
    sessions : activeSessions.size,
    uptime   : process.uptime(),
    timestamp: new Date().toISOString(),
  }));
}).listen(PORT, () => {
  console.log(`[Server] HTTP keep-alive listening on port ${PORT}`);
});

// ═══════════════════════════════════════════════════════════════
//  FIREBASE DATABASE STRUCTURE (reference)
// ═══════════════════════════════════════════════════════════════
/*
  bot_requests/
    <phoneNumber>/
      action    : "generate_code" | "generate_qr"
      status    : "pending" | "processing" | "code_ready" | "error"
      pairing_code: "XXXX-XXXX"        ← written by bot
      qr_url    : "https://..."        ← written by bot
      updated_at: 1700000000000

  devices/
    <phoneNumber>/
      status      : "connected" | "disconnected"
      phone       : "923001234567"
      connected_at: 1700000000000

  numbers/
    <key>/
      number  : "923001234567"
      name    : "John"          (optional)
      status  : "pending" | "sent" | "failed"
      sent_at : 1700000000000   (written by bot)

  settings/
    message_template: "Hello {name}! This is your message."
*/
