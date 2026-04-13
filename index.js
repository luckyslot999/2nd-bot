const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const pino = require('pino');
const admin = require('firebase-admin');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

// ==========================================
// 1. ENVIRONMENT & FIREBASE INITIALIZATION
// ==========================================
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data'); // Mapped to persistent disk in Render

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Initialize Firebase Admin (Using Base64 to safely pass JSON via Env Vars)
if (!process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 || !process.env.FIREBASE_DATABASE_URL) {
    console.error("FATAL: Firebase environment variables are missing!");
    process.exit(1);
}

const serviceAccount = JSON.parse(
    Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8')
);

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL
});
const db = admin.database();

// Active WhatsApp sockets in memory
const sessions = new Map();

// ==========================================
// 2. WHATSAPP CONNECTION LOGIC
// ==========================================
async function startWhatsApp(phoneNumber, isNewLogin = false) {
    const sessionDir = path.join(DATA_DIR, `auth_info_${phoneNumber}`);
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version, isLatest } = await fetchLatestBaileysVersion();

    console.log(`Starting WhatsApp for ${phoneNumber} (v${version.join('.')})`);

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ["Ubuntu", "Chrome", "20.0.04"], // Required for pairing code to work
        generateHighQualityLinkPreview: true
    });

    sessions.set(phoneNumber, sock);

    return new Promise((resolve, reject) => {
        let responseSent = false;

        // Auto-save credentials on update
        sock.ev.on('creds.update', saveCreds);

        // Track user activity to manage the 24-hour rule
        sock.ev.on('messages.upsert', async () => {
            await db.ref(`users/${phoneNumber}/devices/primary`).update({
                lastActivity: Date.now()
            });
        });

        // Connection State Listener
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            // 1. Capture and save QR Code
            if (qr && isNewLogin) {
                try {
                    const qrDataUrl = await QRCode.toDataURL(qr);
                    await db.ref(`users/${phoneNumber}/devices/primary`).update({
                        qrDataUrl,
                        qrRaw: qr,
                        status: 'awaiting_scan',
                        updatedAt: Date.now()
                    });

                    // We don't resolve here yet, we will resolve after generating pairing code
                } catch (err) {
                    console.error("QR Generation Error:", err);
                }
            }

            // 2. Handle Connection Close
            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

                console.log(`Connection closed for ${phoneNumber}. Reconnect: ${shouldReconnect}`);

                if (statusCode === DisconnectReason.loggedOut) {
                    // User logged out from WhatsApp
                    sessions.delete(phoneNumber);
                    fs.rmSync(sessionDir, { recursive: true, force: true });
                    await db.ref(`users/${phoneNumber}/devices/primary`).update({
                        status: 'disconnected',
                        loggedOutAt: Date.now()
                    });
                } else if (shouldReconnect) {
                    // Auto-reconnect
                    setTimeout(() => startWhatsApp(phoneNumber), 5000);
                }
            }

            // 3. Handle Connection Open
            if (connection === 'open') {
                console.log(`Successfully connected: ${phoneNumber}`);
                await db.ref(`users/${phoneNumber}/devices/primary`).update({
                    status: 'connected',
                    lastActivity: Date.now(),
                    connectedAt: Date.now()
                });

                // Send Instant Welcome Message (Only on new login)
                if (isNewLogin) {
                    try {
                        const jid = sock.user.id; 
                        await sock.sendMessage(jid, { text: "🟢 System Online: Bot connected successfully." });
                    } catch (e) {
                        console.error("Failed to send welcome message:", e);
                    }
                }

                if (!responseSent && isNewLogin) {
                    responseSent = true;
                    resolve({ status: 'already_connected' });
                }
            }
        });

        // 4. Generate Pairing Code (If new login & not registered)
        if (isNewLogin && !sock.authState.creds.registered) {
            setTimeout(async () => {
                try {
                    const pairingCode = await sock.requestPairingCode(phoneNumber);
                    
                    // Save to Firebase
                    await db.ref(`users/${phoneNumber}/devices/primary`).update({
                        pairingCode,
                        status: 'awaiting_pairing',
                        updatedAt: Date.now()
                    });

                    if (!responseSent) {
                        responseSent = true;
                        // Fetch the latest QR from DB to return both
                        const snap = await db.ref(`users/${phoneNumber}/devices/primary`).once('value');
                        const data = snap.val();
                        
                        resolve({
                            status: 'pending_auth',
                            phoneNumber,
                            pairingCode,
                            qrDataUrl: data?.qrDataUrl || null
                        });
                    }
                } catch (error) {
                    console.error("Pairing Code Error:", error);
                    if (!responseSent) {
                        responseSent = true;
                        reject(error);
                    }
                }
            }, 3000); // Wait 3 seconds for socket stabilization before requesting code
        } else if (sock.authState.creds.registered && isNewLogin) {
            if (!responseSent) {
                responseSent = true;
                resolve({ status: 'already_connected' });
            }
        }
    });
}

