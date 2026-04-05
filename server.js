const express = require('express');
const cors = require('cors');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcodeTerminal = require('qrcode-terminal');
const qrcode = require('qrcode');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// SSE tracking for Live Reactions
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

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    }
});

let lastQR = null;
let status = 'Initializing...';

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

client.initialize();

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
    const chats = await client.getChats();
    return chats.find(c => c.isGroup && c.name.toLowerCase().includes(namePart.toLowerCase()));
}

app.post('/send-message', async (req, res) => {
    try {
        const { groupName, message, durationMins, phones } = req.body;
        console.log(`\n--> Request to Send: [${groupName}] | Phones: ${phones.length}`);

        const group = await findGroupByName(groupName);
        if (!group) return res.status(404).json({ error: 'Group not found! Ensure WhatsApp has synced recently.' });

        let mentions = [];
        let finalMessage = message;

        // Process Mentions invisibly to map the inline tags & enforce exact ID matching
        if (phones && phones.length > 0) {
            for (let p of group.participants) {
                const userNum = p.id.user;
                // Find all phone values sent from the dashboard that match this participant
                const matchingInputNums = phones.filter(num => userNum.includes(num) || num.includes(userNum));

                if (matchingInputNums.length > 0) {
                    try {
                        const contact = await client.getContactById(p.id._serialized);
                        mentions.push(contact);

                        // WhatsApp Web requires the text to exactly match the contact ID.
                        // We dynamically rewrite whatever the dashboard sent to the perfect WhatsApp ID.
                        for (let num of matchingInputNums) {
                            finalMessage = finalMessage.replace(new RegExp('@' + num, 'g'), '@' + userNum);
                        }
                    } catch (e) {
                        console.error('Could not fetch contact ', userNum);
                    }
                }
            }
        }

        await client.sendMessage(group.id._serialized, finalMessage, { mentions });
        console.log(`✅ Message Sent Successfully to ${group.name} with ${mentions.length} tags!`);
        res.json({ success: true, tagsCount: mentions.length });

        if (durationMins) {
            const warningMs = (durationMins * 0.8) * 60 * 1000; // Sending warning at 80% of the slot duration
            setTimeout(async () => {
                // Determine the tag strings for warning message
                let tagList = '';
                if (phones && phones.length > 0) {
                   tagList = phones.map(p => `@${p}`).join(' ');
                }

                const warnMsg = `⚠️ *TIME-SLOT WARNING* ⚠️\n\n${tagList ? tagList + ' ' : ''}Your timing slot is about to end soon. Please start wrapping up your assigned chats to prepare for the next shift rotation.`;
                
                await client.sendMessage(group.id._serialized, warnMsg, { mentions });
            }, warningMs);
        }

    } catch (e) {
        console.error('❌ ERROR sending message:', e);
        res.status(500).json({ error: e.message });
    }
});

// Listen to Reactions
client.on('message_reaction', async (reaction) => {
    if (!reaction.id.participant) return;
    const phone = reaction.id.participant.replace('@c.us', '');
    const emoji = reaction.reaction;
    console.log(`[Reaction] ${phone} 👍`);
    broadcastEvent({ type: 'reaction', phone, emoji });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🤖 Bot Server is fully online and accessible on port ${PORT}!`);
    console.log(`Cloud Deployment Ready. Render automatically binds to this port.`);
});
