'use strict';
/* Angra City Online - servidor (Node 18+, SEM dependencias) */
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto'), zlib = require('zlib');
const { pipeline } = require('stream');

const PORT = +process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const HTML_GZ = path.join(__dirname, 'public', 'index.html.gz');
/* procura index.html e os .gz de dados em qualquer pasta do projeto (ate 4 niveis) */
const FILES = {};
(function scan(dir, depth) {
  let ls = []; try { ls = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const e of ls) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'data') continue;
    const f = path.join(dir, e.name);
    if (e.isDirectory()) { if (depth < 4) scan(f, depth + 1); }
    else if ((e.name === 'index.html' || /\.gz$/.test(e.name)) && !FILES[e.name]) FILES[e.name] = f;
  }
})(__dirname, 0);
const HTML = FILES['index.html'] || path.join(__dirname, 'public', 'index.html');
console.log('servidor v3 | index.html:', FILES['index.html'] || 'NAO ACHADO', '| arquivos .gz:', Object.keys(FILES).filter(n => n !== 'index.html').length);
const HAS_GZ = fs.existsSync(HTML_GZ);
const START_SALDO = 20000000;
/* senha de ADM: so o hash fica no servidor. Pode trocar no Render com ADMIN_PASSWORD (texto) ou ADM_HASH (sha256 hex) */
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const ADM_HASH = (process.env.ADMIN_PASSWORD ? sha(process.env.ADMIN_PASSWORD.trim().toLowerCase())
  : (process.env.ADM_HASH || '9cb8bd1dd71e9fb01574afa4cbc034e4385a46a2b1e8d9f0833f212bacaccb68')).toLowerCase();
const DMG = { ak47: 14, m4: 12, mp5lng: 8, shotgspa: 35, colt45: 12, silenced: 14 };
const RATE = { ak47: 100, m4: 100, mp5lng: 70, shotgspa: 800, colt45: 220, silenced: 220 };

fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'db.json');
let db = { next: 1, acc: {} };
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (_) {}
let dirty = false;
const save = () => { dirty = true; };
const flush = sync => { if (!dirty) return; dirty = false; const s = JSON.stringify(db);
  if (sync) { try { fs.writeFileSync(DB_FILE, s); } catch (_) {} } else fs.writeFile(DB_FILE + '.tmp', s, e => { if (!e) fs.rename(DB_FILE + '.tmp', DB_FILE, () => {}); }); };
setInterval(() => flush(false), 5000);
['SIGTERM', 'SIGINT'].forEach(sg => process.on(sg, () => { dirty = true; flush(true); process.exit(0); }));
const byId = id => Object.values(db.acc).find(a => a.id === id);

