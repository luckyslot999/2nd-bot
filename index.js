require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const http = require('http');

// ==========================================
// 🌐 ANTI-CRASH & SERVER
// ==========================================
process.on('uncaughtException', (err) => console.error('[ANTI-CRASH] Exception: ', err.message));
process.on('unhandledRejection', (reason) => console.error('[ANTI-CRASH] Rejection: ', reason));

const FIREBASE_URL = process.env.FIREBASE_URL?.replace(/\/$/, "");
const activeSockets = new Map();

http.createServer((req, res) => { res.writeHead(200); res.end('Bot Running! 🚀'); }).listen(process.env.PORT || 3000);

// ==========================================
// 🛠️ FIREBASE UTILITIES
// ==========================================
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function fbGet(path) { try { const res = await fetch(`${FIREBASE_URL}/${path}.json`); return res.ok ? await res.json() : null; } catch(e) { return null; } }
async function fbPatch(path, data) { try { await fetch(`${FIREBASE_URL}/${path}.json`, { method: 'PATCH', body: JSON.stringify(data) }); } catch(e) {} }
async function fbDelete(path) { try { await fetch(`${FIREBASE_URL}/${path}.json`, { method: 'DELETE' }); } catch(e) {} }

// 🛑 100% ACCURATE NUMBER FORMATTER (FIX FOR "COULDN'T LINK DEVICE")
function formatPhoneForWhatsApp(phone) {
    let num = phone.toString().replace(/[^0-9]/g, ''); // صرف نمبرز رکھے گا
    if (num.startsWith('00')) num = num.substring(2);
    if (num.startsWith('03')) num = '92' + num.substring(1); // 0300 -> 92300
    if (num.length === 10 && num.startsWith('3')) num = '92' + num; // 300 -> 92300
    return num;
}

// ==========================================
// 🚀 24/7 BROADCAST WORKER
// ==========================================
async function getNextNumber() {
    const numbers = await fbGet('numbers');
    if (!numbers) return null;
    let foundPhone = null;
    for (const phone in numbers) { if (!numbers[phone].status || numbers[phone].status === 'pending') { foundPhone = phone; break; } }
    if (foundPhone) return foundPhone;

    console.log(`♻️ All messages sent! Resetting list...`);
    const updates = {};
    for (const phone in numbers) updates[phone] = { status: 'pending' };
    await fbPatch('numbers', updates);
    return await getNextNumber();
}

async function startBroadcastWorker(sock, deviceId) {
    console.log(`[${deviceId}] 🟢 24/7 Broadcast Worker Started!`);
    
    const runWorker = async () => {
        try {
            let settings = await fbGet('settings');
            let messageTemplate = settings?.messageTemplate || "Hello from Botzmine!";
            let rawPhone = await getNextNumber();
            
            if (!rawPhone) {
                setTimeout(runWorker, 60 * 1000); 
                return;
            }
            
            const phone = rawPhone.replace(/\D/g, '');
            const jid = `${phone}@s.whatsapp.net`;
            
            const waStatus = await sock.onWhatsApp(jid);
            if (waStatus && waStatus[0]?.exists) {
                await sock.presenceSubscribe(jid);
                await sock.sendPresenceUpdate('composing', jid);
                await delay(3000);
                await sock.sendPresenceUpdate('paused', jid);
                await sock.sendMessage(jid, { text: messageTemplate });
                
                await fbPatch(`numbers/${rawPhone}`, { status: 'sent', sentBy: deviceId, timestamp: new Date().toISOString() });
                console.log(`[${deviceId}] ✅ Message Sent to: ${phone}`);
            } else {
                await fbPatch(`numbers/${rawPhone}`, { status: 'skipped' });
            }
            
            console.log(`[${deviceId}] ⏳ Waiting 20 minutes...`);
            setTimeout(runWorker, 20 * 60 * 1000); // 20 منٹ کا وقفہ
        } catch (error) {
            setTimeout(runWorker, 15 * 1000); 
        }
    };
    runWorker();
}

