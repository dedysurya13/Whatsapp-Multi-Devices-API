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

const port = process.env.PORT || 8000;
const app = express();
const server = http.createServer(app);
const io = socketIO(server);

// Session Management
const sessions = new Map();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(fileUpload({ debug: true }));
app.use('/dist', express.static(path.join(__dirname, 'dist')));
app.use('/plugins', express.static(path.join(__dirname, 'plugins')));

function createClient(sessionId) {
  const client = new Client({
    restartOnAuthFail: true,
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu'
      ],
    },
    authStrategy: new LocalAuth({
      clientId: sessionId 
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
  });

  client.on('ready', async () => {
    const version = await client.getWWebVersion();
    const sessionData = sessions.get(sessionId);
    sessionData.connected = true;
    sessionData.phoneNumber = client.info.wid.user;
    sessionData.pushname = client.info.pushname;
    
    io.to(sessionId).emit('ready', { 
      sessionId,
      pushname: client.info.pushname,
      phoneNumber: client.info.wid.user
    });
  });

  client.on('authenticated', () => {
    io.to(sessionId).emit('authenticated', { sessionId });
  });

  client.on('disconnected', (reason) => {
    io.to(sessionId).emit('disconnected', { sessionId, reason });
    sessions.delete(sessionId);
  });

  client.on('message', msg => handleMessage(sessionId, msg));
  client.initialize();
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

// Create New Session
app.post('/api/sessions', [
  body('sessionId').notEmpty(),
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { sessionId, port } = req.body;
  if (sessions.has(sessionId)) return res.status(400).json({ error: 'Session already exists' });

  sessions.set(sessionId, {
    client: createClient(sessionId),
    connected: false,
    phoneNumber: null,
    pushname: null
  });

  res.json({ success: true });
});

// Send Message
app.post('/:sessionId/send-message', [
  body('number').notEmpty(),
  body('message').notEmpty(),
], async (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const errors = validationResult(req).formatWith(({ msg }) => msg);
  if (!errors.isEmpty()) return res.status(422).json({ errors: errors.mapped() });

  const number = phoneNumberFormatter(req.body.number);
  const message = req.body.message;

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

    const response = await session.client.sendMessage(number, message);
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

const findGroupByName = async function(name) {
  const group = await client.getChats().then(chats => {
    return chats.find(chat => 
      chat.isGroup && chat.name.toLowerCase() == name.toLowerCase()
    );
  });
  return group;
}

// Send message to group
// You can use chatID or group name, yea!
app.post('/:sessionId/send-group-message', [
  body('id').custom((value, { req }) => {
    if (!value && !req.body.name) {
      throw new Error('Invalid value, you can use `id` or `name`');
    }
    return true;
  }),
  body('message').notEmpty(),
], async (req, res) => {
  const errors = validationResult(req).formatWith(({
    msg
  }) => {
    return msg;
  });

  if (!errors.isEmpty()) {
    return res.status(422).json({
      status: false,
      message: errors.mapped()
    });
  }
  
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  let chatId = req.body.id;
  const groupName = req.body.name;
  const message = req.body.message;

  // Find the group by name
  if (!chatId) {
    const group = await findGroupByName(groupName);
    if (!group) {
      connectedSocket.emit('message', `Grup ${groupName} tidak ditemukan!`);
      connectedSocket.emit('response', `{ status: false, message: "Grup ${groupName} tidak ditemukan!"}`);
      return res.status(422).json({
        status: false,
        message: `Grup ${groupName} tidak ditemukan!`
      });
    }
    chatId = group.id._serialized;
  }

  try {
    const response = await session.client.sendMessage(chatId, message);
    res.json({ status: true, response });
  } catch (err) {
    res.status(500).json({ status: false, error: err.message });
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
app.post('/delete-message', [
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

// Dapatkan Daftar Session
app.get('/api/sessions', (req, res) => {
  const sessionList = Array.from(sessions.entries()).map(([sessionId, sessionData]) => ({
    sessionId,
    connected: sessionData.connected,
    phoneNumber: sessionData.phoneNumber,
    pushname: sessionData.pushname
  }));
  res.json(sessionList);
});

// Socket.IO Setup
io.on('connection', (socket) => {
  socket.on('joinSession', (sessionId) => {
    socket.join(sessionId);
    const session = sessions.get(sessionId);
    if (session && session.connected) {
      socket.emit('ready', {
        sessionId,
        pushname: session.pushname,
        phoneNumber: session.phoneNumber
      });
    }
  });

  socket.on('disconnectSession', (sessionId) => {
    const session = sessions.get(sessionId);
    if (session) {
      session.client.destroy();
      sessions.delete(sessionId);
      io.to(sessionId).emit('disconnected', { sessionId, reason: 'Manual disconnect' });
    }
  });
});

// Jalankan Server
server.listen(port, () => {
  console.log(`Server berjalan di http://localhost:${port}`);
});
