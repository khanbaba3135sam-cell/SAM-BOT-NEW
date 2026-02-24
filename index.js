const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const bodyParser = require('body-parser');
const login = require('ws3-fca');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Global bot state
let botApi = null;
let adminID = null;
let prefix = '/';
let joinedGroups = [];

// Per-thread settings
const threadSettings = new Map(); // key: threadID
// Target system: per thread { targetID, active }
const targetMode = new Map(); // key: threadID, value: { targetID, active }
// Fight mode per thread
const fightMode = new Map(); // key: threadID, value: boolean

// Helper: emit log to all connected clients
function emitLog(msg) {
    io.emit('botlog', msg);
}

// Helper: check if user is admin
function isAdmin(senderID) {
    return senderID === adminID;
}

// Helper: update groups list and emit
function updateGroupsList() {
    if (!botApi) return;
    botApi.getThreadList(100, null, ['INBOX'], (err, list) => {
        if (!err) {
            joinedGroups = list.filter(t => t.isGroup).map(t => t.threadID);
            io.emit('groupsUpdate', joinedGroups);
        }
    });
}

// Socket.io connection
io.on('connection', (socket) => {
    socket.emit('groupsUpdate', joinedGroups);
});

// POST /configure – start bot with given cookies
app.post('/configure', (req, res) => {
    const { cookies, prefix: newPrefix, adminID: newAdminID } = req.body;

    let appState;
    try {
        appState = JSON.parse(cookies);
    } catch (e) {
        emitLog('❌ Cookies JSON गलत है');
        return res.status(400).send('Invalid JSON');
    }

    prefix = newPrefix || '/';
    adminID = newAdminID;

    emitLog('🔑 Facebook में login कर रहा हूँ...');

    login({ appState }, (err, api) => {
        if (err) {
            emitLog('❌ Login फेल: ' + err);
            return res.status(500).send('Login failed: ' + err);
        }

        botApi = api;
        emitLog('✅ Login सफल!');

        api.setOptions({
            listenEvents: true,
            selfListen: false
        });

        // Initial groups list
        updateGroupsList();

        // Listen to events
        api.listenMqtt((err, event) => {
            if (err) {
                emitLog('❌ Listen error: ' + err);
                return;
            }

            // Handle message events
            if (event.type === 'message' && event.body && event.senderID !== api.getCurrentUserID()) {
                handleMessage(api, event);
            }

            // Handle log events for group changes
            if (event.type === 'event' && event.logMessageType) {
                handleLogEvent(api, event);
            }
        });

        res.send('बॉट सफलतापूर्वक शुरू हो गया! ✅');
    });
});

