require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const http = require('http');

// ==========================================
// 🛡️ ANTI-CRASH (GLOBAL ERROR HANDLERS)
// ==========================================
process.on('uncaughtException', (err) => console.error('🛡️ [ANTI-CRASH] Exception: ', err.message));
process.on('unhandledRejection', (reason) => console.error('🛡️ [ANTI-CRASH] Rejection: ', reason));

const FIREBASE_URL = process.env.FIREBASE_URL?.replace(/\/$/, "");
const activeSockets = new Map();
const activeTimeouts = new Map(); // 50 سیکنڈ والے لوپ کو کنٹرول کرنے کے لیے

// ==========================================
// 🌐 WEB SERVER (FOR 24/7 UPTIME)
// ==========================================
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Botzmine 24/7 Node Server Running! 🚀');
}).listen(process.env.PORT || 3000, () => console.log(`🌐 Server running on port ${process.env.PORT || 3000}`));

// ==========================================
// 🛠️ FIREBASE UTILITIES
// ==========================================
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function fbGet(path) {
    try { const res = await fetch(`${FIREBASE_URL}/${path}.json`); return res.ok ? await res.json() : null; } catch(e) { return null; }
}
async function fbPatch(path, data) {
    try { await fetch(`${FIREBASE_URL}/${path}.json`, { method: 'PATCH', body: JSON.stringify(data) }); } catch(e) {}
}
async function fbDelete(path) {
    try { await fetch(`${FIREBASE_URL}/${path}.json`, { method: 'DELETE' }); } catch(e) {}
}

function formatPhoneForPairing(phone) {
    let num = phone.toString().replace(/\D/g, ''); 
    if (num.startsWith('03')) return '92' + num.substring(1);
    if (num.startsWith('3') && num.length === 10) return '92' + num;
    return num;
}

// ==========================================
// 🚀 24/7 BROADCAST WORKER (EVERY 20 MINS)
// ==========================================
async function getNextNumber() {
    const numbers = await fbGet('numbers');
    if (!numbers) return null;
    let foundPhone = null;
    for (const phone in numbers) {
        if (!numbers[phone].status || numbers[phone].status === 'pending') { foundPhone = phone; break; }
    }
    if (foundPhone) return foundPhone;

    console.log(`♻️ All numbers finished! Resetting back to pending for continuous loop...`);
    const updates = {};
    for (const phone in numbers) updates[phone] = { status: 'pending' };
    await fbPatch('numbers', updates);
    return await getNextNumber();
}

async function startBroadcastWorker(sock, deviceId) {
    console.log(`[${deviceId}] 🟢 24/7 Broadcast Worker Activated!`);
    
    const runWorker = async () => {
        try {
            let settings = await fbGet('settings');
            let messageTemplate = settings?.messageTemplate || "Hello from Botzmine!";
            
            let rawPhone = await getNextNumber();
            if (!rawPhone) {
                console.log(`[${deviceId}] No numbers found, waiting 1 minute...`);
                setTimeout(runWorker, 60 * 1000); 
                return;
            }
            
            const phone = rawPhone.replace(/\D/g, '');
            const jid = `${phone}@s.whatsapp.net`;
            
            const waStatus = await sock.onWhatsApp(jid);
            if (!waStatus || waStatus.length === 0 || !waStatus[0].exists) {
                console.log(`[${deviceId}] ⏩ Skipped (No WhatsApp): ${phone}`);
                await fbPatch(`numbers/${rawPhone}`, { status: 'skipped' });
                setTimeout(runWorker, 5000); 
                return;
            }
            
            await sock.presenceSubscribe(jid);
            await sock.sendPresenceUpdate('composing', jid);
            await delay(3000);
            await sock.sendPresenceUpdate('paused', jid);
            
            await sock.sendMessage(jid, { text: messageTemplate });
            
            await fbPatch(`numbers/${rawPhone}`, { status: 'sent', sentBy: deviceId, timestamp: new Date().toISOString() });
            console.log(`[${deviceId}] ✅ Message Sent to: ${phone}`);
            
            // ⏳ EXACTLY 20 MINUTES DELAY (24/7 NON STOP)
            console.log(`[${deviceId}] ⏳ Waiting 20 minutes before next message...`);
            setTimeout(runWorker, 20 * 60 * 1000); 
            
        } catch (error) {
            console.log(`[${deviceId}] ❌ Worker Error:`, error.message);
            setTimeout(runWorker, 10 * 1000); 
        }
    };
    runWorker(); // Start immediately upon connection
}

