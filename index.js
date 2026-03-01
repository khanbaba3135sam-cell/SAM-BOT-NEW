const express = require('express');
const bodyParser = require('body-parser');
const login = require('ws3-fca');
const fs = require('fs');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- GLOBAL STATE ---
let botAPI = null;
let adminID = null;
let prefix = '/';
let botNickname = '𝐓𝐇𝐄 𝐖𝐀𝐋𝐄𝐄𝐃 𝐗𝐃';

let lockedGroups = {};
let lockedNicknames = {};
let lockedGroupPhoto = {};
let fightSessions = {};
let joinedGroups = new Set();
let targetSessions = {};
let nickLockEnabled = false;
let nickRemoveEnabled = false;
let gcAutoRemoveEnabled = false;
let currentCookies = null;
let reconnectAttempt = 0;
const signature = `\n                      ⚠️\n                  𝐓𝐇𝐄 𝐖𝐀𝐋𝐄𝐄𝐃 𝐗𝐃⚠️`;
const separator = `\n---🤬---💸---😈--🤑---😈---👑---`;

// --- ANTI-OUT FEATURE ---
let antiOutEnabled = true;

// --- ANTI-CALL FEATURE ---
let antiCallEnabled = true;

// --- UTILITY FUNCTIONS ---
function emitLog(message, isError = false) {
  const logMessage = `[${new Date().toISOString()}] ${isError ? '❌ ERROR: ' : '✅ INFO: '}${message}`;
  console.log(logMessage);
  io.emit('botlog', logMessage);
}

function saveCookies() {
  if (!botAPI) {
    emitLog('❌ Cannot save cookies: Bot API not initialized.', true);
    return;
  }
  try {
    const newAppState = botAPI.getAppState();
    const configToSave = {
      botNickname: botNickname,
      cookies: newAppState
    };
    fs.writeFileSync('config.json', JSON.stringify(configToSave, null, 2));
    currentCookies = newAppState;
    emitLog('✅ AppState saved successfully.');
  } catch (e) {
    emitLog('❌ Failed to save AppState: ' + e.message, true);
  }
}

// --- BOT INITIALIZATION AND RECONNECTION LOGIC ---
function initializeBot(cookies, prefix, adminID) {
  emitLog('🚀 Initializing bot with ws3-fca...');
  currentCookies = cookies;
  reconnectAttempt = 0;

  login({ appState: currentCookies }, (err, api) => {
    if (err) {
      emitLog(`❌ Login error: ${err.message}. Retrying in 10 seconds.`, true);
      setTimeout(() => initializeBot(currentCookies, prefix, adminID), 10000);
      return;
    }

    emitLog('✅ Bot successfully logged in.');
    botAPI = api;
    botAPI.setOptions({
      selfListen: true,
      listenEvents: true,
      updatePresence: false
    });

    updateJoinedGroups(api);

    setTimeout(() => {
        setBotNicknamesInGroups();
        sendStartupMessage();
        startListening(api);
    }, 5000);

    setInterval(saveCookies, 600000);
  });
}

function startListening(api) {
  api.listenMqtt(async (err, event) => {
    if (err) {
      emitLog(`❌ Listener error: ${err.message}. Attempting to reconnect...`, true);
      reconnectAndListen();
      return;
    }

    try {
      if (event.type === 'message' || event.type === 'message_reply') {
        await handleMessage(api, event);
      } else if (event.logMessageType === 'log:thread-name') {
        await handleThreadNameChange(api, event);
      } else if (event.logMessageType === 'log:user-nickname') {
        await handleNicknameChange(api, event);
      } else if (event.logMessageType === 'log:thread-image') {
        await handleGroupImageChange(api, event);
      } else if (event.logMessageType === 'log:subscribe') {
        await handleBotAddedToGroup(api, event);
      } else if (event.logMessageType === 'log:unsubscribe') {
        await handleParticipantLeft(api, event);
      } else if (event.type === 'event' && event.logMessageType === 'log:thread-call') {
        await handleGroupCall(api, event);
      }
    } catch (e) {
      emitLog(`❌ Handler crashed: ${e.message}`, true);
    }
  });
}

