const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const bodyParser = require('body-parser');
const login = require('ws3-fca');  // Facebook API
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Middleware
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// 📁 Static files serve करें (जैसे index.html, CSS, JS)
app.use(express.static(__dirname));

// 🏠 होम पेज के लिए सीधा index.html भेजें
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// बॉट से जुड़े वेरिएबल
let botApi = null;
let joinedGroups = [];

// Socket.io connection
io.on('connection', (socket) => {
    console.log('Client connected');
    socket.emit('groupsUpdate', joinedGroups);
});

// लॉग भेजने का helper function
function emitLog(msg) {
    io.emit('botlog', msg);
}

// 📩 /configure POST endpoint (form से डेटा यहाँ आएगा)
app.post('/configure', (req, res) => {
    const { cookies, prefix, adminID } = req.body;

    // cookies JSON को पार्स करें
    let appState;
    try {
        appState = JSON.parse(cookies);
    } catch (e) {
        emitLog('❌ Cookies JSON गलत है');
        return res.status(400).send('Invalid JSON');
    }

    emitLog('🔑 Facebook में login कर रहा हूँ...');

    // ws3-fca से login
    login({ appState }, (err, api) => {
        if (err) {
            emitLog('❌ Login फेल: ' + err);
            return res.status(500).send('Login failed: ' + err);
        }

        botApi = api;
        emitLog('✅ Login सफल!');

        // बॉट सेटिंग्स
        api.setOptions({
            listenEvents: true,
            selfListen: false
        });

        // जॉइन किए गए ग्रुप्स की लिस्ट लें
        api.getThreadList(100, null, ['INBOX'], (err, list) => {
            if (!err) {
                joinedGroups = list.filter(t => t.isGroup).map(t => t.threadID);
                io.emit('groupsUpdate', joinedGroups);
                emitLog(`📋 कुल ग्रुप: ${joinedGroups.length}`);
            }
        });

        // मैसेज सुनना शुरू करें
        api.listenMqtt((err, event) => {
            if (err) {
                emitLog('❌ Listen error: ' + err);
                return;
            }

            // सिर्फ मैसेज इवेंट हैंडल करें
            if (event.type === 'message' && event.body) {
                const msg = event.body;
                const senderID = event.senderID;
                const threadID = event.threadID;

                // अगर मैसेज prefix से शुरू होता है
                if (msg.startsWith(prefix)) {
                    const args = msg.slice(prefix.length).trim().split(/ +/);
                    const cmd = args.shift().toLowerCase();

                    emitLog(`📨 कमांड आया: ${cmd} थ्रेड ${threadID} से`);

                    // 🧠 यहाँ अपने सभी कमांड हैंडल करें
                    switch (cmd) {
                        case 'help':
                            api.sendMessage('📚 सभी कमांड की लिस्ट...', threadID);
                            break;
                        case 'tid':
                            api.sendMessage(`इस ग्रुप की ID: ${threadID}`, threadID);
                            break;
                        case 'uid':
                            if (Object.keys(event.mentions).length > 0) {
                                const uid = Object.keys(event.mentions)[0];
                                api.sendMessage(`उस यूजर की ID: ${uid}`, threadID);
                            } else {
                                api.sendMessage(`आपकी ID: ${senderID}`, threadID);
                            }
                            break;
                        // ... और भी कमांड जोड़ें
                        default:
                            api.sendMessage('❌ अज्ञात कमांड', threadID);
                    }
                }
            }
        });

        res.send('बॉट सफलतापूर्वक शुरू हो गया! ✅');
    });
});

// Render द्वारा दिया गया PORT इस्तेमाल करें
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`🌐 सर्वर चल रहा है पोर्ट ${PORT} पर`);
});
