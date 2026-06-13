/**
 * Scribbly! - Multiplayer Drawing Game Server
 * Distributed Systems Mini Project
 *
 * Architecture:
 *  - Express serves the static HTML client
 *  - WebSocket (ws) handles all real-time events
 *  - Rooms isolate game state per group of players
 *  - Anthropic API generates words + hints
 *
 * Distributed concepts demonstrated:
 *  - Message-passing concurrency (WebSocket events)
 *  - Shared state with a central coordinator (server-side room state)
 *  - Fault tolerance (player disconnect handling, room cleanup)
 *  - Leader election (drawer rotation)
 *  - Broadcast vs. unicast messaging patterns
 */

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const Anthropic = require('@anthropic-ai/sdk');

// ─── Config ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

const anthropic = ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: ANTHROPIC_API_KEY })
  : null;

// Fallback word bank if no API key
const FALLBACK_WORDS = [
  ['cat','bicycle','constellation'],
  ['tree','umbrella','microscope'],
  ['house','guitar','parachute'],
  ['fish','airplane','philosopher'],
  ['sun','lighthouse','submarine'],
  ['bird','telescope','thunderstorm'],
  ['book','volcano','kaleidoscope'],
  ['car','butterfly','architecture'],
  ['apple','compass','hieroglyphics'],
  ['dog','rainbow','electromagnetic'],
];
let fallbackIdx = 0;

// ─── App Setup ───────────────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, '../client')));

// ─── Room State ──────────────────────────────────────────────────────────────
// rooms: Map<roomCode, RoomState>
const rooms = new Map();

function createRoom(code) {
  return {
    code,
    players: new Map(),       // playerId -> playerObj
    phase: 'lobby',           // lobby | choosing | drawing | reveal | gameover
    currentDrawerId: null,
    drawerOrder: [],           // ordered player ids for turns
    currentWord: '',
    wordChoices: [],
    currentRound: 1,
    totalRounds: 3,
    drawTime: 80,
    timeLeft: 0,
    timerInterval: null,
    hintInterval: null,
    guessedPlayers: new Set(),
    revealedIndices: new Set(),
    drawingData: [],           // stroke history for late joiners
    chat: [],
    createdAt: Date.now(),
  };
}

function createPlayer(ws, id, name, avatar) {
  return { ws, id, name, avatar, score: 0, connected: true };
}

// ─── Anthropic helpers ───────────────────────────────────────────────────────
async function fetchWordChoices() {
  if (!anthropic) {
    const words = FALLBACK_WORDS[fallbackIdx % FALLBACK_WORDS.length];
    fallbackIdx++;
    return words;
  }
  try {
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: 'Give me exactly 3 random drawing words for a Pictionary game. Mix difficulties: one easy, one medium, one hard. Return ONLY a JSON array of 3 strings, nothing else. Example: ["cat","bicycle","constellation"]'
      }]
    });
    const text = msg.content[0].text.trim().replace(/```json|```/g, '').trim();
    const arr = JSON.parse(text);
    if (Array.isArray(arr) && arr.length >= 3) return arr.slice(0, 3);
  } catch (e) {
    console.error('Anthropic word fetch failed:', e.message);
  }
  const words = FALLBACK_WORDS[fallbackIdx % FALLBACK_WORDS.length];
  fallbackIdx++;
  return words;
}

async function fetchHint(word) {
  if (!anthropic) return `It has ${word.length} letters`;
  try {
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 80,
      messages: [{
        role: 'user',
        content: `Give a subtle hint for the word "${word}" in a drawing game. Do NOT say the word or any part of it. Max 10 words. Return only the hint text.`
      }]
    });
    return msg.content[0].text.trim();
  } catch (e) {
    return `Think carefully about what's being drawn...`;
  }
}

// ─── Messaging helpers ───────────────────────────────────────────────────────
function send(ws, type, payload = {}) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, ...payload }));
  }
}

function broadcast(room, type, payload = {}, excludeId = null) {
  room.players.forEach((player, id) => {
    if (id !== excludeId && player.connected) {
      send(player.ws, type, payload);
    }
  });
}

function broadcastAll(room, type, payload = {}) {
  broadcast(room, type, payload, null);
}

// ─── Room code generator ─────────────────────────────────────────────────────
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

// ─── Game Logic ──────────────────────────────────────────────────────────────
function getPlayerList(room) {
  return [...room.players.values()].map(p => ({
    id: p.id,
    name: p.name,
    avatar: p.avatar,
    score: p.score,
    connected: p.connected,
  }));
}

