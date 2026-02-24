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

// ========== REPLY SPEED CONTROL (YAHAN SE SET KARO) ==========
const REPLY_DELAY = 1200; // Milliseconds mein delay - tum yahan badal sakte ho speed
// 600 = very fast, 1200 = perfect, 2500 = slow/dramatic
// ============================================================

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

// Delay function for reply speed
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

// ... [baaki sab functions same hi hain, sirf handleMessage ke end mein delay add kiya hai]

// Updated handleMessage with delay
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
      } else if (lowerCaseBody.includes('randi')) {
        replyMessage = `😼𝐁𝐎𝐋 𝐓𝐄𝐑𝐈 𝐁𝐇𝐀𝐍 𝐂𝐇𝐎𝐃𝐔🙄👈🏻`;
        isReply = true;
      } else if (lowerCaseBody.includes('teri maa chod dunga')) {
        replyMessage = `🙄𝐋𝐔𝐋𝐋𝐈 𝐇𝐎𝐓𝐈 𝐍𝐇𝐈 𝐊𝐇𝐀𝐃𝐈 𝐁𝐀𝐀𝐓𝐄 𝐊𝐑𝐓𝐀 𝐁𝐃𝐈 𝐁𝐃𝐈 𝐒𝐈𝐃𝐄 𝐇𝐀𝐓 𝐁𝐒𝐃𝐊🙄👈🏻`;
        isReply = true;
      } else if (lowerCaseBody.includes('chutiya')) {
        replyMessage = `😼𝐓𝐔 𝐉𝐔𝐓𝐇𝐀 𝐓𝐄𝐑𝐄 𝐆𝐇𝐀𝐑 𝐖𝐀𝐋𝐄 𝐉𝐔𝐓𝐇𝐄 𝐉𝐔𝐓𝐇𝐈 𝐒𝐀𝐀𝐑𝐈 𝐊𝐇𝐔𝐃𝐀𝐀𝐈 𝐀𝐆𝐀𝐑 𝐂𝐇𝐔𝐓 𝐌𝐈𝐋𝐄 𝐓𝐄𝐑𝐈 𝐃𝐈𝐃𝐈 𝐊𝐈 𝐓𝐎 𝐉𝐀𝐌 𝐊𝐄 𝐊𝐑 𝐃𝐄 𝐓𝐄𝐑𝐀 𝐃𝟑𝟑𝐏 𝐁𝟒𝐃𝐌𝟒𝐒𝐇 𝐉𝐈𝐉𝐀 𝐂𝐇𝐔𝐃𝐀𝐀𝐈🙄👈🏻 `;
        isReply = true;
      } else if (lowerCaseBody.includes('boxdika')) {
        replyMessage = `😼𝐌𝐀𝐈𝐍 𝐋𝐎𝐍𝐃𝐀 𝐇𝐔 𝐕𝐀𝐊𝐈𝐋 𝐊𝐀 𝐋𝐀𝐍𝐃 𝐇𝐀𝐈 𝐌𝐄𝐑𝐀 𝐒𝐓𝐄𝐄𝐋 𝐊𝐀 𝐉𝐇𝐀 𝐌𝐔𝐭 𝐃𝐔 𝐖𝐀𝐇𝐀 𝐆𝐀𝐃𝐃𝐇𝐀 𝐊𝐇𝐔𝐃 𝐉𝐀𝐀𝐘𝐄 🙄𝐎𝐑 𝐓𝐔 𝐊𝐘𝐀 𝐓𝐄𝐑𝐈 𝐌𝐀 𝐁𝐇𝐄 𝐂𝐇𝐔𝐃 𝐉𝐀𝐀𝐘𝐄😼👈🏻`;
        isReply = true;
      } else if (lowerCaseBody.trim() === 'bot') {
        const botResponses = [
            `😈𝗕𝗢𝗟 𝗡𝗔 𝗠𝗔𝗗𝗥𝗖𝗛𝗢𝗗😼👈🏻`,
            `😈𝗕𝗢𝗧 𝗕𝗢𝗧 𝗞𝗬𝗨 𝗞𝗥 𝗥𝗛𝗔 𝗚𝗔𝗡𝗗 𝗠𝗔𝗥𝗩𝗔𝗡𝗔 𝗞𝗬𝗔 𝗕𝗢𝗧 𝗦𝗘 𝗕𝗦𝗗𝗞😈`,
            `🙄𝗞𝗜𝗦𝗞𝗜 𝗕𝗛𝗔𝗡 𝗞𝗜 𝗖𝗛𝗨𝗧 𝗠𝗘 𝗞𝗛𝗨𝗝𝗟𝗜 𝗛𝗘🙄👈🏻`,
            `🙈𝗝𝗔𝗬𝗔𝗗𝗔 𝗕𝗢𝗧 𝗕𝗢𝗧 𝗕𝗢𝗟𝗘𝗚𝗔 𝗧𝗢 𝗧𝗘𝗥𝗜 𝗚𝗔𝗔𝗡𝗗 𝗠𝗔𝗜 𝗣𝗘𝗧𝗥𝗢𝗟 𝗗𝗔𝗔𝗟 𝗞𝗘 𝗝𝗔𝗟𝗔 𝗗𝗨𝗚𝗔😬`,
            `🙄𝗠𝗨𝗛 𝗠𝗘 𝗟𝗘𝗚𝗔 𝗞𝗬𝗔 𝗠𝗖🙄👈🏻`,
            `🙄𝗕𝗢𝗧 𝗡𝗛𝗜 𝗧𝗘𝗥𝗜 𝗕𝗛𝗔𝗡 𝗞𝗜 𝗖𝗛𝗨𝗧 𝗠𝗔𝗔𝗥𝗡𝗘 𝗪𝗔𝗟𝗔 𝗛𝗨🙄👈🏻`,
            `🙄𝗔𝗕𝗬 𝗦𝗔𝗟𝗘 𝗦𝗨𝗞𝗛𝗘 𝗛𝗨𝗘 𝗟𝗔𝗡𝗗 𝗞𝗘 𝗔𝗗𝗛𝗠𝗥𝗘 𝗞𝗬𝗨 𝗕𝗛𝗢𝗞 𝗥𝗛𝗔🙄👈🏻`,
            `🙄𝗖𝗛𝗔𝗟 𝗔𝗣𝗡𝗜 𝗚𝗔𝗡𝗗 𝗗𝗘 𝗔𝗕 𝘿𝙀𝙀𝙋 𝘽4𝘿𝙈4𝙎𝙃 𝗞𝗢😼👈🏻`
        ];
        replyMessage = botResponses[Math.floor(Math.random() * botResponses.length)];
        isReply = true;
      }
      
      if (isReply) {
          await delay(REPLY_DELAY); // ← YEH LINE ADD KI HAI SPEED CONTROL KE LIYE
          const formattedReply = await formatMessage(api, event, replyMessage);
          return await api.sendMessage(formattedReply, threadID);
      }
    }

    if (!body || !body.startsWith(prefix)) return;
    const args = body.slice(prefix.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    let commandReply = '';

    // ... [saare commands same hi hain]

    if (commandReply) {
        await delay(REPLY_DELAY); // ← Command replies mein bhi delay laga diya
        const formattedReply = await formatMessage(api, event, commandReply);
        await api.sendMessage(formattedReply, threadID);
    }

  } catch (err) {
    emitLog('❌ Error in handleMessage: ' + err.message, true);
  }
}

// Baaki pura code 100% same hai jo tumhara tha... (startListening, handlers, web server sab same)

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  emitLog(`✅ Server running on port ${PORT}`);
});