/* ---------- HTTP: serve o jogo (gzip) ---------- */
let gzFile = null;
(function prep() {
  if (HAS_GZ) { gzFile = HTML_GZ; return; }
  try {
    const st = fs.statSync(HTML), out = path.join(require('os').tmpdir(), 'angra_' + st.size + '_' + Math.floor(st.mtimeMs) + '.html.gz');
    if (fs.existsSync(out)) { gzFile = out; return; }
    pipeline(fs.createReadStream(HTML), zlib.createGzip({ level: 6 }), fs.createWriteStream(out + '.tmp'), e => {
      if (!e) { fs.renameSync(out + '.tmp', out); gzFile = out; console.log('gzip pronto'); } else console.log('gzip falhou', e.message); });
  } catch (e) { console.log('sem index.html em public/', e.message); }
})();
const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u === '/health') { res.end('ok v3 | index=' + (FILES['index.html'] ? 'sim' : 'NAO') + ' | gz=' + (Object.keys(FILES).length - (FILES['index.html'] ? 1 : 0))); return; }
  if (u === '/' || u === '/index.html') {
    let st; try { st = fs.statSync(HAS_GZ ? HTML_GZ : HTML); } catch (_) { res.statusCode = 500; res.end('index.html nao encontrado'); return; }
    const etag = '"' + st.size + '-' + Math.floor(st.mtimeMs) + '"';
    if (req.headers['if-none-match'] === etag) { res.statusCode = 304; res.end(); return; }
    const h = { 'Content-Type': 'text/html; charset=utf-8', 'ETag': etag, 'Cache-Control': 'public, max-age=600' };
    const useGz = gzFile && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    if (useGz) { h['Content-Encoding'] = 'gzip'; res.writeHead(200, h); fs.createReadStream(gzFile).pipe(res); }
    else if (HAS_GZ) { res.writeHead(200, h); fs.createReadStream(HTML_GZ).pipe(zlib.createGunzip()).pipe(res); }
    else { h['Content-Length'] = st.size; res.writeHead(200, h); fs.createReadStream(HTML).pipe(res); }
    return;
  }
  /* arquivos de dados do jogo (public/d/*.gz, ja comprimidos) */
  if (/^\/d\/[\w.-]+\.gz$/.test(u)) {
    const nm = path.basename(u), f = FILES[nm]; let st;
    try { st = fs.statSync(f); } catch (_) { res.statusCode = 404; res.end('404'); return; }
    const etag = '"' + st.size + '-' + Math.floor(st.mtimeMs) + '"';
    if (req.headers['if-none-match'] === etag) { res.statusCode = 304; res.end(); return; }
    const h = { 'Content-Type': 'text/plain; charset=utf-8', 'ETag': etag, 'Cache-Control': 'public, max-age=86400' };
    if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) { h['Content-Encoding'] = 'gzip'; h['Content-Length'] = st.size; res.writeHead(200, h); fs.createReadStream(f).pipe(res); }
    else { res.writeHead(200, h); fs.createReadStream(f).pipe(zlib.createGunzip()).pipe(res); }
    return;
  }
  res.statusCode = 404; res.end('404');
});

/* ---------- WebSocket minimo (RFC 6455) ---------- */
class WS {
  constructor(sock) { this.sock = sock; this.buf = Buffer.alloc(0); this.frag = null; this.alive = true; this.closed = false;
    sock.setNoDelay(true); sock.on('data', d => this.data(d)); sock.on('close', () => this.end()); sock.on('error', () => {}); }
  data(d) {
    this.alive = true; this.buf = Buffer.concat([this.buf, d]);
    if (this.buf.length > 1 << 20) return this.close();
    for (;;) {
      const b = this.buf; if (b.length < 2) return;
      const fin = !!(b[0] & 128), op = b[0] & 15, mk = !!(b[1] & 128); let len = b[1] & 127, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      if (len > 65536) return this.close();
      if (mk) off += 4; if (b.length < off + len) return;
      let pl = b.subarray(off, off + len);
      if (mk) { const m = b.subarray(off - 4, off), o = Buffer.allocUnsafe(len); for (let i = 0; i < len; i++) o[i] = pl[i] ^ m[i & 3]; pl = o; }
      this.buf = b.subarray(off + len);
      if (op === 8) return this.close();
      if (op === 9) { this.frame(10, pl); continue; }
      if (op === 1) this.frag = [pl]; else if (op === 0 && this.frag) this.frag.push(pl);
      if ((op === 1 || op === 0) && fin && this.frag) { const s = Buffer.concat(this.frag).toString('utf8'); this.frag = null; try { this.onmsg && this.onmsg(s); } catch (e) { console.log('erro msg', e); } }
    }
  }
  frame(op, pl) {
    if (this.closed || this.sock.destroyed) return; const n = pl.length; let h;
    if (n < 126) h = Buffer.from([128 | op, n]); else if (n < 65536) { h = Buffer.alloc(4); h[0] = 128 | op; h[1] = 126; h.writeUInt16BE(n, 2); }
    else { h = Buffer.alloc(10); h[0] = 128 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); }
    this.sock.write(Buffer.concat([h, pl]));
  }
  send(o) { this.frame(1, Buffer.from(JSON.stringify(o))); }
  close() { if (this.closed) return; try { this.frame(8, Buffer.alloc(0)); } catch (_) {} this.closed = true; setTimeout(() => this.sock.destroy(), 200); this.end(); }
  end() { if (this.ended) return; this.ended = true; this.closed = true; this.onclose && this.onclose(); }
}
server.on('upgrade', (req, sock) => {
  if (req.url.split('?')[0] !== '/ws' || !req.headers['sec-websocket-key']) { sock.destroy(); return; }
  const acc = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + acc + '\r\n\r\n');
  newConn(new WS(sock));
});