function getMaskedWord(room, forPlayerId) {
  const word = room.currentWord;
  if (!word) return '';
  if (forPlayerId === room.currentDrawerId) return word; // drawer sees full word
  return [...word].map((c, i) => {
    if (c === ' ') return ' ';
    return room.revealedIndices.has(i) ? c : '_';
  }).join(' ');
}

function revealRandomLetter(room) {
  const word = room.currentWord;
  const candidates = [...word].map((c, i) => c !== ' ' && !room.revealedIndices.has(i) ? i : -1).filter(i => i >= 0);
  if (candidates.length > 0) {
    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    room.revealedIndices.add(pick);
    // broadcast updated masked word to non-drawers
    room.players.forEach((player) => {
      send(player.ws, 'word_update', { masked: getMaskedWord(room, player.id) });
    });
  }
}

async function startTurn(room) {
  clearTimers(room);
  room.phase = 'choosing';
  room.guessedPlayers = new Set();
  room.revealedIndices = new Set();
  room.currentWord = '';
  room.drawingData = [];

  // Clear canvas for everyone
  broadcastAll(room, 'clear_canvas');

  const drawer = room.players.get(room.currentDrawerId);
  if (!drawer) { advanceTurn(room); return; }

  broadcastAll(room, 'turn_start', {
    drawerId: room.currentDrawerId,
    drawerName: drawer.name,
    round: room.currentRound,
    totalRounds: room.totalRounds,
  });

  addChat(room, null, `${drawer.name} is choosing a word...`, 'system');

  // Fetch words
  const words = await fetchWordChoices();
  room.wordChoices = words;

  // Send choices only to drawer
  send(drawer.ws, 'choose_word', { words });

  // Others wait
  broadcast(room, 'waiting_for_word', { drawerName: drawer.name }, room.currentDrawerId);
}

async function beginDrawing(room, word) {
  room.currentWord = word;
  room.phase = 'drawing';
  room.timeLeft = room.drawTime;

  // Send each player their view
room.players.forEach((player) => {
  send(player.ws, 'drawing_start', {
    masked: getMaskedWord(room, player.id),
    timeLeft: room.timeLeft,
    wordLength: room.currentWord.length,
    spaces: [...room.currentWord].map((c,i)=>c===' '?i:-1).filter(i=>i>=0)
  });
});

  addChat(room, null, `Round ${room.currentRound}/${room.totalRounds} — Guess the drawing!`, 'system');

  // Fetch hint in background
  fetchHint(word).then(hint => {
    room._hint = hint;
  });

  // Main timer
  room.timerInterval = setInterval(() => {
    room.timeLeft--;

    broadcastAll(room, 'timer', { timeLeft: room.timeLeft });

    // Progressive letter reveal
    if (room.timeLeft === Math.floor(room.drawTime * 0.5)) revealRandomLetter(room);
    if (room.timeLeft === Math.floor(room.drawTime * 0.25)) revealRandomLetter(room);

    // Show hint at 50%
    if (room.timeLeft === Math.floor(room.drawTime * 0.5) && room._hint) {
      broadcastAll(room, 'hint', { hint: room._hint });
      addChat(room, null, `💡 Hint: ${room._hint}`, 'hint');
    }

    if (room.timeLeft <= 0) endTurn(room);
  }, 1000);
}

function handleGuess(room, playerId, guess) {
  if (room.phase !== 'drawing') return;
  if (playerId === room.currentDrawerId) return;
  if (room.guessedPlayers.has(playerId)) return;

  const player = room.players.get(playerId);
  if (!player) return;

  const correct = guess.trim().toLowerCase() === room.currentWord.toLowerCase();

  if (correct) {
    const pts = Math.max(50, Math.round((room.timeLeft / room.drawTime) * 300));
    player.score += pts;
    room.guessedPlayers.add(playerId);

    // Give drawer partial credit
    const drawer = room.players.get(room.currentDrawerId);
    if (drawer) drawer.score += 30;

    addChat(room, null, `✅ ${player.name} guessed the word! +${pts} pts`, 'correct');
    broadcastAll(room, 'player_guessed', {
      playerId,
      playerName: player.name,
      points: pts,
      players: getPlayerList(room),
    });

    // Check if everyone guessed
    const nonDrawers = [...room.players.values()].filter(p => p.id !== room.currentDrawerId && p.connected);
    if (nonDrawers.every(p => room.guessedPlayers.has(p.id))) {
      setTimeout(() => endTurn(room), 1000);
    }
  } else {
    // Broadcast wrong guess as chat to all
    addChat(room, playerId, guess, 'guess');
    broadcastAll(room, 'chat', { playerId, playerName: player.name, message: guess, cls: 'guess' });
  }
}