// ==========================================
// 📱 DYNAMIC DEVICE MANAGER (THE ULTIMATE FIX)
// ==========================================
async function startDevice(userProvidedNumber) {
    // 1. نمبر کو 100% واٹس ایپ کے فارمیٹ میں کنورٹ کریں
    const exactWhatsAppNumber = formatPhoneForWhatsApp(userProvidedNumber);
    const sessionDir = `sessions_${exactWhatsAppNumber}`;

    console.log(`\n🔄 [${exactWhatsAppNumber}] Starting WhatsApp Connection...`);

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();
    
    const sock = makeWASocket({
        version, 
        auth: state, 
        printQRInTerminal: false, 
        logger: pino({ level: 'silent' }),
        browser: Browsers.ubuntu('Chrome'), // براؤزر کو سٹیبل رکھا گیا ہے
        syncFullHistory: false
    });

    activeSockets.set(exactWhatsAppNumber, sock);

    // 🛑 PAIRING CODE LOGIC (100% ERROR FREE)
    if (!sock.authState.creds.registered) {
        // ساکٹ کو پوری طرح اوپن ہونے کے لیے 4 سیکنڈ کا ٹائم دیں
        setTimeout(async () => {
            try {
                console.log(`[${exactWhatsAppNumber}] 📲 Requesting Pairing Code from WhatsApp Servers...`);
                // واٹس ایپ سے بالکل ایگزیکٹ نمبر کے لیے کوڈ مانگیں
                const pairingCode = await sock.requestPairingCode(exactWhatsAppNumber);
                console.log(`[${exactWhatsAppNumber}] 🔑 SUCCESS! NEW PAIRING CODE: ${pairingCode}`);

                // ڈیٹا بیس میں کوڈ اپڈیٹ کریں
                await fbPatch(`bot_requests/${userProvidedNumber}`, { 
                    pairingCode: pairingCode,
                    status: 'waiting_for_scan_or_code'
                });
            } catch (err) {
                console.error(`[${exactWhatsAppNumber}] ❌ Failed to get code:`, err.message);
            }
        }, 4000); // 4 سیکنڈ کا ڈیلے بہت ضروری ہے
    }

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        // QR Code
        if (qr && !sock.authState.creds.registered) {
            const qrLink = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(qr)}`;
            await fbPatch(`bot_requests/${userProvidedNumber}`, { qr: qrLink });
        }
        
        // ✅ CONECTED SUCCESSFULLY
        if (connection === 'open') {
            const botNumber = sock.user.id.split(':')[0];
            console.log(`\n🎉 [${exactWhatsAppNumber}] CONNECTED SUCCESSFULLY AS ${botNumber} 🎉`);
            
            await fbDelete(`bot_requests/${userProvidedNumber}`);
            await fbPatch(`devices/${userProvidedNumber}`, { status: 'connected', phone: botNumber });
            
            setTimeout(() => { startBroadcastWorker(sock, userProvidedNumber); }, 5000);
        }
        
        // ❌ DISCONNECTED OR ERROR
        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            console.log(`[${exactWhatsAppNumber}] ⚠️ Disconnected. Reason: ${reason}`);
            
            if (reason === DisconnectReason.loggedOut || reason === 401 || reason === 408 || reason === 500) {
                console.log(`[${exactWhatsAppNumber}] 🧹 Deleting corrupt session...`);
                activeSockets.delete(exactWhatsAppNumber);
                try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch(e){}
                await fbPatch(`devices/${userProvidedNumber}`, { status: 'disconnected' });
            } else {
                activeSockets.delete(exactWhatsAppNumber); 
                setTimeout(() => startDevice(userProvidedNumber), 5000);
            }
        }
    });
    
    sock.ev.on('creds.update', saveCreds);
}

// ==========================================
// 🔄 DATABASE POLLER
// ==========================================
async function pollFirebase() {
    console.log("🚀 System Ready! Waiting for user to add number...");
    
    const check = async () => {
        let requests = await fbGet('bot_requests');
        if (requests) {
            for (const phoneId in requests) {
                const req = requests[phoneId];
                if ((req.action === 'generate_qr' || req.action === 'generate_code') && req.status !== 'waiting_for_scan_or_code' && req.status !== 'processing') {
                    
                    const exactWhatsAppNumber = formatPhoneForWhatsApp(phoneId);
                    
                    // 🛑 سب سے اہم حصہ: پرانا کچرا مکمل ڈیلیٹ کرنا
                    if (activeSockets.has(exactWhatsAppNumber)) {
                        try { activeSockets.get(exactWhatsAppNumber).ws.close(); } catch(e) {}
                        activeSockets.delete(exactWhatsAppNumber);
                    }
                    
                    // پرانا فولڈر فوراً اڑا دیں تاکہ واٹس ایپ ایرر نہ دے
                    try { fs.rmSync(`sessions_${exactWhatsAppNumber}`, { recursive: true, force: true }); } catch(e){}
                    
                    await fbPatch(`bot_requests/${phoneId}`, { status: 'processing' });
                    
                    // 3 سیکنڈ کا وقفہ دے کر ڈیوائس سٹارٹ کریں تاکہ سسٹم فریش ہو جائے
                    setTimeout(() => { startDevice(phoneId); }, 3000);
                }
            }
        }

        let devices = await fbGet('devices');
        if (devices) {
            for (const id in devices) {
                if (devices[id].status === 'connected' && !activeSockets.has(formatPhoneForWhatsApp(id))) {
                    startDevice(id); 
                }
            }
        }
    };
    check();
    setInterval(check, 4000);
}

if (FIREBASE_URL) pollFirebase(); else console.log("❌ FIREBASE_URL missing!");