/* ---------- Jogo ---------- */
const online = new Map(); /* id da conta -> jogador */
const now = () => Date.now();
const send = (p, o) => p.ws.send(o);
const bcast = (o, except) => online.forEach(p => { if (p !== except && p.ready) p.ws.send(o); });
const sys = (p, m) => send(p, { t: 'sys', m });
const isAdm = p => p.master || p.acc.admin;
const accAdm = a => a.admin || (online.get(a.id) && online.get(a.id).master);
const can = (actor, ta) => ta.id !== actor.acc.id && (accAdm(ta) ? actor.master : isAdm(actor));
const roleOf = p => p.master ? 'master' : (p.acc.admin ? 'admin' : '');
const flags = p => (p.frozen ? 1 : 0) | (p.black ? 2 : 0) | (p.acc.prison > now() ? 4 : 0);
const norm = s => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const fmtDur = ms => { const m = Math.round(ms / 60000); return m >= 1440 ? (m / 1440).toFixed(1).replace('.0', '') + ' dia(s)' : m >= 60 ? (m / 60).toFixed(1).replace('.0', '') + ' h' : m + ' min'; };
const parseDur = (s, unit) => { const m = /^(\d+(?:[.,]\d+)?)(s|m|min|h|d)?$/i.exec(s || ''); if (!m) return 0;
  const v = parseFloat(m[1].replace(',', '.')), u = (m[2] || unit).toLowerCase(); return v * ({ s: 1e3, m: 6e4, min: 6e4, h: 36e5, d: 864e5 }[u]); };
const banned = a => a.ban && (a.ban.until === 0 || a.ban.until > now());

function releasePrison(a) { a.prison = 0; save(); const p = online.get(a.id); if (p) { send(p, { t: 'prison', on: false }); sys(p, 'Você foi solto da prisão.'); } }
setInterval(() => { Object.values(db.acc).forEach(a => { if (a.prison && a.prison <= now()) releasePrison(a); }); }, 5000);

const CMDS = [
  ['/comando', 'abre esta lista', 'todos adm'],
  ['/lista', 'lista jogadores online (id e nome)', 'todos adm'],
  ['/ban id dias [motivo]', 'bane (dias=0 permanente)', 'todos adm*'],
  ['/offbanir id', 'desbane', 'todos adm'],
  ['/kick id [motivo]', 'expulsa do servidor', 'todos adm*'],
  ['/prisao id 30m|2h', 'prende (m=minutos, h=horas)', 'todos adm*'],
  ['/offprisao id', 'solta da prisão', 'todos adm'],
  ['/puxa id', 'puxa o jogador até você', 'todos adm*'],
  ['/imovel id', 'deixa paralisado/imóvel', 'todos adm*'],
  ['/offimovel id', 'libera o movimento', 'todos adm'],
  ['/tela id', 'trava a tela do jogador (preta)', 'todos adm*'],
  ['/offtela id', 'destrava a tela', 'todos adm'],
  ['/setadmin id', 'promove a admin', 'só ADM com senha'],
  ['/offsetadmin id', 'remove admin', 'só ADM com senha'],
  ['/admoff', 'sai do modo ADM com senha', 'ADM com senha']];