function endTurn(room) {
  clearTimers(room);
  room.phase = 'reveal';

  broadcastAll(room, 'turn_end', {
    word: room.currentWord,
    players: getPlayerList(room),
  });

  addChat(room, null, `The word was: "${room.currentWord}"`, 'system');

  // Advance to next drawer
  const idx = room.drawerOrder.indexOf(room.currentDrawerId);
  const nextIdx = (idx + 1) % room.drawerOrder.length;
  room.currentDrawerId = room.drawerOrder[nextIdx];

  if (nextIdx === 0) {
    room.currentRound++;
  }

  if (room.currentRound > room.totalRounds) {
    setTimeout(() => endGame(room), 2500);
  } else {
    setTimeout(() => startTurn(room), 3000);
  }
}

function endGame(room) {
  clearTimers(room);
  room.phase = 'gameover';
  const sorted = [...room.players.values()]
    .sort((a, b) => b.score - a.score)
    .map(p => ({ id: p.id, name: p.name, avatar: p.avatar, score: p.score }));

  broadcastAll(room, 'game_over', { leaderboard: sorted });
}

function addChat(room, senderId, message, cls) {
  const entry = { senderId, message, cls, ts: Date.now() };
  room.chat.push(entry);
  if (room.chat.length > 200) room.chat.shift();
}

function advanceTurn(room) {
  // skip disconnected players
  const alive = room.drawerOrder.filter(id => {
    const p = room.players.get(id);
    return p && p.connected;
  });
  if (alive.length === 0) return;
  room.currentDrawerId = alive[0];
  startTurn(room);
}

function clearTimers(room) {
  if (room.timerInterval) { clearInterval(room.timerInterval); room.timerInterval = null; }
  if (room.hintInterval) { clearInterval(room.hintInterval); room.hintInterval = null; }
}

// ─── WebSocket handler ───────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  const playerId = uuidv4();
  let playerRoom = null;

  console.log(`[WS] New connection: ${playerId}`);

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    const { type, ...data } = msg;

    // ── CREATE ROOM ────────────────────────────────────────────────
    if (type === 'create_room') {
      const code = generateRoomCode();
      const room = createRoom(code);
      const player = createPlayer(ws, playerId, data.name, data.avatar);
      room.players.set(playerId, player);
      room.totalRounds = data.rounds || 3;
      room.drawTime = data.drawTime || 80;
      rooms.set(code, room);
      playerRoom = room;

      send(ws, 'room_created', {
        roomCode: code,
        playerId,
        players: getPlayerList(room),
        isHost: true,
        totalRounds: room.totalRounds,
        drawTime: room.drawTime,
      });
      console.log(`[ROOM] Created: ${code} by ${data.name}`);
    }

    // ── JOIN ROOM ──────────────────────────────────────────────────
    else if (type === 'join_room') {
      const room = rooms.get(data.roomCode?.toUpperCase());
      if (!room) { send(ws, 'error', { message: 'Room not found. Check the code!' }); return; }
      if (room.phase !== 'lobby') { send(ws, 'error', { message: 'Game already started!' }); return; }
      if (room.players.size >= 8) { send(ws, 'error', { message: 'Room is full (max 8 players)' }); return; }

      const player = createPlayer(ws, playerId, data.name, data.avatar);
      room.players.set(playerId, player);
      playerRoom = room;

      send(ws, 'room_joined', {
        roomCode: room.code,
        playerId,
        players: getPlayerList(room),
        isHost: false,
        totalRounds: room.totalRounds,
        drawTime: room.drawTime,
      });

      broadcast(room, 'player_joined', {
        player: { id: playerId, name: data.name, avatar: data.avatar, score: 0, connected: true },
        players: getPlayerList(room),
      }, playerId);

      addChat(room, null, `${data.name} joined the room!`, 'system');
      broadcastAll(room, 'chat_msg', { message: `${data.name} joined the room!`, cls: 'system' });
      console.log(`[ROOM] ${data.name} joined ${room.code}`);
    }

    // ── START GAME (host only) ─────────────────────────────────────
    else if (type === 'start_game') {
      if (!playerRoom) return;
      const room = playerRoom;
      if (room.players.size < 2) { send(ws, 'error', { message: 'Need at least 2 players to start!' }); return; }

      // Build drawer rotation (shuffle)
      const ids = [...room.players.keys()];
      room.drawerOrder = ids.sort(() => Math.random() - 0.5);
      room.currentDrawerId = room.drawerOrder[0];
      room.currentRound = 1;
      room.phase = 'starting';

      broadcastAll(room, 'game_starting', {
        drawerOrder: room.drawerOrder,
        totalRounds: room.totalRounds,
        drawTime: room.drawTime,
        players: getPlayerList(room),
      });

      await startTurn(room);
    }

    // ── WORD CHOSEN (drawer) ───────────────────────────────────────
    else if (type === 'word_chosen') {
      if (!playerRoom) return;
      const room = playerRoom;
      if (playerId !== room.currentDrawerId) return;
      if (room.phase !== 'choosing') return;
      await beginDrawing(room, data.word);
    }

    // ── DRAW EVENT (stroke data) ───────────────────────────────────
