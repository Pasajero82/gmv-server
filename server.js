const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// CORS para que la pagina del control pueda usar /roku/send desde cualquier dominio
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.static(__dirname));

// ============================================================
// PUENTE PARA ROKU (no tiene WebSocket: usa HTTP long-poll)
// ============================================================
const rooms = new Map();   // room -> { seq, items: [] }
const waiters = new Map(); // room -> [ { res, after, timer } ]
const HOLD_MS = 15000;     // cuanto se queda esperando una orden
const MAX_ITEMS = 100;     // maximo de ordenes guardadas por sala
const EXPIRE_MS = 120000;  // las ordenes viejas ya no sirven

function getRoom(room) {
  // seq empieza en 1 para que after=0 signifique "primer contacto"
  if (!rooms.has(room)) rooms.set(room, { seq: 1, items: [] });
  return rooms.get(room);
}

function flushRoom(room, state) {
  const list = waiters.get(room);
  if (!list || list.length === 0) return;
  waiters.delete(room);
  for (const w of list) {
    clearTimeout(w.timer);
    const out = state.items.filter(x => x.id > w.after);
    try {
      w.res.json({ seq: state.seq, cmds: out });
    } catch (e) {}
  }
}

function pushCmd(room, data) {
  if (!room || typeof room !== 'string' || !data) return;
  const state = getRoom(room);
  state.seq += 1;
  state.items.push({
    id: state.seq,
    cmd: data.cmd || '',
    query: data.query || '',
    ts: Date.now()
  });

  const cutoff = Date.now() - EXPIRE_MS;
  while (state.items.length > 0 && (state.items[0].ts < cutoff || state.items.length > MAX_ITEMS)) {
    state.items.shift();
  }

  flushRoom(room, state);
}

// El Roku llama esto: si no hay ordenes, la peticion se queda "colgada"
// hasta HOLD_MS o hasta que llegue una orden (respuesta instantanea).
app.get('/roku/poll', (req, res) => {
  const room = String(req.query.room || '');
  if (!room) return res.status(400).json({ error: 'room requerido' });

  let after = parseInt(req.query.after || '0', 10) || 0;
  const state = getRoom(room);

  // Si el servidor se reinicio, el seq vuelve a cero: sincronizar al Roku
  if (after > state.seq) {
    return res.json({ seq: state.seq, cmds: [] });
  }

  const pending = state.items.filter(x => x.id > after);

  if (pending.length > 0) {
    return res.json({ seq: state.seq, cmds: pending });
  }

  // Primer contacto: no repetir ordenes viejas
  if (after === 0) {
    return res.json({ seq: state.seq, cmds: [] });
  }

  const waiter = { res, after, timer: null };
  waiter.timer = setTimeout(() => {
    const list = (waiters.get(room) || []).filter(w => w !== waiter);
    if (list.length > 0) waiters.set(room, list); else waiters.delete(room);
    try { res.json({ seq: state.seq, cmds: [] }); } catch (e) {}
  }, HOLD_MS);

  const list = waiters.get(room) || [];
  list.push(waiter);
  waiters.set(room, list);

  req.on('close', () => {
    clearTimeout(waiter.timer);
    const left = (waiters.get(room) || []).filter(w => w !== waiter);
    if (left.length > 0) waiters.set(room, left); else waiters.delete(room);
  });
});

// Por si algun dia se quiere mandar una orden por HTTP (sin socket.io)
app.post('/roku/send', express.json(), (req, res) => {
  const body = req.body || {};
  if (!body.room || !body.cmd) return res.status(400).json({ ok: false, error: 'room y cmd requeridos' });
  io.to(body.room).emit('ejecutar-comando', body);
  pushCmd(body.room, body);
  res.json({ ok: true });
});

// Estado del servidor (util para probar desde el navegador)
app.get('/roku/status', (req, res) => {
  const room = String(req.query.room || '');
  if (!room) return res.json({ rooms: rooms.size });
  const state = getRoom(room);
  res.json({
    room: room,
    seq: state.seq,
    pendientes: state.items.length,
    esperando: (waiters.get(room) || []).length
  });
});

// ============================================================
// SOCKET.IO (celular web)
// ============================================================
io.on('connection', (socket) => {
  console.log('✅ Usuario conectado:', socket.id);

  socket.on('join-room', (room) => {
    socket.join(room);
    console.log(`👥 Dispositivo unido a la sala: ${room}`);
  });

  // Recibe la orden del celular y la retransmite a la TV
  socket.on('muvibot-ask', (data) => {
    if (!data) return;
    console.log(`🔍 Buscando: ${data.query} en la sala ${data.room}`);

    io.to(data.room).emit('muvibot-response', {
      success: true,
      text: "Buscando..."
    });

    io.to(data.room).emit('muvibot-search', { query: data.query });
    pushCmd(data.room, { cmd: 'voice-search', query: data.query });
  });

  socket.on('enviar-comando', (data) => {
    if (!data || !data.room) return;
    io.to(data.room).emit('ejecutar-comando', data);
    pushCmd(data.room, data);
    console.log(`📲 ${data.room} -> ${data.cmd}${data.query ? ' (' + data.query + ')' : ''}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Servidor MUVIBOX (Modo Búsqueda) en puerto ${PORT}`);
});