function reconnectAndListen() {
  reconnectAttempt++;
  emitLog(`🔄 Reconnect attempt #${reconnectAttempt}...`, false);
  if (botAPI) {
    try {
      botAPI.stopListening();
    } catch (e) {
      emitLog(`❌ Failed to stop listener: ${e.message}`, true);
    }
  }

  if (reconnectAttempt > 5) {
    emitLog('❌ Maximum reconnect attempts reached. Restarting login process.', true);
    initializeBot(currentCookies, prefix, adminID);
  } else {
    setTimeout(() => {
      if (botAPI) {
        startListening(botAPI);
      } else {
        initializeBot(currentCookies, prefix, adminID);
      }
    }, 5000);
  }
}

async function setBotNicknamesInGroups() {
  if (!botAPI) return;
  try {
    const threads = await botAPI.getThreadList(100, null, ['GROUP']);
    const botID = botAPI.getCurrentUserID();
    for (const thread of threads) {
        try {
            const threadInfo = await botAPI.getThreadInfo(thread.threadID);
            if (threadInfo && threadInfo.nicknames && threadInfo.nicknames[botID] !== botNickname) {
                await botAPI.changeNickname(botNickname, thread.threadID, botID);
                emitLog(`✅ Bot's nickname set in group: ${thread.threadID}`);
            }
        } catch (e) {
            emitLog(`❌ Error: ${e.message}`, true);
        }
        await new Promise(resolve => setTimeout(resolve, 1000)); // Increased delay to 1s
    }
  } catch (e) {
    emitLog(`❌ Error: ${e.message}`, true);
  }
}

async function sendStartupMessage() {
  if (!botAPI) return;
  const startupMessage = `😈𝟒𝐋𝐋 𝐇𝟒𝐓𝟑𝐑𝐒 𝐊𝐈 𝐌𝟒𝟒 𝐂𝐇𝐎𝐃𝐍𝟑 𝐖𝟒𝐋𝟒  𝐖𝐀𝐋𝐄𝐄𝐃 𝐁𝐎𝐓 𝐇𝟑𝐑𝟑 😈`;
  try {
    const threads = await botAPI.getThreadList(100, null, ['GROUP']);
    for (const thread of threads) {
        botAPI.sendMessage(startupMessage, thread.threadID)
          .catch(e => emitLog(`❌ Startup error: ${e.message}`, true));
        await new Promise(resolve => setTimeout(resolve, 2000)); [span_2](start_span)// Increased delay for startup spam prevention[span_2](end_span)
    }
  } catch (e) {
    emitLog(`❌ Error: ${e.message}`, true);
  }
}

async function updateJoinedGroups(api) {
  try {
    const threads = await api.getThreadList(100, null, ['GROUP']);
    joinedGroups = new Set(threads.map(t => t.threadID));
    emitGroups();
  } catch (e) {
    emitLog('❌ Update groups failed: ' + e.message, true);
  }
}

// --- ANTI-OUT HANDLER ---
async function handleParticipantLeft(api, event) {
  if (!antiOutEnabled) return;
  try {
    const { threadID, logMessageData } = event;
    const leftParticipantID = logMessageData.leftParticipantFbId;
    if (leftParticipantID === adminID || leftParticipantID === api.getCurrentUserID()) return;
    
    await api.addUserToGroup(leftParticipantID, threadID);
    const userInfo = await api.getUserInfo(leftParticipantID);
    const userName = userInfo[leftParticipantID]?.name || "User";
    
    const warningMessage = await formatMessage(api, event, 
      `😈 𝐀𝐍𝐓𝐈-𝐎𝐔𝐓 𝐒𝐘𝐒𝐓𝐄𝐌 😈\n\n@${userName} NIKALNE KI KOSHISH KI? 😼\nTERI BHAN KI CHUT ME 𝐖𝐀𝐋𝐄𝐄𝐃 BADMASH KA LODA 😈`
    );
    await api.sendMessage(warningMessage, threadID);
  } catch (error) {
    emitLog(`❌ Anti-out error: ${error.message}`, true);
  }
}

