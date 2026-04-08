require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');

// ==========================================
// 🛡️ ANTI-CRASH (GLOBAL ERROR HANDLERS)
// ==========================================
process.on('uncaughtException', function (err) {
    console.error('Caught exception: ', err.message);
});
process.on('unhandledRejection', (reason, p) => {
    console.error('Unhandled Rejection at: Promise', p, 'reason:', reason);
});

const FIREBASE_URL = process.env.FIREBASE_URL?.replace(/\/$/, "");
const activeDevices = new Set();

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
            if (i === retries - 1) {
                console.error(`Firebase Read Error (${path}):`, e.message);
                return null;
            }
            await delay(2000); // Wait 2 seconds before retrying
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
            return; // Success
        } catch (e) {
            if (i === retries - 1) console.error(`Firebase Update Error (${path}):`, e.message);
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
            if (i === retries - 1) console.error(`Firebase Delete Error (${path}):`, e.message);
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
        console.log(`\n♻️ [AUTO-LOOP] All numbers processed! Resetting targets...\n`);
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
    
    // Strict date check to reset daily counter
    if (!stats || stats.date !== today) {
        stats = { ...stats, sentToday: 0, date: today };
        await fbPatch(`devices/${deviceId}`, { sentToday: 0, date: today }); // Force save new date
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
                // FIX: If no number found, check again in 15 seconds (Not 2 minutes)
                setTimeout(runWorker, 15 * 1000); 
                return;
            }
            
            const phone = formatNumber(rawPhone);
            const jid = `${phone}@s.whatsapp.net`;
            
            const [waResult] = await sock.onWhatsApp(jid);
            if (!waResult?.exists) {
                console.log(`[${deviceId}] ❌ Invalid number: ${phone}. Marking as failed.`);
                await fbPatch(`numbers/${rawPhone}`, { status: 'failed', pickedBy: deviceId });
                setTimeout(runWorker, 5000); 
                return;
            }
            
            console.log(`[${deviceId}] ✍️ Emulating human typing for ${phone}...`);
            await sock.presenceSubscribe(jid);
            await sock.sendPresenceUpdate('composing', jid);
            
            const typingTime = Math.floor(Math.random() * (8000 - 5000 + 1)) + 5000;
            await delay(typingTime);
            
            await sock.sendPresenceUpdate('paused', jid);
            await sock.sendMessage(jid, { text: settings.messageTemplate });
            
            await fbPatch(`numbers/${rawPhone}`, { 
                status: 'sent', sentBy: deviceId, timestamp: new Date().toISOString() 
            });
            console.log(`[${deviceId}] ✅ Sent successfully to: ${phone}`);
            
            const delayMs = getRandomDelayMs(settings.minDelayMinutes, settings.maxDelayMinutes);
            const delayMinutesDisplay = (delayMs / 60000).toFixed(1);
            console.log(`[${deviceId}] ⏳ Waiting ${delayMinutesDisplay} minutes before next message...`);
            
            setTimeout(runWorker, delayMs);
            
        } catch (error) {
            console.log(`[${deviceId}] ❌ Worker Error:`, error.message);
            // FIX: If an error occurs, retry quickly in 15 seconds
            setTimeout(runWorker, 15 * 1000); 
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
        browser: Browsers.ubuntu('Chrome'), 
        syncFullHistory: false,
        qrTimeout: 50000 
    });

    if (!sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                let formattedNumber = formatPhoneNumberForPairing(phoneNumberId);
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

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            const qrApiLink = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(qr)}`;
            console.log(`[${phoneNumberId}] 📷 NEW QR LINK GENERATED!`);
            
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
        }
        
        if (connection === 'open') {
            const botNumber = sock.user.id.split(':')[0];
            console.log(`\n✅ [${phoneNumberId}] SUCCESSFULLY CONNECTED AS ${botNumber} ✅\n`);
            
            await fbDelete(`bot_requests/${phoneNumberId}`);
            await fbDelete(`qrcodes/${phoneNumberId}`);

            await fbPatch(`devices/${phoneNumberId}`, { 
                status: 'connected', 
                phone: botNumber, 
                device_id: phoneNumberId, 
                connected_at: new Date().toISOString()
            });
            
            startBroadcastWorker(sock, phoneNumberId);
        }
        
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const reason = statusCode || DisconnectReason.connectionClosed;
            console.log(`[${phoneNumberId}] ⚠️ Disconnected. Reason: ${reason}`);
            
            // Logged out or banned (401)
            if (reason === DisconnectReason.loggedOut || reason === 401) {
                console.log(`[${phoneNumberId}] ❌ Logged out or session invalid. Deleting session...`);
                fs.rmSync(sessionDir, { recursive: true, force: true });
                activeDevices.delete(phoneNumberId);
                await fbDelete(`bot_requests/${phoneNumberId}`);
                await fbDelete(`qrcodes/${phoneNumberId}`);
                
                await fbPatch(`devices/${phoneNumberId}`, { 
                    status: 'disconnected', 
                    phone: null 
                });
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
    console.log("🚀 Botzmine Task System Started! Listening for users & bot requests...");
    
    const checkSystem = async () => {
        let requests = await fbGet('bot_requests');
        if (requests) {
            for (const phoneId in requests) {
                const reqData = requests[phoneId];
                if ((reqData.action === 'generate_qr' || reqData.action === 'generate_code') && reqData.status !== 'waiting_for_scan_or_code' && reqData.status !== 'processing') {
                    
                    const sessionDir = `sessions_${phoneId}`;
                    if (fs.existsSync(sessionDir)) {
                        fs.rmSync(sessionDir, { recursive: true, force: true });
                    }

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
}, 5 * 60 * 1000); // Logs every 5 minutes so GitHub actions doesn't think it's frozen

if (!FIREBASE_URL) { 
    console.error("❌ FIREBASE_URL is missing in .env file!");
    process.exit(1); 
}

pollFirebaseForDevices();
