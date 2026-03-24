const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const fs       = require('fs');
const path     = require('path');
const os       = require('os');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });
const PORT   = process.env.PORT || 3000;

// ─────────────────── helpers ───────────────────
function getLocalIP() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return 'localhost';
}

function loadQuestions() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return Array.from({ length: 20 }, (_, i) => ({
      round: i + 1,
      question: `Question ${i + 1}`,
    }));
  }
}

function parseMarkdownQuestions(md) {
  // Supports:
  //   ## Round 1\nQuestion text
  //   or bare numbered list:
  //   1. Question text
  const lines = md.split('\n').map(l => l.trim()).filter(Boolean);
  const result = [];
  let idx = 1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    // "## Round N" or "# N" heading patterns — skip, use next line as question
    if (/^#{1,3}\s/.test(l)) {
      const next = lines[i + 1];
      if (next && !/^#{1,3}/.test(next)) {
        result.push({ round: idx++, question: next });
        i++;
      }
      continue;
    }
    // Numbered list: "1. Question"
    const match = l.match(/^\d+[.)]\s+(.*)/);
    if (match) {
      result.push({ round: idx++, question: match[1] });
      continue;
    }
    // Plain non-empty line
    if (l.length > 3) {
      result.push({ round: idx++, question: l });
    }
  }
  return result.slice(0, 20);
}

// ─────────────────── game state ───────────────────
const WIN_SCORE = 25;

let state = freshState();

function freshState() {
  return {
    phase: 'lobby',           // lobby | playing | round-open | game-over
    teams: [],
    questions: loadQuestions(),
    currentRound: 1,
    submissions: {},          // socketId → [points per team index]
    players: {},              // socketId → { joined: timestamp }
  };
}

function publicState() {
  return {
    phase:           state.phase,
    teams:           state.teams,
    currentRound:    state.currentRound,
    totalRounds:     state.questions.length,
    currentQuestion: state.questions[state.currentRound - 1]?.question ?? '',
    submittedCount:  Object.keys(state.submissions).length,
    playerCount:     Object.keys(state.players).length,
  };
}

// ─────────────────── routes ───────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '256kb' }));

app.get('/admin', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.get('/api/info', (_req, res) =>
  res.json({ ip: getLocalIP(), port: PORT }));

app.get('/api/questions', (_req, res) =>
  res.json(state.questions));

// Full state snapshot used by client polling on reconnect/reload
app.get('/api/state', (_req, res) => {
  const s = publicState();
  // Include round payload when a round is open so the overlay can be shown
  if (state.phase === 'round-open') {
    s.roundPayload = {
      round:    state.currentRound,
      total:    state.questions.length,
      question: state.questions[state.currentRound - 1]?.question ?? '',
      teams:    state.teams,
    };
  }
  // Include winner info when game is over
  if (state.phase === 'game-over') {
    const sorted = [...state.teams].sort((a, b) => b.score - a.score);
    s.gameOverPayload = { winner: sorted[0], teams: state.teams };
  }
  res.json(s);
});

// Save questions from admin editor (JSON or markdown string)
app.post('/api/questions', (req, res) => {
  try {
    let qs = req.body;
    if (typeof qs === 'string') {
      // Try JSON first, then markdown
      try { qs = JSON.parse(qs); } catch { qs = parseMarkdownQuestions(qs); }
    }
    if (!Array.isArray(qs) || qs.length === 0) throw new Error('No questions parsed');
    qs = qs.map((q, i) => ({
      round: i + 1,
      question: typeof q === 'string' ? q : (q.question ?? `Question ${i+1}`)
    }));
    state.questions = qs;
    fs.writeFileSync(
      path.join(__dirname, 'questions.json'),
      JSON.stringify(qs, null, 2)
    );
    io.emit('state', publicState());
    res.json({ ok: true, count: qs.length });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ─────────────────── sockets ───────────────────
io.on('connection', socket => {
  const role = socket.handshake.query.role; // 'admin' | 'player'

  if (role !== 'admin') {
    state.players[socket.id] = { joined: Date.now() };
    io.emit('state', publicState()); // update player count for admin
  }

  socket.emit('state', publicState());
  // If a round is already open, send the round details to late-joining players
  if (state.phase === 'round-open' && role !== 'admin') {
    socket.emit('round-opened', roundOpenPayload());
  }

  // ── Admin commands ──
  socket.on('admin:teams', teams => {
    if (role !== 'admin') return;
    state.teams = teams.map((t, i) => ({ ...t, score: 0, index: i }));
    io.emit('state', publicState());
  });

  socket.on('admin:start', () => {
    if (role !== 'admin') return;
    state.phase       = 'playing';
    state.currentRound = 1;
    state.submissions  = {};
    state.teams        = state.teams.map(t => ({ ...t, score: 0 }));
    io.emit('state', publicState());
    io.emit('game-started');
  });

  socket.on('admin:open-round', () => {
    if (role !== 'admin' || state.phase !== 'playing') return;
    state.phase       = 'round-open';
    state.submissions = {};
    io.emit('state', publicState());
    io.emit('round-opened', roundOpenPayload());
  });

  socket.on('admin:tally', () => {
    if (role !== 'admin' || state.phase !== 'round-open') return;

    const subs = Object.values(state.submissions);
    if (subs.length > 0) {
      // Average across all player submissions
      const n = subs.length;
      const totals = state.teams.map((_, i) =>
        subs.reduce((s, alloc) => s + (alloc[i] ?? 0), 0) / n
      );
      state.teams = state.teams.map((t, i) => ({
        ...t,
        score: Math.round((t.score + totals[i]) * 10) / 10,
      }));
    }

    const winners = state.teams.filter(t => t.score >= WIN_SCORE);
    const roundsDone = state.currentRound >= state.questions.length;

    if (winners.length > 0 || roundsDone) {
      state.phase = 'game-over';
      const winner = [...state.teams].sort((a, b) => b.score - a.score)[0];
      io.emit('state', publicState());
      io.emit('game-over', { winner, teams: state.teams });
    } else {
      state.currentRound++;
      state.phase      = 'playing';
      state.submissions = {};
      io.emit('state', publicState());
      io.emit('round-closed', { teams: state.teams });
    }
  });

  socket.on('admin:reset', () => {
    if (role !== 'admin') return;
    const players = state.players; // keep connected players
    state = freshState();
    state.players = players;
    io.emit('state', publicState());
    io.emit('reset');
  });

  // ── Player commands ──
  socket.on('player:submit', allocation => {
    if (state.phase !== 'round-open') return;
    // Validate: non-negative, sum ≤ 10
    const alloc = state.teams.map((_, i) => Math.max(0, allocation[i] ?? 0));
    const total = alloc.reduce((s, v) => s + v, 0);
    if (total > 10) return; // reject invalid submission
    state.submissions[socket.id] = alloc;
    io.emit('state', publicState()); // live submission counter
    socket.emit('submitted');
  });

  socket.on('disconnect', () => {
    delete state.players[socket.id];
    delete state.submissions[socket.id];
    io.emit('state', publicState());
  });
});

function roundOpenPayload() {
  return {
    round:    state.currentRound,
    total:    state.questions.length,
    question: state.questions[state.currentRound - 1]?.question ?? `Round ${state.currentRound}`,
    teams:    state.teams,
  };
}

// ─────────────────── boot ───────────────────
server.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log('\n🏄‍♂️  WindScore is running!\n');
  console.log(`   👑 Admin panel  → http://localhost:${PORT}/admin`);
  console.log(`   📱 Players join → http://${ip}:${PORT}`);
  console.log(`\n   Share the QR code in the admin panel with your players.\n`);
});
