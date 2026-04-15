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
const activeSockets = new Map(); // 🛠️ Active Connections Map
const activeWorkers = new Map(); // 🛠️ Prevent Duplicate Loops

// ==========================================
// 🌐 NATIVE HTTP SERVER (FOR RENDER 24/7 UPTIME)
// ==========================================
const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
    if (req.url === '/ping') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('pong');
    } else {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Botzmine is running perfectly 24/7 on Render! 🚀');
    }
});

server.listen(PORT, () => {
    console.log(`🌐 Web server is listening on port ${PORT}`);
});

// ==========================================
// 🛠️ FIREBASE UTILITY FUNCTIONS
// ==========================================
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function fbGet(path, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const res = await fetch(`${FIREBASE_URL}/${path}.json`);
            if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
            return await res.json();
        } catch (e) {
            if (i === retries - 1) return null;
            await delay(2000);
        }
    }
}

async function fbPatch(path, data, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const res = await fetch(`${FIREBASE_URL}/${path}.json`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
            if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
            return;
        } catch (e) {
            if (i === retries - 1) return;
            await delay(2000);
        }
    }
}

async function fbDelete(path, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const res = await fetch(`${FIREBASE_URL}/${path}.json`, { method: 'DELETE' });
            if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
            return;
        } catch (e) {
            if (i === retries - 1) return;
            await delay(2000);
        }
    }
}

// ==========================================
// ⚙️ SETTINGS 
// ==========================================
async function getSettings() {
    const data = await fbGet('settings');
    return { 
        messageTemplate: data?.messageTemplate || "Hello, this is a message from Botzmine!" 
    };
}

function formatNumber(phone) {
    return phone.replace(/\D/g, ''); 
}

function formatPhoneNumberForPairing(phoneNumber) {
    let num = phoneNumber.toString().replace(/\D/g, ''); 
    if (num.startsWith('03')) {
        return '92' + num.substring(1);
    } else if (num.startsWith('3') && num.length === 10) {
        return '92' + num;
    }
    return num;
}

// ==========================================
// 🔄 INFINITE LOOP & NUMBER FETCHING LOGIC 
// ==========================================
async function getNextPendingNumber() {
    const numbers = await fbGet('numbers');
    if (!numbers) return null;

    let foundPhone = null;
    let hasAnyNumber = false;

    for (const phone in numbers) {
        hasAnyNumber = true;
        const status = numbers[phone].status;
        
        if (!status || status === 'pending') {
            foundPhone = phone;
            break; 
        }
    }

    if (foundPhone) return foundPhone;

    if (hasAnyNumber) {
        console.log(`\n♻️ [AUTO-LOOP] All targets finished! Resetting all numbers back to pending...\n`);
        const updates = {};
        for (const phone in numbers) {
            updates[phone] = { status: 'pending', sentBy: null, timestamp: null, pickedBy: null };
        }
        await fbPatch('numbers', updates);
        return await getNextPendingNumber();
    }

    return null; 
}

