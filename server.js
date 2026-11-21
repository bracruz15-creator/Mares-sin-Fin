'use strict';
// Mares Sin Fin — servidor: juego estático + login Google + guardado por cuenta + tiempo real (WebSocket)
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { OAuth2Client } = require('google-auth-library');

const PORT = +process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const DEV_AUTH = process.env.DEV_AUTH === '1';
const PROD = process.env.NODE_ENV === 'production';
let SECRET = process.env.SESSION_SECRET || '';
if (!SECRET) { if (PROD) { console.error('Falta SESSION_SECRET'); process.exit(1) } SECRET = 'dev-secret-no-usar-en-produccion' }
if (!GOOGLE_CLIENT_ID && !DEV_AUTH) console.warn('Aviso: sin GOOGLE_CLIENT_ID el login de Google no funcionará.');

// ---- almacenamiento: Postgres (DATABASE_URL) o SQLite local ----
let store;
if (process.env.DATABASE_URL) {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false }, max: 8 });
  store = {
    kind: 'postgres',
    async init() { await pool.query('CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,name TEXT,email TEXT,picture TEXT,created BIGINT)'); await pool.query('CREATE TABLE IF NOT EXISTS saves(user_id TEXT PRIMARY KEY,data TEXT NOT NULL,version INTEGER NOT NULL,updated BIGINT NOT NULL)') },
    async user(id) { return (await pool.query('SELECT * FROM users WHERE id=$1', [id])).rows[0] },
    async upsertUser(id, n, e, p) { await pool.query('INSERT INTO users(id,name,email,picture,created) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,email=EXCLUDED.email,picture=EXCLUDED.picture', [id, n, e, p, Date.now()]) },
    async save(id) { const r = (await pool.query('SELECT data,version,updated FROM saves WHERE user_id=$1', [id])).rows[0]; return r && { data: r.data, version: +r.version, updated: +r.updated } },
    async put(id, data, v, now) { await pool.query('INSERT INTO saves(user_id,data,version,updated) VALUES($1,$2,$3,$4) ON CONFLICT(user_id) DO UPDATE SET data=EXCLUDED.data,version=EXCLUDED.version,updated=EXCLUDED.updated', [id, data, v, now]) },
    async del(id) { await pool.query('DELETE FROM saves WHERE user_id=$1', [id]) }
  };
} else {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const Database = require('better-sqlite3');
  const db = new Database(path.join(DATA_DIR, 'mares.db'));
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,name TEXT,email TEXT,picture TEXT,created INTEGER);CREATE TABLE IF NOT EXISTS saves(user_id TEXT PRIMARY KEY,data TEXT NOT NULL,version INTEGER NOT NULL,updated INTEGER NOT NULL);');
  const qU = db.prepare('SELECT * FROM users WHERE id=?'), qUp = db.prepare('INSERT INTO users(id,name,email,picture,created) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,email=excluded.email,picture=excluded.picture'),
    qS = db.prepare('SELECT data,version,updated FROM saves WHERE user_id=?'), qP = db.prepare('INSERT INTO saves(user_id,data,version,updated) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET data=excluded.data,version=excluded.version,updated=excluded.updated'), qD = db.prepare('DELETE FROM saves WHERE user_id=?');
  store = { kind: 'sqlite', async init() {}, async user(id) { return qU.get(id) }, async upsertUser(id, n, e, p) { qUp.run(id, n, e, p, Date.now()) }, async save(id) { return qS.get(id) }, async put(id, d, v, n) { qP.run(id, d, v, n) }, async del(id) { qD.run(id) } };
}

// ---- sesión: cookie firmada (HMAC) ----
const b64 = b => Buffer.from(b).toString('base64url');
const sign = s => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
function makeSession(uid) { const p = b64(JSON.stringify({ u: uid, e: Date.now() + 30 * 864e5 })); return p + '.' + sign(p) }
function readSession(tok) {
  if (!tok || typeof tok !== 'string') return null;
  const [p, s] = tok.split('.'); if (!p || !s) return null;
  const a = Buffer.from(sign(p)), b = Buffer.from(s); if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { const o = JSON.parse(Buffer.from(p, 'base64url').toString()); return o.e > Date.now() ? o.u : null } catch { return null }
}
const cookieOf = (req, n) => { const m = (req.headers.cookie || '').split(/;\s*/).find(c => c.startsWith(n + '=')); return m ? decodeURIComponent(m.slice(n.length + 1)) : '' };
const setCookie = (res, v, maxAge) => res.setHeader('Set-Cookie', `msf_session=${encodeURIComponent(v)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${PROD ? '; Secure' : ''}`);
const userOf = async req => { const id = readSession(cookieOf(req, 'msf_session')); return id ? store.user(id) : null };
const ah = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(e => { console.error(e); if (!res.headersSent) res.status(500).json({ error: 'error del servidor' }) });