// --- ANTI-CALL HANDLER ---
async function handleGroupCall(api, event) {
  if (!antiCallEnabled) return;
  try {
    const { threadID, logMessageData } = event;
    const callerID = logMessageData?.caller_id;
    if (callerID === adminID) return;
    
    const userInfo = await api.getUserInfo(callerID);
    const userName = userInfo[callerID]?.name || "User";
    
    const warningMessage = await formatMessage(api, event, 
      `😈 𝐀𝐍𝐓𝐈-𝐂𝐀𝐋𝐋 𝐒𝐘𝐒𝐓𝐄𝐌 😈\n\n@${userName} CALL LAGANE KI KOSHISH KI? 😼\nYAHAN CALL NHI LAG SAKTI BSDK! 😼`
    );
    await api.sendMessage(warningMessage, threadID);
  } catch (error) {
    emitLog(`❌ Anti-call error: ${error.message}`, true);
  }
}

// --- WEB SERVER & DASHBOARD ---
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static('public'));
app.get('/', (req, res) => { res.sendFile(__dirname + '/public/index.html'); });

app.post('/configure', (req, res) => {
  try {
    const cookies = JSON.parse(req.body.cookies);
    prefix = req.body.prefix || '/';
    adminID = req.body.adminID;
    if (!Array.isArray(cookies) || cookies.length === 0 || !adminID) {
      return res.status(400).send('Error: Missing configuration.');
    }
    res.send('Bot configured successfully!');
    initializeBot(cookies, prefix, adminID);
  } catch (e) {
    res.status(400).send('Error: Invalid JSON.');
  }
});

let loadedConfig = null;
try {
  if (fs.existsSync('config.json')) {
    loadedConfig = JSON.parse(fs.readFileSync('config.json'));
    if (loadedConfig.botNickname) botNickname = loadedConfig.botNickname;
    if (loadedConfig.cookies && loadedConfig.cookies.length > 0) {
        initializeBot(loadedConfig.cookies, prefix, adminID);
    }
  }
} catch (e) { emitLog('❌ Config error: ' + e.message, true); }

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { emitLog(`✅ Server running on port ${PORT}`); });
io.on('connection', (socket) => {
  socket.emit('botlog', `Bot status: ${botAPI ? 'Started' : 'Not started'}`);
  socket.emit('groupsUpdate', Array.from(joinedGroups));
});

async function handleBotAddedToGroup(api, event) {
  const { threadID, logMessageData } = event;
  const botID = api.getCurrentUserID();
  if (logMessageData.addedParticipants.some(p => p.userFbId === botID)) {
    try {
      await api.changeNickname(botNickname, threadID, botID);
      await api.sendMessage(`😈𝟒𝐋𝐋 𝐇𝟒𝐓𝟑𝐑𝐒 𝐊𝐈 𝐌𝟒𝟒 𝐂𝐇𝐎𝐃𝐍𝟑 𝐖𝟒𝐋𝟒 𝐖𝐀𝐋𝐄𝐄𝐃𝐁 𝐁𝐎𝐓 𝐇𝟑𝐑𝟑 😈`, threadID);
    } catch (e) { emitLog('❌ Add error: ' + e.message, true); }
  }
}

function emitGroups() { io.emit('groupsUpdate', Array.from(joinedGroups)); }

async function formatMessage(api, event, mainMessage) {
    const { senderID } = event;
    let senderName = 'User';
    try {
      const userInfo = await api.getUserInfo(senderID);
      senderName = userInfo && userInfo[senderID] && userInfo[senderID].name ? userInfo[senderID].name : 'User';
    } catch (e) { emitLog('❌ Info error: ' + e.message, true); }
    
    const styledMentionBody = `             [🦋°🫧•𖨆٭ ${senderName}꙳○𖨆°🦋]`;
    const fromIndex = styledMentionBody.indexOf(senderName);
    const mentionObject = { tag: senderName, id: senderID, fromIndex: fromIndex };
    const finalMessage = `${styledMentionBody}\n${mainMessage}${signature}${separator}`;
    return { body: finalMessage, mentions: [mentionObject] };
}

