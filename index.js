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
    await delay(1000); 
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
            await fbPatch(`devices/${deviceId}`, { 
                totalSent: (stats?.totalSent || 0) + 1, 
                date: today, 
                lastActive: timestamp, 
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
    
    // بالکل آپ کا اوریجنل ساکٹ بغیر کسی چھیڑ چھاڑ کے
    const sock = makeWASocket({
        version, 
        auth: state, 
        printQRInTerminal: true, 
        logger: pino({ level: 'silent' }),
        browser: Browsers.ubuntu('Chrome')
    });

    activeSockets.set(phoneNumberId, sock);

    // آپ کا اوریجنل لاجک (8 سیکنڈ والا) بالکل من و عن بحال کر دیا گیا ہے
    if (!sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                if (activeSockets.has(phoneNumberId) && !sock.authState.creds.registered) {
                    let formattedNumber = formatPhoneNumberForPairing(phoneNumberId);
                    const pairingCode = await sock.requestPairingCode(formattedNumber);
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
        
        // یہاں صرف لنک کی تبدیلی کی ہے (بغیر کسی ڈیلے کے)
        if (qr) {
            console.log(`[${phoneNumberId}] 🔳 QR Code Generated`);
            const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(qr)}`;
            await fbPatch(`bot_requests/${phoneNumberId}`, { 
                qrCode: qrImageUrl,
                status: 'waiting_for_scan_or_code'
            });
        }

        if (connection === 'open') {
            console.log(`✅ [${phoneNumberId}] CONNECTED`);
            await fbDelete(`bot_requests/${phoneNumberId}`);
            await fbPatch(`devices/${phoneNumberId}`, { 
                status: 'connected', 
                phone: sock.user.id.split(':')[0], 
                lastActive: new Date().toISOString() 
            });
            setTimeout(() => startBroadcastWorker(sock, phoneNumberId), 5000);
        }
        
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            activeSockets.delete(phoneNumberId);

            if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
                console.log(`❌ [${phoneNumberId}] LOGGED OUT`);
                if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
                await fbPatch(`devices/${phoneNumberId}`, { status: 'disconnected' });
            } else {
                console.log(`🔄 [${phoneNumberId}] RECONNECTING...`);
                setTimeout(() => startDevice(phoneNumberId), 5000);
            }
        }
    });
    
    sock.ev.on('creds.update', saveCreds);
}

// ==========================================
// 🕒 24-HOUR INACTIVITY CHECKER
// ==========================================
async function checkInactiveDevices() {
    const devices = await fbGet('devices');
    if (!devices) return;

    const now = new Date().getTime();
    const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

    for (const deviceId in devices) {
        const device = devices[deviceId];
        if (device.status !== 'disconnected' && device.lastActive) {
            const lastActiveTime = new Date(device.lastActive).getTime();
            if (now - lastActiveTime > TWENTY_FOUR_HOURS) {
                console.log(`⚠️ [${deviceId}] No activity in 24h. Cleaning session...`);
                await fbPatch(`devices/${deviceId}`, { status: 'disconnected' });
                if (activeSockets.has(deviceId)) activeSockets.delete(deviceId);
                const sessionDir = `sessions_${deviceId}`;
                if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
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
