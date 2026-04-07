// ==========================================
// 📱 DYNAMIC DEVICE MANAGER (QR LINK & PAIRING CODE)
// ==========================================
async function startDevice(phoneNumberId) {
    if (activeDevices.has(phoneNumberId)) return;
    activeDevices.add(phoneNumberId);

    console.log(`\n🔄 [${phoneNumberId}] Starting WhatsApp Engine...`);

    const sessionDir = `sessions_${phoneNumberId}`;
    
    // 🛠️ FIX 1: اگر سیشن رجسٹرڈ نہیں ہے تو شروع میں ہی فولڈر کلین کر دیں تاکہ کوئی پرانا کچرا نہ رہے
    if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir);
    }

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

    // 🛠️ FIX 2: Pairing Code کی ریکویسٹ QR ایونٹ سے باہر نکال دی گئی ہے
    // جب سوکٹ (socket) بنے، اور اگر وہ رجسٹرڈ نہ ہو، تو 4 سیکنڈ بعد صرف ایک بار کوڈ منگوائیں
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
        }, 4000); // 4 سیکنڈ کا انتظار تاکہ Baileys پوری طرح لوڈ ہو جائے
    }

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        // 📷 1. GENERATE QR CODE LINK (اب اس کے اندر کوڈ کی ریکویسٹ نہیں ہے)
        if (qr) {
            const qrApiLink = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(qr)}`;
            console.log(`[${phoneNumberId}] 📷 NEW QR LINK GENERATED!`);
            
            await fbPatch(`qrcodes/${phoneNumberId}`, { 
                qr_link: qrApiLink, 
                last_updated: new Date().toISOString() 
            });
            
            // صرف QR لنک اپڈیٹ کریں، pairing code کو مت چھیڑیں
            await fbPatch(`bot_requests/${phoneNumberId}`, { 
                qr: qrApiLink, 
                status: 'waiting_for_scan_or_code',
                last_updated: new Date().toISOString() 
            });
            await fbPatch(`devices/${phoneNumberId}`, { status: 'qr_ready' });
        }
        
        // ✅ ON SUCCESSFUL CONNECTION
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
        
        // ❌ ON DISCONNECT / LOGOUT
        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            console.log(`[${phoneNumberId}] ⚠️ Disconnected. Reason: ${reason}`);
            
            if (reason !== DisconnectReason.loggedOut) {
                await fbPatch(`devices/${phoneNumberId}`, { status: 'reconnecting' });
                activeDevices.delete(phoneNumberId);
                setTimeout(() => startDevice(phoneNumberId), 5000);
            } else {
                console.log(`[${phoneNumberId}] ❌ Logged out. Deleting session...`);
                fs.rmSync(sessionDir, { recursive: true, force: true });
                activeDevices.delete(phoneNumberId);
                await fbDelete(`bot_requests/${phoneNumberId}`);
                await fbDelete(`qrcodes/${phoneNumberId}`);
                
                await fbPatch(`devices/${phoneNumberId}`, { 
                    status: 'disconnected', 
                    phone: null 
                });
            }
        }
    });
    
    sock.ev.on('creds.update', saveCreds);
}
