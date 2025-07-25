const { Client, MessageMedia, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const { body, validationResult } = require('express-validator');
const socketIO = require('socket.io');
const qrcode = require('qrcode');
const http = require('http');
const fs = require('fs');
const { phoneNumberFormatter } = require('./helpers/formatter');
const fileUpload = require('express-fileupload');
const axios = require('axios');
const mime = require('mime-types');
const cors = require('cors');
const path = require('path');

//Catch Unhandled Promise Rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('UNHANDLED REJECTION!');
  console.error('Reason:', reason);
  if (reason && reason.message && reason.message.includes('Target closed')) {
    console.warn('[Warning] "Target closed" error handled gracefully.');
    return;
  }

  if (reason && reason.message && reason.message.includes('ERR_NAME_NOT_RESOLVED')) {
    console.error('[Network Error] Could not resolve domain. Please check the server\'s internet connection and DNS settings then restart the server.');
  } else {
    console.error('Reason:', reason);
  }

  server.close(() => {
    process.exit(1);
  });
});

//Catch Uncaught Synchronous Exceptions
process.on('uncaughtException', (error) => {
  console.error('UNCAUGHT EXCEPTION! Shutting down...');
  console.error('Error:', error);
  process.exit(1);
});

//Graceful Shutdown
const shutdown = (signal) => {
  console.log(`\n${signal} received. Shutting down gracefully...`);
  server.close(() => {
    console.log('All connections closed. Server is down.');
    process.exit(0);
  });
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));


const port = process.env.PORT || 8000;
const app = express();
const server = http.createServer(app);
const io = socketIO(server);

// Session Management
const sessions = new Map();
const SESSIONS_FILE = './sessions.json';

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(fileUpload({ debug: true }));
app.use('/dist', express.static(path.join(__dirname, 'dist')));
app.use('/plugins', express.static(path.join(__dirname, 'plugins')));

function saveSessionsToFile() {
  const sessionData = Array.from(sessions.entries()).map(([sessionId, session]) => ({
    sessionId,
    connected: session.connected,
    phoneNumber: session.phoneNumber,
    pushname: session.pushname
  }));
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessionData, null, 2));
}

function loadSessionsFromFile() {
  if (fs.existsSync(SESSIONS_FILE)) {
    const sessionData = JSON.parse(fs.readFileSync(SESSIONS_FILE));
    sessionData.forEach(({ sessionId }) => {
      const client = createClient(sessionId);

      sessions.set(sessionId, {
        client,
        connected: false,
        phoneNumber: null,
        pushname: null,
      });

      client.initialize();
    });
  }
}

function createClient(sessionId) {
  const client = new Client({
    restartOnAuthFail: true,
    puppeteer: {
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--single-process", // Matikan multi-process untuk mengurangi penggunaan memori
        "--disable-gpu",
        "--disable-extensions", // Matikan ekstensi
        "--disable-background-networking", // Matikan proses network di latar belakang
        "--disable-default-apps", // Matikan aplikasi default
        "--disable-sync", // Matikan sinkronisasi
        "--disable-translate", // Matikan fitur terjemahan
        "--hide-scrollbars", // Sembunyikan scrollbar
        "--mute-audio", // Matikan audio
        "--no-default-browser-check", // Jangan cek browser default
        "--no-pings", // Jangan kirim ping
        "--no-startup-window", // Jangan buat startup window
        "--safeBrowse-disable-auto-update", // Matikan update safeBrowse
        "--ignore-certificate-errors",
        "--ignore-ssl-errors",
        "--ignore-certificate-errors-spki-list",
      ],
    },
    authStrategy: new LocalAuth({
      clientId: sessionId,
      // dataPath: './.wwebjs_auth'
    }),
    // webVersionCache: {
    // type: 'none'
    // type: 'remote',
    // remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2413.51-beta.html',
    // remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1014547162-alpha.html'
    // }
  });

  client.on('qr', (qr) => {
    qrcode.toDataURL(qr, (err, url) => {
      io.to(sessionId).emit('qr', { sessionId, url });
    });
    io.to(sessionId).emit("message", "QR Code diterima, silakan scan.");
  });

  client.on('ready', async () => {
    const version = await client.getWWebVersion();
    const sessionData = sessions.get(sessionId);
    sessionData.connected = true;
    sessionData.phoneNumber = client.info.wid.user;
    sessionData.pushname = client.info.pushname;

    saveSessionsToFile();
    
    io.to(sessionId).emit('ready', { 
      sessionId,
      pushname: client.info.pushname,
      phoneNumber: client.info.wid.user
    });
  });

  client.on('authenticated', () => {
    io.to(sessionId).emit('authenticated', { sessionId });
  });

  client.on("message_ack", (msg, ack) => {
    const ackStatus = {
      "-1": "Error", //error kirim ke server
      0: "Pending", //pending kirim ke server
      1: "Server", //berhasil dikirim ke server
      2: "Device", //berhasil dikirim ke penerima
      3: "Read", //telah dibaca
      4: "Played", //telah diputar (audio/video)
    };
    io.to(sessionId).emit("message_ack", {
      sesId:sessionId,
      id: msg.id.id,
      ack: ack,
      ackName: ackStatus[ack] || "Unknown",
    });
  });

  client.on("auth_failure", (msg) => {
    console.error(`[${sessionId}] Authentication failed:`, msg);
  });

  client.on("disconnected", (reason) => {
    console.log(`[${sessionId}] Disconnected:`, reason);

    const sessionData = sessions.get(sessionId);

    if (sessionData) {
      sessionData.connected = false;
      saveSessionsToFile();
      io.to(sessionId).emit("disconnected", {
        sessionId,
        reason: "Session disconnected",
      });
    }
  });

  client.on('message', msg => handleMessage(sessionId, msg));
  return client;
}

