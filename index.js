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
// ⚙️ SETTINGS & ANTI-BAN LOGIC (REMAINED SAME)
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
// 🚀 ANTI-BAN BROADCAST WORKER (REMAINED SAME)
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
// 📱 DYNAMIC DEVICE MANAGER (UPDATED QR LOGIC)
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
        
        // 📷 ہر بار جب نیا کیو آر بنے گا تو یہ فائر بیس کے الگ 'qrcodes' نوڈ میں ریپلیس ہو جائے گا
        if (qr) {
            const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(qr)}`;
            
            console.log(`[DEVICE: ${deviceId}] 📷 NEW QR GENERATED! Updating in Firebase 'qrcodes' node...`);
            
            // 1. نیا کیو آر اس کے اپنے نوڈ میں سیو ہو گا (ایپ میں آپ نے اس نوڈ کو Listen کرنا ہے)
            await fbPatch(`qrcodes/${deviceId}`, { 
                qrLink: qrImageUrl,
                rawQr: qr, // یہ فرنٹ اینڈ پر کیو آر لائبریری میں دکھانے کے لیے زیادہ تیز کام کرتا ہے
                last_updated: new Date().toISOString() 
            });

            // 2. ڈیوائس کا سٹیٹس بھی اپڈیٹ کر دیں
            await fbPatch(`devices/${deviceId}`, { 
                status: 'qr_ready'
            });
        }
        
        if (connection === 'open') {
            const botNumber = sock.user.id.split(':')[0];
            console.log(`\n✅ [${deviceId}] SUCCESSFULLY CONNECTED AS ${botNumber} ✅\n`);
            
            // جیسے ہی کنیکٹ ہو، 'qrcodes' والے نوڈ سے کیو آر ڈیلیٹ کر دیں تاکہ ڈیٹا بیس کلین رہے
            await fbDelete(`qrcodes/${deviceId}`);

            // ڈیوائس کا سٹیٹس 'connected' کر دیں تاکہ ایپ ارننگ سٹارٹ کر سکے
            await fbPatch(`devices/${deviceId}`, { 
                status: 'connected', 
                phone: botNumber, 
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
                
                // احتیاطاً کیو آر نوڈ ڈیلیٹ کر دیں
                await fbDelete(`qrcodes/${deviceId}`);

                // فائر بیس میں سٹیٹس لاگ آؤٹ کر دیں
                await fbPatch(`devices/${deviceId}`, { 
                    status: 'logged_out',
                    phone: null
                });
            }
        }
    });
    
    sock.ev.on('creds.update', saveCreds);
}

// ==========================================
// 🔄 DYNAMIC SYSTEM POLLING
// ==========================================
async function pollFirebaseForDevices() {
    console.log("🚀 Earning App WhatsApp Engine Started! Listening for users...");
    
    const checkDevices = async () => {
        let devices = await fbGet('devices');
        
        if (!devices) return;

        for (const deviceId in devices) {
            const deviceData = devices[deviceId];
            
            if ((deviceData.status === 'pending' || deviceData.status === 'disconnected') && !activeDevices.has(deviceId)) {
                startDevice(deviceId);
            } 
            else if (deviceData.status === 'connected' && !activeDevices.has(deviceId)) {
                startDevice(deviceId);
            }
        }
    };

    await checkDevices();
    setInterval(checkDevices, 5000); 
}

if (!FIREBASE_URL) { 
    console.error("❌ FIREBASE_URL is missing in .env file!");
    process.exit(1); 
}

pollFirebaseForDevices();