// ==========================================
// 🚀 ROBUST LIFETIME BROADCAST WORKER
// ==========================================
async function startBroadcastWorker(deviceId) {
    // 🛑 Prevent multiple loops for the same device
    if (activeWorkers.get(deviceId)) {
        console.log(`[${deviceId}] ⚠️ Worker already running. Skipping duplicate.`);
        return;
    }
    
    activeWorkers.set(deviceId, true);
    console.log(`[${deviceId}] 🟢 Broadcast Worker activated! Running Lifetime mode...`);
    
    const runWorker = async () => {
        // If device gets disconnected, stop this loop
        if (!activeWorkers.get(deviceId)) return; 

        try {
            // Get the MOST RECENT socket (avoids using dead sockets)
            const sock = activeSockets.get(deviceId);
            if (!sock || sock === 'initializing') {
                setTimeout(runWorker, 10000); // Wait 10s if socket isn't ready
                return;
            }

            // 🕒 SMART 20-MINUTE DELAY CHECKER (Render-Safe)
            let stats = await fbGet(`devices/${deviceId}`);
            if (stats && stats.lastActive) {
                const lastSentTime = new Date(stats.lastActive).getTime();
                const currentTime = Date.now();
                const diffMinutes = (currentTime - lastSentTime) / (1000 * 60);

                if (diffMinutes < 20) {
                    // Agar 20 minute pure nahi hue, to 1 minute baad dobara check karega
                    // Is se Render par setTimeout freez nahi hoga.
                    setTimeout(runWorker, 60 * 1000); 
                    return;
                }
            }
            
            // نمبر اٹھانا
            let rawPhone = await getNextPendingNumber();
            
            if (!rawPhone) {
                setTimeout(runWorker, 15 * 1000); 
                return;
            }
            
            // Prevent others from picking this number
            await fbPatch(`numbers/${rawPhone}`, { status: 'processing', pickedBy: deviceId });

            const phone = formatNumber(rawPhone);
            const jid = `${phone}@s.whatsapp.net`;
            
            const waStatus = await sock.onWhatsApp(jid);
            if (!waStatus || waStatus.length === 0 || !waStatus[0].exists) {
                console.log(`[${deviceId}] ⏩ Skipped (No WhatsApp): ${phone}`);
                await fbPatch(`numbers/${rawPhone}`, { status: 'skipped_no_wa', pickedBy: null });
                setTimeout(runWorker, 5000); 
                return;
            }
            
            console.log(`[${deviceId}] ✍️ Sending message to ${phone}...`);
            const settings = await getSettings();

            await sock.presenceSubscribe(jid);
            await sock.sendPresenceUpdate('composing', jid);
            
            const typingTime = Math.floor(Math.random() * (5000 - 3000 + 1)) + 3000;
            await delay(typingTime);
            
            await sock.sendPresenceUpdate('paused', jid);
            await sock.sendMessage(jid, { text: settings.messageTemplate });
            
            const timestamp = new Date().toISOString();
            
            // فائر بیس اپڈیٹ 
            await fbPatch(`numbers/${rawPhone}`, { status: 'sent', sentBy: deviceId, timestamp: timestamp, pickedBy: null });
            await fbPatch(`sent_history/${deviceId}`, { [rawPhone]: { timestamp: timestamp } });
            await fbPatch(`devices/${deviceId}`, { totalSent: (stats?.totalSent || 0) + 1, lastActive: timestamp, status: 'connected' });

            console.log(`[${deviceId}] ✅ Message Sent Successfully to: ${phone}`);
            console.log(`[${deviceId}] ⏳ Waiting 20 minutes before sending the next message...`);
            
            // 1 منٹ بعد لوپ دوبارہ چلے گی اور اوپر موجود ٹائم چیکر اسے 20 منٹ تک روکے رکھے گا
            setTimeout(runWorker, 60 * 1000);
            
        } catch (error) {
            console.log(`[${deviceId}] ❌ Worker Error:`, error.message);
            // Agar message block ho ya net issue ho, 15 second baad retry kare
            setTimeout(runWorker, 15 * 1000); 
        }
    };
    
    runWorker();
}