function handleMessage(sessionId, msg) {
  if(msg.body == '!ping') {
    msg.reply('pong');
  } else if (msg.body == 'good morning') {
    msg.reply('selamat pagi');
  } else if (msg.body == '!groups') {
    client.getChats().then(chats => {
      const groups = chats.filter(chat => chat.isGroup);

      if (groups.length == 0) {
        msg.reply('You have no group yet.');
      } else {
        let replyMsg = '*YOUR GROUPS*\n\n';
        groups.forEach((group, i) => {
          replyMsg += `ID: ${group.id._serialized}\nName: ${group.name}\n\n`;
        });
        replyMsg += '_You can use the group id to send a message to the group._'
        msg.reply(replyMsg);
      }
    });
  } else if (msg.body == "command") {
    const { from } = msg;
    let embed = new WwebjsSender.MessageEmbed()
      .setTitle("✅ | Successful process!")
      .setDescription(
        "The process has been successful! To confirm press *Yes* or press *No* to cancel."
      )
      .setFooter("WwebjsSender")
      .setTimestamp();

    let button1 = new WwebjsSender.MessageButton()
      .setCustomId("yes")
      .setLabel("Yes");

    let button2 = new WwebjsSender.MessageButton()
      .setCustomId("no")
      .setLabel("No");

    WwebjsSender.send({
      client: client,
      number: from,
      embed: embed,
      button: [button1, button2],
    });
  }
  // Downloading media
  // if (msg.hasMedia) {
  //   msg.downloadMedia().then(media => {
  //     // To better understanding
  //     // Please look at the console what data we get
  //     console.log(media);

  //     if (media) {
  //       // The folder to store: change as you want!
  //       // Create if not exists
  //       const mediaPath = './downloaded-media/';

  //       if (!fs.existsSync(mediaPath)) {
  //         fs.mkdirSync(mediaPath);
  //       }

  //       // Get the file extension by mime-type
  //       const extension = mime.extension(media.mimetype);
        
  //       // Filename: change as you want! 
  //       // I will use the time for this example
  //       // Why not use media.filename? Because the value is not certain exists
  //       const filename = new Date().getTime();

  //       const fullFilename = mediaPath + filename + '.' + extension;

  //       // Save to file
  //       try {
  //         // fs.writeFileSync(fullFilename, media.data, { encoding: 'base64' }); 
  //         console.log('File downloaded successfully!', fullFilename);
  //       } catch (err) {
  //         console.log('Failed to save the file:', err);
  //       }
  //     }
  //   });
  // }
};

// API Endpoints
app.get('/', (req, res) => {
  res.sendFile('index.html', { root: __dirname });
});

app.post("/api/sessions", [body("sessionId").notEmpty()], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty())
    return res.status(400).json({ errors: errors.array() });

  const { sessionId } = req.body; 
  if (sessions.has(sessionId))
    return res.status(400).json({ error: "Session already exists" });

  const client = createClient(sessionId);

  sessions.set(sessionId, {
    client: client,
    connected: false,
    phoneNumber: null,
    pushname: null,
  });

  client.initialize();

  saveSessionsToFile();
  res.json({
    success: true,
    message: "Session created. Please scan the QR code.",
  });
});

// Get sessions list
app.get('/api/sessions', (req, res) => {
  const sessionList = Array.from(sessions.entries()).map(([sessionId, sessionData]) => ({
    sessionId,
    connected: sessionData.connected,
    phoneNumber: sessionData.phoneNumber,
    pushname: sessionData.pushname
  }));
  res.json(sessionList);
});

