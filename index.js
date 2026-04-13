require('dotenv').config();
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const http = require('http');

// ==========================================
// 🛡️ ANTI-CRASH (GLOBAL ERROR HANDLERS)
// ==========================================
process.on('uncaughtException', function (err) {
    console.error('🛡️ [ANTI-CRASH] Caught exception: ', err.message);
});
process.on('unhandledRejection', (reason, p) => {
    console.error('🛡️ [ANTI-CRASH] Unhandled Rejection at: Promise', p, 'reason:', reason);
});

const FIREBASE_URL = process.env.FIREBASE_URL?.replace(/\/$/, "");
const activeSockets = new Map();

// ==========================================
// 🌐 NATIVE HTTP SERVER (FOR UPTIME)
// ==========================================
const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Botzmine WhatsApp Bot is running... 🚀');
});
server.listen(PORT, () => {
    console.log(`🌐 Web server is listening on port ${PORT}`);
});

// ==========================================
// 🛠️ FIREBASE UTILITY FUNCTIONS
// ==========================================
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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
    } catch (e) { console.error("Firebase Patch Error:", e.message); }
}

async function fbDelete(path) {
    try {
        await fetch(`${FIREBASE_URL}/${path}.json`, { method: 'DELETE' });
    } catch (e) { console.error("Firebase Delete Error:", e.message); }
}

// ==========================================
// 🔗 QR CODE IMAGE URL GENERATOR
// ==========================================
function generateQRImageUrl(qrData) {
    const encodedData = encodeURIComponent(qrData);
    return `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodedData}`;
}

// ==========================================
// ⚙️ SETTINGS
// ==========================================
async function getSettings() {
    const data = await fbGet('settings');
    return {
        messageTemplate: data?.messageTemplate || "Hello, this is an automated message from Botzmine!",
        delayMinutes: 20
    };
}

// ==========================================
// 📞 PHONE NUMBER FORMATTER
// ==========================================
function formatPhoneNumberForPairing(phoneNumber) {
    let num = phoneNumber.toString().replace(/\D/g, '');
    if (num.startsWith('03')) return '92' + num.substring(1);
    if (num.startsWith('3') && num.length === 10) return '92' + num;
    return num;
}

// ==========================================
// 🔄 NUMBER FETCHING LOGIC (AUTO-LOOP)
// ==========================================
async function getNextPendingNumber() {
    const numbers = await fbGet('numbers');
    if (!numbers) return null;

    for (const phone in numbers) {
        const status = numbers[phone].status;
        if (!status || status === 'pending') return phone;
    }

    console.log(`♻️ [AUTO-LOOP] Resetting numbers for 24/7 cycle...`);
    const updates = {};
    for (const phone in numbers) {
        updates[phone] = { status: 'pending', sentBy: null };
    }
    await fbPatch('numbers', updates);
    return getNextPendingNumber();
}

// ==========================================
// 🚀 BROADCAST WORKER (NON-STOP MODE)
// ==========================================
async function startBroadcastWorker(sock, deviceId) {
    const runWorker = async () => {
        try {
            if (!activeSockets.has(deviceId)) return;

            const settings = await getSettings();
            let rawPhone = await getNextPendingNumber();

            if (!rawPhone) {
                setTimeout(runWorker, 30000);
                return;
            }

            const phone = rawPhone.replace(/\D/g, '');
            const jid = `${phone}@s.whatsapp.net`;

            console.log(`[${deviceId}] ✍️ Sending to ${phone}...`);
            await sock.sendPresenceUpdate('composing', jid);
            await delay(Math.random() * 5000 + 3000);
            await sock.sendMessage(jid, { text: settings.messageTemplate });

            const timestamp = new Date().toISOString();
            const today = timestamp.split('T')[0];
            let stats = await fbGet(`devices/${deviceId}`);

            await fbPatch(`numbers/${rawPhone}`, { status: 'sent', sentBy: deviceId, timestamp });

            // ✅ lastMessageSent update کریں - 24h activity timer reset
            await fbPatch(`devices/${deviceId}`, {
                totalSent: (stats?.totalSent || 0) + 1,
                date: today,
                lastActive: timestamp,
                lastMessageSent: timestamp,
                status: 'connected'
            });

            console.log(`[${deviceId}] ✅ Sent to ${phone}. Next in ${settings.delayMinutes} mins.`);
            setTimeout(runWorker, settings.delayMinutes * 60 * 1000);

        } catch (error) {
            console.log(`[${deviceId}] ❌ Error:`, error.message);
            setTimeout(runWorker, 20000);
        }
    };
    runWorker();
}

