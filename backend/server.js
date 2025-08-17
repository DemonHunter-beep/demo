require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Configuration, OpenAIApi } = require('openai');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

const openai = new OpenAIApi(new Configuration({ apiKey: process.env.OPENAI_API_KEY }));

// In-memory store
const lobbies = {};

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('join', ({ lobbyId, username, password }) => {
    const lobby = lobbies[lobbyId];
    if (!lobby || (lobby.type === 'private' && lobby.password !== password)) {
      socket.emit('error', 'Invalid lobby or password');
      return;
    }
    socket.join(lobbyId);
    socket.lobbyId = lobbyId;
    socket.username = username;
    io.to(lobbyId).emit('user_joined', { username });
  });

  socket.on('message', async ({ content }) => {
    const lobbyId = socket.lobbyId;
    const username = socket.username;
    const msg = { sender: username, content, timestamp: new Date() };
    io.to(lobbyId).emit('message', msg);

    if (!lobbies[lobbyId].messages) lobbies[lobbyId].messages = [];
    lobbies[lobbyId].messages.push(msg);

    const messageCount = lobbies[lobbyId].messages.length;
    if (messageCount % 5 === 0) {
      io.to(lobbyId).emit('game_event', {
        type: 'trivia',
        question: "Quick poll: cats or dogs?",
        options: ["Cats", "Dogs"]
      });
    }

    setTimeout(async () => {
      const botName = "AI_Bot";
      const prompt = `You are \${botName}, a fun and friendly bot. Respond to: "\${content}"`;
      try {
        const stream = await openai.createChatCompletion({
          model: 'gpt-3.5-turbo',
          messages: [{ role: 'user', content: prompt }],
          stream: true,
        }, { responseType: 'stream' });

        let replyContent = '';
        const botMsgId = Date.now();
        stream.data.on('data', (chunk) => {
          const text = chunk.toString();
          const lines = text.split('\n').filter(line => line.trim() !== '');
          for (const line of lines) {
            if (line.includes('[DONE]')) {
              io.to(lobbyId).emit('ai_reply_end', { id: botMsgId });
              return;
            }
            try {
              const parsed = JSON.parse(line.replace(/^ /, ''));
              const token = parsed.choices[0]?.delta?.content || '';
              replyContent += token;
              io.to(lobbyId).emit('ai_reply_chunk', { id: botMsgId, sender: botName, content: token });
            } catch (e) {}
          }
        });
      } catch (err) {
        console.error(err);
        io.to(lobbyId).emit('message', { sender: 'System', content: '[AI: Error]' });
      }
    }, 2000);
  });

  socket.on('create_lobby', (lobby) => {
    lobbies[lobby.id] = { ...lobby, messages: [] };
    socket.join(lobby.id);
    socket.lobbyId = lobby.id;
    io.emit('lobbies_update', Object.keys(lobbies).map(id => ({
      id,
      type: lobbies[id].type,
      playerCount: io.sockets.adapter.rooms.get(id)?.size || 0
    })));
  });

  socket.on('disconnect', () => {
    if (socket.lobbyId) {
      io.to(socket.lobbyId).emit('user_left', { username: socket.username });
    }
  });
});

setInterval(() => {
  io.emit('lobbies_update', Object.keys(lobbies).map(id => ({
    id,
    type: lobbies[id].type,
    playerCount: io.sockets.adapter.rooms.get(id)?.size || 0
  })));
}, 5000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port \${PORT}`);
});