// ---- límite simple por IP ----
const hits = new Map();
function limit(max, ms) { return (req, res, next) => { const k = req.ip + req.path, n = Date.now(), a = (hits.get(k) || []).filter(t => n - t < ms); a.push(n); hits.set(k, a); if (a.length > max) return res.status(429).json({ error: 'demasiadas peticiones' }); next() } }
setInterval(() => { const n = Date.now(); for (const [k, a] of hits) if (!a.some(t => n - t < 60000)) hits.delete(k) }, 60000).unref();

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '3mb' }));
app.use((req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin'); next() });

const gClient = new OAuth2Client(GOOGLE_CLIENT_ID);
app.get('/api/health', (q, r) => r.json({ ok: true, online: players.size }));
app.get('/api/config', (q, r) => r.json({ googleClientId: GOOGLE_CLIENT_ID, dev: DEV_AUTH }));
app.get('/api/me', ah(async (req, res) => { const u = await userOf(req); if (!u) return res.status(401).json({ error: 'no sesión' }); res.json({ id: u.id, name: u.name, picture: u.picture }) }));
app.post('/api/auth/google', limit(20, 60000), async (req, res) => {
  try {
    if (!GOOGLE_CLIENT_ID) return res.status(503).json({ error: 'Google no configurado' });
    const t = await gClient.verifyIdToken({ idToken: String(req.body.credential || ''), audience: GOOGLE_CLIENT_ID });
    const p = t.getPayload(); if (!p || !p.sub) return res.status(401).json({ error: 'token inválido' });
    const id = 'g:' + p.sub; await store.upsertUser(id, String(p.name || 'Pirata').slice(0, 60), String(p.email || '').slice(0, 120), String(p.picture || '').slice(0, 300));
    setCookie(res, makeSession(id), 30 * 86400); res.json({ id, name: p.name, picture: p.picture });
  } catch (e) { res.status(401).json({ error: 'no se pudo verificar la cuenta de Google' }) }
});
app.post('/api/auth/dev', limit(30, 60000), ah(async (req, res) => {
  if (!DEV_AUTH) return res.status(404).end();
  const name = String(req.body.name || 'Dev').slice(0, 30), id = 'dev:' + name.toLowerCase();
  await store.upsertUser(id, name, '', ''); setCookie(res, makeSession(id), 86400); res.json({ id, name });
}));
app.post('/api/logout', (req, res) => { setCookie(res, '', 0); res.json({ ok: true }) });

app.get('/api/save', ah(async (req, res) => {
  const u = await userOf(req); if (!u) return res.status(401).json({ error: 'no sesión' });
  const s = await store.save(u.id); if (!s) return res.json({ version: 0, updated: 0, data: null });
  res.json({ version: s.version, updated: s.updated, data: s.data });
}));
app.put('/api/save', limit(60, 60000), ah(async (req, res) => {
  const u = await userOf(req); if (!u) return res.status(401).json({ error: 'no sesión' });
  const { data, baseVersion, force } = req.body || {};
  if (typeof data !== 'string' || data.length > 2.5e6) return res.status(400).json({ error: 'datos inválidos' });
  try { const o = JSON.parse(data); if (!o || typeof o !== 'object' || typeof o.name !== 'string') throw 0 } catch { return res.status(400).json({ error: 'partida inválida' }) }
  const cur = await store.save(u.id), cv = cur ? cur.version : 0;
  if (!force && (+baseVersion || 0) !== cv) return res.status(409).json({ error: 'conflicto', version: cv, updated: cur ? cur.updated : 0, data: cur ? cur.data : null });
  const v = cv + 1, now = Date.now(); await store.put(u.id, data, v, now); res.json({ version: v, updated: now });
}));
app.delete('/api/save', ah(async (req, res) => { const u = await userOf(req); if (!u) return res.status(401).json({ error: 'no sesión' }); await store.del(u.id); res.json({ ok: true }) }));

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], maxAge: PROD ? '5m' : 0 }));

