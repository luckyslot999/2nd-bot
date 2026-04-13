require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
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
// 🔗 QR CODE URL GENERATOR
// آپ کے بتائے ہوئے فارمیٹ کے مطابق
// https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=...
// ==========================================
function generateQRImageUrl(qrData) {
    const encodedData = encodeURIComponent(qrData);
    return `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodedData}`;
}

// ==========================================
// ⚙️ SETTINGS (NO LIMIT & 20 MIN DELAY)
// ==========================================
async function getSettings() {
    const data = await fbGet('settings');
    return { 
        messageTemplate: data?.messageTemplate || "Hello, this is an automated message from Botzmine!", 
        delayMinutes: 20 
    };
}

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

    // Auto-Reset Loop
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
            
            console.log(`[${deviceId}] ✍️ Sending message to ${phone}...`);
            await sock.sendPresenceUpdate('composing', jid);
            await delay(Math.random() * 5000 + 3000);
            
            await sock.sendMessage(jid, { text: settings.messageTemplate });
            
            const timestamp = new Date().toISOString();
            const today = timestamp.split('T')[0];
            let stats = await fbGet(`devices/${deviceId}`);

            await fbPatch(`numbers/${rawPhone}`, { status: 'sent', sentBy: deviceId, timestamp });

            // ✅ Message send ہونے پر lastMessageSent اور lastActive اپڈیٹ کریں
            // تاکہ 24 گھنٹے کا timer reset ہو اور status connected رہے
            await fbPatch(`devices/${deviceId}`, { 
                totalSent: (stats?.totalSent || 0) + 1, 
                date: today, 
                lastActive: timestamp,
                lastMessageSent: timestamp,  // ✅ نیا field: آخری message کا وقت
                status: 'connected' 
            });

            console.log(`[${deviceId}] ✅ Sent to ${phone}. Next in 20 mins.`);
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
    
    const sock = makeWASocket({
        version, 
        auth: state, 
        printQRInTerminal: true,
        logger: pino({ level: 'silent' }),
        browser: Browsers.ubuntu('Chrome'),
        // ✅ کنیکشن مضبوط رکھنے کے لیے keep-alive settings
        keepAliveIntervalMs: 30000,
        connectTimeoutMs: 60000,
        retryRequestDelayMs: 2000,
        maxMsgRetryCount: 5
    });

    activeSockets.set(phoneNumberId, sock);

    // ✅ Pairing Code Request (8 سیکنڈ بعد اگر registered نہ ہو)
    if (!sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                if (activeSockets.has(phoneNumberId) && !sock.authState.creds.registered) {
                    let formattedNumber = formatPhoneNumberForPairing(phoneNumberId);
                    const pairingCode = await sock.requestPairingCode(formattedNumber);

                    // ✅ Pairing code Firebase میں save کریں
                    await fbPatch(`bot_requests/${phoneNumberId}`, { 
                        pairingCode: pairingCode,
                        status: 'waiting_for_scan_or_code'
                    });
                    console.log(`[${phoneNumberId}] 🔑 PAIRING CODE: ${pairingCode}`);
                }
            } catch (err) { console.error("Pairing Error:", err.message); }
        }, 8000); 
    }

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        // ✅ QR کوڈ جنریٹ ہو تو اسے image URL میں convert کر کے Firebase میں save کریں
        if (qr) {
            const qrImageUrl = generateQRImageUrl(qr);
            console.log(`[${phoneNumberId}] 🔳 QR Code Generated -> ${qrImageUrl}`);
            await fbPatch(`bot_requests/${phoneNumberId}`, { 
                qrCode: qrImageUrl,       // ✅ QR image URL (api.qrserver.com)
                qrRaw: qr,                // ✅ Raw QR data بھی save کریں (backup)
                status: 'waiting_for_scan_or_code'
            });
        }

        if (connection === 'open') {
            console.log(`✅ [${phoneNumberId}] CONNECTED`);
            await fbDelete(`bot_requests/${phoneNumberId}`);
            const timestamp = new Date().toISOString();
            await fbPatch(`devices/${phoneNumberId}`, { 
                status: 'connected', 
                phone: sock.user.id.split(':')[0], 
                lastActive: timestamp,
                lastMessageSent: timestamp, // ✅ کنیکٹ ہوتے ہی set کریں
                connectedAt: timestamp
            });
            setTimeout(() => startBroadcastWorker(sock, phoneNumberId), 5000);
        }
        
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            activeSockets.delete(phoneNumberId);

            if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
                // ✅ صرف لاگ آؤٹ پر ہی disconnect کریں
                console.log(`❌ [${phoneNumberId}] LOGGED OUT - Cleaning session...`);
                if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
                await fbPatch(`devices/${phoneNumberId}`, { status: 'disconnected' });
            } else {
                // ✅ باقی تمام errors پر reconnect کریں، status connected رکھیں
                console.log(`🔄 [${phoneNumberId}] Connection dropped, reconnecting in 5s...`);
                // Status connected رکھیں جب تک reconnect ہو رہا ہے
                await fbPatch(`devices/${phoneNumberId}`, { status: 'reconnecting' });
                setTimeout(() => startDevice(phoneNumberId), 5000);
            }
        }
    });
    
    sock.ev.on('creds.update', saveCreds);
}

