require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const http = require('http'); // 🌐 Node.js Built-in HTTP

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
const activeSockets = new Map(); // 🛠️ Dynamic Socket Manager
const activeWorkers = new Set(); // 🚀 24/7 Worker Tracking

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
        res.end('Botzmine System is running 24/7! 🚀 No Limits.');
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
// ⚙️ SETTINGS & UTILS
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
// 🔄 SMART NUMBER FETCHING (LOCKS NUMBER)
// ==========================================
async function getAndLockNextNumber(deviceId) {
    const numbers = await fbGet('numbers');
    if (!numbers) return null;

    let foundPhone = null;
    let hasAnyNumber = Object.keys(numbers).length > 0;

    for (const phone in numbers) {
        const status = numbers[phone].status;
        
        // صرف وہ نمبر اٹھائے گا جو pending ہے یا جس کا اسٹیٹس نہیں ہے۔
        if (!status || status === 'pending') {
            foundPhone = phone;
            break; 
        }
    }

    if (foundPhone) {
        // 🔒 فوراً processing پر سیٹ کریں تاکہ کوئی اور لوپ اسے نہ پکڑے
        await fbPatch(`numbers/${foundPhone}`, { status: 'processing', pickedBy: deviceId });
        return foundPhone;
    }

    // اگر تمام نمبرز ختم ہو جائیں تو دوبارہ ری سیٹ کر دے
    if (hasAnyNumber) {
        console.log(`\n♻️ [AUTO-LOOP] All targets finished! Resetting all numbers back to pending...\n`);
        const updates = {};
        for (const phone in numbers) {
            updates[phone] = { status: 'pending', sentBy: null, timestamp: null, pickedBy: null };
        }
        await fbPatch('numbers', updates);
        await delay(5000); // Wait before retrying
        return await getAndLockNextNumber(deviceId);
    }

    return null; 
}

// ==========================================
// 🚀 UNLIMITED LIFETIME BROADCAST WORKER (7x24 HOURS)
// ==========================================
async function startBroadcastWorker(deviceId) {
    // 🛑 Prevent multiple overlapping workers
    if (activeWorkers.has(deviceId)) return;
    activeWorkers.add(deviceId);

    console.log(`[${deviceId}] 🟢 24/7 Broadcast Worker activated! Running Unstoppable mode...`);
    
    while (true) {
        let rawPhone = null; // Declare here so catch block can access it
        
        try {
            // 🛑 چیک کریں کہ ورکر کینسل تو نہیں کر دیا گیا (Logout کی صورت میں)
            if (!activeWorkers.has(deviceId)) {
                console.log(`[${deviceId}] 🛑 Worker safely terminated.`);
                break;
            }

            // 🔥 ڈائنامک ساکٹ (Dynamic Socket) حاصل کریں: 
            // اگر ساکٹ ری کنیکٹ ہوتا ہے تو یہ ہمیشہ نیا اور ایکٹیو ساکٹ ہی استعمال کرے گا
            const sock = activeSockets.get(deviceId);
            if (!sock || sock === 'initializing') {
                console.log(`[${deviceId}] ⚠️ Socket not ready. Worker waiting 15s...`);
                await delay(15000);
                continue;
            }

            const settings = await getSettings();
            
            // نمبر اٹھائیں اور لاک کریں
            rawPhone = await getAndLockNextNumber(deviceId);
            
            if (!rawPhone) {
                await delay(15 * 1000); // کوئی نمبر نہیں ملا تو 15 سیکنڈ رکے گا
                continue;
            }
            
            const phone = formatNumber(rawPhone);
            const jid = `${phone}@s.whatsapp.net`;
            
            // Timeout preventer (اگر واٹس ایپ کا API فریز ہو جائے)
            const waStatus = await Promise.race([
                sock.onWhatsApp(jid),
                delay(10000).then(() => 'TIMEOUT') 
            ]);

            if (waStatus === 'TIMEOUT') {
                throw new Error('WhatsApp API Timeout - Network issue or socket disconnected.');
            }

            if (!waStatus || waStatus.length === 0 || !waStatus[0].exists) {
                console.log(`[${deviceId}] ⏩ Skipped (No WhatsApp): ${phone}`);
                await fbPatch(`numbers/${rawPhone}`, { status: 'skipped_no_wa', pickedBy: null });
                await delay(3000); 
                continue;
            }
            
            console.log(`[${deviceId}] ✍️ Sending message to ${phone}...`);
            
            // Typing effect
            try {
                await sock.presenceSubscribe(jid);
                await sock.sendPresenceUpdate('composing', jid);
                const typingTime = Math.floor(Math.random() * (5000 - 3000 + 1)) + 3000;
                await delay(typingTime);
                await sock.sendPresenceUpdate('paused', jid);
            } catch (e) {
                console.log(`[${deviceId}] ⚠️ Presence update ignored (Privacy settings).`);
            }
            
            // 📩 میسج بھیجنا
            await sock.sendMessage(jid, { text: settings.messageTemplate });
            
            const timestamp = new Date().toISOString();
            
            // فائر بیس اپڈیٹ 
            await fbPatch(`numbers/${rawPhone}`, { status: 'sent', sentBy: deviceId, timestamp: timestamp, pickedBy: null });
            await fbPatch(`sent_history/${deviceId}`, { [rawPhone]: { timestamp: timestamp } });
            
            let stats = await fbGet(`devices/${deviceId}`);
            await fbPatch(`devices/${deviceId}`, { totalSent: (stats?.totalSent || 0) + 1, lastActive: timestamp, status: 'connected' });

            console.log(`[${deviceId}] ✅ Message Sent Successfully to: ${phone}`);
            
            // ⏳ ٹھیک 20 منٹ کا ڈیلے (Anti-Ban safety)
            const delayMs = 20 * 60 * 1000; // 20 Minutes
            console.log(`[${deviceId}] ⏳ Waiting 20 minutes before sending the next message...`);
            await delay(delayMs);
            
        } catch (error) {
            console.log(`[${deviceId}] ❌ Worker Loop Error:`, error.message);
            // 🔄 اگر کوئی ایرر آئے تو نمبر کو واپس pending کر دے تاکہ ضائع نہ ہو
            if (rawPhone) {
                console.log(`[${deviceId}] 🔄 Reverting ${rawPhone} back to pending due to error.`);
                await fbPatch(`numbers/${rawPhone}`, { status: 'pending', pickedBy: null });
            }
            await delay(15 * 1000); // Wait 15s on error before trying again
        }
    }
}