// Send Message
app.post('/:sessionId/send-message', [
  body('number').notEmpty(),
  body('message').notEmpty(),
], async (req, res) => {
  const sessionId = req.params.sessionId;
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const errors = validationResult(req).formatWith(({ msg }) => msg);
  if (!errors.isEmpty()) return res.status(422).json({ errors: errors.mapped() });

  const number = phoneNumberFormatter(req.body.number);
  const message = req.body.message;

  try {

    const response = await session.client.sendMessage(number, message);
    io.to(sessionId).emit("response", response);
    res.json({ status: true, response });
  } catch (err) {
    res.status(500).json({ status: false, error: err.message });
  }
});

// Send Media Local
app.post('/:sessionId/send-media-local', async (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const number = phoneNumberFormatter(req.body.number);
  const caption = req.body.caption;
  const media = MessageMedia.fromFilePath('./local-file.png');

  try {
    const response = await session.client.sendMessage(number, media, { caption });
    res.json({ status: true, response });
  } catch (err) {
    res.status(500).json({ status: false, error: err.message });
  }
});

// Send Media Upload
app.post('/:sessionId/send-media-upload', async (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const number = phoneNumberFormatter(req.body.number);
  const caption = req.body.caption;
  const file = req.files.file;
  const fileName = req.body.title || file.name || 'Media';
  const media = new MessageMedia(file.mimetype, file.data.toString('base64'), fileName);

  try {
    const response = await session.client.sendMessage(number, media, { caption });
    res.json({ status: true, response });
  } catch (err) {
    res.status(500).json({ status: false, error: err.message });
  }
});

// Send Media Link
app.post('/:sessionId/send-media-link', async (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const number = phoneNumberFormatter(req.body.number);
  const caption = req.body.caption;
  const fileUrl = req.body.file;
  const fileName = req.body.title || 'Media';

  let mimetype;
  const attachment = await axios.get(fileUrl, {
    responseType: 'arraybuffer'
  }).then(response => {
    mimetype = response.headers['content-type'];
    return response.data.toString('base64');
  });

  const media = new MessageMedia(mimetype, attachment, fileName);

  try {
    const response = await session.client.sendMessage(number, media, { caption });
    res.json({ status: true, response });
  } catch (err) {
    res.status(500).json({ status: false, error: err.message });
  }
});

const findGroupByName = async function(client, name) {
  const group = await client.getChats().then(chats => {
    return chats.find(chat => 
      chat.isGroup && chat.name.toLowerCase() === name.toLowerCase()
    );
  });
  return group;
};

// Send message to group
// You can use chatID or group name
app.post('/:sessionId/send-group-message', [
  body('id').custom((value, { req }) => {
    if (!value && !req.body.name) {
      throw new Error('Invalid value, you can use `id` or `name`');
    }
    return true;
  }),
  body('message').notEmpty(),
], async (req, res) => {
  const errors = validationResult(req).formatWith(({ msg }) => msg);

  if (!errors.isEmpty()) {
    return res.status(422).json({
      status: false,
      message: errors.mapped()
    });
  }

  const sessionId = req.params.sessionId;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).json({
      status: false,
      message: `Session dengan ID ${sessionId} tidak ditemukan!`
    });
  }

  const { client } = session;
  let chatId = req.body.id;
  const groupName = req.body.name;
  const message = req.body.message;

  // Cari grup berdasarkan nama jika chatId tidak disediakan
  if (!chatId) {
    const group = await findGroupByName(client, groupName);
    if (!group) {
      return res.status(422).json({
        status: false,
        message: `Grup ${groupName} tidak ditemukan!`
      });
    }
    chatId = group.id._serialized;
  }

  try {
    const response = await client.sendMessage(chatId, message);
    res.status(200).json({
      status: true,
      response: response
    });
  } catch (err) {
    res.status(500).json({
      status: false,
      response: err.message
    });
  }
});

// Clearing message on spesific chat
app.post('/:sessionId/clear-message', [
  body('number').notEmpty(),
], async (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const errors = validationResult(req).formatWith(({ msg }) => msg);
  if (!errors.isEmpty()) return res.status(422).json({ errors: errors.mapped() });

  const number = phoneNumberFormatter(req.body.number);

  try {
    const isRegistered = await session.client.isRegisteredUser(number);
    if (!isRegistered){
      connectedSocket.emit('message', `Nomor ${number.replace(/@c\.us$/, '')} tidak terdaftar`);
      connectedSocket.emit('response', `{ status: false, message: 'Nomor ${number.replace(/@c\.us$/, '')} tidak terdaftar!'}`);
      return res.status(422).json({
        status: false,
        message: 'Nomor tidak terdaftar!'
      });
    }

    const chat = await session.client.getChatById(number);

    const response = await chat.clearMessages();
    res.json({ status: true, response });
  } catch (err) {
    res.status(500).json({ status: false, error: err.message });
  }
});