// ==========================================
// 📱 DYNAMIC DEVICE MANAGER
// ==========================================
async function startDevice(phoneNumberId) {
    if (activeSockets.has(phoneNumberId) && activeSockets.get(phoneNumberId) === 'initializing') return;
    activeSockets.set(phoneNumberId, 'initializing');

    console.log(`\n🔄 [${phoneNumberId}] Starting WhatsApp Engine...`);

    const sessionDir = `sessions_${phoneNumberId}`;
    if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
    }
    
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();
    
    const sock = makeWASocket({
        version, 
        auth: state, 
        printQRInTerminal: false, 
        logger: pino({ level: 'silent' }),
        browser: Browsers.ubuntu('Chrome'), 
        syncFullHistory: false,
        qrTimeout: 50000,
        generateHighQualityLinkPreview: false,
        markOnlineOnConnect: true // Keeps account active
    });

    activeSockets.set(phoneNumberId, sock); 

    if (!sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                let formattedNumber = formatPhoneNumberForPairing(phoneNumberId);
                console.log(`[${phoneNumberId}] 📲 Requesting Pairing Code for: ${formattedNumber}...`);
                const pairingCode = await sock.requestPairingCode(formattedNumber);
                console.log(`[${phoneNumberId}] 🔑 PAIRING CODE GENERATED: ${pairingCode}`);

                await fbPatch(`bot_requests/${phoneNumberId}`, { 
                    pairingCode: pairingCode,
                    status: 'waiting_for_scan_or_code',
                    last_updated: new Date().toISOString() 
                });
            } catch (err) {
                console.error(`[${phoneNumberId}] ❌ Pairing Code Error:`, err.message);
            }
        }, 4000); // 4 Sec delay gives Baileys time to connect fully before requesting
    }

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            const qrApiLink = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(qr)}`;
            console.log(`[${phoneNumberId}] 📷 NEW QR LINK GENERATED!`);
            
            await fbPatch(`qrcodes/${phoneNumberId}`, { qr_link: qrApiLink, last_updated: new Date().toISOString() });
            
            await fbPatch(`bot_requests/${phoneNumberId}`, { 
                qr: qrApiLink, 
                status: 'waiting_for_scan_or_code',
                last_updated: new Date().toISOString() 
            });
            await fbPatch(`devices/${phoneNumberId}`, { status: 'qr_ready' });
        }
        
        if (connection === 'open') {
            const botNumber = sock.user.id.split(':')[0];
            console.log(`\n✅ [${phoneNumberId}] SUCCESSFULLY CONNECTED AS ${botNumber} ✅`);
            
            await fbDelete(`bot_requests/${phoneNumberId}`);
            await fbDelete(`qrcodes/${phoneNumberId}`);

            await fbPatch(`devices/${phoneNumberId}`, { status: 'connected', phone: botNumber, device_id: phoneNumberId, connected_at: new Date().toISOString() });
            
            console.log(`[${phoneNumberId}] ⏳ Stabilizing... starting worker in 10 seconds.`);
            setTimeout(() => { startBroadcastWorker(phoneNumberId); }, 10000);
        }
        
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const reason = statusCode || DisconnectReason.connectionClosed;
            console.log(`[${phoneNumberId}] ⚠️ Disconnected. Reason: ${reason}`);
            
            // 🛑 Kill the old worker to prevent loop crashing
            activeWorkers.set(phoneNumberId, false); 

            if (reason === DisconnectReason.loggedOut || reason === 401 || reason === 403) {
                console.log(`[${phoneNumberId}] ❌ Logged out. Deleting session...`);
                try { sock.ws.close(); } catch(e){} // Force close websocket
                activeSockets.delete(phoneNumberId);
                await delay(2000); // Wait for file locks to release
                if (fs.existsSync(sessionDir)) {
                    fs.rmSync(sessionDir, { recursive: true, force: true });
                }
                await fbDelete(`bot_requests/${phoneNumberId}`);
                await fbDelete(`qrcodes/${phoneNumberId}`);
                await fbPatch(`devices/${phoneNumberId}`, { status: 'disconnected', phone: null });
            } else {
                console.log(`[${phoneNumberId}] 🔄 Attempting to reconnect...`);
                await fbPatch(`devices/${phoneNumberId}`, { status: 'reconnecting' });
                activeSockets.delete(phoneNumberId); 
                setTimeout(() => startDevice(phoneNumberId), 5000);
            }
        }
    });
    
    sock.ev.on('creds.update', saveCreds);
}

// ==========================================
// 🔄 DYNAMIC SYSTEM POLLING
// ==========================================
async function pollFirebaseForDevices() {
    console.log("🚀 Botzmine Task System Started! Listening for users...");
    
    const checkSystem = async () => {
        let requests = await fbGet('bot_requests');
        if (requests) {
            for (const phoneId in requests) {
                const reqData = requests[phoneId];
                
                if (reqData.action === 'generate_qr' || reqData.action === 'generate_code') {
                    
                    console.log(`[${phoneId}] 🔄 New Pairing Request Received! Processing Fresh Connection...`);
                    
                    await fbPatch(`bot_requests/${phoneId}`, { action: 'processing', status: 'processing' });

                    const sessionDir = `sessions_${phoneId}`;
                    
                    // 🛑 Properly Kill Old Session
                    activeWorkers.set(phoneId, false); // Stop worker
                    if (activeSockets.has(phoneId)) {
                        console.log(`[${phoneId}] 🛑 Killing old socket to prevent conflicts...`);
                        const oldSock = activeSockets.get(phoneId);
                        try { oldSock.ev.removeAllListeners(); } catch(e){}
                        try { oldSock.ws.close(); } catch(e){}
                        activeSockets.delete(phoneId);
                    }

                    await delay(3000); // Give system time to release files lock

                    if (fs.existsSync(sessionDir)) {
                        console.log(`[${phoneId}] 🧹 Cleaning old session data...`);
                        try {
                            fs.rmSync(sessionDir, { recursive: true, force: true });
                        } catch (err) {
                            console.log(`[${phoneId}] ⚠️ File lock issue, skipping delete...`, err.message);
                        }
                    }

                    startDevice(phoneId);
                }
            }
        }

        let devices = await fbGet('devices');
        if (devices) {
            for (const deviceId in devices) {
                const deviceData = devices[deviceId];
                if ((deviceData.status === 'pending' || deviceData.status === 'reconnecting') && !activeSockets.has(deviceId)) {
                    startDevice(deviceId);
                } 
                else if (deviceData.status === 'connected' && !activeSockets.has(deviceId)) {
                    startDevice(deviceId);
                }
            }
        }
    };

    await checkSystem();
    setInterval(checkSystem, 5000); 
}

// ==========================================
// 💓 SERVER HEARTBEAT
// ==========================================
setInterval(() => {
    console.log(`💓 [SYSTEM HEARTBEAT] Active Devices Running: ${activeSockets.size} | Time: ${new Date().toISOString()}`);
}, 5 * 60 * 1000); 

// ==========================================
// 🚀 STARTUP
// ==========================================
if (!FIREBASE_URL) { 
    console.error("❌ FIREBASE_URL is missing in .env file!");
} else {
    try {
        pollFirebaseForDevices();
    } catch (error) {
        console.error("❌ Critical Error starting Bot System: ", error);
    }
}