function command(p, line) {
  const a = line.trim().split(/\s+/), k = norm(a[0]);
  if (k === '/key' || k === '/keyy') {
    if (p.master) return sys(p, 'O modo ADM já está ativo.');
    if (now() < p.keyLock) return sys(p, 'Comando desconhecido.');
    if (sha(a.slice(1).join(' ').trim().toLowerCase()) === ADM_HASH) { p.master = true; p.fails = 0; send(p, { t: 'role', r: roleOf(p) }); sys(p, '[ADM] Modo administrador ativado (senha).'); console.log('ADM com senha:', p.acc.name, p.acc.id); }
    else { if (++p.fails >= 5) { p.fails = 0; p.keyLock = now() + 60000; } sys(p, 'Comando desconhecido.'); }
    return;
  }
  if (k === '/help') return sys(p, 'Comandos: /help' + (isAdm(p) ? ' /comando' : ''));
  if (k === '/admoff') { if (!p.master) return sys(p, 'Comando desconhecido.'); p.master = false; send(p, { t: 'role', r: roleOf(p) }); return sys(p, '[ADM] Modo administrador desativado.'); }
  const adminCmds = ['/comando', '/lista', '/ban', '/offbanir', '/kick', '/prisao', '/offprisao', '/puxa', '/imovel', '/offimovel', '/tela', '/offtela', '/setadmin', '/offsetadmin', '/offsetaadmin'];
  if (!adminCmds.includes(k)) return sys(p, 'Comando desconhecido. Use /help.');
  if (!isAdm(p)) return sys(p, 'Você não é administrador.');
  if (k === '/comando') return send(p, { t: 'cmds', list: CMDS, master: p.master });
  if (k === '/lista') { const l = [...online.values()].filter(q => q.ready).map(q => q.acc.id + ' ' + q.acc.name + (roleOf(q) ? ' [' + roleOf(q) + ']' : '')); return sys(p, 'Online (' + l.length + '): ' + l.join(' | ')); }
  const id = parseInt(a[1], 10), ta = byId(id);
  if (!id || !ta) return sys(p, 'Uso: ' + k + ' id (jogador não encontrado). Veja /lista.');
  const tp = online.get(id);
  if (k === '/setadmin' || k === '/offsetadmin' || k === '/offsetaadmin') {
    if (!p.master) return sys(p, 'Só quem entrou com a senha de ADM pode fazer isso.');
    const on = k === '/setadmin'; ta.admin = on; save();
    if (tp) { send(tp, { t: 'role', r: roleOf(tp) }); sys(tp, on ? '[ADM] Você agora é administrador.' : '[ADM] Você não é mais administrador.'); }
    return sys(p, ta.name + (on ? ' agora é admin.' : ' não é mais admin.'));
  }
  if (k === '/offbanir') { if (!ta.ban) return sys(p, 'Esse jogador não está banido.'); ta.ban = null; save(); return sys(p, ta.name + ' desbanido.'); }
  if (k === '/offprisao') { if (!(ta.prison > now())) return sys(p, 'Esse jogador não está preso.'); releasePrison(ta); return sys(p, ta.name + ' solto.'); }
  if (k === '/offimovel' || k === '/offtela') {
    if (!tp) return sys(p, 'Jogador offline.');
    if (k === '/offimovel') { tp.frozen = false; send(tp, { t: 'frz', on: false }); } else { tp.black = false; send(tp, { t: 'scr', on: false }); }
    return sys(p, 'Feito: ' + tp.acc.name + '.');
  }
  if (!can(p, ta)) return sys(p, ta.id === p.acc.id ? 'Você não pode usar isso em si mesmo.' : 'Só quem entrou com a senha de ADM pode agir contra um admin.');
  if (k === '/ban') {
    const d = parseFloat((a[1 + 1] || '').replace(',', '.')); if (isNaN(d) || d < 0) return sys(p, 'Uso: /ban id dias [motivo] (0 = permanente)');
    ta.ban = { until: d === 0 ? 0 : now() + d * 864e5, by: p.acc.name, why: a.slice(3).join(' ') }; save();
    if (tp) { send(tp, { t: 'kick', m: 'Você foi banido ' + (d === 0 ? 'permanentemente' : 'por ' + d + ' dia(s)') + (ta.ban.why ? ': ' + ta.ban.why : '.') }); tp.ws.close(); }
    bcast({ t: 'sys', m: '[ADM] ' + ta.name + ' foi banido.' }); return sys(p, 'Banido: ' + ta.name + ' (' + (d === 0 ? 'permanente' : d + ' dia(s)') + ')');
  }
  if (k === '/kick') {
    if (!tp) return sys(p, 'Jogador offline.'); send(tp, { t: 'kick', m: 'Você foi expulso' + (a[2] ? ': ' + a.slice(2).join(' ') : '.') }); tp.ws.close();
    bcast({ t: 'sys', m: '[ADM] ' + ta.name + ' foi expulso.' }); return;
  }
  if (k === '/prisao') {
    const ms = parseDur(a[2], 'm'); if (!ms) return sys(p, 'Uso: /prisão id tempo (ex: 30m, 2h)');
    ta.prison = now() + ms; save(); if (tp) { send(tp, { t: 'prison', on: true, until: ta.prison }); sys(tp, 'Você foi preso por ' + fmtDur(ms) + '.'); }
    bcast({ t: 'sys', m: '[ADM] ' + ta.name + ' foi preso por ' + fmtDur(ms) + '.' }); return;
  }
  if (!tp) return sys(p, 'Jogador offline.');
  if (k === '/puxa') { tp.x = p.x; tp.y = p.y; tp.z = p.z; send(tp, { t: 'tp', x: p.x, y: p.y, z: p.z }); return sys(p, tp.acc.name + ' puxado até você.'); }
  if (k === '/imovel') { tp.frozen = true; send(tp, { t: 'frz', on: true }); return sys(p, tp.acc.name + ' está imóvel.'); }
  if (k === '/tela') { tp.black = true; send(tp, { t: 'scr', on: true }); return sys(p, 'Tela de ' + tp.acc.name + ' travada.'); }
}