// Message handler
function handleMessage(api, event) {
    const { body, senderID, threadID } = event;
    const threadSetting = threadSettings.get(threadID) || {};

    // Check for target mode
    const target = targetMode.get(threadID);
    if (target && target.active && target.targetID === senderID) {
        // Auto-reply to target
        api.sendMessage('TERI MA KI CHUT 🖕', threadID);
    }

    // Check for fight mode
    if (fightMode.get(threadID)) {
        const insults = ['Bhosdike', 'Madarchod', 'Gandu', 'Harami', 'Chutiya'];
        const randomInsult = insults[Math.floor(Math.random() * insults.length)];
        api.sendMessage(randomInsult, threadID);
        return; // Don't process commands in fight mode? Better to still allow commands? We'll allow commands if they start with prefix.
    }

    // Process commands
    if (body.startsWith(prefix)) {
        const args = body.slice(prefix.length).trim().split(/ +/);
        const cmd = args.shift().toLowerCase();

        emitLog(`📨 कमांड: ${cmd} थ्रेड ${threadID} से`);

        // Admin-only commands check
        const adminOnly = ['target', 'fyt', 'stop', 'group', 'nickname', 'photolock', 'botnickname'];
        if (adminOnly.includes(cmd) && !isAdmin(senderID)) {
            api.sendMessage('❌ यह कमांड सिर्फ ADMIN इस्तेमाल कर सकता है!', threadID);
            return;
        }

        switch (cmd) {
            case 'help':
                sendHelp(api, threadID);
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

            // Group name lock (set and auto-revert on change)
            case 'group':
                if (args[0] === 'on') {
                    const newName = args.slice(1).join(' ');
                    if (!newName) {
                        api.sendMessage('❌ नाम लिखो! उदाहरण: /group on Mera Group', threadID);
                        return;
                    }
                    api.setTitle(newName, threadID, (err) => {
                        if (err) {
                            api.sendMessage('❌ नाम सेट नहीं हुआ', threadID);
                        } else {
                            // Store locked name
                            const settings = threadSettings.get(threadID) || {};
                            settings.lockedGroupName = newName;
                            threadSettings.set(threadID, settings);
                            api.sendMessage(`✅ ग्रुप का नाम लॉक कर दिया: "${newName}"`, threadID);
                        }
                    });
                } else if (args[0] === 'off') {
                    const settings = threadSettings.get(threadID) || {};
                    delete settings.lockedGroupName;
                    threadSettings.set(threadID, settings);
                    api.sendMessage('✅ ग्रुप नाम लॉक हटा दिया', threadID);
                } else {
                    api.sendMessage('⚠️ सही फॉर्मेट: /group on <name> या /group off', threadID);
                }
                break;

            // Nickname lock for all members
            case 'nickname':
                if (args[0] === 'on') {
                    const nick = args.slice(1).join(' ');
                    if (!nick) {
                        api.sendMessage('❌ निकनेम लिखो! उदाहरण: /nickname on SpiderMan', threadID);
                        return;
                    }
                    // Set nickname for all members
                    api.getThreadInfo(threadID, (err, info) => {
                        if (err) {
                            api.sendMessage('❌ ग्रुप जानकारी नहीं मिली', threadID);
                            return;
                        }
                        info.participantIDs.forEach(uid => {
                            api.changeNickname(nick, threadID, uid, (err) => {
                                if (err) console.log('Nickname change error for', uid);
                            });
                        });
                        // Store locked nickname
                        const settings = threadSettings.get(threadID) || {};
                        settings.lockedNickname = nick;
                        threadSettings.set(threadID, settings);
                        api.sendMessage(`✅ सभी का निकनेम लॉक कर दिया: "${nick}"`, threadID);
                    });
                } else if (args[0] === 'off') {
                    const settings = threadSettings.get(threadID) || {};
                    delete settings.lockedNickname;
                    threadSettings.set(threadID, settings);
                    api.sendMessage('✅ निकनेम लॉक हटा दिया', threadID);
                } else {
                    api.sendMessage('⚠️ सही फॉर्मेट: /nickname on <name> या /nickname off', threadID);
                }
                break;

            // Photo lock (set a photo and revert on change)
            case 'photolock':
                if (args[0] === 'on') {
                    // You need to provide a photo URL. For demo, we use a default image.
                    const photoUrl = 'https://i.ibb.co/1YkGn1ts/34b55d0c232d6b7ba78dde006e979dfc.jpg';
                    api.changeThreadImage(photoUrl, threadID, (err) => {
                        if (err) {
                            api.sendMessage('❌ फोटो सेट नहीं हुई', threadID);
                        } else {
                            const settings = threadSettings.get(threadID) || {};
                            settings.lockedPhoto = photoUrl;
                            threadSettings.set(threadID, settings);
                            api.sendMessage('✅ ग्रुप फोटो लॉक कर दी गई', threadID);
                        }
                    });
                } else if (args[0] === 'off') {
                    const settings = threadSettings.get(threadID) || {};
                    delete settings.lockedPhoto;
                    threadSettings.set(threadID, settings);
                    api.sendMessage('✅ फोटो लॉक हटा दिया', threadID);
                } else {
                    api.sendMessage('⚠️ सही फॉर्मेट: /photolock on या /photolock off', threadID);
                }
                break;

            // Set bot's own nickname
            case 'botnickname':
                const newNick = args.join(' ');
                if (!newNick) {
                    api.sendMessage('❌ निकनेम लिखो!', threadID);
                    return;
                }
                api.changeNickname(newNick, threadID, api.getCurrentUserID(), (err) => {
                    if (err) {
                        api.sendMessage('❌ निकनेम सेट नहीं हुआ', threadID);
                    } else {
                        const settings = threadSettings.get(threadID) || {};
                        settings.botNickname = newNick;
                        threadSettings.set(threadID, settings);
                        api.sendMessage(`✅ बॉट का निकनेम सेट: "${newNick}"`, threadID);
                    }
                });
                break;

            // Target system
            case 'target':
                if (args[0] === 'on') {
                    const mention = Object.keys(event.mentions)[0];
                    if (!mention) {
                        api.sendMessage('❌ किसी को मेंशन करो! उदाहरण: /target on @username', threadID);
                        return;
                    }
                    targetMode.set(threadID, { targetID: mention, active: true });
                    api.sendMessage(`🎯 टारगेट सेट: ${mention}`, threadID);
                } else if (args[0] === 'off') {
                    targetMode.delete(threadID);
                    api.sendMessage('✅ टारगेट बंद', threadID);
                } else {
                    api.sendMessage('⚠️ सही फॉर्मेट: /target on @mention या /target off', threadID);
                }
                break;

            // Fight mode
            case 'fyt':
                if (args[0] === 'on') {
                    fightMode.set(threadID, true);
                    api.sendMessage('⚔️ फाइट मोड ऑन! अब हर मैसेज पर जवाब मिलेगा', threadID);
                } else {
                    api.sendMessage('⚠️ सही फॉर्मेट: /fyt on', threadID);
                }
                break;

            case 'stop':
                fightMode.delete(threadID);
                api.sendMessage('🛑 फाइट मोड बंद', threadID);
                break;

            default:
                api.sendMessage('❌ अज्ञात कमांड। /help देखो।', threadID);
        }
    }
}

