const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const readXlsxFile = require('read-excel-file/node');

// ---------- Configuración (variables de entorno) ----------
const PORT = process.env.PORT || 3001;
const GOOGLE_SHEET = process.env.GOOGLE_SHEET || '';   // enlace o ID del Google Sheet con las preguntas
const CONTROL_KEY = process.env.CONTROL_KEY || '';     // si existe, solo el control con ?key=... puede manejar el juego
const SHEETS_BASE = process.env.SHEETS_BASE || 'https://docs.google.com';
const EXCEL_PATH = path.join(__dirname, 'preguntas.xlsx'); // respaldo local si no hay GOOGLE_SHEET

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (_req, res) => res.send('ok'));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ---------- Preguntas (Google Sheets o preguntas.xlsx) ----------
const SHEETS = { adivina: 'Adivina el jugador', vf: 'Verdadero o falso', top5: 'Top 5' };

async function readExcel(input) {
  const names = (await readXlsxFile(input, { getSheets: true })).map(h => h.name);
  const rowsOf = async key => {
    const name = names.find(n => n.trim().toLowerCase() === SHEETS[key].toLowerCase());
    if (!name) throw new Error(`falta la hoja "${SHEETS[key]}"`);
    const rows = await readXlsxFile(input, { sheet: name });
    return rows.slice(1) // la fila 1 son los encabezados
      .map((r, i) => ({ n: i + 2, cells: r.map(x => (x == null ? '' : String(x).trim())) }))
      .filter(r => r.cells.some(Boolean));
  };
  const where = (key, n) => `hoja "${SHEETS[key]}", fila ${n}`;

  const adivina = (await rowsOf('adivina')).map(({ n, cells: [respuesta, ...resto] }) => {
    const pistas = resto.filter(Boolean);
    if (!respuesta) throw new Error(`${where('adivina', n)}: falta la respuesta`);
    if (!pistas.length) throw new Error(`${where('adivina', n)}: escribe al menos una pista`);
    return { respuesta, pistas: pistas.slice(0, 10) };
  });

  const vf = (await rowsOf('vf')).map(({ n, cells: [texto, valor] }) => {
    const val = String(valor || '').toLowerCase().replace(/[¿?\s]/g, '');
    let verdad;
    if (['verdadero', 'verdad', 'v', 'true', 'si', 'sí', '1'].includes(val)) verdad = true;
    else if (['falso', 'f', 'false', 'no', '0'].includes(val)) verdad = false;
    else throw new Error(`${where('vf', n)}: en la columna B escribe Verdadero o Falso`);
    if (!texto) throw new Error(`${where('vf', n)}: falta la afirmación`);
    return { texto, verdad };
  });

  const top5 = (await rowsOf('top5')).map(({ n, cells: [titulo, ...resto] }) => {
    const items = resto.filter(Boolean);
    if (!titulo) throw new Error(`${where('top5', n)}: falta el título del ranking`);
    if (!items.length) throw new Error(`${where('top5', n)}: escribe al menos un puesto`);
    return { titulo, items: items.slice(0, 10) };
  });
  return { adivina, vf, top5 };
}

const sheetId = v => { const m = String(v).match(/\/d\/([a-zA-Z0-9_-]+)/); return m ? m[1] : String(v).trim(); };

async function fetchSheet(v) {
  const url = `${SHEETS_BASE}/spreadsheets/d/${sheetId(v)}/export?format=xlsx`;
  let res;
  try { res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20000) }); }
  catch (e) { throw new Error('no se pudo conectar con Google Sheets (' + e.message + ')'); }
  const buf = Buffer.from(await res.arrayBuffer());
  const isZip = buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b; // los .xlsx empiezan con "PK"
  if (!res.ok || !isZip) {
    throw new Error('no se pudo descargar el Google Sheet. Revisa que el enlace sea correcto y que esté compartido como "Cualquier persona con el enlace: Lector"');
  }
  return buf;
}

