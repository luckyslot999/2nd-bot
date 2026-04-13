require('dotenv').config();
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    Browsers
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const http = require('http');

// ==========================================
// 🛡️ ANTI-CRASH
// ==========================================
process.on('uncaughtException', (err) => console.error('🛡️ [ANTI-CRASH]', err.message));
process.on('unhandledRejection', (reason) => console.error('🛡️ [UNHANDLED]', reason));

const FIREBASE_URL = process.env.FIREBASE_URL?.replace(/\/$/, "");
const activeSockets = new Map();

// ==========================================
// 🌐 HTTP SERVER (UPTIME)
// ==========================================
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Botzmine Bot Running 🚀');
}).listen(PORT, () => console.log(`🌐 Server on port ${PORT}`));

// ==========================================
// 🛠️ FIREBASE HELPERS
// ==========================================
const delay = (ms) => new Promise(r => setTimeout(r, ms));

async function fbGet(path) {
    try {
        const res = await fetch(`${FIREBASE_URL}/${path}.json`);
        return await res.json();
    } catch (e) { return null; }
}

async function fbPatch(path, data) {
    try {
        await fetch(`${FIREBASE_URL}/${path}.json`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
    } catch (e) { console.error("fbPatch Error:", e.message); }
}

async function fbDelete(path) {
    try {
        await fetch(`${FIREBASE_URL}/${path}.json`, { method: 'DELETE' });
    } catch (e) { console.error("fbDelete Error:", e.message); }
}

// ==========================================
// 📞 PHONE FORMATTER
// ==========================================
function formatPhone(raw) {
    let num = raw.toString().replace(/\D/g, '');
    if (num.startsWith('03') && num.length === 11) return '92' + num.substring(1);
    if (num.startsWith('3') && num.length === 10) return '92' + num;
    if (num.startsWith('92') && num.length === 12) return num;
    return num;
}

// ==========================================
// ⚙️ SETTINGS
// ==========================================
async function getSettings() {
    const data = await fbGet('settings');
    return {
        messageTemplate: data?.messageTemplate || "Hello from Botzmine!",
        delayMinutes: 20
    };
}

// ==========================================
// 🔄 NUMBER LOOP
// ==========================================
async function getNextPendingNumber() {
    const numbers = await fbGet('numbers');
    if (!numbers) return null;
    for (const phone in numbers) {
        if (!numbers[phone].status || numbers[phone].status === 'pending') return phone;
    }
    console.log('♻️ [AUTO-LOOP] Resetting all numbers...');
    const updates = {};
    for (const phone in numbers) updates[phone] = { status: 'pending', sentBy: null };
    await fbPatch('numbers', updates);
    return getNextPendingNumber();
}

// ==========================================
// 🚀 BROADCAST WORKER
// ==========================================
async function startBroadcastWorker(sock, deviceId) {
    const run = async () => {
        try {
            if (!activeSockets.has(deviceId)) return;
            const settings = await getSettings();
            const rawPhone = await getNextPendingNumber();
            if (!rawPhone) { setTimeout(run, 30000); return; }

            const phone = rawPhone.replace(/\D/g, '');
            const jid = `${phone}@s.whatsapp.net`;

            console.log(`[${deviceId}] ✍️ Sending to ${phone}...`);
            await sock.sendPresenceUpdate('composing', jid);
            await delay(Math.random() * 5000 + 3000);
            await sock.sendMessage(jid, { text: settings.messageTemplate });

            const timestamp = new Date().toISOString();
            const stats = await fbGet(`devices/${deviceId}`);

            await fbPatch(`numbers/${rawPhone}`, { status: 'sent', sentBy: deviceId, timestamp });
            await fbPatch(`devices/${deviceId}`, {
                totalSent: (stats?.totalSent || 0) + 1,
                date: timestamp.split('T')[0],
                lastActive: timestamp,
                status: 'connected'
            });
            await fbPatch(`users/${deviceId}`, { waStatus: 'connected', lastActive: timestamp });

            console.log(`[${deviceId}] ✅ Sent to ${phone}. Next in ${settings.delayMinutes} mins.`);
            setTimeout(run, settings.delayMinutes * 60 * 1000);
        } catch (err) {
            console.log(`[${deviceId}] ❌ Worker Error:`, err.message);
            setTimeout(run, 20000);
        }
    };
    run();
}

// ==========================================
// 📱 DEVICE STARTER
// ==========================================
// ✅ اصل FIX:
//   Pairing Code کے لیے: mobile: true + printQRInTerminal: false
//   QR Code کے لیے:      mobile: false + printQRInTerminal: true
//   دونوں ایک socket پر نہیں چل سکتے — الگ الگ socket بنتا ہے
// ==========================================
async function startDevice(phoneNumberId) {
    if (activeSockets.has(phoneNumberId) && typeof activeSockets.get(phoneNumberId) !== 'string') return;
    activeSockets.set(phoneNumberId, 'initializing');

    const sessionDir = `sessions_${phoneNumberId}`;
    if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir);

    // Firebase سے method چیک کریں: 'pairing' یا 'qr'
    const request = await fbGet(`bot_requests/${phoneNumberId}`);
    const usePairingCode = request?.method === 'pairing';

    console.log(`[${phoneNumberId}] 🔌 Method: ${usePairingCode ? 'PAIRING CODE' : 'QR CODE'}`);

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    // ✅ KEY FIX: pairing کے لیے mobile:true لازمی ہے
    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        keepAliveIntervalMs: 30000,
        markOnlineOnConnect: true,
        browser: Browsers.ubuntu('Chrome'),
        printQRInTerminal: !usePairingCode,
        mobile: usePairingCode   // ← یہی pairing code کا راز ہے
    });

    activeSockets.set(phoneNumberId, sock);
    sock.ev.on('creds.update', saveCreds);

    let pairingDone = false;

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        // ─── QR MODE ───────────────────────────────────────────────
        if (qr && !usePairingCode) {
            const link = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(qr)}`;
            console.log(`[${phoneNumberId}] 📷 QR Ready`);
            await fbPatch(`bot_requests/${phoneNumberId}`, {
                qrCode: link,
                pairingCode: null,
                status: 'waiting_for_scan_or_code'
            });
        }

        // ─── PAIRING CODE MODE ─────────────────────────────────────
        // ✅ FIX: 'connecting' state پر request — QR کا انتظار نہیں
        if (usePairingCode && !pairingDone && !sock.authState.creds.registered) {
            if (connection === 'connecting' || connection === 'open') return; // open پر skip
            if (!connection || connection === 'connecting') {
                pairingDone = true;
                await delay(3000);
                try {
                    const formatted = formatPhone(phoneNumberId);
                    console.log(`[${phoneNumberId}] 📞 Requesting code for: ${formatted}`);
                    const code = await sock.requestPairingCode(formatted);
                    const display = code?.match(/.{1,4}/g)?.join('-') || code;
                    console.log(`[${phoneNumberId}] 🔑 CODE: ${display}`);
                    await fbPatch(`bot_requests/${phoneNumberId}`, {
                        pairingCode: display,
                        qrCode: null,
                        status: 'waiting_for_scan_or_code'
                    });
                } catch (err) {
                    console.error(`[${phoneNumberId}] ❌ Pairing error:`, err.message);
                    pairingDone = false;
                    // 8 سیکنڈ بعد retry
                    setTimeout(async () => {
                        if (!activeSockets.has(phoneNumberId) || pairingDone) return;
                        pairingDone = true;
                        try {
                            const formatted = formatPhone(phoneNumberId);
                            const code = await sock.requestPairingCode(formatted);
                            const display = code?.match(/.{1,4}/g)?.join('-') || code;
                            await fbPatch(`bot_requests/${phoneNumberId}`, {
                                pairingCode: display,
                                status: 'waiting_for_scan_or_code'
                            });
                            console.log(`[${phoneNumberId}] 🔑 CODE (retry): ${display}`);
                        } catch (e) {
                            console.error(`[${phoneNumberId}] Retry failed:`, e.message);
                            pairingDone = false;
                        }
                    }, 8000);
                }
            }
        }

        // ─── CONNECTED ─────────────────────────────────────────────
        if (connection === 'open') {
            console.log(`✅ [${phoneNumberId}] CONNECTED!`);
            pairingDone = false;
            await fbDelete(`bot_requests/${phoneNumberId}`);
            await fbPatch(`devices/${phoneNumberId}`, {
                status: 'connected',
                phone: sock.user?.id?.split(':')[0] || phoneNumberId,
                lastActive: new Date().toISOString()
            });
            await fbPatch(`users/${phoneNumberId}`, { waStatus: 'connected' });
            setTimeout(() => startBroadcastWorker(sock, phoneNumberId), 5000);
        }

        // ─── DISCONNECTED ──────────────────────────────────────────
        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode;
            activeSockets.delete(phoneNumberId);
            pairingDone = false;

            const isLoggedOut = code === DisconnectReason.loggedOut || code === 401;

            if (isLoggedOut) {
                console.log(`❌ [${phoneNumberId}] LOGGED OUT`);
                if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
                await fbPatch(`devices/${phoneNumberId}`, { status: 'disconnected' });
                await fbPatch(`users/${phoneNumberId}`, { waStatus: 'disconnected' });
            } else {
                console.log(`🔄 [${phoneNumberId}] Reconnecting in 5s...`);
                setTimeout(() => startDevice(phoneNumberId), 5000);
            }
        }
    });
}

// ==========================================
// 🕒 HEARTBEAT & 24H CHECK
// ==========================================
async function checkInactiveDevices() {
    const devices = await fbGet('devices');
    if (!devices) return;

    const now = Date.now();
    const H24 = 24 * 60 * 60 * 1000;

    for (const id in devices) {
        const dev = devices[id];

        if (activeSockets.has(id) && activeSockets.get(id)?.authState?.creds?.registered) {
            const ts = new Date().toISOString();
            await fbPatch(`devices/${id}`, { lastActive: ts, status: 'connected' });
            await fbPatch(`users/${id}`, { waStatus: 'connected' });
            continue;
        }

        if (dev.status !== 'disconnected' && dev.lastActive) {
            const last = new Date(dev.lastActive).getTime();
            if (now - last > H24) {
                console.log(`⚠️ [${id}] 24h inactive.`);
                await fbPatch(`devices/${id}`, { status: 'disconnected' });
                await fbPatch(`users/${id}`, { waStatus: 'disconnected' });
                activeSockets.delete(id);
                const dir = `sessions_${id}`;
                if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
            } else if (dev.status !== 'connected') {
                await fbPatch(`devices/${id}`, { status: 'connected' });
                await fbPatch(`users/${id}`, { waStatus: 'connected' });
            }
        }
    }
}

// ==========================================
// 🔄 MAIN POLL LOOP
// ==========================================
async function pollFirebase() {
    setInterval(async () => {
        const requests = await fbGet('bot_requests');
        if (requests) {
            for (const id in requests) {
                const req = requests[id];
                if (req.action &&
                    req.status !== 'processing' &&
                    req.status !== 'waiting_for_scan_or_code') {

                    await fbPatch(`bot_requests/${id}`, { status: 'processing' });

                    // پرانا socket بند کریں
                    if (activeSockets.has(id)) {
                        try {
                            const old = activeSockets.get(id);
                            if (typeof old !== 'string') {
                                old.ev.removeAllListeners();
                                old.ws?.close();
                            }
                        } catch (e) {}
                        activeSockets.delete(id);
                    }

                    // پرانا session صاف کریں
                    const dir = `sessions_${id}`;
                    if (fs.existsSync(dir)) {
                        fs.rmSync(dir, { recursive: true, force: true });
                        console.log(`🗑️ [${id}] Session cleared.`);
                    }

                    setTimeout(() => startDevice(id), 2000);
                }
            }
        }

        // موجودہ active devices restart کریں اگر socket نہیں
        const devices = await fbGet('devices');
        if (devices) {
            for (const id in devices) {
                if ((devices[id].status === 'pending' || devices[id].status === 'connected') &&
                    !activeSockets.has(id)) {
                    startDevice(id);
                }
            }
        }
    }, 10000);

    setInterval(() => checkInactiveDevices(), 60 * 60 * 1000);
}

// ==========================================
// 🚀 START ENGINE
// ==========================================
if (FIREBASE_URL) {
    pollFirebase();
    console.log("🚀 Botzmine Engine Started! (24/7 Active)");
} else {
    console.error("❌ FIREBASE_URL missing in .env!");
}