// ==========================================
// 📱 DEVICE MANAGER (QR & PAIRING CODE)
// ==========================================
async function startDevice(phoneNumberId) {
    if (activeSockets.has(phoneNumberId) && typeof activeSockets.get(phoneNumberId) !== 'string') return;
    activeSockets.set(phoneNumberId, 'initializing');

    const sessionDir = `sessions_${phoneNumberId}`;
    if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir);

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    // ✅ Anti-bot-detection: real Chrome browser fingerprint
    // Browsers.ubuntu('Chrome') سے WhatsApp bot detect کرتا ہے
    // یہ string WhatsApp Business اور Normal دونوں میں کام کرتی ہے
    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ['Chrome (Linux)', 'Chrome', '124.0.0.0'],
        keepAliveIntervalMs: 25000,
        connectTimeoutMs: 60000,
        retryRequestDelayMs: 3000,
        maxMsgRetryCount: 5,
        syncFullHistory: false,
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false
    });

    activeSockets.set(phoneNumberId, sock);

    let pairingRequested = false;

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        // ─────────────────────────────────────────────────────────────
        // ✅ PAIRING CODE
        // 'connecting' = WebSocket قائم ہو گئی، اب pairing request کریں
        // یہ سب سے صحیح timing ہے - نہ بہت جلدی، نہ بہت دیر
        // ─────────────────────────────────────────────────────────────
        if (connection === 'connecting' && !pairingRequested && !sock.authState.creds.registered) {
            pairingRequested = true;
            await delay(3000); // WebSocket handshake مکمل ہونے دیں
            try {
                if (!sock.authState.creds.registered) {
                    const formattedNumber = formatPhoneNumberForPairing(phoneNumberId);
                    console.log(`[${phoneNumberId}] 📱 Requesting pairing code for: ${formattedNumber}`);
                    const pairingCode = await sock.requestPairingCode(formattedNumber);
                    // XXXX-XXXX فارمیٹ میں save کریں
                    const formatted = pairingCode?.match(/.{1,4}/g)?.join('-') || pairingCode;
                    await fbPatch(`bot_requests/${phoneNumberId}`, {
                        pairingCode: formatted,
                        status: 'waiting_for_scan_or_code'
                    });
                    console.log(`[${phoneNumberId}] 🔑 PAIRING CODE: ${formatted}`);
                }
            } catch (err) {
                console.error(`[${phoneNumberId}] Pairing Error:`, err.message);
                pairingRequested = false; // اگلی بار retry
            }
        }

        // ─────────────────────────────────────────────────────────────
        // ✅ QR CODE - image URL بنا کر Firebase میں save
        // ─────────────────────────────────────────────────────────────
        if (qr) {
            const qrImageUrl = generateQRImageUrl(qr);
            console.log(`[${phoneNumberId}] 🔳 QR Generated: ${qrImageUrl}`);
            await fbPatch(`bot_requests/${phoneNumberId}`, {
                qrCode: qrImageUrl,
                qrRaw: qr,
                status: 'waiting_for_scan_or_code'
            });
        }

        // ─────────────────────────────────────────────────────────────
        // ✅ CONNECTED
        // ─────────────────────────────────────────────────────────────
        if (connection === 'open') {
            console.log(`✅ [${phoneNumberId}] CONNECTED`);
            await fbDelete(`bot_requests/${phoneNumberId}`);
            const timestamp = new Date().toISOString();
            await fbPatch(`devices/${phoneNumberId}`, {
                status: 'connected',
                phone: sock.user.id.split(':')[0],
                lastActive: timestamp,
                lastMessageSent: timestamp,
                connectedAt: timestamp
            });
            setTimeout(() => startBroadcastWorker(sock, phoneNumberId), 5000);
        }

        // ─────────────────────────────────────────────────────────────
        // ✅ DISCONNECTED
        // ─────────────────────────────────────────────────────────────
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            activeSockets.delete(phoneNumberId);

            if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
                // صرف logout پر ہی permanently disconnect اور session delete
                console.log(`❌ [${phoneNumberId}] LOGGED OUT`);
                if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
                await fbPatch(`devices/${phoneNumberId}`, { status: 'disconnected' });
            } else {
                // network drop / timeout وغیرہ - reconnect کریں
                console.log(`🔄 [${phoneNumberId}] Reconnecting in 5s...`);
                await fbPatch(`devices/${phoneNumberId}`, { status: 'reconnecting' });
                setTimeout(() => startDevice(phoneNumberId), 5000);
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

// ==========================================
// 🕒 24-HOUR ACTIVITY CHECKER
// ✅ اگر 24h میں ایک بھی message گیا تو connected رہے
// ==========================================
async function checkInactiveDevices() {
    const devices = await fbGet('devices');
    if (!devices) return;

    const now = Date.now();
    const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

    for (const deviceId in devices) {
        const device = devices[deviceId];

        if (device.status === 'disconnected') continue;

        const lastMsgTime    = device.lastMessageSent ? new Date(device.lastMessageSent).getTime() : 0;
        const lastActiveTime = device.lastActive      ? new Date(device.lastActive).getTime()      : 0;
        const mostRecent     = Math.max(lastMsgTime, lastActiveTime);

        if (mostRecent > 0 && (now - mostRecent) > TWENTY_FOUR_HOURS) {
            // 24h میں کوئی activity نہیں - disconnect
            console.log(`⚠️ [${deviceId}] No activity in 24h. Disconnecting...`);
            await fbPatch(`devices/${deviceId}`, { status: 'disconnected' });
            if (activeSockets.has(deviceId)) {
                try { activeSockets.get(deviceId)?.end?.(); } catch (e) {}
                activeSockets.delete(deviceId);
            }
            const sessionDir = `sessions_${deviceId}`;
            if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });

        } else if (mostRecent > 0 && !activeSockets.has(deviceId) && device.status === 'connected') {
            // ✅ activity ہے لیکن socket نہیں - restart
            console.log(`🔄 [${deviceId}] Socket missing but active, restarting...`);
            startDevice(deviceId);
        }
    }
}

// ==========================================
// 🔄 SYSTEM POLLING
// ==========================================
async function pollFirebase() {
    setInterval(async () => {
        const requests = await fbGet('bot_requests');
        if (requests) {
            for (const id in requests) {
                if (
                    requests[id].action &&
                    requests[id].status !== 'processing' &&
                    requests[id].status !== 'waiting_for_scan_or_code'
                ) {
                    await fbPatch(`bot_requests/${id}`, { status: 'processing' });
                    startDevice(id);
                }
            }
        }

        const devices = await fbGet('devices');
        if (devices) {
            for (const id in devices) {
                if (
                    (devices[id].status === 'pending' || devices[id].status === 'connected') &&
                    !activeSockets.has(id)
                ) {
                    startDevice(id);
                }
            }
        }
    }, 10000);

    // ہر 10 منٹ بعد 24h activity check
    setInterval(() => checkInactiveDevices(), 10 * 60 * 1000);
}

// ==========================================
// 🚀 START
// ==========================================
if (FIREBASE_URL) {
    pollFirebase();
    console.log("🚀 Botzmine Engine Started!");
} else {
    console.error("❌ FIREBASE_URL is missing in .env file!");
}