function newConn(ws) {
  const p = { ws, ready: false, acc: null, x: 0, y: 0, z: 0, ph: 0, an: '', wp: null, cr: 0, hp: 100, ar: 0, master: false, frozen: false, black: false,
    fails: 0, keyLock: 0, last: {}, msgT: 0, msgN: 0, lastChat: 0 };
  ws.alive = true; const pi = setInterval(() => { if (!ws.alive) { ws.sock.destroy(); return; } ws.alive = false; ws.frame(9, Buffer.alloc(0)); }, 20000);
  ws.onclose = () => { clearInterval(pi); if (p.ready && online.get(p.acc.id) === p) { online.delete(p.acc.id); bcast({ t: 'leave', id: p.acc.id }); } };
  ws.onmsg = s => {
    if (now() - p.msgT > 1000) { p.msgT = now(); p.msgN = 0; } if (++p.msgN > 80) return;
    let m; try { m = JSON.parse(s); } catch (_) { return; }
    if (!p.ready) { if (m.t === 'hello') hello(p, m); return; }
    const fin = v => typeof v === 'number' && isFinite(v) && Math.abs(v) < 1e6;
    switch (m.t) {
      case 'pos': if (!p.frozen && fin(m.x) && fin(m.y) && fin(m.z)) { p.x = m.x; p.y = m.y; p.z = m.z; p.ph = fin(m.ph) ? m.ph : 0; p.wp = typeof m.wp === 'string' ? m.wp.slice(0, 12) : null; p.cr = m.cr ? 1 : 0; } break;
      case 'chat': { const t = String(m.m || '').trim().slice(0, 200); if (!t) break; if (t[0] === '/') { command(p, t); break; }
        if (now() - p.lastChat < 400) break; p.lastChat = now(); bcast({ t: 'chat', id: p.acc.id, n: p.acc.name, r: roleOf(p), m: t }); break; }
      case 'shot': { const w = String(m.w); if (!DMG[w]) break; const tt = now(); if (tt - (p.last[w] || 0) < RATE[w] * .6) break; p.last[w] = tt;
        const q = online.get(m.id | 0); if (!q || q === p || !q.ready) break; if (q.acc.prison > tt) break;
        if (Math.hypot(q.x - p.x, q.z - p.z) > 130) break;
        let d = DMG[w] * (m.hs && w !== 'shotgspa' ? 2 : 1); const ab = Math.min(q.ar, d); q.ar -= ab; q.hp = Math.max(0, q.hp - (d - ab)); /* nao morre: a vida so zera */
        send(q, { t: 'hp', hp: q.hp, ar: q.ar, by: p.acc.name }); send(p, { t: 'hit', id: q.acc.id, hp: q.hp }); break; }
      case 'fx': if (Array.isArray(m.o) && Array.isArray(m.e) && DMG[m.w] && now() - (p.last.fx || 0) > 50) { p.last.fx = now();
        const o = m.o.map(Number), e = m.e.map(Number); if (o.concat(e).every(fin)) bcast({ t: 'fx', id: p.acc.id, o, e, w: m.w }, p); } break;
      case 'dmg': { const n = Math.min(Math.max(+m.n || 0, 0), 50), ab = Math.min(p.ar, n); p.ar -= ab; p.hp = Math.max(0, p.hp - (n - ab)); send(p, { t: 'hp', hp: p.hp, ar: p.ar }); break; }
      case 'heal': if (fin(m.hp) && fin(m.ar)) { p.hp = Math.min(100, Math.max(p.hp, m.hp)); p.ar = Math.min(100, Math.max(p.ar, m.ar)); send(p, { t: 'hp', hp: p.hp, ar: p.ar }); } break;
      case 'money': if (fin(m.v) && m.v >= 0 && m.v < 1e13) { p.acc.saldo = Math.round(m.v); save(); } break;
    }
  };
}

