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
// ⚙️ SETTINGS & ANTI-BAN LOGIC (UPDATED)
// ==========================================
async function getSettings() {
    const data = await fbGet('settings');
    // ⚠️ ڈیلی لمٹ اور ٹائم کوڈ میں فکس کر دیا گیا ہے تاکہ اینٹی بین کام کر سکے
    return { 
        messageTemplate: data?.messageTemplate || "Hello, this is a message from Botzmine!", 
        dailyLimitPerDevice: 35, // روزانہ 30 سے 35 میسجز کی لمٹ
        minDelayMinutes: 15,     // کم از کم 15 منٹ کا وقفہ
        maxDelayMinutes: 20      // زیادہ سے زیادہ 20 منٹ کا وقفہ
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

// 📊 یہ فنکشن مخصوص ڈیوائس (نمبر) کا ڈیٹا ڈیٹا بیس میں اپڈیٹ کرتا ہے
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
                console.log(`[${deviceId}] 🛑 Daily limit (35 messages) reached. Sleeping until tomorrow...`);
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
            
            console.log(`[${deviceId}] ✍️ Emulating human typing for ${phone}...`);
            await sock.presenceSubscribe(jid);
            await sock.sendPresenceUpdate('composing', jid);
            
            // ٹائپنگ کا ٹائم اصلی انسان کی طرح 5 سے 8 سیکنڈ رکھا گیا ہے
            const typingTime = Math.floor(Math.random() * (8000 - 5000 + 1)) + 5000;
            await new Promise(resolve => setTimeout(resolve, typingTime));
            
            await sock.sendPresenceUpdate('paused', jid);
            
            await sock.sendMessage(jid, { text: settings.messageTemplate });
            
            await fbPatch(`numbers/${rawPhone}`, { 
                status: 'sent', sentBy: deviceId, timestamp: new Date().toISOString() 
            });
            console.log(`[${deviceId}] ✅ Sent successfully to: ${phone}`);
            
            // 🚨 15 to 20 Minutes Anti-Ban Delay (سٹکٹر اینٹی بین ڈیلے)
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
// 📱 DYNAMIC DEVICE MANAGER (QR LINK & PAIRING CODE)
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
        // 🛡️ واٹس ایپ میں "Botzmine Web" شو ہوگا تاکہ اصلی براؤزر لاگ ان لگے
        browser: ['Botzmine Web', 'Chrome', '122.0.0.0'], 
        syncFullHistory: false,
        qrTimeout: 50000 // ⏳ QR Code Expiry set to 50 Seconds
    });

    let pairingCodeRequested = false;

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        // 📷 1. GENERATE QR CODE LINK
        if (qr) {
            const qrApiLink = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(qr)}`;
            console.log(`[${phoneNumberId}] 📷 NEW QR LINK GENERATED! (Expiry: 50s)`);
            
            await fbPatch(`qrcodes/${phoneNumberId}`, { 
                qr_link: qrApiLink, 
                last_updated: new Date().toISOString() 
            });
            await fbPatch(`bot_requests/${phoneNumberId}`, { 
                qr: qrApiLink, 
                status: 'waiting_for_scan_or_code',
                last_updated: new Date().toISOString() 
            });
            await fbPatch(`devices/${phoneNumberId}`, { status: 'qr_ready' });

            // 🔑 2. GENERATE 8-DIGIT PAIRING CODE
            if (!pairingCodeRequested && !sock.authState.creds.registered) {
                pairingCodeRequested = true;
                
                setTimeout(async () => {
                    try {
                        let formattedNumber = phoneNumberId.replace(/\D/g, '');
                        if (formattedNumber.startsWith('0')) {
                            formattedNumber = '92' + formattedNumber.substring(1);
                        }

                        console.log(`[${phoneNumberId}] 📲 Requesting 8-digit Pairing Code for exact number: ${formattedNumber}...`);
                        
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
        }
        
        // ✅ ON SUCCESSFUL CONNECTION (کنیکٹ ہونے پر یوزر کے نمبر کا سٹیٹس اپڈیٹ ہوگا)
        if (connection === 'open') {
            const botNumber = sock.user.id.split(':')[0];
            console.log(`\n✅ [${phoneNumberId}] SUCCESSFULLY CONNECTED AS ${botNumber} ✅\n`);
            
            await fbDelete(`bot_requests/${phoneNumberId}`);
            await fbDelete(`qrcodes/${phoneNumberId}`);

            // ڈیٹا بیس میں اسی نمبر کو Active/Connected شو کرے گا
            await fbPatch(`devices/${phoneNumberId}`, { 
                status: 'connected', 
                phone: botNumber, // اصلی واٹس ایپ نمبر جس سے لاگ ان ہوا ہے
                device_id: phoneNumberId, // فرنٹ اینڈ سے آیا ہوا نمبر
                connected_at: new Date().toISOString()
            });
            
            startBroadcastWorker(sock, phoneNumberId);
        }
        
        // ❌ ON DISCONNECT / LOGOUT (ڈسکنیکٹ ہونے پر سٹیٹس اپڈیٹ)
        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            console.log(`[${phoneNumberId}] ⚠️ Disconnected. Reason: ${reason}`);
            
            if (reason !== DisconnectReason.loggedOut) {
                await fbPatch(`devices/${phoneNumberId}`, { status: 'reconnecting' });
                activeDevices.delete(phoneNumberId);
                setTimeout(() => startDevice(phoneNumberId), 5000);
            } else {
                console.log(`[${phoneNumberId}] ❌ Logged out. Deleting session & updating status to disconnected...`);
                fs.rmSync(sessionDir, { recursive: true, force: true });
                activeDevices.delete(phoneNumberId);
                await fbDelete(`bot_requests/${phoneNumberId}`);
                await fbDelete(`qrcodes/${phoneNumberId}`);
                
                // یوزر کا اکاؤنٹ لاگ آؤٹ ہونے پر سٹیٹس 'disconnected' ہو جائے گا
                await fbPatch(`devices/${phoneNumberId}`, { 
                    status: 'disconnected', 
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
    console.log("🚀 Botzmine Task System Started! Listening for users & bot requests...");
    
    const checkSystem = async () => {
        // 1. Check New Bot Requests
        let requests = await fbGet('bot_requests');
        if (requests) {
            for (const phoneId in requests) {
                const reqData = requests[phoneId];
                if ((reqData.action === 'generate_qr' || reqData.action === 'generate_code') && reqData.status !== 'waiting_for_scan_or_code' && reqData.status !== 'processing') {
                    await fbPatch(`bot_requests/${phoneId}`, { status: 'processing' });
                    startDevice(phoneId);
                }
            }
        }

        // 2. Check Disconnected/Pending Devices to Restart
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

if (!FIREBASE_URL) { 
    console.error("❌ FIREBASE_URL is missing in .env file!");
    process.exit(1); 
}

pollFirebaseForDevices();
