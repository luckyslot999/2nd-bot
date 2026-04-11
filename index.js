

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
// ⚙️ SETTINGS (NO DAILY LIMIT & 15 MIN DELAY)
// ==========================================
async function getSettings() {
    const data = await fbGet('settings');
    return { 
        messageTemplate: data?.messageTemplate || "Hello, this is an automated message from Botzmine!", 
        minDelayMinutes: 15,     // 👈 Har 15 Minutes Baad
        maxDelayMinutes: 16      // 👈 15-16 mins k darmian bhejay ga (WhatsApp Ban se bachne k liye)
    };
}

function getRandomDelayMs(minMinutes, maxMinutes) {
    const min = minMinutes * 60 * 1000;
    const max = maxMinutes * 60 * 1000;
    return Math.floor(Math.random() * (max - min + 1)) + min;
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
// 🚀 BROADCAST WORKER (INFINITE LOOP)
// ==========================================
async function startBroadcastWorker(sock, deviceId) {
    const runWorker = async () => {
        try {
            // Check if socket is still active
            if (!activeSockets.has(deviceId)) return;

            const settings = await getSettings();
            let stats = await fbGet(`devices/${deviceId}`);
            const today = new Date().toISOString().split('T')[0];
            
            let rawPhone = await getNextPendingNumber();
            if (!rawPhone) {
                setTimeout(runWorker, 30000); // Agar number nahi hain tou 30 sec baad dubara check kare
                return;
            }
            
            const phone = rawPhone.replace(/\D/g, '');
            const jid = `${phone}@s.whatsapp.net`;
            
            console.log(`[${deviceId}] ✍️ Sending message to ${phone}...`);
            await sock.sendPresenceUpdate('composing', jid);
            await delay(Math.random() * 5000 + 3000);
            await sock.sendMessage(jid, { text: settings.messageTemplate });
            
            // 👈 Ye line 24-hours wale disconnect logic ko refresh karti hai
            const timestamp = new Date().toISOString(); 
            
            await fbPatch(`numbers/${rawPhone}`, { status: 'sent', sentBy: deviceId, timestamp });
            await fbPatch(`devices/${deviceId}`, { 
                totalSent: (stats?.totalSent || 0) + 1, 
                date: today, 
                lastActive: timestamp, 
                status: 'connected' // 👈 Message jatay he permanently connected show hoga
            });

            console.log(`[${deviceId}] ✅ Sent to ${phone}. Next in ~15 mins.`);
            // Infinite lagatar chalta rahega har 15 minute baad
            setTimeout(runWorker, getRandomDelayMs(settings.minDelayMinutes, settings.maxDelayMinutes));
            
        } catch (error) {
            console.log(`[${deviceId}] ❌ Error:`, error.message);
            setTimeout(runWorker, 60000); // Agar koi error aye tou 1 minute baad dubara try kare
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
                // User ne khud WhatsApp se Log out kiya
                console.log(`❌ [${phoneNumberId}] LOGGED OUT BY USER`);
                fs.rmSync(sessionDir, { recursive: true, force: true });
                await fbPatch(`devices/${phoneNumberId}`, { status: 'disconnected' });
            } else {
                // Network drop ki waja se connection close hua (Hum DB mein disconnected nahi show karwayenge)
                console.log(`🔄 [${phoneNumberId}] RECONNECTING IN BACKGROUND...`);
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
    const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000; // 24 Hours in milliseconds

    for (const deviceId in devices) {
        const device = devices[deviceId];
        
        // Agar device pehle se disconnected nahi hai aur uski lastActive detail majood hai
        if (device.status !== 'disconnected' && device.lastActive) {
            const lastActiveTime = new Date(device.lastActive).getTime();
            
            // 👈 Agar pichle 24 ghante mein ek bhi message send nahi hua
            if (now - lastActiveTime > TWENTY_FOUR_HOURS) {
                console.log(`⚠️ [${deviceId}] No message sent for 24 hours. Marking as disconnected...`);
                
                // 1. Firebase mein status update karein
                await fbPatch(`devices/${deviceId}`, { status: 'disconnected' });
                
                // 2. Memory mein se active socket khatam karein
                if (activeSockets.has(deviceId)) {
                    try {
                        const sock = activeSockets.get(deviceId);
                        if (sock && typeof sock.ws?.close === 'function') {
                            sock.ws.close();
                        }
                    } catch (e) {}
                    activeSockets.delete(deviceId);
                }

                // 3. Local session files ko delete karein taake woh dobara connect mangay
                const sessionDir = `sessions_${deviceId}`;
                if (fs.existsSync(sessionDir)) {
                    fs.rmSync(sessionDir, { recursive: true, force: true });
                }
            }
        }
    }
}

// ==========================================
// 🔄 SYSTEM POLLING
// ==========================================
async function pollFirebase() {
    // 10 second delay for regular requests
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

    // Har 5 minute baad 24-hours wala Inactivity Check run hoga
    setInterval(() => {
        checkInactiveDevices();
    }, 5 * 60 * 1000); 
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