function hello(p, m) {
  const tk = String(m.token || ''), name = String(m.name || '').replace(/[^\p{L}\p{N} _.\-]/gu, '').trim().slice(0, 16);
  if (tk.length < 16 || tk.length > 80 || name.length < 2) { p.ws.send({ t: 'kick', m: 'Nome inválido (2 a 16 letras/números).' }); return p.ws.close(); }
  const key = sha(tk); let a = db.acc[key];
  if (!a) { a = db.acc[key] = { id: db.next++, name, saldo: START_SALDO, admin: false, ban: null, prison: 0 }; }
  a.name = name; save();
  if (banned(a)) { p.ws.send({ t: 'kick', m: 'Você está banido' + (a.ban.until ? ' até ' + new Date(a.ban.until).toLocaleString('pt-BR') : ' permanentemente') + (a.ban.why ? ': ' + a.ban.why : '.') }); return p.ws.close(); }
  if (a.ban) a.ban = null;
  const old = online.get(a.id); if (old) { send(old, { t: 'kick', m: 'Sua conta entrou em outro lugar.' }); old.ready = false; old.ws.close(); online.delete(a.id); bcast({ t: 'leave', id: a.id }); }
  p.acc = a; p.ready = true; online.set(a.id, p);
  p.ws.send({ t: 'welcome', id: a.id, name: a.name, saldo: a.saldo, admin: !!a.admin, prison: a.prison > now() ? a.prison : 0,
    players: [...online.values()].filter(q => q !== p && q.ready).map(q => [q.acc.id, q.acc.name]) });
  bcast({ t: 'join', id: a.id, n: a.name }, p); bcast({ t: 'sys', m: a.name + ' entrou no servidor.' }, p);
  console.log('entrou:', a.id, a.name, 'online:', online.size);
}

setInterval(() => { /* estado dos jogadores, 10x por segundo */
  if (!online.size) return; const l = [];
  online.forEach(p => { if (p.ready && (p.x || p.z)) l.push([p.acc.id, +p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2), +p.ph.toFixed(2), p.wp, p.hp, flags(p), p.cr]); });
  const o = { t: 's', p: l }; online.forEach(p => p.ready && p.ws.send(o));
}, 100);

server.listen(PORT, () => console.log('Angra City Online na porta', PORT));