// ── DRAW EVENT (REAL FIX) ───────────────────────────────────
else if (type === 'stroke' || type === 'dot') {
  if (!playerRoom) return;
  const room = playerRoom;

  if (playerId !== room.currentDrawerId || room.phase !== 'drawing') return;

  // store stroke
  room.drawingData.push({ type, ...data });

  // send SAME event type (important)
  broadcast(room, type, data, playerId);
}

    // ── CLEAR CANVAS ───────────────────────────────────────────────
    else if (type === 'clear') {
      if (!playerRoom) return;
      const room = playerRoom;
      if (playerId !== room.currentDrawerId) return;
      room.drawingData = [];
      broadcastAll(room, 'clear_canvas', {}, playerId);
    }

    // ── UNDO ───────────────────────────────────────────────────────
    else if (type === 'undo') {
      if (!playerRoom) return;
      const room = playerRoom;
      if (playerId !== room.currentDrawerId) return;
      // Remove last stroke batch
      if (data.snapshotId && room.drawingData.length) {
        const idx = room.drawingData.findLastIndex(d => d.snapshotId === data.snapshotId);
        if (idx >= 0) room.drawingData = room.drawingData.slice(0, idx);
      }
      broadcast(room, 'undo', { snapshotId: data.snapshotId }, playerId);
    }

    // ── CHAT / GUESS ───────────────────────────────────────────────
    else if (type === 'chat') {
      if (!playerRoom) return;
      const room = playerRoom;
      if (room.phase === 'drawing') {
        handleGuess(room, playerId, data.message);
      } else {
        const player = room.players.get(playerId);
        if (!player) return;
        addChat(room, playerId, data.message, 'chat');
        broadcastAll(room, 'chat_msg', {
          playerName: player.name,
          message: data.message,
          cls: 'chat',
        });
      }
    }

    // ── SETTINGS UPDATE (host) ─────────────────────────────────────
    else if (type === 'update_settings') {
      if (!playerRoom) return;
      const room = playerRoom;
      if (room.phase !== 'lobby') return;
      if (data.rounds) room.totalRounds = data.rounds;
      if (data.drawTime) room.drawTime = data.drawTime;
      broadcastAll(room, 'settings_updated', {
        totalRounds: room.totalRounds,
        drawTime: room.drawTime,
      });
    }
  });

  ws.on('close', () => {
    if (!playerRoom) return;
    const room = playerRoom;
    const player = room.players.get(playerId);
    if (player) {
      player.connected = false;
      console.log(`[WS] Disconnected: ${player.name} from ${room.code}`);
      broadcast(room, 'player_left', { playerId, playerName: player.name, players: getPlayerList(room) });
      addChat(room, null, `${player.name} disconnected.`, 'system');
      broadcastAll(room, 'chat_msg', { message: `${player.name} disconnected.`, cls: 'system' });

      // If drawer disconnected, skip turn
      if (room.phase === 'drawing' && playerId === room.currentDrawerId) {
        clearTimers(room);
        setTimeout(() => endTurn(room), 1500);
      }

      // Cleanup empty rooms
      const anyConnected = [...room.players.values()].some(p => p.connected);
      if (!anyConnected) {
        clearTimers(room);
        rooms.delete(room.code);
        console.log(`[ROOM] Cleaned up empty room: ${room.code}`);
      }
    }
  });

  ws.on('error', (err) => console.error('[WS] Error:', err.message));
});

// ─── Start server ─────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  🎨 Scribbly! Multiplayer Game Server');
  console.log('  ─────────────────────────────────────');
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  Network: http://<your-ip>:${PORT}`);
  console.log('');
  if (!ANTHROPIC_API_KEY) {
    console.log('  ⚠️  No ANTHROPIC_API_KEY set — using fallback word bank');
    console.log('  Set it: export ANTHROPIC_API_KEY=sk-ant-...');
  } else {
    console.log('  ✅ Anthropic API connected — AI words enabled');
  }
  console.log('');
  console.log('  Share your network URL with friends to play!');
  console.log('');
});