// Delete your own message on spesific chat
app.post('/:sessionId/delete-message', [
  body('number').notEmpty(),
], async (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const errors = validationResult(req).formatWith(({ msg }) => msg);
  if (!errors.isEmpty()) return res.status(422).json({ errors: errors.mapped() });

  const number = phoneNumberFormatter(req.body.number);
  const limit = req.body.limit || 1;
  const everyone = req.body.everyone || true;

  try {
    const isRegistered = await session.client.isRegisteredUser(number);
    if (!isRegistered){
      connectedSocket.emit('message', `Nomor ${number.replace(/@c\.us$/, '')} tidak terdaftar`);
      connectedSocket.emit('response', `{ status: false, message: 'Nomor ${number.replace(/@c\.us$/, '')} tidak terdaftar!'}`);
      return res.status(422).json({
        status: false,
        message: 'Nomor tidak terdaftar!'
      });
    }

    const chat = await session.client.getChatById(number);

    const messages = await chat.fetchMessages({ limit: limit }); // message limit
    const deletePromises = messages
      .filter(msg => msg.fromMe)
      .map(async (msg) => {
        try {
          await msg.delete(everyone); // true: delete for everyone, false: delete for me
          console.log(`Pesan dihapus: ${msg.body}`);
        } catch (err) {
          console.error('Gagal menghapus pesan:', err);
        }
      });

    await Promise.all(deletePromises);

    connectedSocket.emit('response', `Pesan yang dikirim Anda ke ${number.replace(/@c\.us$/, '')} berhasil dihapus.`);
    res.status(200).json({
      status: true,
      message: `Pesan berhasil dihapus untuk nomor ${number.replace(/@c\.us$/, '')}`
    });
  } catch (err) {
    console.error(err);
    connectedSocket.emit('response', err);
    res.status(500).json({
      status: false,
      message: 'Gagal menghapus pesan!',
      error: err.message
    });
  }
});

app.post("/api/sessions/:sessionId/logout", (req, res) => {
  const sessionId = req.params.sessionId;
  const session = sessions.get(sessionId);

  if (!session) return res.status(404).json({ error: "Session not found" });

  session.client
    .logout()
    .then(() => {
      sessions.delete(sessionId);
      saveSessionsToFile();
      res.json({ success: true });
    })
    .catch((err) => {
      res.status(500).json({ error: err.message });
    });
});

// Socket.IO Setup
io.on('connection', (socket) => {
  socket.on("joinSession", (sessionId) => {
    socket.join(sessionId);
    const session = sessions.get(sessionId);
    if (session && session.connected) {
      socket.emit("ready", {
        sessionId,
        pushname: session.pushname,
        phoneNumber: session.phoneNumber,
      });
    }
  });

  socket.on("disconnectSession", (sessionId) => {
    const session = sessions.get(sessionId);
    if (session) {
      session.client.destroy();
      sessions.delete(sessionId);
      io.to(sessionId).emit("disconnected", {
        sessionId,
        reason: "Manual disconnect",
      });
    }
  });

  socket.on("deleteSession", async (sessionId) => {
    console.log(`[${sessionId}] Received request to delete session.`);
    const session = sessions.get(sessionId);
    const sessionFolderPath = path.join(
      __dirname,
      ".wwebjs_auth",
      `session-${sessionId}`
    );

    try {
      if (session) {
        console.log(`[${sessionId}] Destroying client...`);
        await session.client.destroy();
      }

      sessions.delete(sessionId);
      console.log(`[${sessionId}] Deleted from memory map.`);

      saveSessionsToFile();
      console.log(`[${sessionId}] Updated sessions.json.`);

      setTimeout(() => {
        try {
          if (fs.existsSync(sessionFolderPath)) {
            fs.rmSync(sessionFolderPath, { recursive: true, force: true });
            console.log(`[${sessionId}] Deleted auth folder.`);
          }
          io.emit("sessionDeleted", sessionId);
          console.log(`[${sessionId}] Deletion process completed.`);
        } catch (err) {
          console.error(
            `[${sessionId}] Failed to delete auth folder after delay:`,
            err
          );
        }
      }, 500);
    } catch (err) {
      if (err.message.includes("Target closed")) {
        console.warn(
          `[${sessionId}] Gracefully handled "Target closed" error during session destruction.`
        );
      } else {
        console.error(`[${sessionId}] Failed to destroy session client:`, err);
      }
    }
  });
});

loadSessionsFromFile();
// Jalankan Server
server.listen(port, () => {
  console.log(`Server berjalan di http://localhost:${port}`);
});
