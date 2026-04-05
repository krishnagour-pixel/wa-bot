const express = require('express');
const cors = require('cors');
const { Client, RemoteAuth } = require('whatsapp-web.js');
const { MongoStore } = require('wwebjs-mongo');
const mongoose = require('mongoose');
const qrcodeTerminal = require('qrcode-terminal');
const qrcode = require('qrcode');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

let dashboardClients = [];

app.get('/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    const clientId = Date.now();
    dashboardClients.push({ id: clientId, res });
    req.on('close', () => { dashboardClients = dashboardClients.filter(c => c.id !== clientId); });
});

function broadcastEvent(data) {
    dashboardClients.forEach(client => client.res.write(`data: ${JSON.stringify(data)}\n\n`));
}

let lastQR = null;
let status = 'Waiting for DB...';

let client;
const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
    console.error('❌ MONGODB_URI is not set! Please set it in Render Environment Variables.');
} else {
    mongoose.connect(MONGODB_URI).then(() => {
        console.log('✅ Connected to MongoDB completely!');
        const store = new MongoStore({ mongoose: mongoose });
        
        client = new Client({
            authStrategy: new RemoteAuth({
                store: store,
                backupSyncIntervalMs: 300000 
            }),
            puppeteer: {
                executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null,
                args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
            }
        });

        client.on('remote_session_saved', () => {
            console.log('✅ Session permanently backed up to MongoDB successfully!');
        });

        client.on('qr', (qr) => {
            lastQR = qr;
            status = 'Waiting for Scan...';
            console.log('\n\n==================================================');
            console.log('✅ PLEASE SCAN THIS QR CODE IN THE WHATSAPP APP ✅');
            console.log('==================================================\n');
            qrcodeTerminal.generate(qr, { small: true });
        });

        client.on('ready', () => {
            lastQR = null;
            status = 'Connected';
            console.log('🎉 HABUILD WHATSAPP BOT IS READY AND CONNECTED! 🎉');
        });

        client.on('authenticated', () => {
            status = 'Authenticated';
            console.log('Authenticated...');
        });

        client.on('auth_failure', () => {
            status = 'Auth Failure';
            console.error('Auth Failure...');
        });

        client.on('disconnected', () => {
            status = 'Disconnected';
            console.error('Disconnected...');
        });

        client.on('message_reaction', async (reaction) => {
            if (!reaction.id.participant) return;
            const phone = reaction.id.participant.replace('@c.us', '');
            const emoji = reaction.reaction;
            console.log(`[Reaction] ${phone} 👍`);
            broadcastEvent({ type: 'reaction', phone, emoji });
        });

        client.initialize();
    }).catch(err => {
        console.error('Failed to connect to MongoDB', err);
        status = 'DB Error';
    });
}

app.get('/status', (req, res) => {
    res.json({ status, hasQR: !!lastQR });
});

app.get('/qr', async (req, res) => {
    if (!lastQR) return res.status(404).json({ error: 'No QR code available and status is ' + status });
    try {
        const dataURL = await qrcode.toDataURL(lastQR);
        res.json({ qr: dataURL });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

async function findGroupByName(namePart) {
    if (!client) return null;
    const chats = await client.getChats();
    return chats.find(c => c.isGroup && c.name.toLowerCase().includes(namePart.toLowerCase()));
}

app.post('/send-message', async (req, res) => {
    if (!client) return res.status(500).json({ error: 'Bot is still connecting to MongoDB...' });
    
    try {
        const { groupName, message, durationMins, phones } = req.body;

        const group = await findGroupByName(groupName);
        if (!group) return res.status(404).json({ error: 'Group not found! Ensure WhatsApp has synced recently.' });

        let mentions = [];
        let finalMessage = message;

        if (phones && phones.length > 0) {
            for (let p of group.participants) {
                const userNum = p.id.user;
                const matchingInputNums = phones.filter(num => userNum.includes(num) || num.includes(userNum));

                if (matchingInputNums.length > 0) {
                    try {
                        const contact = await client.getContactById(p.id._serialized);
                        mentions.push(contact);

                        for (let num of matchingInputNums) {
                            finalMessage = finalMessage.replace(new RegExp('@' + num, 'g'), '@' + userNum);
                        }
                    } catch (e) { }
                }
            }
        }

        await client.sendMessage(group.id._serialized, finalMessage, { mentions });
        res.json({ success: true, tagsCount: mentions.length });

        if (durationMins) {
            const warningMs = (durationMins * 0.8) * 60 * 1000;
            setTimeout(async () => {
                let tagList = '';
                if (phones && phones.length > 0) {
                   tagList = phones.map(p => `@${p}`).join(' ');
                }
                const warnMsg = `⚠️ *TIME-SLOT WARNING* ⚠️\n\n${tagList ? tagList + ' ' : ''}Your timing slot is about to end soon. Please start wrapping up your assigned chats to prepare for the next shift rotation.`;
                await client.sendMessage(group.id._serialized, warnMsg, { mentions });
            }, warningMs);
        }

    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🤖 Bot Server is fully online and accessible on port ${PORT}!`);
    console.log(`Cloud Deployment Ready. Waiting for MongoDB connection...`);
});
