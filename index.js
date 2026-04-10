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
const activeDevices = new Set();

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
        res.end('Bot is running continuously on Render! 🚀');
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
// ⚙️ SETTINGS & ANTI-BAN LOGIC
// ==========================================
async function getSettings() {
    const data = await fbGet('settings');
    return { 
        messageTemplate: data?.messageTemplate || "Hello, this is a message from Botzmine!", 
        dailyLimitPerDevice: 35, 
        minDelayMinutes: 15,     
        maxDelayMinutes: 20      
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

function formatNumber(phone) {
    return phone.replace(/\D/g, ''); 
}

// 🛠️ BUG FIX: Improved Number Formatting for Pairing Code
function formatPhoneNumberForPairing(phoneNumber) {
    if (!phoneNumber) return '';
    // 1. Remove all spaces, +, -, and any non-numeric characters
    let num = phoneNumber.toString().replace(/\D/g, ''); 
    
    // 2. Fix 0092 to 92
    if (num.startsWith('00')) {
        num = num.substring(2);
    }
    
    // 3. Fix Pakistani local format to international
    if (num.startsWith('03') && num.length === 11) {
        return '92' + num.substring(1);
    } else if (num.startsWith('3') && num.length === 10) {
        return '92' + num;
    }
    
    return num; // Return as is for international numbers
}

// ==========================================
// 🔄 INFINITE LOOP & NUMBER FETCHING LOGIC (UPDATED)
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
// 🚀 ANTI-BAN BROADCAST WORKER
// ==========================================
async function startBroadcastWorker(sock, deviceId) {
    console.log(`[${deviceId}] 🟢 Broadcast Worker activated! Checking for numbers...`);
    
    const runWorker = async () => {
        try {
            const settings = await getSettings();
            let stats = await fbGet(`devices/${deviceId}`);
            const today = new Date().toISOString().split('T')[0];
            
            let sentToday = 0;
            if (stats && stats.date === today) {
                sentToday = stats.sentToday || 0;
            } else {
                await fbPatch(`devices/${deviceId}`, { sentToday: 0, date: today });
            }

            if (sentToday >= settings.dailyLimitPerDevice) {
                const sleepTimeMs = getMsUntilMidnight();
                console.log(`[${deviceId}] 🛑 Daily limit reached. Sleeping until midnight...`);
                setTimeout(runWorker, sleepTimeMs);
                return;
            }
            
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
            await fbPatch(`numbers/${rawPhone}`, { status: 'sent', sentBy: deviceId, timestamp: timestamp, pickedBy: null });
            await fbPatch(`sent_history/${deviceId}`, { [rawPhone]: { timestamp: timestamp } });
            await fbPatch(`devices/${deviceId}`, { sentToday: sentToday + 1, totalSent: (stats?.totalSent || 0) + 1, date: today, lastActive: timestamp, status: 'connected' });

            console.log(`[${deviceId}] ✅ Message Sent Successfully to: ${phone}`);
            
            const delayMs = getRandomDelayMs(settings.minDelayMinutes, settings.maxDelayMinutes);
            console.log(`[${deviceId}] ⏳ Waiting ${(delayMs / 60000).toFixed(1)} minutes before next message...`);
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
    if (activeDevices.has(phoneNumberId)) return;
    activeDevices.add(phoneNumberId);

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

    if (!sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                let formattedNumber = formatPhoneNumberForPairing(phoneNumberId);
                console.log(`[${phoneNumberId}] 🔍 Formatted Number for WA API: "${formattedNumber}"`);
                console.log(`[${phoneNumberId}] 📲 Requesting Pairing Code...`);
                
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
                activeDevices.delete(phoneNumberId);
                await fbDelete(`bot_requests/${phoneNumberId}`);
                await fbDelete(`qrcodes/${phoneNumberId}`);
                await fbPatch(`devices/${phoneNumberId}`, { status: 'disconnected', phone: null });
            } else {
                console.log(`[${phoneNumberId}] 🔄 Attempting to reconnect...`);
                await fbPatch(`devices/${phoneNumberId}`, { status: 'reconnecting' });
                activeDevices.delete(phoneNumberId); 
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
                if ((reqData.action === 'generate_qr' || reqData.action === 'generate_code') && reqData.status !== 'waiting_for_scan_or_code' && reqData.status !== 'processing') {
                    const sessionDir = `sessions_${phoneId}`;
                    // 🛠️ BUG FIX: Ensure old corrupted sessions are completely deleted before generating code
                    if (fs.existsSync(sessionDir)) {
                        console.log(`[${phoneId}] 🧹 Cleaning old session data before new pairing code...`);
                        fs.rmSync(sessionDir, { recursive: true, force: true });
                    }
                    activeDevices.delete(phoneId); // 🛠️ Allow the script to restart fresh

                    await fbPatch(`bot_requests/${phoneId}`, { status: 'processing' });
                    startDevice(phoneId);
                }
            }
        }

        let devices = await fbGet('devices');
        if (devices) {
            for (const deviceId in devices) {
                const deviceData = devices[deviceId];
                if ((deviceData.status === 'pending' || deviceData.status === 'reconnecting') && !activeDevices.has(deviceId)) {
                    startDevice(deviceId);
                } 
                else if (deviceData.status === 'connected' && !activeDevices.has(deviceId)) {
                    startDevice(deviceId);
                }
            }
        }
    };

    await checkSystem();
    setInterval(checkSystem, 5000); 
}

// ==========================================
// 💓 GITHUB ACTIONS HEARTBEAT
// ==========================================
setInterval(() => {
    console.log(`💓 [SYSTEM HEARTBEAT] Active Devices Running: ${activeDevices.size} | Time: ${new Date().toISOString()}`);
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