// Log events handler (for auto-revert on changes)
function handleLogEvent(api, event) {
    const { threadID, logMessageType, logMessageData } = event;
    const settings = threadSettings.get(threadID);
    if (!settings) return;

    // Group name change
    if (logMessageType === 'log:thread-name' && settings.lockedGroupName) {
        const newName = logMessageData.name;
        if (newName !== settings.lockedGroupName) {
            api.setTitle(settings.lockedGroupName, threadID, (err) => {
                if (!err) {
                    api.sendMessage('⚠️ ग्रुप का नाम बदलने की कोशिश हुई, वापस लॉक किया गया!', threadID);
                }
            });
        }
    }

    // Nickname change
    if (logMessageType === 'log:user-nickname' && settings.lockedNickname) {
        const { participant_id, nickname } = logMessageData;
        if (nickname !== settings.lockedNickname) {
            api.changeNickname(settings.lockedNickname, threadID, participant_id, (err) => {
                if (!err) {
                    api.sendMessage(`⚠️ ${participant_id} का निकनेम बदलने की कोशिश हुई, वापस लॉक किया गया!`, threadID);
                }
            });
        }
    }

    // Photo change
    if (logMessageType === 'log:thread-icon' && settings.lockedPhoto) {
        // Photo changed, revert
        api.changeThreadImage(settings.lockedPhoto, threadID, (err) => {
            if (!err) {
                api.sendMessage('⚠️ ग्रुप फोटो बदलने की कोशिश हुई, वापस लॉक किया गया!', threadID);
            }
        });
    }

    // Bot's own nickname change
    if (logMessageType === 'log:user-nickname' && logMessageData.participant_id === api.getCurrentUserID() && settings.botNickname) {
        if (logMessageData.nickname !== settings.botNickname) {
            api.changeNickname(settings.botNickname, threadID, api.getCurrentUserID(), (err) => {
                if (!err) {
                    api.sendMessage('⚠️ मेरा निकनेम बदलने की कोशिश हुई, वापस लॉक किया गया!', threadID);
                }
            });
        }
    }
}

// Help message
function sendHelp(api, threadID) {
    const helpMsg = `
😈 𝐃𝟑𝟑𝐏 𝐁𝟒𝐃𝐌𝟒𝐒𝐇 𝐁𝐎𝐓 😈
उपलब्ध कमांड्स:

📚 सामान्य:
  /help – यह मैसेज
  /tid – ग्रुप ID
  /uid – अपनी या मेंशन यूजर की ID

🔐 ग्रुप सिक्योरिटी (केवल एडमिन):
  /group on <नाम> – ग्रुप नाम लॉक
  /group off – लॉक हटाएँ
  /nickname on <निकनेम> – सबका निकनेम लॉक
  /nickname off – लॉक हटाएँ
  /photolock on – ग्रुप फोटो लॉक (डिफॉल्ट फोटो)
  /photolock off – लॉक हटाएँ
  /botnickname <नाम> – बॉट का निकनेम सेट

🎯 टारगेट सिस्टम (केवल एडमिन):
  /target on @मेंशन – यूजर को टारगेट करें (ऑटो-रिप्लाई)
  /target off – बंद करें

⚔️ फाइट मोड (केवल एडमिन):
  /fyt on – फाइट मोड शुरू (हर मैसेज पर गाली)
  /stop – बंद करें
    `;
    api.sendMessage(helpMsg, threadID);
}

// Start server
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`🌐 सर्वर चल रहा है पोर्ट ${PORT} पर`);
});
