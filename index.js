const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const bodyParser = require('body-parser');
const login = require('ws3-fca');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// ✅ Public folder serve
app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// ✅ Home route
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Bot state
let botApi = null;
let adminID = null;
let prefix = '/';
let joinedGroups = [];

// Per-thread settings
const threadSettings = new Map();      // { lockedGroupName, lockedNickname, lockedPhoto, botNickname }
const targetMode = new Map();          // { targetID, active }
const fightMode = new Map();           // boolean

function emitLog(msg) {
    io.emit('botlog', msg);
}

function isAdmin(senderID) {
    return senderID === adminID;
}

function updateGroupsList() {
    if (!botApi) return;
    botApi.getThreadList(100, null, ['INBOX'], (err, list) => {
        if (!err) {
            joinedGroups = list.filter(t => t.isGroup).map(t => t.threadID);
            io.emit('groupsUpdate', joinedGroups);
        }
    });
}

io.on('connection', (socket) => {
    socket.emit('groupsUpdate', joinedGroups);
});

// ==================== CONFIGURE ENDPOINT ====================
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

        updateGroupsList();

        api.listenMqtt((err, event) => {
            if (err) {
                emitLog('❌ Listen error: ' + err);
                return;
            }

            if (event.type === 'message' && event.body && event.senderID !== api.getCurrentUserID()) {
                handleMessage(api, event);
            }

            if (event.type === 'event' && event.logMessageType) {
                handleLogEvent(api, event);
            }
        });

        res.send('✅ बॉट सफलतापूर्वक शुरू हो गया!');
    });
});

// ==================== MESSAGE HANDLER ====================
function handleMessage(api, event) {
    const { body, senderID, threadID } = event;
    const threadSetting = threadSettings.get(threadID) || {};

    // Target mode auto-reply
    const target = targetMode.get(threadID);
    if (target && target.active && target.targetID === senderID) {
        api.sendMessage('𝐓𝐄𝐑𝐈 𝐌𝐀 𝐊𝐈 𝐂𝐇𝐔𝐓 🖕', threadID);
    }

    // Fight mode (random gaali)
    if (fightMode.get(threadID)) {
        const insults = ['𝐁𝐡𝐨𝐬𝐝𝐢𝐤𝐞', '𝐌𝐚𝐝𝐚𝐫𝐜𝐡𝐨𝐝', '𝐆𝐚𝐧𝐝𝐮', '𝐇𝐚𝐫𝐚𝐦𝐢', '𝐂𝐡𝐮𝐭𝐢𝐲𝐚'];
        const randomInsult = insults[Math.floor(Math.random() * insults.length)];
        api.sendMessage(randomInsult, threadID);
        return;
    }

    // Commands
    if (body.startsWith(prefix)) {
        const args = body.slice(prefix.length).trim().split(/ +/);
        const cmd = args.shift().toLowerCase();

        emitLog(`📨 कमांड: ${cmd} थ्रेड ${threadID} से`);

        const adminOnly = ['target', 'fight', 'stop', 'group', 'nickname', 'photolock', 'botnickname'];
        if (adminOnly.includes(cmd) && !isAdmin(senderID)) {
            api.sendMessage('❌ यह कमांड सिर्फ एडमिन इस्तेमाल कर सकता है!', threadID);
            return;
        }

        switch (cmd) {
            case 'help':
                sendHelp(api, threadID);
                break;

            case 'tid':
                api.sendMessage(`इस ग्रुप की आईडी: ${threadID}`, threadID);
                break;

            case 'uid':
                if (Object.keys(event.mentions).length > 0) {
                    const uid = Object.keys(event.mentions)[0];
                    api.sendMessage(`उस यूजर की आईडी: ${uid}`, threadID);
                } else {
                    api.sendMessage(`आपकी आईडी: ${senderID}`, threadID);
                }
                break;

            // ========== GROUP SECURITY ==========
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
                    api.sendMessage('⚠️ सही फॉर्मेट: /group on <नाम> या /group off', threadID);
                }
                break;

            case 'nickname':
                if (args[0] === 'on') {
                    const nick = args.slice(1).join(' ');
                    if (!nick) {
                        api.sendMessage('❌ निकनेम लिखो! उदाहरण: /nickname on SpiderMan', threadID);
                        return;
                    }
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
                    api.sendMessage('⚠️ सही फॉर्मेट: /nickname on <निकनेम> या /nickname off', threadID);
                }
                break;

            case 'photolock':
                if (args[0] === 'on') {
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

            // ========== TARGET SYSTEM ==========
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
                    api.sendMessage('⚠️ सही फॉर्मेट: /target on @मेंशन या /target off', threadID);
                }
                break;

            // ========== FIGHT MODE ==========
            case 'fight':
                if (args[0] === 'on') {
                    fightMode.set(threadID, true);
                    api.sendMessage('⚔️ फाइट मोड ऑन! अब हर मैसेज पर जवाब मिलेगा', threadID);
                } else {
                    api.sendMessage('⚠️ सही फॉर्मेट: /fight on', threadID);
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

// ==================== LOG EVENT HANDLER ====================
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

// ==================== HELP MESSAGE ====================
function sendHelp(api, threadID) {
    const helpMsg = `
😈 𝐃𝟑𝟑𝐏 𝐁𝟒𝐃𝐌𝟒𝐒𝐇 𝐁𝐎𝐓 😈
उपलब्ध कमांड्स:

📚 सामान्य:
  /help – यह मैसेज
  /tid – ग्रुप आईडी
  /uid – अपनी या मेंशन यूजर की आईडी

🔐 ग्रुप सिक्योरिटी (केवल एडमिन):
  /group on <नाम> – ग्रुप नाम लॉक
  /group off – लॉक हटाएँ
  /nickname on <निकनेम> – सबका निकनेम लॉक
  /nickname off – लॉक हटाएँ
  /photolock on – ग्रुप फोटो लॉक
  /photolock off – लॉक हटाएँ
  /botnickname <नाम> – बॉट का निकनेम सेट

🎯 टारगेट सिस्टम (केवल एडमिन):
  /target on @मेंशन – यूजर को टारगेट करें
  /target off – बंद करें

⚔️ फाइट मोड (केवल एडमिन):
  /fight on – फाइट मोड शुरू
  /stop – बंद करें
    `;
    api.sendMessage(helpMsg, threadID);
}

// ==================== SERVER START ====================
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`🌐 सर्वर चल रहा है पोर्ट ${PORT} पर`);
});
