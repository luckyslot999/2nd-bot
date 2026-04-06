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
        console.error(`Firebase Read Error:`, e.message);
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

async function fbDelete(path) {
    try {
        await fetch(`${FIREBASE_URL}/${path}.json`, { method: 'DELETE' });
    } catch (e) { console.error(`Firebase Delete Error:`, e.message); }
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
    console.log(`[${deviceId}] 🟢 Broadcast Worker activated! Waiting for numbers...`);
    
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
// 📱 DYNAMIC DEVICE MANAGER FOR EARNING APP
// ==========================================
async function startDevice(deviceId) {
    if (activeDevices.has(deviceId)) return;
    activeDevices.add(deviceId);

    console.log(`\n🔄 [${deviceId}] Starting WhatsApp Engine for User...`);

    const sessionDir = `sessions_${deviceId}`;
    if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir);
    
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();
    
    const sock = makeWASocket({
        version, 
        auth: state, 
        printQRInTerminal: true, 
        logger: pino({ level: 'silent' }),
        browser: [`EarningApp - ${deviceId}`, "Chrome", "1.0"] 
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        // 📷 GENERATE & SAVE QR CODE TO FIREBASE (FOR FRONTEND)
        if (qr) {
            const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(qr)}`;
            
            console.log(`[DEVICE: ${deviceId}] 📷 NEW QR GENERATED! Saving to Firebase...`);
            
            // فائر بیس میں اپڈیٹ ہو رہا ہے تاکہ ایپ میں یوزر کو شو ہو سکے
            await fbPatch(`devices/${deviceId}`, { 
                status: 'qr_ready', 
                qrLink: qrImageUrl,
                last_updated: new Date().toISOString() // اس سے ایپ کو پتہ چلے گا کہ نیا QR آیا ہے
            });
        }
        
        if (connection === 'open') {
            const botNumber = sock.user.id.split(':')[0];
            console.log(`\n✅ [${deviceId}] SUCCESSFULLY CONNECTED AS ${botNumber} ✅\n`);
            
            // یوزر کا اکاؤنٹ کنیکٹ ہو گیا ہے، اب آپ کی ایپ اس سٹیٹس کو دیکھ کر ارننگ دے گی
            await fbPatch(`devices/${deviceId}`, { 
                status: 'connected', 
                phone: botNumber, 
                qrLink: null, // کنیکٹ ہونے کے بعد لنک ختم کر دیں
                connected_at: new Date().toISOString()
            });
            startBroadcastWorker(sock, deviceId);
        }
        
        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            console.log(`[${deviceId}] ⚠️ Disconnected. Reason: ${reason}`);
            
            if (reason !== DisconnectReason.loggedOut) {
                // اگر نیٹ کا مسئلہ ہے تو ری کنیکٹ کرے
                await fbPatch(`devices/${deviceId}`, { status: 'reconnecting' });
                activeDevices.delete(deviceId);
                setTimeout(() => startDevice(deviceId), 5000);
            } else {
                // اگر یوزر نے خود واٹس ایپ سے لاگ آؤٹ کر دیا ہے
                console.log(`[${deviceId}] ❌ Logged out. Deleting session and updating Database...`);
                fs.rmSync(sessionDir, { recursive: true, force: true });
                activeDevices.delete(deviceId);
                
                // فائر بیس میں سٹیٹس لاگ آؤٹ کر دیں تاکہ ایپ اس کی ارننگ روک سکے
                await fbPatch(`devices/${deviceId}`, { 
                    status: 'logged_out',
                    qrLink: null,
                    phone: null
                });
            }
        }
    });
    
    sock.ev.on('creds.update', saveCreds);
}

// ==========================================
// 🔄 DYNAMIC SYSTEM POLLING (LISTENS FOR APP USERS)
// ==========================================
async function pollFirebaseForDevices() {
    console.log("🚀 Earning App WhatsApp Engine Started! Listening for users...");
    
    const checkDevices = async () => {
        let devices = await fbGet('devices');
        
        if (!devices) return; // اگر کوئی یوزر نہیں ہے تو ویٹ کرے گا

        // فائر بیس میں موجود تمام یوزرز کی لسٹ چیک کرے گا
        for (const deviceId in devices) {
            const deviceData = devices[deviceId];
            
            // اگر ایپ نے یوزر کا نیا نوڈ بنایا ہے یا ڈسکنیکٹ ہے، اور سسٹم میں ایکٹو نہیں ہے تو اس کو سٹارٹ کرے
            if ((deviceData.status === 'pending' || deviceData.status === 'disconnected') && !activeDevices.has(deviceId)) {
                startDevice(deviceId);
            } 
            // اگر یوزر کا سیشن موجود ہے اور وہ فائر بیس میں "connected" ہے تو بیک گراؤنڈ میں چلاتا رہے
            else if (deviceData.status === 'connected' && !activeDevices.has(deviceId)) {
                startDevice(deviceId);
            }
        }
    };

    await checkDevices();
    
    // ہر 5 سیکنڈ بعد فائر بیس چیک کرے گا کہ کوئی نیا یوزر ایپ سے کنیکٹ ہونے آیا ہے یا نہیں۔
    setInterval(checkDevices, 5000); 
}

if (!FIREBASE_URL) { 
    console.error("❌ FIREBASE_URL is missing in .env file!");
    process.exit(1); 
}

pollFirebaseForDevices();