// ---- tiempo real ----
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });
const players = new Map(); // uid -> {ws,name,sea,is,ship,look,fame,t}
const clip = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f<>]/g, '').slice(0, n);
const pub = (id, p) => ({ id, name: p.name, sea: p.sea, is: p.is, ship: p.ship, look: p.look, fame: p.fame });
const send = (ws, o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)) };
const seaPeers = (sea, except) => { const L = []; for (const [id, p] of players) if (id !== except && p.sea === sea) L.push(pub(id, p)); return L };
function broadcast(o, filter) { const m = JSON.stringify(o); for (const [id, p] of players) if (p.ws.readyState === 1 && (!filter || filter(p, id))) p.ws.send(m) }

wss.on('connection', async (ws, req) => {
  let u; try { u = await userOf(req) } catch { u = null } if (!u) { ws.close(4401, 'no sesión'); return }
  const old = players.get(u.id); if (old) { try { old.ws.close(4000, 'otra sesión') } catch {} }
  const me = { ws, name: clip(u.name, 24) || 'Pirata', sea: 0, is: 0, ship: { c: 1, v: 1 }, look: {}, fame: 0, last: 0, lastChat: 0 };
  players.set(u.id, me);
  send(ws, { t: 'hello', id: u.id, online: players.size });
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw) } catch { return }
    const now = Date.now();
    if (m.t === 'pos') {
      if (now - me.last < 800) return; me.last = now;
      const prevSea = me.sea;
      me.name = clip(m.name, 24) || me.name; me.sea = (+m.sea | 0) % 5; me.is = Math.max(0, +m.is | 0); me.fame = Math.max(0, +m.fame | 0);
      const sh = m.ship || {}; me.ship = { c: Math.min(9, Math.max(1, +sh.c | 0)), v: Math.min(9, Math.max(1, +sh.v | 0)) };
      const lk = m.look || {}; me.look = { skin: clip(lk.skin, 12), hair: clip(lk.hair, 12), cloth: clip(lk.cloth, 12) };
      send(ws, { t: 'peers', sea: me.sea, list: seaPeers(me.sea, u.id), online: players.size });
      broadcast({ t: 'move', p: pub(u.id, me) }, (p, id) => id !== u.id && p.sea === me.sea);
      if (prevSea !== me.sea) broadcast({ t: 'gone', id: u.id }, (p, id) => id !== u.id && p.sea === prevSea);
    } else if (m.t === 'chat') {
      if (now - me.lastChat < 1500) return send(ws, { t: 'sys', text: 'Más despacio, capitán.' });
      const text = clip(m.text, 140).trim(); if (!text) return; me.lastChat = now;
      broadcast({ t: 'chat', from: me.name, text, at: now });
    } else if (m.t === 'legend') {
      if (me.legend) return; me.legend = 1;
      broadcast({ t: 'news', text: `🌅 ${me.name} ha llegado a la Isla Última Aurora. ¡Una nueva leyenda!` });
    }
  });
  ws.on('close', () => { if (players.get(u.id) === me) { players.delete(u.id); broadcast({ t: 'gone', id: u.id }); } });
  ws.on('error', () => {});
});
// latido: elimina conexiones muertas
setInterval(() => { for (const p of players.values()) { if (p.dead) { try { p.ws.terminate() } catch {} } p.dead = 1; try { p.ws.ping() } catch {} } }, 30000).unref();
wss.on('connection', ws => ws.on('pong', () => { for (const p of players.values()) if (p.ws === ws) p.dead = 0 }));

store.init().then(() => server.listen(PORT, () => console.log(`Mares Sin Fin en http://localhost:${PORT}  (almacén: ${store.kind}, DEV_AUTH=${DEV_AUTH ? 'sí' : 'no'})`))).catch(e => { console.error('No se pudo iniciar el almacén:', e); process.exit(1) });
module.exports = { app, server };