async function loadContent() {
  let c, source;
  if (GOOGLE_SHEET) { c = await readExcel(await fetchSheet(GOOGLE_SHEET)); source = 'Google Sheets'; }
  else if (fs.existsSync(EXCEL_PATH)) { c = await readExcel(EXCEL_PATH); source = 'preguntas.xlsx'; }
  else throw new Error('no hay preguntas: configura GOOGLE_SHEET o agrega preguntas.xlsx');
  for (const k of ['adivina', 'vf', 'top5']) {
    if (!c[k].length) throw new Error(`la hoja "${SHEETS[k]}" no tiene preguntas`);
  }
  return { c, source };
}
let content = null;

// ---------- Estado ----------
const DEFAULT_TIME = 60; // segundos (también se cambia desde el panel de control)
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const wrap = (i, n, d) => (i + d + n) % n;
const hidden = idx => content.top5[idx].items.map(() => false);

function fresh(total = DEFAULT_TIME) {
  return {
    content,
    contentMsg: '',
    game: 'none', // none | adivina | vf | top5
    adivina: { idx: 0, revealed: 0, solved: false, score: 0 },
    vf: { idx: 0, shown: false, reveal: false, score: 0, answered: 0 },
    top5: { idx: 0, rev: hidden(0) },
    timer: { total, remaining: total, running: false, show: true },
  };
}
let state = null; // se crea al cargar las preguntas

// Vista para la pantalla (sin permiso de control): solo lo que ya se mostró al aire, nunca las respuestas pendientes
function viewOf(st) {
  const c = st.content, A = st.adivina, V = st.vf, T = st.top5;
  return {
    ...st, readOnly: true, contentMsg: '',
    content: {
      adivina: c.adivina.map((q, i) => i !== A.idx ? { respuesta: '', pistas: [] }
        : { respuesta: A.solved ? q.respuesta : '', pistas: q.pistas.map((p, j) => (j < A.revealed ? p : '')) }),
      vf: c.vf.map((q, i) => i !== V.idx ? { texto: '', verdad: null }
        : { texto: V.shown ? q.texto : '', verdad: V.reveal ? q.verdad : null }),
      top5: c.top5.map((q, i) => i !== T.idx ? { titulo: '', items: [] }
        : { titulo: q.titulo, items: q.items.map((it, j) => (T.rev[j] ? it : '')) }),
    },
  };
}

function broadcast() {
  let full = null, view = null;
  wss.clients.forEach(c => {
    if (c.readyState !== 1) return;
    if (c.canControl) c.send(full || (full = JSON.stringify(state)));
    else c.send(view || (view = JSON.stringify(viewOf(state))));
  });
}

// ---------- Reloj ----------
let last = Date.now(), lastKey = '';
setInterval(() => {
  if (!state) return;
  const now = Date.now(), t = state.timer;
  if (t.running) {
    t.remaining = Math.max(0, t.remaining - (now - last) / 1000);
    if (t.remaining === 0) t.running = false;
  }
  last = now;
  const key = Math.ceil(t.remaining) + '|' + t.running;
  if (key !== lastKey) { lastKey = key; broadcast(); }
}, 200);
setInterval(() => wss.clients.forEach(c => { try { c.ping(); } catch {} }), 30000); // mantiene viva la conexión en la nube

