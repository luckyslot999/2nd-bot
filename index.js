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
    res.end('Botzmine WhatsApp Bot is running... 🚀 (24/7 Edition)');
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

    // Auto-Reset Loop for 24/7 Continuity
    console.log(`♻️ [AUTO-LOOP] All numbers sent. Resetting for 24/7 continuous cycle...`);
    const updates = {};
    for (const phone in numbers) {
        updates[phone] = { status: 'pending', sentBy: null };
    }
    await fbPatch('numbers', updates);
    return getNextPendingNumber(); // Restart loop
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

            // Update Database: Mark Number Sent & Update Device Stats
            await fbPatch(`numbers/${rawPhone}`, { status: 'sent', sentBy: deviceId, timestamp });
            await fbPatch(`devices/${deviceId}`, { 
                totalSent: (stats?.totalSent || 0) + 1, 
                date: today, 
                lastActive: timestamp, // Link proven active!
                status: 'connected' 
            });

            console.log(`[${deviceId}] ✅ Successfully sent to ${phone}. Next in ${settings.delayMinutes} mins.`);
            setTimeout(runWorker, settings.delayMinutes * 60 * 1000); 
            
        } catch (error) {
            console.log(`[${deviceId}] ❌ Worker Error (Will auto-retry):`, error.message);
            setTimeout(runWorker, 20000); // Non-Stop Retry
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
        keepAliveIntervalMs: 30000, // 24/7 Link Protection
        markOnlineOnConnect: true
    });

    activeSockets.set(phoneNumberId, sock);

    // 🔑 Pairing Code Generator (Original & Working)
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
                    console.log(`[${phoneNumberId}] 🔑 PAIRING CODE GENERATED: ${pairingCode}`);
                }
            } catch (err) { console.error("Pairing Error:", err.message); }
        }, 4000); 
    }

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        // 🔳 100% FIXED QR CODE LINK GENERATOR (GUARANTEED)
        if (qr) {
            // سب سے پہلے کچے کوڈ (2@G0rlx...) کو انکوڈ کر رہے ہیں تاکہ لنک ٹوٹے نہ
            const encodedQr = encodeURIComponent(qr);
            
            // یہاں ایگزیکٹ (Exact) وہی لنک بن رہا ہے جو آپ نے مجھے دیا ہے
            const finalQrLink = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodedQr}`;
            
            console.log(`[${phoneNumberId}] 🔗 Sending FULL URL to Firebase: ${finalQrLink}`);
            
            // فائر بیس میں اب یہ پورا https والا کلک ایبل لنک سیو ہوگا
            await fbPatch(`bot_requests/${phoneNumberId}`, { 
                qrCode: finalQrLink, 
                status: 'waiting_for_scan_or_code'
            });
        }

        if (connection === 'open') {
            console.log(`✅ [${phoneNumberId}] WA CONNECTED SECURELY`);
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
                console.log(`❌ [${phoneNumberId}] LOGGED OUT BY USER.`);
                if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
                await fbPatch(`devices/${phoneNumberId}`, { status: 'disconnected' });
            } else {
                console.log(`🔄 [${phoneNumberId}] CONNECTION DROPPED. RECONNECTING...`);
                setTimeout(() => startDevice(phoneNumberId), 5000);
            }
        }
    });
    
    sock.ev.on('creds.update', saveCreds);
}

// ==========================================
// 🕒 24-HOUR INACTIVITY & HEARTBEAT SYSTEM
// ==========================================
async function checkInactiveDevices() {
    const devices = await fbGet('devices');
    if (!devices) return;

    const now = new Date().getTime();
    const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

    for (const deviceId in devices) {
        const device = devices[deviceId];
        
        // HEARTBEAT: Prevent auto-disconnect if bot is active in server
        if (activeSockets.has(deviceId) && activeSockets.get(deviceId)?.authState?.creds?.registered) {
            await fbPatch(`devices/${deviceId}`, { lastActive: new Date().toISOString() });
            continue; 
        }

        if (device.status !== 'disconnected' && device.lastActive) {
            const lastActiveTime = new Date(device.lastActive).getTime();
            if (now - lastActiveTime > TWENTY_FOUR_HOURS) {
                console.log(`⚠️ [${deviceId}] No activity for 24h. Cleaning up...`);
                await fbPatch(`devices/${deviceId}`, { status: 'disconnected' });
                if (activeSockets.has(deviceId)) activeSockets.delete(deviceId);
                const sessionDir = `sessions_${deviceId}`;
                if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
            }
        }
    }
}

// ==========================================
// 🔄 SYSTEM POLLING (DATABASE CHECKER)
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

    setInterval(() => checkInactiveDevices(), 60 * 60 * 1000); 
}

// ==========================================
// 🚀 START ENGINE
// ==========================================
if (FIREBASE_URL) {
    pollFirebase();
    console.log("🚀 Botzmine Engine Started! (24/7 Continuity Active)");
} else {
    console.error("❌ FIREBASE_URL is missing in .env!");
}