async function handleMessage(api, event) {
  try {
    const { threadID, senderID, body, mentions } = event;
    const isAdmin = senderID === adminID;
    let replyMessage = '';
    let isReply = false;

    if (Object.keys(mentions || {}).includes(adminID)) {
      replyMessage = "😈 NAAM MAT LE 𝐖𝐀𝐋𝐄𝐄𝐃 JIJU JI BOL 😼";
      isReply = true;
    }

    if (body) {
      const lowerCaseBody = body.toLowerCase();
      if (lowerCaseBody.includes('mkc')) {
        replyMessage = `😼𝐁𝐎𝐋 𝐍𝐀 𝐌𝐀𝐃𝐑𝐂𝐇𝐎𝐃𝐄 𝐓𝐄𝐑𝐈 𝐆𝐀𝐍𝐃 𝐌𝐀𝐀𝐑𝐔🙄`;
        isReply = true;
      } else if (lowerCaseBody.trim() === 'bot') {
        const botResponses = [`😈𝗕𝗢𝗟 𝗡𝗔 𝗠𝗔𝗗𝗥𝗖𝗛𝗢𝗗😼👈🏻`, `🙄𝗠𝗨𝗛 𝗠𝗘 𝗟𝗘𝗚𝗔 𝗞𝗬𝗔 𝗠𝗖🙄👈🏻` ];
        replyMessage = botResponses[Math.floor(Math.random() * botResponses.length)];
        isReply = true;
      }
      
      if (isReply) {
          const formattedReply = await formatMessage(api, event, replyMessage);
          return await api.sendMessage(formattedReply, threadID);
      }
    }

    if (!body || !body.startsWith(prefix)) return;
    const args = body.slice(prefix.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();
    let commandReply = '';

    switch (command) {
      case 'group': await handleGroupCommand(api, event, args, isAdmin); return;
      case 'target': await handleTargetCommand(api, event, args, isAdmin); return;
      case 'mentiontarget': await handleMentionTargetCommand(api, event, args, isAdmin); return;
      case 'stop': await handleStopCommand(api, event, isAdmin); return;
      case 'help': await handleHelpCommand(api, event); return;
      case 'tid': commandReply = `Group ID: ${threadID}`; break;
      case 'status': await handleStatusCommand(api, event, isAdmin); return;
      default:
        commandReply = isAdmin ? `Ye h mera prefix ${prefix}` : `Tera jija hu mc!`;
    }
    
    if (commandReply) {
        const formattedReply = await formatMessage(api, event, commandReply);
        await api.sendMessage(formattedReply, threadID);
    }
  } catch (err) { emitLog('❌ Message error: ' + err.message, true); }
}

// --- MENTION TARGET (SLOWED MODIFICATION) ---
async function handleMentionTargetCommand(api, event, args, isAdmin) {
  const { threadID, mentions } = event;
  if (!isAdmin) return;

  const subCommand = args.shift()?.toLowerCase();
  if (subCommand === 'on') {
    if (Object.keys(mentions || {}).length === 0) return;
    const fileNumber = args.shift();
    const mentionedID = Object.keys(mentions)[0];
    const filePath = path.join(__dirname, `np${fileNumber}.txt`);
    if (!fs.existsSync(filePath)) return;

    const targetMessages = fs.readFileSync(filePath, 'utf8').split('\n').filter(l => l.trim() !== '');
    const userInfo = await api.getUserInfo(mentionedID);
    const targetName = userInfo[mentionedID]?.name || "User";
    
    if (targetSessions[threadID]?.active) clearInterval(targetSessions[threadID].interval);

    let currentIndex = 0;
    [span_3](start_span)// MODIFICATION: Set delay to 25 seconds for inbox protection[span_3](end_span)
    const interval = setInterval(async () => {
      try {
        const formattedMessage = `@${targetName} ${targetMessages[currentIndex]}\n\nMR AAHAN HERE 😈`;
        await botAPI.sendMessage(formattedMessage, mentionedID);
        await botAPI.sendMessage(`💣 ${targetName} KO INBOX ME REPORT MARA GAYA! 😈`, threadID);
        currentIndex = (currentIndex + 1) % targetMessages.length;
      } catch (err) {
        clearInterval(interval);
        delete targetSessions[threadID];
      }
    }, 25000); 

    targetSessions[threadID] = { active: true, targetName, interval, isMentionTarget: true };
    await api.sendMessage(`💣 **Mention Target Lock!** (25s Delay) 😈`, threadID);
  
  } else if (subCommand === 'off') {
    if (targetSessions[threadID]?.active) {
      clearInterval(targetSessions[threadID].interval);
      delete targetSessions[threadID];
      await api.sendMessage(`🛑 **Mention Target Off!**`, threadID);
    }
  }
}

// --- TARGET COMMAND (SLOWED MODIFICATION) ---
async function handleTargetCommand(api, event, args, isAdmin) {
  const { threadID } = event;
  if (!isAdmin) return;

  const subCommand = args.shift()?.toLowerCase();
  if (subCommand === 'on') {
    const fileNumber = args.shift();
    const targetName = args.join(' ');
    const filePath = path.join(__dirname, `np${fileNumber}.txt`);
    if (!fs.existsSync(filePath)) return;

    const targetMessages = fs.readFileSync(filePath, 'utf8').split('\n').filter(l => l.trim() !== '');
    if (targetSessions[threadID]?.active) clearInterval(targetSessions[threadID].interval);

    let currentIndex = 0;
    [span_4](start_span)// MODIFICATION: Set delay to 15 seconds for group message slowing[span_4](end_span)
    const interval = setInterval(async () => {
      const formattedMessage = `${targetName} ${targetMessages[currentIndex]}\n\nMR AAHAN HERE 😈`;
      try {
        await botAPI.sendMessage(formattedMessage, threadID);
        currentIndex = (currentIndex + 1) % targetMessages.length;
      } catch (err) {
        clearInterval(interval);
        delete targetSessions[threadID];
      }
    }, 15000);

    targetSessions[threadID] = { active: true, targetName, interval };
    await api.sendMessage(`💣 **Target lock!** (15s Delay)`, threadID);
  } else if (subCommand === 'off') {
    if (targetSessions[threadID]?.active) {
      clearInterval(targetSessions[threadID].interval);
      delete targetSessions[threadID];
      await api.sendMessage("🛑 **Target Off!**", threadID);
    }
  }
}

// --- REMAINING HANDLERS (UNCHANGED) ---
async function handleGroupCommand(api, event, args, isAdmin) {
  const { threadID } = event;
  if (!isAdmin) return;
  const subCommand = args.shift();
  if (subCommand === 'on') {
    const groupName = args.join(' ');
    lockedGroups[threadID] = groupName;
    await api.setTitle(groupName, threadID);
    await api.sendMessage(`😼 GROUP NAME LOCKED 😼`, threadID);
  } else if (subCommand === 'off') {
    delete lockedGroups[threadID];
    await api.sendMessage("Group name unlocked.", threadID);
  }
}

async function handleStopCommand(api, event, isAdmin) {
  const { threadID } = event;
  if (!isAdmin) return;
  if (targetSessions[threadID]?.active) {
    clearInterval(targetSessions[threadID].interval);
    delete targetSessions[threadID];
    await api.sendMessage("All attacks stopped.", threadID);
  }
}

async function handleStatusCommand(api, event, isAdmin) {
  const { threadID } = event;
  if (!isAdmin) return;
  const status = `STATUS:\n• Target: ${targetSessions[threadID]?.active ? "ON" : "OFF"}\n• Anti-Out: ${antiOutEnabled ? "ON" : "OFF"}`;
  await api.sendMessage(status, threadID);
}

async function handleHelpCommand(api, event) {
  const { threadID } = event;
  const help = `HELP:\n${prefix}target on/off\n${prefix}mentiontarget on/off\n${prefix}stop`;
  await api.sendMessage(help, threadID);
}

async function handleThreadNameChange(api, event) {
  const { threadID, authorID } = event;
  if (lockedGroups[threadID] && authorID !== adminID) {
    await api.setTitle(lockedGroups[threadID], threadID);
  }
}

async function handleNicknameChange(api, event) {
  const { threadID, authorID, participantID, newNickname } = event;
  if (participantID === api.getCurrentUserID() && authorID !== adminID && newNickname !== botNickname) {
    await api.changeNickname(botNickname, threadID, participantID);
  }
}

async function handleGroupImageChange(api, event) {}
