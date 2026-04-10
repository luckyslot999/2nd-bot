

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
// ⚙️ SETTINGS (40 MESSAGES & 15 MIN DELAY)
// ==========================================
async function getSettings() {
    const data = await fbGet('settings');
    return { 
        messageTemplate: data?.messageTemplate || "Hello, this is an automated message from Botzmine!", 
        dailyLimitPerDevice: 40, // 👈 Updated to 40
        minDelayMinutes: 15,     // 👈 15 Minutes Gap
        maxDelayMinutes: 17      
    };
}

function getRandomDelayMs(minMinutes, maxMinutes) {
    const min = minMinutes * 60 * 1000;
    const max = maxMinutes * 60 * 1000;
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function getMsUntilMidnight() {
    const now = new Date();
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);
    return midnight.getTime() - now.getTime();
}

function formatPhoneNumberForPairing(phoneNumber) {
    let num = phoneNumber.toString().replace(/\D/g, ''); 
    if (num.startsWith('03')) return '92' + num.substring(1);
    if (num.startsWith('3') && num.length === 10) return '92' + num;
    return num;
}

// ==========================================
// 🔄 NUMBER FETCHING LOGIC 
// ==========================================
async function getNextPendingNumber() {
    const numbers = await fbGet('numbers');
    if (!numbers) return null;

    for (const phone in numbers) {
        const status = numbers[phone].status;
        if (!status || status === 'pending') return phone;
    }

    // Auto-Reset Loop
    console.log(`♻️ [AUTO-LOOP] Resetting numbers...`);
    const updates = {};
    for (const phone in numbers) {
        updates[phone] = { status: 'pending', sentBy: null };
    }
    await fbPatch('numbers', updates);
    return getNextPendingNumber();
}

// ==========================================
// 🚀 BROADCAST WORKER (SAFE MODE)
// ==========================================
async function startBroadcastWorker(sock, deviceId) {
    const runWorker = async () => {
        try {
            // Check if socket is still active
            if (!activeSockets.has(deviceId)) return;

            const settings = await getSettings();
            let stats = await fbGet(`devices/${deviceId}`);
            const today = new Date().toISOString().split('T')[0];
            
            let sentToday = (stats && stats.date === today) ? (stats.sentToday || 0) : 0;

            // 40 Message Limit Check
            if (sentToday >= settings.dailyLimitPerDevice) {
                console.log(`[${deviceId}] 🛑 Daily limit (40) reached. Sleeping...`);
                await fbPatch(`devices/${deviceId}`, { status: 'limit_reached' });
                setTimeout(runWorker, getMsUntilMidnight());
                return;
            }
            
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
            await fbPatch(`numbers/${rawPhone}`, { status: 'sent', sentBy: deviceId, timestamp });
            await fbPatch(`devices/${deviceId}`, { 
                sentToday: sentToday + 1, 
                totalSent: (stats?.totalSent || 0) + 1, 
                date: today, 
                lastActive: timestamp, 
                status: 'connected' // 👈 Keeps status connected during activity
            });

            console.log(`[${deviceId}] ✅ Sent to ${phone}. Next in 15 mins.`);
            setTimeout(runWorker, getRandomDelayMs(settings.minDelayMinutes, settings.maxDelayMinutes));
            
        } catch (error) {
            console.log(`[${deviceId}] ❌ Error:`, error.message);
            setTimeout(runWorker, 20000); 
        }
    };
    runWorker();
}

// ==========================================
// 📱 DEVICE MANAGER
// ==========================================
async function startDevice(phoneNumberId) {
    if (activeSockets.has(phoneNumberId) && activeSockets.get(phoneNumberId) !== 'initializing') return;
    activeSockets.set(phoneNumberId, 'initializing');

    const sessionDir = `sessions_${phoneNumberId}`;
    if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir);
    
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();
    
    const sock = makeWASocket({
        version, 
        auth: state, 
        printQRInTerminal: false, 
        logger: pino({ level: 'silent' }),
        browser: Browsers.ubuntu('Chrome')
    });

    activeSockets.set(phoneNumberId, sock);

    if (!sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                let formattedNumber = formatPhoneNumberForPairing(phoneNumberId);
                const pairingCode = await sock.requestPairingCode(formattedNumber);
                await fbPatch(`bot_requests/${phoneNumberId}`, { 
                    pairingCode: pairingCode,
                    status: 'waiting_for_scan_or_code'
                });
                console.log(`[${phoneNumberId}] 🔑 PAIRING CODE: ${pairingCode}`);
            } catch (err) { console.error("Pairing Error:", err.message); }
        }, 5000); 
    }

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        
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
                fs.rmSync(sessionDir, { recursive: true, force: true });
                await fbPatch(`devices/${phoneNumberId}`, { status: 'disconnected' });
            } else {
                console.log(`🔄 [${phoneNumberId}] RECONNECTING...`);
                await fbPatch(`devices/${phoneNumberId}`, { status: 'reconnecting' });
                setTimeout(() => startDevice(phoneNumberId), 5000);
            }
        }
    });
    
    sock.ev.on('creds.update', saveCreds);
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