// ==========================================
// 📱 DYNAMIC DEVICE MANAGER (50 SECONDS AUTO-LOOP)
// ==========================================
async function startDevice(phoneNumberId) {
    console.log(`\n🔄 [${phoneNumberId}] Initializing WhatsApp Engine...`);

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
        syncFullHistory: false
    });

    activeSockets.set(phoneNumberId, sock);
    let isConnected = false;

    // 🕒 50 SECONDS AUTO-REGENERATE LOOP
    if (!sock.authState.creds.registered) {
        
        // Clear old timeout if any
        if(activeTimeouts.has(phoneNumberId)) clearTimeout(activeTimeouts.get(phoneNumberId));

        const timeoutId = setTimeout(async () => {
            if (!isConnected) {
                console.log(`\n⏳ [${phoneNumberId}] 50 Seconds passed! Generating new QR & Pairing Code...`);
                try { sock.ws.close(); } catch(e){}
                activeSockets.delete(phoneNumberId);
                try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch(e){} // Delete old session
                
                await delay(1000); // Breathe
                startDevice(phoneNumberId); // 🔄 RESTART PROCESS
            }
        }, 50000); // 50 Seconds

        activeTimeouts.set(phoneNumberId, timeoutId);

        // Request Pairing Code after a short 3s delay to ensure socket is ready
        setTimeout(async () => {
            try {
                let formattedNumber = formatPhoneForPairing(phoneNumberId);
                const pairingCode = await sock.requestPairingCode(formattedNumber);
                console.log(`[${phoneNumberId}] 🔑 NEW PAIRING CODE: ${pairingCode} (Valid for 50s)`);

                await fbPatch(`bot_requests/${phoneNumberId}`, { 
                    pairingCode: pairingCode,
                    status: 'waiting_for_scan_or_code'
                });
            } catch (err) {}
        }, 3000);
    }

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        // 📷 GENERATE QR
        if (qr && !isConnected) {
            const qrLink = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(qr)}`;
            console.log(`[${phoneNumberId}] 📷 NEW QR GENERATED (Valid for 50s)`);
            await fbPatch(`bot_requests/${phoneNumberId}`, { qr: qrLink, status: 'waiting_for_scan_or_code' });
        }
        
        // ✅ SUCCESSFUL CONNECTION
        if (connection === 'open') {
            isConnected = true;
            // Stop the 50 second auto-loop
            if(activeTimeouts.has(phoneNumberId)) {
                clearTimeout(activeTimeouts.get(phoneNumberId));
                activeTimeouts.delete(phoneNumberId);
            }

            const botNumber = sock.user.id.split(':')[0];
            console.log(`\n🎉 [${phoneNumberId}] SUCCESSFULLY CONNECTED AS ${botNumber} 🎉`);
            
            // 💾 SAVE TO DATABASE AS CONNECTED
            await fbDelete(`bot_requests/${phoneNumberId}`);
            await fbPatch(`devices/${phoneNumberId}`, { 
                status: 'connected', 
                phone: botNumber, 
                connected_at: new Date().toISOString() 
            });
            
            // 🚀 START 24/7 BROADCAST (Sends first message immediately)
            console.log(`[${phoneNumberId}] ⏳ Initializing Broadcast...`);
            setTimeout(() => { startBroadcastWorker(sock, phoneNumberId); }, 5000);
        }
        
        // ❌ DISCONNECTED / ERROR
        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            
            if (reason === DisconnectReason.loggedOut || reason === 401 || reason === 408) {
                console.log(`[${phoneNumberId}] ❌ Disconnected. Wiping session...`);
                try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch(e){}
                activeSockets.delete(phoneNumberId);
                await fbPatch(`devices/${phoneNumberId}`, { status: 'disconnected' });
            } else if(isConnected) {
                // Only try to auto-reconnect if it was previously successfully connected
                console.log(`[${phoneNumberId}] 🔄 Network Drop. Reconnecting...`);
                activeSockets.delete(phoneNumberId); 
                setTimeout(() => startDevice(phoneNumberId), 5000);
            }
        }
    });
    
    sock.ev.on('creds.update', saveCreds);
}

// ==========================================
// 🔄 DATABASE POLLER
// ==========================================
async function pollFirebase() {
    console.log("🚀 System Listening for New WhatsApp Connections...");
    
    const check = async () => {
        let requests = await fbGet('bot_requests');
        if (requests) {
            for (const phoneId in requests) {
                const req = requests[phoneId];
                if ((req.action === 'generate_qr' || req.action === 'generate_code') && req.status !== 'waiting_for_scan_or_code' && req.status !== 'processing') {
                    
                    if (activeSockets.has(phoneId)) {
                        try { activeSockets.get(phoneId).ws.close(); } catch(e) {}
                        activeSockets.delete(phoneId);
                    }
                    try { fs.rmSync(`sessions_${phoneId}`, { recursive: true, force: true }); } catch(e){}
                    
                    await fbPatch(`bot_requests/${phoneId}`, { status: 'processing' });
                    startDevice(phoneId);
                }
            }
        }

        let devices = await fbGet('devices');
        if (devices) {
            for (const id in devices) {
                if (devices[id].status === 'connected' && !activeSockets.has(id)) {
                    startDevice(id); // Auto-start already connected devices on server restart
                }
            }
        }
    };
    check();
    setInterval(check, 3000); // Check DB every 3 seconds
}

if (FIREBASE_URL) pollFirebase(); else console.log("❌ FIREBASE_URL missing!");
