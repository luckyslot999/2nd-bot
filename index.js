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
    } catch (e) { return null; }
}

async function fbPatch(path, data) {
    try {
        await fetch(`${FIREBASE_URL}/${path}.json`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
    } catch (e) { console.error(`Firebase Update Error:`, e); }
}

// ==========================================
// ⚙️ SETTINGS & ANTI-BAN LOGIC
// ==========================================
async function getSettings() {
    const data = await fbGet('settings');
    // اب ہم Min اور Max ڈیلے استعمال کریں گے تاکہ روبوٹک نہ لگے
    return data || { 
        messageTemplate: "Hello, this is a test from SaaS Broadcaster!", 
        dailyLimitPerDevice: 35, 
        minDelayMinutes: 12, // کم از کم 12 منٹ
        maxDelayMinutes: 20  // زیادہ سے زیادہ 20 منٹ
    };
}

// رینڈم ٹائم جنریٹر (روبوٹک بیہیویئر ختم کرنے کے لیے)
function getRandomDelayMs(minMinutes, maxMinutes) {
    const min = minMinutes * 60 * 1000;
    const max = maxMinutes * 60 * 1000;
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

// رات 12 بجے تک کا ٹائم کیلکولیٹ کریں (تاکہ لمٹ پوری ہونے پر ڈیوائس سو جائے)
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
    console.log(`[${deviceId}] 🟢 Worker activated!`);
    
    const runWorker = async () => {
        try {
            const settings = await getSettings();
            
            // 1. چیک کریں کہ آج کی لمٹ تو پوری نہیں ہو گئی؟
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
                console.log(`[${deviceId}] 📂 No numbers right now. Checking in 2 mins...`);
                setTimeout(runWorker, 2 * 60 * 1000);
                return;
            }
            
            const phone = formatNumber(rawPhone);
            const jid = `${phone}@s.whatsapp.net`;
            
            // 2. WhatsApp ویلیڈیشن
            const [waResult] = await sock.onWhatsApp(jid);
            if (!waResult?.exists) {
                console.log(`[${deviceId}] ❌ Invalid number: ${phone}.`);
                await fbPatch(`numbers/${rawPhone}`, { status: 'failed', pickedBy: deviceId });
                setTimeout(runWorker, 5000); 
                return;
            }
            
            // 🔥 3. ANTI-BAN FEATURE: ٹائپنگ شو کریں (Human Behavior)
            console.log(`[${deviceId}] ✍️ Emulating typing for ${phone}...`);
            await sock.presenceSubscribe(jid);
            await sock.sendPresenceUpdate('composing', jid);
            
            // 3 سے 6 سیکنڈ کا رینڈم ٹائم ٹائپنگ کے لیے
            const typingTime = Math.floor(Math.random() * (6000 - 3000 + 1)) + 3000;
            await new Promise(resolve => setTimeout(resolve, typingTime));
            
            await sock.sendPresenceUpdate('paused', jid);
            
            // 4. میسج سینڈ کریں
            await sock.sendMessage(jid, { text: settings.messageTemplate });
            
            await fbPatch(`numbers/${rawPhone}`, { 
                status: 'sent', sentBy: deviceId, timestamp: new Date().toISOString() 
            });
            console.log(`[${deviceId}] ✅ Sent successfully to: ${phone}`);
            
            // 🔥 5. ANTI-BAN FEATURE: Random Delay (رینڈم ڈیلے)
            const delayMs = getRandomDelayMs(settings.minDelayMinutes, settings.maxDelayMinutes);
            const delayMinutesDisplay = (delayMs / 60000).toFixed(1);
            console.log(`[${deviceId}] ⏳ Anti-Ban Delay: Waiting for ${delayMinutesDisplay} minutes before next message...`);
            
            setTimeout(runWorker, delayMs);
            
        } catch (error) {
            console.log(`[${deviceId}] ❌ Worker Error:`, error.message);
            setTimeout(runWorker, 1 * 60 * 1000); 
        }
    };
    
    runWorker();
}

// ==========================================
// 📱 DEVICE MANAGER & POLLING
// ==========================================
async function startDevice(deviceId) {
    if (activeDevices.has(deviceId)) return;
    activeDevices.add(deviceId);

    const sessionDir = `sessions_${deviceId}`;
    if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir);
    
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();
    
    const sock = makeWASocket({
        version, auth: state, printQRInTerminal: true,
        logger: pino({ level: 'silent' }),
        browser: [`SaaS Broadcaster`, "Chrome", "1.0"]
    });
    
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(qr)}`;
            await fbPatch(`devices/${deviceId}`, { status: 'qr_ready', qrLink: qrImageUrl });
        }
        
        if (connection === 'open') {
            const botNumber = sock.user.id.split(':')[0];
            console.log(`✅ [${deviceId}] CONNECTED AS ${botNumber}`);
            await fbPatch(`devices/${deviceId}`, { status: 'connected', phone: botNumber, qrLink: null });
            startBroadcastWorker(sock, deviceId);
        }
        
        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            await fbPatch(`devices/${deviceId}`, { status: 'disconnected' });

            if (reason !== DisconnectReason.loggedOut) {
                activeDevices.delete(deviceId);
                setTimeout(() => startDevice(deviceId), 5000);
            } else {
                fs.rmSync(sessionDir, { recursive: true, force: true });
                activeDevices.delete(deviceId);
            }
        }
    });
    
    sock.ev.on('creds.update', saveCreds);
}

async function pollFirebaseForDevices() {
    console.log("🚀 Starting System with Anti-Ban Logic...");
    setInterval(async () => {
        const devices = await fbGet('devices');
        if (!devices) return;
        for (const deviceId in devices) {
            if (!activeDevices.has(deviceId)) {
                startDevice(deviceId);
            }
        }
    }, 10000);
}

if (!FIREBASE_URL) { process.exit(1); }
pollFirebaseForDevices();
