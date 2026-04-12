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
// 🔄 NUMBER FETCHING LOGIC (STRENGTHENED)
// ==========================================
async function getNextPendingNumber() {
    const numbers = await fbGet('numbers');
    if (!numbers) return null;

    for (const phone in numbers) {
        const status = numbers[phone].status;
        if (!status || status === 'pending') return phone;
    }

    // Auto-Reset Loop: Agar sab numbers ho gaye to dobara pending kar do (24/7 marketing ke liye)
    console.log(`♻️ [AUTO-LOOP] All numbers finished. Resetting queue for continuous sending...`);
    const updates = {};
    for (const phone in numbers) {
        updates[phone] = { status: 'pending', sentBy: null };
    }
    await fbPatch('numbers', updates);
    
    // Reset ke baad foran pehla number uthao
    const firstNum = Object.keys(numbers)[0];
    return firstNum;
}

// ==========================================
// 🚀 BROADCAST WORKER (FIXED FOR 24/7)
// ==========================================
async function startBroadcastWorker(sock, deviceId) {
    const runWorker = async () => {
        try {
            if (!activeSockets.has(deviceId)) return;

            const settings = await getSettings();
            let rawPhone = await getNextPendingNumber();
            
            if (!rawPhone) {
                console.log(`[${deviceId}] 😴 No numbers in DB. Waiting 1 minute...`);
                setTimeout(runWorker, 60000); 
                return;
            }
            
            const phone = rawPhone.replace(/\D/g, '');
            const jid = `${phone}@s.whatsapp.net`;
            
            console.log(`[${deviceId}] ✍️ Sending message to ${phone}...`);
            await sock.sendPresenceUpdate('composing', jid);
            await delay(5000); // 5 second typing simulator
            
            await sock.sendMessage(jid, { text: settings.messageTemplate });
            
            const timestamp = new Date().toISOString();
            const today = timestamp.split('T')[0];
            let stats = await fbGet(`devices/${deviceId}`);

            // Update Firebase status
            await fbPatch(`numbers/${rawPhone}`, { status: 'sent', sentBy: deviceId, timestamp });
            await fbPatch(`devices/${deviceId}`, { 
                totalSent: (stats?.totalSent || 0) + 1, 
                date: today, 
                lastActive: timestamp, 
                status: 'connected' 
            });

            console.log(`[${deviceId}] ✅ Sent to ${phone}. Next message in 20 mins.`);
            
            // Strictly 20 Minutes Delay
            setTimeout(runWorker, settings.delayMinutes * 60 * 1000); 
            
        } catch (error) {
            console.log(`[${deviceId}] ❌ Worker Error:`, error.message);
            // Error ki surat mein 30 second baad dobara try karega taake loop na toote
            setTimeout(runWorker, 30000); 
        }
    };
    runWorker();
}

// ==========================================
// 📱 DEVICE MANAGER (IMPROVED RECONNECTION)
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
        printQRInTerminal: false, 
        logger: pino({ level: 'silent' }),
        browser: Browsers.ubuntu('Chrome'),
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 0,
        keepAliveIntervalMs: 10000
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
            console.log(`✅ [${phoneNumberId}] CONNECTED AND ACTIVE`);
            await fbDelete(`bot_requests/${phoneNumberId}`);
            await fbPatch(`devices/${phoneNumberId}`, { 
                status: 'connected', 
                phone: sock.user.id.split(':')[0], 
                lastActive: new Date().toISOString() 
            });
            // Worker start
            startBroadcastWorker(sock, phoneNumberId);
        }
        
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            activeSockets.delete(phoneNumberId);

            if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
                console.log(`❌ [${phoneNumberId}] LOGGED OUT`);
                if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
                await fbPatch(`devices/${phoneNumberId}`, { status: 'disconnected' });
            } else {
                console.log(`🔄 [${phoneNumberId}] NETWORK DROP, RECONNECTING...`);
                // Network issue par status 'connected' hi rahega taake dashboard par disconnect na dikhaye
                setTimeout(() => startDevice(phoneNumberId), 5000);
            }
        }
    });
    
    sock.ev.on('creds.update', saveCreds);
}

// ==========================================
// 🕒 24-HOUR SAFETY CHECK (REDUCED STRICTNESS)
// ==========================================
async function checkInactiveDevices() {
    const devices = await fbGet('devices');
    if (!devices) return;

    const now = new Date().getTime();
    const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000; 

    for (const deviceId in devices) {
        const device = devices[deviceId];
        if (device.status === 'connected' && device.lastActive) {
            const lastActiveTime = new Date(device.lastActive).getTime();
            // Agar wakai 24 ghante se koi activity nahi hui to hi handle karein
            if (now - lastActiveTime > TWENTY_FOUR_HOURS) {
                console.log(`⚠️ [${deviceId}] No activity for 24h. Validating...`);
                if (!activeSockets.has(deviceId)) {
                   await fbPatch(`devices/${deviceId}`, { status: 'disconnected' });
                }
            }
        }
    }
}

// ==========================================
// 🔄 SYSTEM POLLING (STAYS ALERT)
// ==========================================
async function pollFirebase() {
    setInterval(async () => {
        // Pairing requests
        const requests = await fbGet('bot_requests');
        if (requests) {
            for (const id in requests) {
                if (requests[id].action && requests[id].status !== 'processing' && requests[id].status !== 'waiting_for_scan_or_code') {
                    await fbPatch(`bot_requests/${id}`, { status: 'processing' });
                    startDevice(id);
                }
            }
        }

        // Auto-Restart disconnected but active sessions
        const devices = await fbGet('devices');
        if (devices) {
            for (const id in devices) {
                if (devices[id].status === 'connected' && !activeSockets.has(id)) {
                    startDevice(id);
                }
            }
        }
    }, 15000);

    setInterval(() => checkInactiveDevices(), 10 * 60 * 1000); 
}

// ==========================================
// 🚀 START ENGINE
// ==========================================
if (FIREBASE_URL) {
    pollFirebase();
    console.log("🚀 Botzmine Engine 24/7 Started Successfully!");
} else {
    console.error("❌ FIREBASE_URL missing!");
}