// ---------- Mensajes del panel de control ----------
wss.on('connection', (ws, req) => {
  const key = new URL(req.url, 'http://x').searchParams.get('key') || '';
  ws.canControl = !CONTROL_KEY || key === CONTROL_KEY;
  ws.send(JSON.stringify(ws.canControl ? state : viewOf(state)));

  ws.on('message', async raw => {
    if (!ws.canControl) return; // la pantalla es solo de lectura
    let m;
    try { m = JSON.parse(raw); } catch { return; }

    // Recargar las preguntas sin reiniciar el servidor
    if (m.type === 'reload_content') {
      try {
        const r = await loadContent();
        content = r.c; state.content = content;
        state.adivina.idx = Math.min(state.adivina.idx, content.adivina.length - 1);
        state.vf.idx = Math.min(state.vf.idx, content.vf.length - 1);
        state.top5.idx = Math.min(state.top5.idx, content.top5.length - 1);
        state.top5.rev = hidden(state.top5.idx);
        state.adivina.revealed = Math.min(state.adivina.revealed, content.adivina[state.adivina.idx].pistas.length);
        state.contentMsg = `✔ Preguntas recargadas (${r.source}): ${content.adivina.length} jugadores, ${content.vf.length} afirmaciones, ${content.top5.length} rankings`;
      } catch (e) {
        state.contentMsg = '✘ No se pudieron leer las preguntas: ' + e.message;
      }
      broadcast();
      return;
    }

    const { adivina: A, vf: V, top5: T, timer: R } = state;
    const c = state.content;

    switch (m.type) {
      case 'game': state.game = m.value; break;

      // Adivina el jugador
      case 'a_clue':
        A.revealed = Math.min(A.revealed + 1, c.adivina[A.idx].pistas.length);
        break;
      case 'a_solve':
        if (!A.solved) {
          const n = c.adivina[A.idx].pistas.length;
          A.score += Math.max(1, n - Math.max(A.revealed, 1) + 1);
          A.solved = true;
        }
        break;
      case 'a_reveal': A.solved = true; break; // mostrar respuesta sin puntos
      case 'a_go':
        A.idx = wrap(A.idx, c.adivina.length, m.dir);
        A.revealed = 0; A.solved = false;
        break;

      // Verdadero o falso
      case 'v_show': V.shown = true; break;
      case 'v_mark':
        if (!V.reveal) { V.reveal = true; V.answered++; if (m.value) V.score++; }
        break;
      case 'v_go':
        V.idx = wrap(V.idx, c.vf.length, m.dir);
        V.shown = false; V.reveal = false;
        break;

      // Top 5
      case 't_toggle': T.rev[m.i] = !T.rev[m.i]; break;
      case 't_all': T.rev = T.rev.map(() => true); break;
      case 't_go':
        T.idx = wrap(T.idx, c.top5.length, m.dir);
        T.rev = hidden(T.idx);
        break;

      // Reloj
      case 'timer_set': {
        const v = clamp(Math.round(Number(m.value)) || DEFAULT_TIME, 1, 5999);
        R.total = v; R.remaining = v; R.running = false;
        break;
      }
      case 'timer_start':
        if (R.remaining <= 0) R.remaining = R.total;
        R.running = true; last = Date.now();
        break;
      case 'timer_pause': R.running = false; break;
      case 'timer_reset': R.remaining = R.total; R.running = false; break;
      case 'timer_add': R.remaining = clamp(R.remaining + Number(m.value || 0), 0, 5999); break;
      case 'timer_show': R.show = !!m.value; break;

      case 'reset': state = fresh(state.timer.total); break;
    }
    broadcast();
  });
});

(async () => {
  let r, startMsg = '';
  try {
    r = await loadContent();
  } catch (e) {
    console.error('No se pudieron leer las preguntas:', e.message);
    // Si falla Google Sheets, el servidor igual arranca con preguntas.xlsx de respaldo para poder corregir y recargar
    if (GOOGLE_SHEET && fs.existsSync(EXCEL_PATH)) {
      try {
        r = { c: await readExcel(EXCEL_PATH), source: 'preguntas.xlsx (respaldo)' };
        startMsg = '⚠ No se pudo leer Google Sheets: ' + e.message + '. Se usan las preguntas de respaldo; corrige y presiona "Recargar preguntas".';
      } catch { process.exit(1); }
    } else process.exit(1);
  }
  content = r.c;
  console.log(`Preguntas cargadas desde ${r.source}: ${content.adivina.length} jugadores, ${content.vf.length} afirmaciones, ${content.top5.length} rankings`);
  state = fresh();
  state.contentMsg = startMsg;
  server.listen(PORT, () => console.log(`FSHOW Juegos listo en http://localhost:${PORT}` + (CONTROL_KEY ? ' (control protegido con clave)' : '')));
})();
