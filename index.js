require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');

const FIREBASE_URL = process.env.FIREBASE_URL?.replace(/\/$/, "");
const activeDevices = new Set();

// ==========================================
// 🛠️ FIREBASE UTILITY FUNCTIONS
// ==========================================
async function fbGet(path) {
    try {
        const res = await fetch(`${FIREBASE_URL}/${path}.json`);
        return await res.json();
    } catch (e) { 
        console.error(`Firebase Read Error on ${path}:`, e.message);
        return null; 
    }
}

async function fbPatch(path, data) {
    try {
        await fetch(`${FIREBASE_URL}/${path}.json`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
    } catch (e) { console.error(`Firebase Update Error:`, e.message); }
}

// ==========================================
// ⚙️ SETTINGS & ANTI-BAN LOGIC
// ==========================================
async function getSettings() {
    const data = await fbGet('settings');
    return data || { 
        messageTemplate: "Hello, this is a test from SaaS Broadcaster!", 
        dailyLimitPerDevice: 35, 
        minDelayMinutes: 12, 
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

async function checkAndResetLoop() {
    const numbers = await fbGet('numbers');
    if (!numbers) return;
    let hasPending = false;
    const updates = {};
    for (const [phone, data] of Object.entries(numbers)) {
        if (data.status === 'pending' || data.status === 'processing') {
            hasPending = true; break;
        }
        updates[phone] = { status: 'pending', sentBy: null, timestamp: null };
    }
    if (!hasPending && Object.keys(updates).length > 0) {
        console.log(`\n♻️ [AUTO-LOOP] All numbers processed! Resetting...\n`);
        await fbPatch('numbers', updates);
    }
}

async function getAndLockPendingNumber(deviceId) {
    const numbers = await fbGet('numbers');
    if (!numbers) return null;
    for (const phone in numbers) {
        if (numbers[phone].status === 'pending') {
            await fbPatch(`numbers/${phone}`, { status: 'processing', pickedBy: deviceId });
            return phone;
        }
    }
    return null;
}

async function checkAndUpdateDeviceLimit(deviceId, maxLimit) {
    const today = new Date().toISOString().split('T')[0];
    let stats = await fbGet(`devices/${deviceId}`);
    
    if (!stats || stats.date !== today) {
        stats = { ...stats, sentToday: 0, date: today };
    }
    
    if (stats.sentToday >= maxLimit) {
        await fbPatch(`devices/${deviceId}`, { status: 'limit_reached' });
        return false;
    }
    
    await fbPatch(`devices/${deviceId}`, { 
        sentToday: stats.sentToday + 1,
        totalSent: (stats.totalSent || 0) + 1,
        date: today,
        lastActive: new Date().toISOString(),
        status: 'connected'
    });
    
    return true;
}

function formatNumber(phone) {
    return phone.replace(/\D/g, ''); 
}

// ==========================================
// 🚀 ANTI-BAN BROADCAST WORKER
// ==========================================
async function startBroadcastWorker(sock, deviceId) {
    console.log(`[${deviceId}] 🟢 Broadcast Worker activated!`);
    
    const runWorker = async () => {
        try {
            const settings = await getSettings();
            
            const canSend = await checkAndUpdateDeviceLimit(deviceId, settings.dailyLimitPerDevice);
            if (!canSend) {
                const sleepTimeMs = getMsUntilMidnight();
                console.log(`[${deviceId}] 🛑 Daily limit reached. Sleeping until tomorrow...`);
                setTimeout(runWorker, sleepTimeMs);
                return;
            }
            
            await checkAndResetLoop(); 
            let rawPhone = await getAndLockPendingNumber(deviceId);
            
            if (!rawPhone) {
                // console.log(`[${deviceId}] 📂 No numbers right now. Checking in 2 mins...`);
                setTimeout(runWorker, 2 * 60 * 1000);
                return;
            }
            
            const phone = formatNumber(rawPhone);
            const jid = `${phone}@s.whatsapp.net`;
            
            const [waResult] = await sock.onWhatsApp(jid);
            if (!waResult?.exists) {
                console.log(`[${deviceId}] ❌ Invalid number: ${phone}.`);
                await fbPatch(`numbers/${rawPhone}`, { status: 'failed', pickedBy: deviceId });
                setTimeout(runWorker, 5000); 
                return;
            }
            
            console.log(`[${deviceId}] ✍️ Emulating typing for ${phone}...`);
            await sock.presenceSubscribe(jid);
            await sock.sendPresenceUpdate('composing', jid);
            
            const typingTime = Math.floor(Math.random() * (6000 - 3000 + 1)) + 3000;
            await new Promise(resolve => setTimeout(resolve, typingTime));
            
            await sock.sendPresenceUpdate('paused', jid);
            
            await sock.sendMessage(jid, { text: settings.messageTemplate });
            
            await fbPatch(`numbers/${rawPhone}`, { 
                status: 'sent', sentBy: deviceId, timestamp: new Date().toISOString() 
            });
            console.log(`[${deviceId}] ✅ Sent successfully to: ${phone}`);
            
            const delayMs = getRandomDelayMs(settings.minDelayMinutes, settings.maxDelayMinutes);
            const delayMinutesDisplay = (delayMs / 60000).toFixed(1);
            console.log(`[${deviceId}] ⏳ Anti-Ban Delay: Waiting for ${delayMinutesDisplay} minutes...`);
            
            setTimeout(runWorker, delayMs);
            
        } catch (error) {
            console.log(`[${deviceId}] ❌ Worker Error:`, error.message);
            setTimeout(runWorker, 1 * 60 * 1000); 
        }
    };
    
    runWorker();
}

// ==========================================
// 📱 DEVICE MANAGER (QR & PAIRING CODE)
// ==========================================
async function startDevice(deviceId, deviceData) {
    if (activeDevices.has(deviceId)) return;
    activeDevices.add(deviceId);

    console.log(`[${deviceId}] 🔄 Initializing session...`);

    const sessionDir = `sessions_${deviceId}`;
    if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir);
    
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();
    
    // Check if user wants to use Pairing Code (If pairingNumber exists in Firebase)
    const usePairingCode = !!deviceData.pairingNumber;
    
    const sock = makeWASocket({
        version, 
        auth: state, 
        printQRInTerminal: !usePairingCode, // Print QR only if NOT using pairing code
        logger: pino({ level: 'silent' }),
        // For pairing code, Baileys requires a specific browser signature
        browser: usePairingCode ? ["Ubuntu", "Chrome", "20.0.04"] : [`SaaS Broadcaster`, "Chrome", "1.0"]
    });

    // 🔢 GENERATE PAIRING CODE
    if (usePairingCode && !sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                console.log(`[${deviceId}] ⏳ Requesting Pairing Code for: ${deviceData.pairingNumber}...`);
                let code = await sock.requestPairingCode(deviceData.pairingNumber);
                code = code?.match(/.{1,4}/g)?.join("-") || code; // Format: ABCD-EFGH
                console.log(`\n============================================`);
                console.log(`[${deviceId}] 🔢 YOUR PAIRING CODE: ${code}`);
                console.log(`============================================\n`);
                
                // Save code to Firebase so you can see it in your Web Panel
                await fbPatch(`devices/${deviceId}`, { 
                    status: 'awaiting_pairing', 
                    pairingCode: code,
                    qrLink: null 
                });
            } catch (err) {
                console.error(`[${deviceId}] ❌ Failed to get Pairing Code:`, err.message);
            }
        }, 3000);
    }

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        // 📷 GENERATE QR CODE (If pairing code is not used)
        if (qr && !usePairingCode) {
            console.log(`[${deviceId}] 📷 QR Code Generated! Scan it now.`);
            const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(qr)}`;
            await fbPatch(`devices/${deviceId}`, { 
                status: 'qr_ready', 
                qrLink: qrImageUrl,
                pairingCode: null 
            });
        }
        
        if (connection === 'open') {
            const botNumber = sock.user.id.split(':')[0];
            console.log(`✅ [${deviceId}] SUCCESSFULLY CONNECTED AS ${botNumber}`);
            await fbPatch(`devices/${deviceId}`, { 
                status: 'connected', 
                phone: botNumber, 
                qrLink: null,
                pairingCode: null 
            });
            startBroadcastWorker(sock, deviceId);
        }
        
        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            console.log(`[${deviceId}] ⚠️ Disconnected. Reason: ${reason}`);
            await fbPatch(`devices/${deviceId}`, { status: 'disconnected' });

            if (reason !== DisconnectReason.loggedOut) {
                activeDevices.delete(deviceId);
                setTimeout(() => startDevice(deviceId, deviceData), 5000); // Reconnect auto
            } else {
                console.log(`[${deviceId}] ❌ Logged out. Deleting session...`);
                fs.rmSync(sessionDir, { recursive: true, force: true });
                activeDevices.delete(deviceId);
            }
        }
    });
    
    sock.ev.on('creds.update', saveCreds);
}

// ==========================================
// 🔄 SYSTEM POLLING (MAIN LOOP)
// ==========================================
async function pollFirebaseForDevices() {
    console.log("🚀 Starting System with Multi-Device & Pairing Code Logic...");
    
    setInterval(async () => {
        const devices = await fbGet('devices');
        if (!devices) {
            // Uncomment line below if you want to see polling status in GitHub Actions
            // console.log("⏳ Waiting for devices in Firebase..."); 
            return;
        }
        
        for (const [deviceId, deviceData] of Object.entries(devices)) {
            if (!activeDevices.has(deviceId)) {
                startDevice(deviceId, deviceData);
            }
        }
    }, 10000); // Checks every 10 seconds
}

if (!FIREBASE_URL) { 
    console.error("❌ FIREBASE_URL is missing in .env file!");
    process.exit(1); 
}

pollFirebaseForDevices();