// ==========================================
// 📱 DYNAMIC DEVICE MANAGER (24/7 STABILITY)
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
        generateHighQualityLinkPreview: false,
        keepAliveIntervalMs: 30000, // 💡 Keeps connection alive 24/7
        retryRequestDelayMs: 5000
    });

    // 🔥 یہ ساکٹ اب ڈائنامک میپ میں سیو ہو گیا ہے جسے ورکر لوپ بار بار چیک کرے گا
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
            await fbPatch(`bot_requests/${phoneNumberId}`, { qr: qrApiLink, status: 'waiting_for_scan_or_code', last_updated: new Date().toISOString() });
            await fbPatch(`devices/${phoneNumberId}`, { status: 'qr_ready' });
        }
        
        if (connection === 'open') {
            const botNumber = sock.user.id.split(':')[0];
            console.log(`\n✅ [${phoneNumberId}] SUCCESSFULLY CONNECTED AS ${botNumber} ✅`);
            
            await fbDelete(`bot_requests/${phoneNumberId}`);
            await fbDelete(`qrcodes/${phoneNumberId}`);

            await fbPatch(`devices/${phoneNumberId}`, { status: 'connected', phone: botNumber, device_id: phoneNumberId, connected_at: new Date().toISOString() });
            
            console.log(`[${phoneNumberId}] ⏳ Stabilizing WhatsApp encryption keys...`);
            setTimeout(() => { 
                // ورکر کو اسٹارٹ کریں (صرف ڈیوائس آئی ڈی پاس کریں، ساکٹ خود اٹھائے گا)
                startBroadcastWorker(phoneNumberId); 
            }, 5000);
        }
        
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const reason = statusCode || DisconnectReason.connectionClosed;
            console.log(`[${phoneNumberId}] ⚠️ Disconnected. Reason: ${reason}`);
            
            if (reason === DisconnectReason.loggedOut || reason === 401 || reason === 403) {
                console.log(`[${phoneNumberId}] ❌ Logged out or Banned. Cleaning up...`);
                fs.rmSync(sessionDir, { recursive: true, force: true });
                activeSockets.delete(phoneNumberId);
                activeWorkers.delete(phoneNumberId); // 🛑 Stop the worker loop
                await fbDelete(`bot_requests/${phoneNumberId}`);
                await fbDelete(`qrcodes/${phoneNumberId}`);
                await fbPatch(`devices/${phoneNumberId}`, { status: 'disconnected', phone: null });
            } else {
                console.log(`[${phoneNumberId}] 🔄 Background Reconnecting...`);
                await fbPatch(`devices/${phoneNumberId}`, { status: 'reconnecting' });
                // ساکٹ کو میپ سے ہٹائیں، ری کنیکٹ ہونے پر نیا ساکٹ بن کر میپ میں اپڈیٹ ہو جائے گا
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
                    console.log(`[${phoneId}] 🔄 New Pairing Request Received!`);
                    await fbPatch(`bot_requests/${phoneId}`, { action: 'processing', status: 'processing' });

                    const sessionDir = `sessions_${phoneId}`;
                    
                    if (activeSockets.has(phoneId)) {
                        console.log(`[${phoneId}] 🛑 Killing old socket...`);
                        const oldSock = activeSockets.get(phoneId);
                        if (oldSock && oldSock.ws) oldSock.ws.close(); 
                        activeSockets.delete(phoneId);
                        activeWorkers.delete(phoneId);
                    }

                    if (fs.existsSync(sessionDir)) {
                        console.log(`[${phoneId}] 🧹 Cleaning old session data...`);
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
                if ((deviceData.status === 'pending' || deviceData.status === 'reconnecting' || deviceData.status === 'connected') && !activeSockets.has(deviceId)) {
                    startDevice(deviceId);
                }
            }
        }
    };

    await checkSystem();
    setInterval(checkSystem, 10000); 
}

// ==========================================
// 💓 SERVER HEARTBEAT
// ==========================================
setInterval(() => {
    console.log(`💓 [HEARTBEAT] Active Devices: ${activeSockets.size} | Active Workers: ${activeWorkers.size} | Time: ${new Date().toISOString()}`);
}, 5 * 60 * 1000); 

// ==========================================
// 🚀 INITIALIZATION
// ==========================================
if (!FIREBASE_URL) { 
    console.error("❌ FIREBASE_URL is missing in .env file! Bot logic will not run.");
} else {
    try {
        pollFirebaseForDevices();
    } catch (error) {
        console.error("❌ Critical Error starting Bot System: ", error);
    }
}
