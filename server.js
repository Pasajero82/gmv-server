const express = require('express');
const http = require('http');
const https = require('https');
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

  // Primer contacto: no repetir ordenes viejas
  if (after === 0) {
    return res.json({ seq: state.seq, cmds: [] });
  }

  const pending = state.items.filter(x => x.id > after);

  if (pending.length > 0) {
    return res.json({ seq: state.seq, cmds: pending });
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
// BUZON / ENVIOS  (proxy a Google Apps Script, con cache)
// ============================================================
const APPS_URL = 'https://script.google.com/macros/s/AKfycbzhmmiESNQqAZDtcHDSLCa-y2hb9mi_uL7f3QsBB8HhSW2wUmgf9SQiTQqvFMkyDGcBPg/exec';
const mailCache = new Map(); // key -> { v, exp }

function cacheGet(key) {
  const c = mailCache.get(key);
  if (!c) return null;
  if (Date.now() > c.exp) { mailCache.delete(key); return null; }
  return c.v;
}
function cacheSet(key, v, seconds) {
  mailCache.set(key, { v, exp: Date.now() + seconds * 1000 });
  if (mailCache.size > 300) {
    const first = mailCache.keys().next().value;
    mailCache.delete(first);
  }
}
function clearMailCache(user) {
  for (const k of Array.from(mailCache.keys())) {
    if (k.indexOf(user + ':') === 0) mailCache.delete(k);
  }
}
async function appsGet(action, params) {
  const qs = new URLSearchParams(Object.assign({ action: action }, params));
  return httpGetJson(APPS_URL + '?' + qs.toString(), 5);
}
function httpGetJson(url, redirectsLeft) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { 'Accept': 'application/json' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
        res.resume();
        resolve(httpGetJson(res.headers.location, redirectsLeft - 1));
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { resolve({ success: false, message: 'Respuesta invalida del servidor.' }); }
      });
    });
    req.on('error', () => resolve({ success: false, message: 'No se pudo conectar con el servidor de accesos.' }));
    req.setTimeout(25000, () => {
      req.destroy();
      resolve({ success: false, message: 'El servidor de accesos tardo demasiado.' });
    });
  });
}

// Lista de usuarios (para elegir destinatario desde la tele)
app.get('/mail/usuarios', async (req, res) => {
  const u = String(req.query.u || '');
  const t = String(req.query.t || '');
  if (!u || !t) return res.status(400).json({ success: false, message: 'Faltan datos.' });
  const key = u + ':users';
  const hit = cacheGet(key);
  if (hit) return res.json(hit);
  const data = await appsGet('usuarios', { user: u, token: t });
  if (data.success) cacheSet(key, data, 300);
  res.json(data);
});

// Cuantas cartas nuevas tiene el usuario
app.get('/mail/count', async (req, res) => {
  const u = String(req.query.u || '');
  const t = String(req.query.t || '');
  if (!u || !t) return res.status(400).json({ success: false, message: 'Faltan datos.' });
  const key = u + ':count';
  const hit = cacheGet(key);
  if (hit) return res.json(hit);
  const data = await appsGet('contar', { user: u, token: t });
  if (data.success) cacheSet(key, data, 45);
  res.json(data);
});

// Lista de cartas del buzon
app.get('/mail/list', async (req, res) => {
  const u = String(req.query.u || '');
  const t = String(req.query.t || '');
  if (!u || !t) return res.status(400).json({ success: false, message: 'Faltan datos.' });
  
  // Quitamos la caché de la lista para que siempre traiga datos frescos
  const data = await appsGet('buzon', { user: u, token: t });
  res.json(data);
});

// Cambiar estado de una carta (visto / guardada / ignorada)
app.get('/mail/estado', async (req, res) => {
  const u = String(req.query.u || '');
  const t = String(req.query.t || '');
  if (!u || !t) return res.status(400).json({ success: false, message: 'Faltan datos.' });
  const data = await appsGet('carta_estado', {
    user: u, token: t,
    id: String(req.query.id || ''),
    estado: String(req.query.estado || '')
  });
  clearMailCache(u);
  res.json(data);
});

// Enviar una pelicula a otro usuario
app.get('/mail/enviar', async (req, res) => {
  const u = String(req.query.u || '');
  const t = String(req.query.t || '');
  if (!u || !t) return res.status(400).json({ success: false, message: 'Faltan datos.' });
  const data = await appsGet('enviar', {
    user: u, token: t,
    para: String(req.query.para || ''),
    archivo: String(req.query.archivo || ''),
    titulo: String(req.query.titulo || ''),
    anio: String(req.query.anio || ''),
    poster: String(req.query.poster || '')
  });
  clearMailCache(u);
  res.json(data);
});

// Enviar por POST (la tele manda la ruta tal cual, sin codificar; evita
// problemas con acentos y espacios en los nombres de archivo).
app.post('/mail/enviar', express.json(), async (req, res) => {
  const b = req.body || {};
  const u = String(b.u || '');
  const t = String(b.t || '');
  if (!u || !t) return res.status(400).json({ success: false, message: 'Faltan datos.' });
  const data = await appsGet('enviar', {
    user: u, token: t,
    para: String(b.para || ''),
    archivo: String(b.archivo || ''),
    titulo: String(b.titulo || ''),
    anio: String(b.anio || ''),
    poster: String(b.poster || '')
  });
  clearMailCache(u);
  res.json(data);
});

// Marcar cartas guardadas como aplicadas (ya entraron a Mi Lista)
app.get('/mail/aplicar', async (req, res) => {
  const u = String(req.query.u || '');
  const t = String(req.query.t || '');
  if (!u || !t) return res.status(400).json({ success: false, message: 'Faltan datos.' });
  const data = await appsGet('aplicar_guardadas', {
    user: u, token: t, ids: String(req.query.ids || '')
  });
  clearMailCache(u);
  res.json(data);
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