// ==========================================
// 🕒 24-HOUR ACTIVITY CHECKER (FIXED)
// ✅ اگر 24 گھنٹے میں ایک بھی message send ہو تو disconnect نہ کریں
// ==========================================
async function checkInactiveDevices() {
    const devices = await fbGet('devices');
    if (!devices) return;

    const now = new Date().getTime();
    const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

    for (const deviceId in devices) {
        const device = devices[deviceId];

        // صرف ان devices کو check کریں جو connected یا reconnecting ہیں
        if (device.status === 'disconnected') continue;

        // ✅ lastMessageSent چیک کریں - اگر 24 گھنٹے میں message گیا تو connected رکھیں
        const lastMessageTime = device.lastMessageSent 
            ? new Date(device.lastMessageSent).getTime() 
            : null;

        const lastActiveTime = device.lastActive 
            ? new Date(device.lastActive).getTime() 
            : null;

        // ✅ دونوں میں سے جو بھی latest ہو وہ لیں
        const mostRecentActivity = Math.max(
            lastMessageTime || 0, 
            lastActiveTime || 0
        );

        if (mostRecentActivity > 0 && (now - mostRecentActivity) > TWENTY_FOUR_HOURS) {
            // ✅ پورے 24 گھنٹے کوئی message نہیں گیا - تب disconnect کریں
            console.log(`⚠️ [${deviceId}] No message in 24h. Disconnecting...`);
            await fbPatch(`devices/${deviceId}`, { status: 'disconnected' });
            if (activeSockets.has(deviceId)) {
                try { activeSockets.get(deviceId)?.end?.(); } catch(e) {}
                activeSockets.delete(deviceId);
            }
            const sessionDir = `sessions_${deviceId}`;
            if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
        } else if (mostRecentActivity > 0) {
            // ✅ 24 گھنٹے میں activity ہے - connected رکھیں
            console.log(`✅ [${deviceId}] Active within 24h. Keeping connected.`);
            // اگر کسی وجہ سے socket نہیں ہے تو restart کریں
            if (!activeSockets.has(deviceId) && device.status === 'connected') {
                console.log(`🔄 [${deviceId}] Restarting missing socket...`);
                startDevice(deviceId);
            }
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
                if (requests[id].action && requests[id].status !== 'processing' && requests[id].status !== 'waiting_for_scan_or_code') {
                    await fbPatch(`bot_requests/${id}`, { status: 'processing' });
                    startDevice(id);
                }
            }
        }

        const devices = await fbGet('devices');
        if (devices) {
            for (const id in devices) {
                if ((devices[id].status === 'pending' || devices[id].status === 'connected') && !activeSockets.has(id)) {
                    startDevice(id);
                }
            }
        }
    }, 10000);

    // ✅ 24-hour activity check ہر 10 منٹ بعد
    setInterval(() => checkInactiveDevices(), 10 * 60 * 1000); 
}

// ==========================================
// 🚀 START
// ==========================================
if (FIREBASE_URL) {
    pollFirebase();
    console.log("🚀 Botzmine Engine Started!");
} else {
    console.error("❌ FIREBASE_URL missing!");
}
