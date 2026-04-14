require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const http = require('http'); // 🌐 Node.js Built-in HTTP (100% Error Free for Render)

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
const activeSockets = new Map(); // 🛠️ Zombie Socket Killer Manager

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
        res.end('Bot is running continuously on Render! 🚀 No Limits, 24/7 Messaging.');
    }
});

server.listen(PORT, () => {
    console.log(`🌐 Web server is listening on port ${PORT} (Prevents Render Deploy Failures)`);
});

// ==========================================
// 🛠️ FIREBASE UTILITY FUNCTIONS (WITH AUTO-RETRY)
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
        
        if (!status || status === 'pending' || status === 'processing') {
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
// 🚀 UNLIMITED LIFETIME BROADCAST WORKER (EVERY 20 MINS)
// ==========================================
async function startBroadcastWorker(sock, deviceId) {
    console.log(`[${deviceId}] 🟢 Broadcast Worker activated! Running Lifetime mode...`);
    
    const runWorker = async () => {
        try {
            const settings = await getSettings();
            
            // نمبر اٹھانا
            let rawPhone = await getNextPendingNumber();
            
            if (!rawPhone) {
                setTimeout(runWorker, 15 * 1000); 
                return;
            }
            
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
            
            let stats = await fbGet(`devices/${deviceId}`);
            await fbPatch(`devices/${deviceId}`, { totalSent: (stats?.totalSent || 0) + 1, lastActive: timestamp, status: 'connected' });

            console.log(`[${deviceId}] ✅ Message Sent Successfully to: ${phone}`);
            
            // ⏳ ٹھیک 20 منٹ کا ڈیلے
            const delayMs = 20 * 60 * 1000; // 20 Minutes
            console.log(`[${deviceId}] ⏳ Waiting 20 minutes before sending the next message...`);
            setTimeout(runWorker, delayMs);
            
        } catch (error) {
            console.log(`[${deviceId}] ❌ Worker Error:`, error.message);
            setTimeout(runWorker, 15 * 1000); 
        }
    };
    runWorker();
}

// ==========================================
// 📱 DYNAMIC DEVICE MANAGER
// ==========================================
async function startDevice(phoneNumberId) {
    if (activeSockets.has(phoneNumberId) && activeSockets.get(phoneNumberId) !== 'initializing') return;
    activeSockets.set(phoneNumberId, 'initializing');

    console.log(`\n🔄 [${phoneNumberId}] Starting WhatsApp Engine...`);

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
        syncFullHistory: false,
        qrTimeout: 50000,
        generateHighQualityLinkPreview: false
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
        }, 3000); 
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
            
            console.log(`[${phoneNumberId}] ⏳ Stabilizing WhatsApp encryption keys... waiting 10 seconds.`);
            setTimeout(() => { startBroadcastWorker(sock, phoneNumberId); }, 10000);
        }
        
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const reason = statusCode || DisconnectReason.connectionClosed;
            console.log(`[${phoneNumberId}] ⚠️ Disconnected. Reason: ${reason}`);
            
            if (reason === DisconnectReason.loggedOut || reason === 401) {
                console.log(`[${phoneNumberId}] ❌ Logged out. Deleting session...`);
                fs.rmSync(sessionDir, { recursive: true, force: true });
                activeSockets.delete(phoneNumberId);
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
                
                // 🛑 اپڈیٹ: اگر یوزر دوبارہ generate_code کی ریکویسٹ بھیجے تو پچھلا سیشن ختم کر کے نیا بنائے گا
                if (reqData.action === 'generate_qr' || reqData.action === 'generate_code') {
                    
                    console.log(`[${phoneId}] 🔄 New Pairing Request Received! Processing Fresh Connection...`);
                    
                    // ایکشن کو فورا processing کر دیں تاکہ لوپ نہ بنے
                    await fbPatch(`bot_requests/${phoneId}`, { action: 'processing', status: 'processing' });

                    const sessionDir = `sessions_${phoneId}`;
                    
                    if (activeSockets.has(phoneId)) {
                        console.log(`[${phoneId}] 🛑 Killing old background socket to prevent conflicts...`);
                        const oldSock = activeSockets.get(phoneId);
                        if (oldSock && oldSock.ws) {
                            oldSock.ws.close(); 
                        }
                        activeSockets.delete(phoneId);
                    }

                    if (fs.existsSync(sessionDir)) {
                        console.log(`[${phoneId}] 🧹 Cleaning old session data before new pairing code...`);
                        fs.rmSync(sessionDir, { recursive: true, force: true });
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
// 💓 GITHUB ACTIONS / SERVER HEARTBEAT
// ==========================================
setInterval(() => {
    console.log(`💓 [SYSTEM HEARTBEAT] Active Devices Running: ${activeSockets.size} | Time: ${new Date().toISOString()}`);
}, 5 * 60 * 1000); 

// ==========================================
// 🚀 INITIALIZATION WRAPPED IN TRY-CATCH
// ==========================================
if (!FIREBASE_URL) { 
    console.error("❌ FIREBASE_URL is missing in .env file! Bot logic will not run, but web server remains online.");
} else {
    try {
        pollFirebaseForDevices();
    } catch (error) {
        console.error("❌ Critical Error starting Bot System: ", error);
    }
}