// ==========================================
// 3. BACKGROUND SCHEDULER (Every 20 mins)
// ==========================================
setInterval(async () => {
    console.log("[Scheduler] Running 20-min task...");
    try {
        const [numbersSnap, templatesSnap, usersSnap] = await Promise.all([
            db.ref('numbers').once('value'),
            db.ref('templates').once('value'),
            db.ref('users').once('value')
        ]);

        const numbers = numbersSnap.val() ? Object.values(numbersSnap.val()) : [];
        const templates = templatesSnap.val() ? Object.values(templatesSnap.val()) : [];
        const users = usersSnap.val() || {};

        if (numbers.length === 0 || templates.length === 0) {
            console.log("[Scheduler] No numbers or templates found. Skipping.");
            return;
        }

        const now = Date.now();
        const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

        for (const [phone, userData] of Object.entries(users)) {
            const device = userData?.devices?.primary;
            if (!device || device.status !== 'connected') continue;

            // Enforce 24-Hour Connection Logic
            if (now - (device.lastActivity || 0) > TWENTY_FOUR_HOURS) {
                console.log(`[Scheduler] ${phone} inactive for 24h. Disconnecting.`);
                await db.ref(`users/${phone}/devices/primary`).update({ status: 'disconnected' });
                
                const sock = sessions.get(phone);
                if (sock) {
                    sock.end(new Error("24h Inactivity Timeout"));
                    sessions.delete(phone);
                }
                continue;
            }

            // Send scheduled messages
            const sock = sessions.get(phone);
            if (sock) {
                // Pick random template
                const template = templates[Math.floor(Math.random() * templates.length)];
                
                for (const targetNum of numbers) {
                    try {
                        const jid = `${targetNum}@s.whatsapp.net`;
                        await sock.sendMessage(jid, { text: template });
                        // Delay to prevent rate limiting
                        await new Promise(r => setTimeout(r, 3000));
                    } catch (e) {
                        console.error(`[Scheduler] Failed to send to ${targetNum}:`, e);
                    }
                }
            }
        }
    } catch (error) {
        console.error("[Scheduler] Error:", error);
    }
}, 20 * 60 * 1000); // 20 minutes

// ==========================================
// 4. REST API (Express)
// ==========================================
const app = express();
app.use(cors());
app.use(bodyParser.json());

app.post('/connect', async (req, res) => {
    try {
        const { phoneNumber } = req.body;
        if (!phoneNumber || !/^[0-9]+$/.test(phoneNumber)) {
            return res.status(400).json({ error: "Provide a valid phone number (e.g. 923...)" });
        }

        const result = await startWhatsApp(phoneNumber, true);
        res.status(200).json(result);
    } catch (error) {
        console.error("/connect error:", error);
        res.status(500).json({ error: "Failed to initialize connection" });
    }
});

app.get('/status', async (req, res) => {
    const { phoneNumber } = req.query;
    if (!phoneNumber) return res.status(400).json({ error: "Phone number required" });

    try {
        const snap = await db.ref(`users/${phoneNumber}/devices/primary`).once('value');
        const data = snap.val();
        
        if (!data) return res.status(404).json({ status: "not_found" });

        res.status(200).json({
            status: data.status,
            lastActivity: data.lastActivity,
            connectedAt: data.connectedAt
        });
    } catch (error) {
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// Restore previously connected sessions on startup
async function restoreSessions() {
    try {
        const snap = await db.ref('users').once('value');
        const users = snap.val() || {};
        for (const [phone, userData] of Object.entries(users)) {
            if (userData?.devices?.primary?.status === 'connected') {
                console.log(`Restoring session for ${phone}...`);
                await startWhatsApp(phone, false);
            }
        }
    } catch (error) {
        console.error("Failed to restore sessions:", error);
    }
}

app.listen(PORT, async () => {
    console.log(`🚀 Server running on port ${PORT}`);
    await restoreSessions();
});
