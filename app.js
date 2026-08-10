/* Blockfield — the inclusion ladder.
   Plots every unconfirmed transaction by fee rate. The bright cutoff line is the
   floor to make the next block; anything above it gets pulled into the forming
   block, anything below waits. Reads a mempool.space-compatible REST/WS API, so
   it runs against the public API or any self-hosted node (Start9 / Umbrel). */

const $ = (id) => document.getElementById(id);
const fmt = new Intl.NumberFormat('en-US');
const PUBLIC_API = 'https://mempool.space/api';
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const TYPICAL_VB = 141; // 1-in / 2-out native segwit, for fiat fee estimates

/* ---------- data source ---------- */
function normalizeBase(raw) {
  if (!raw) return null;
  let v = String(raw).trim();
  if (!v) return null;
  if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
  v = v.replace(/\/+$/, '');
  if (!/\/api$/i.test(v)) v += '/api';
  return v;
}
const params = new URLSearchParams(location.search);
const requested = normalizeBase(params.get('node') || params.get('api') || localStorage.getItem('blockfield_api'));
const source = { base: requested || PUBLIC_API, custom: !!requested && requested !== PUBLIC_API, degraded: false };
const explorerBase = () => source.base.replace(/\/api$/i, '');
const wsUrl = () => source.base.replace(/^http/i, 'ws') + '/v1/ws';
function persistSource(base) {
  const n = normalizeBase(base);
  if (n && n !== PUBLIC_API) localStorage.setItem('blockfield_api', n); else localStorage.removeItem('blockfield_api');
}
function renderSourceBadge() {
  const badge = $('nodeBadge');
  const host = explorerBase().replace(/^https?:\/\//i, '');
  badge.classList.toggle('custom', source.custom);
  badge.classList.toggle('degraded', source.degraded);
  if (source.custom && !source.degraded) { setText('nodeLabel', 'SELF-HOSTED'); badge.title = 'Live from ' + host + ' — click to change'; }
  else if (source.degraded) { setText('nodeLabel', 'NODE OFFLINE'); badge.title = 'Your node did not respond — using mempool.space. Click to reconfigure.'; }
  else { setText('nodeLabel', 'MEMPOOL.SPACE'); badge.title = 'Public mempool.space API — click to use your own node'; }
}

/* ---------- state + helpers ---------- */
const state = {
  fees: { fastestFee: 1, halfHourFee: 1, hourFee: 1, minimumFee: 1, economyFee: 1 },
  mempool: { count: 0, vsize: 0, total_fee: 0, fee_histogram: [] },
  projectedBlocks: [], recent: [], blocks: [], difficulty: null, priceUsd: null,
  height: null, hashrate: null, paused: false, sound: false, audio: null,
  syncedAt: null, loading: false, pressure: 0
};
const setText = (id, v) => { const el = $(id); if (el) el.textContent = v; };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const txRate = (tx) => Math.max(0.1, tx.fee / tx.vsize);
const timeAgo = (s) => { if (!s || s < 60) return 'just now'; const m = Math.floor(s / 60); return m < 60 ? m + ' min ago' : Math.floor(m / 60) + ' hr ago'; };
const shortTime = (ms) => { const m = Math.round(ms / 60000); if (m < 60) return m + 'm'; const h = Math.floor(m / 60); return h < 24 ? h + 'h ' + (m % 60) + 'm' : Math.floor(h / 24) + 'd ' + (h % 24) + 'h'; };
const formatFees = (sats) => sats > 1e8 ? (sats / 1e8).toFixed(3) + ' BTC' : (sats / 1e6).toFixed(2) + 'M sat';
const usdFor = (satsPerVb) => state.priceUsd ? '~$' + (satsPerVb * TYPICAL_VB / 1e8 * state.priceUsd).toFixed(2) : '';
const subsidyAt = (h) => 50 / Math.pow(2, Math.floor(h / 210000));

const RAMP = [[0,[119,185,255]],[.35,[120,220,170]],[.6,[229,251,117]],[.82,[255,176,61]],[1,[255,92,61]]];
function feeColor(fee) {
  const top = Math.max(state.fees.fastestFee * 1.35, state.fees.minimumFee + 4, 6);
  const t = clamp(fee / top, 0, 1);
  for (let i = 1; i < RAMP.length; i++) if (t <= RAMP[i][0]) {
    const [t0, c0] = RAMP[i - 1], [t1, c1] = RAMP[i], k = (t - t0) / (t1 - t0 || 1);
    return [Math.round(c0[0]+(c1[0]-c0[0])*k), Math.round(c0[1]+(c1[1]-c0[1])*k), Math.round(c0[2]+(c1[2]-c0[2])*k)];
  }
  return RAMP[RAMP.length - 1][1];
}
const rgb = (c) => 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')';
const rgba = (c, a) => 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')';
function computePressure() {
  const backlog = clamp((state.projectedBlocks.length || state.mempool.vsize / 1e6) / 12, 0, 1);
  const feeStress = clamp((state.fees.fastestFee - state.fees.minimumFee) / 60, 0, 1);
  return clamp(backlog * 0.65 + feeStress * 0.35, 0, 1);
}
const nextCutoff = () => {
  const r = state.projectedBlocks[0]?.feeRange;
  return r && r.length ? Math.max(r[0], state.fees.minimumFee) : state.fees.minimumFee || 1;
};

/* ---------- fetch ---------- */
async function safeFetch(path, timeout = 8000) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), timeout);
  try { const r = await fetch(source.base + path, { cache: 'no-store', signal: c.signal }); if (!r.ok) throw new Error(r.status); return await r.json(); }
  finally { clearTimeout(t); }
}
async function loadLiveData({ quiet = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  const oldHeight = state.height;
  try {
    const d = await Promise.all([
      safeFetch('/blocks/tip/height'), safeFetch('/mempool'), safeFetch('/v1/fees/recommended'),
      safeFetch('/blocks'), safeFetch('/v1/fees/mempool-blocks'), safeFetch('/mempool/recent'),
      safeFetch('/v1/mining/hashrate/3d').catch(() => ({ currentHashrate: state.hashrate })),
      safeFetch('/v1/difficulty-adjustment').catch(() => state.difficulty),
      safeFetch('/v1/prices').catch(() => null)
    ]);
    state.height = d[0]; state.mempool = d[1]; state.fees = d[2]; state.blocks = d[3];
    state.projectedBlocks = d[4]; state.recent = d[5]; state.hashrate = d[6]?.currentHashrate ?? state.hashrate;
    state.difficulty = d[7] || state.difficulty; if (d[8]?.USD) state.priceUsd = d[8].USD;
    state.pressure = computePressure();
    state.syncedAt = Date.now();
    if (source.degraded) { source.degraded = false; renderSourceBadge(); }
    if (window.__field) window.__field.ingest();
    renderDashboard();
    scanRecentForInscriptions();
    if (oldHeight && state.height > oldHeight) triggerBlockFound(state.blocks[0]);
  } catch (e) {
    window.__blockfieldError = e?.stack || e?.message || String(e);
    console.error('Blockfield live-data update failed:', e);
    setText('syncAge', 'RECONNECTING');
    if (source.custom && !source.degraded) { source.degraded = true; source.base = PUBLIC_API; renderSourceBadge(); state.loading = false; return loadLiveData({ quiet }); }
  } finally { state.loading = false; }
}

/* ---------- render ---------- */
function renderDashboard() {
  const block = state.blocks[0];
  const first = state.projectedBlocks[0];
  const firstRange = first?.feeRange || [state.fees.fastestFee];
  const blockAge = block ? Math.max(0, Date.now() / 1000 - block.timestamp) : 0;
  const eta = Math.max(0, 600 - blockAge);
  const cutoff = nextCutoff();

  // left rail
  setText('height', state.height ? '#' + fmt.format(state.height) : '#------');
  setText('roundHeight', state.height ? '#' + fmt.format(state.height + 1) : '#---');
  setText('blockAge', block ? 'TIP MINED ' + timeAgo(blockAge).toUpperCase() : 'LOCATING TIP');
  setText('mempoolTx', fmt.format(state.mempool.count || 0));
  setText('mempoolSize', (state.mempool.vsize / 1e6).toFixed(1) + ' vMB · ' + Math.max(1, Math.round(state.mempool.vsize / 1e6)) + ' BLOCKS DEEP');
  setText('mempoolFees', (state.mempool.total_fee / 1e8).toFixed(2) + ' BTC');
  setText('minFee', state.fees.minimumFee);
  setText('hashrate', state.hashrate ? (state.hashrate / 1e18).toFixed(0) + ' EH/s' : '--');
  setText('blockEta', '~ ' + String(Math.floor(eta / 60)).padStart(2, '0') + ':' + String(Math.floor(eta % 60)).padStart(2, '0'));

  if (state.difficulty) {
    const dc = state.difficulty.difficultyChange;
    setText('diffChange', (dc >= 0 ? '+' : '') + dc.toFixed(2) + '%');
    const dEl = $('diffChange'); dEl.classList.remove('mid', 'gold'); dEl.classList.add(dc >= 0 ? 'mid' : 'gold');
    $('diffMeter').style.width = clamp(state.difficulty.progressPercent, 2, 100) + '%';
    setText('diffEta', state.difficulty.remainingBlocks + ' blocks · ~' + shortTime(state.difficulty.remainingTime));
    setText('difficultyNote', 'RETARGET ' + (dc >= 0 ? '+' : '') + dc.toFixed(1) + '% IN ' + state.difficulty.remainingBlocks + ' BLK');
  }
  if (state.height != null) {
    const nextHalving = (Math.floor(state.height / 210000) + 1) * 210000;
    setText('halvingBlocks', fmt.format(nextHalving - state.height) + ' blocks');
    setText('subsidy', String(subsidyAt(state.height)));
    const days = Math.round((nextHalving - state.height) * 10 / 60 / 24);
    setText('halvingEta', 'block #' + fmt.format(nextHalving) + ' · ~' + days + 'd');
  }

  // fee routes + fiat
  setText('fastFee', state.fees.fastestFee); setText('fastUsd', usdFor(state.fees.fastestFee));
  setText('halfFee', state.fees.halfHourFee); setText('halfUsd', usdFor(state.fees.halfHourFee));
  setText('hourFee', state.fees.economyFee || state.fees.hourFee); setText('hourUsd', usdFor(state.fees.economyFee || state.fees.hourFee));
  setText('feeUpdated', new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  setText('btcPrice', state.priceUsd ? '$' + fmt.format(Math.round(state.priceUsd)) : '$--');

  // next-block template
  if (first) {
    setText('nbTx', fmt.format(first.nTx) + ' tx');
    setText('nbSize', (first.blockVSize / 1e6).toFixed(2) + ' vMB');
    setText('nbMedian', first.medianFee.toFixed(1) + ' sat/vB');
    setText('nbRange', Math.ceil(firstRange[0]) + '–' + Math.ceil(firstRange[firstRange.length - 1]) + ' sat/vB');
    const reward = subsidyAt(state.height || 0) + (first.totalFees || 0) / 1e8;
    setText('nbReward', reward.toFixed(3) + ' BTC');
  }

  // last block
  if (block) {
    setText('latestHeight', '#' + fmt.format(block.height));
    setText('minerName', (block.extras?.pool?.name || 'Unknown pool').toUpperCase());
    setText('blockTx', fmt.format(block.tx_count));
    setText('blockFees', formatFees(block.extras?.totalFees || 0));
    setText('minedAt', timeAgo(blockAge));
    $('blockLink').href = explorerBase() + '/block/' + block.id;
  }

  // pressure HUD
  const p = state.pressure;
  const label = p > 0.78 ? 'GRIDLOCK' : p > 0.55 ? 'HEAVY' : p > 0.3 ? 'CONTESTED' : p > 0.12 ? 'FLOWING' : 'CLEAR';
  setText('pressureLabel', label);
  setText('pressureFee', cutoff.toFixed(1) + ' sat/vB cutoff');

  renderChain();
  renderArrivals();
}

function renderChain() {
  const proj = $('projectedBlocks'); const conf = $('confirmedBlocks');
  if (proj) proj.innerHTML = state.projectedBlocks.slice(0, 3).map((b, i) => {
    const c = feeColor(b.medianFee);
    return '<div class="blk proj" style="--c:' + rgb(c) + '"><s>' + (i === 0 ? 'next' : '+' + i) + '</s>' +
      '<u>' + b.medianFee.toFixed(0) + '</u><em>' + fmt.format(Math.round(b.nTx / 1000)) + 'k tx</em></div>';
  }).join('');
  if (conf) conf.innerHTML = state.blocks.slice(0, 5).map((b) => {
    const c = feeColor(b.extras?.medianFee || 2);
    return '<a class="blk conf" href="' + explorerBase() + '/block/' + b.id + '" target="_blank" rel="noreferrer" style="--c:' + rgb(c) + '">' +
      '<s>' + timeAgo(Date.now() / 1000 - b.timestamp).replace(' ago', '') + '</s>' +
      '<u>' + fmt.format(b.height).slice(-3) + '</u><em>' + fmt.format(b.tx_count) + ' tx</em></a>';
  }).join('');
}

function renderArrivals() {
  const list = $('arrivalList'); if (!list) return;
  if (!state.recent.length) { list.innerHTML = '<p>Listening…</p>'; return; }
  const cutoff = nextCutoff();
  list.innerHTML = state.recent.slice(0, 5).map((tx, i) => {
    const fee = txRate(tx); const c = feeColor(fee);
    return '<div class="arrival" style="--c:' + rgb(c) + ';animation-delay:' + i * 40 + 'ms">' +
      '<i></i><div><code>' + tx.txid.slice(0, 10) + '</code><small>' + (tx.vsize || 0) + ' vB · ' + (fee >= cutoff ? 'clears cutoff' : 'below cutoff') + '</small></div>' +
      '<b>' + fee.toFixed(1) + '</b></div>';
  }).join('');
}

/* ---------- block found ---------- */
function triggerBlockFound(block) {
  if (!block) return;
  setText('foundHeight', '#' + fmt.format(block.height));
  setText('foundDetail', (block.extras?.pool?.name || 'A miner') + ' sealed ' + fmt.format(block.tx_count) + ' transactions.');
  const overlay = $('blockFound');
  if (state.sound) { playTone(110, .18, .15); setTimeout(() => playTone(220, .24, .12), 140); setTimeout(() => playTone(440, .35, .1), 300); }
  overlay.classList.add('show');
  $('field').classList.add('impact');
  if (window.__field) window.__field.seal();
  setTimeout(() => { overlay.classList.remove('show'); $('field').classList.remove('impact'); }, 3000);
}
function playTone(f, dur = .12, vol = .06) {
  try {
    state.audio = state.audio || new (window.AudioContext || window.webkitAudioContext)();
    const o = state.audio.createOscillator(), g = state.audio.createGain();
    o.type = 'sawtooth'; o.frequency.value = f;
    g.gain.setValueAtTime(vol, state.audio.currentTime);
    g.gain.exponentialRampToValueAtTime(.0001, state.audio.currentTime + dur);
    o.connect(g); g.connect(state.audio.destination); o.start(); o.stop(state.audio.currentTime + dur);
  } catch (e) { state.sound = false; }
}

/* ---------- inscription witness radar ---------- */
const FEATURED_TXID = 'b9a03a958e7af268f1e4e320f56d7c33eec6443bc2f93e1dfae51619a9b60043';
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp']);
const radar = { seen: new Set(), loading: false, items: [], lastAuto: 0 };

function extractTxid(value) {
  const match = String(value || '').match(/[0-9a-f]{64}/i);
  return match ? match[0].toLowerCase() : null;
}

function hexToBytes(hex) {
  if (!hex || hex.length % 2 || !/^[0-9a-f]+$/i.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function readPush(bytes, at) {
  if (at >= bytes.length) return null;
  const opcode = bytes[at++];
  let size;
  if (opcode === 0) return { data: new Uint8Array(0), next: at };
  if (opcode >= 1 && opcode <= 75) size = opcode;
  else if (opcode === 76) { if (at >= bytes.length) return null; size = bytes[at++]; }
  else if (opcode === 77) {
    if (at + 1 >= bytes.length) return null;
    size = bytes[at] | (bytes[at + 1] << 8); at += 2;
  } else if (opcode === 78) {
    if (at + 3 >= bytes.length) return null;
    size = (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0; at += 4;
  } else return { data: null, next: at, opcode };
  if (size > 4_000_000 || at + size > bytes.length) return null;
  return { data: bytes.slice(at, at + size), next: at + size };
}

function parseOrdEnvelopes(witnessHex) {
  const bytes = hexToBytes(witnessHex);
  if (!bytes) return [];
  const marker = [0x00, 0x63, 0x03, 0x6f, 0x72, 0x64];
  const found = [];
  for (let start = 0; start <= bytes.length - marker.length; start++) {
    if (!marker.every((v, i) => bytes[start + i] === v)) continue;
    let at = start + marker.length;
    let contentType = '';
    const body = [];
    let bodySize = 0;
    let inBody = false;
    while (at < bytes.length) {
      if (bytes[at] === 0x68) break;
      const pushed = readPush(bytes, at);
      if (!pushed) break;
      at = pushed.next;
      if (!pushed.data) continue;
      if (!inBody && pushed.data.length === 0) { inBody = true; continue; }
      if (inBody) {
        bodySize += pushed.data.length;
        if (bodySize > 4_000_000) break;
        body.push(pushed.data);
        continue;
      }
      const tag = pushed.data[0];
      const value = readPush(bytes, at);
      if (!value || !value.data) break;
      at = value.next;
      if (tag === 1) contentType = new TextDecoder().decode(value.data).toLowerCase();
    }
    if (!body.length) continue;
    const joined = new Uint8Array(bodySize);
    let offset = 0;
    for (const chunk of body) { joined.set(chunk, offset); offset += chunk.length; }
    found.push({ contentType: contentType || 'application/octet-stream', bytes: joined });
    start = at;
  }
  return found;
}

function decodeInscriptions(tx) {
  const envelopes = [];
  for (const input of tx.vin || []) {
    for (const witness of input.witness || []) envelopes.push(...parseOrdEnvelopes(witness));
  }
  return envelopes.map((item, index) => ({ ...item, index, id: tx.txid + 'i' + index }));
}

function setRadarStatus(title, detail, error = false, media = null) {
  setText('inscriptionStatus', title);
  setText('inscriptionMeta', detail);
  const result = $('inscriptionResult');
  if (result) result.classList.toggle('error', error);
  const preview = $('inscriptionPreview');
  if (preview && media) {
    preview.replaceChildren();
    const image = document.createElement('img');
    image.src = media.url; image.alt = 'Decoded Bitcoin inscription';
    preview.appendChild(image);
  }
}

function imageFromEnvelope(tx, envelope) {
  const mime = envelope.contentType.split(';')[0].trim();
  if (!IMAGE_MIMES.has(mime)) return Promise.resolve(null);
  const url = URL.createObjectURL(new Blob([envelope.bytes], { type: mime }));
  const image = new Image();
  image.decoding = 'async';
  return new Promise((resolve) => {
    image.onload = () => resolve({
      id: envelope.id, txid: tx.txid, mime, bytes: envelope.bytes.length, url, image,
      fee: tx.fee || 0, vsize: Math.ceil((tx.weight || (tx.size || 0) * 4) / 4),
      value: (tx.vout || []).reduce((sum, output) => sum + (output.value || 0), 0),
      confirmed: !!tx.status?.confirmed
    });
    image.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    image.src = url;
  });
}

async function loadInscriptionTx(value, { silent = false } = {}) {
  const txid = extractTxid(value);
  if (!txid) {
    if (!silent) setRadarStatus('INVALID TRANSACTION', 'Paste a mempool.space link or a 64-character txid.', true);
    return false;
  }
  const existing = radar.items.find((item) => item.txid === txid);
  if (existing) {
    if (!silent) setRadarStatus('ALREADY IN THE FIELD', existing.mime + ' · ' + fmt.format(existing.bytes) + ' bytes', false, existing);
    return true;
  }
  if (radar.loading) return false;
  radar.loading = true;
  if (!silent) setRadarStatus('SCANNING WITNESS…', txid.slice(0, 16) + '…', false);
  try {
    const tx = await safeFetch('/tx/' + txid, 15000);
    const envelopes = decodeInscriptions(tx);
    if (!envelopes.length) throw new Error('No Ordinals envelope found in this transaction.');
    const media = (await Promise.all(envelopes.map((item) => imageFromEnvelope(tx, item)))).filter(Boolean);
    if (!media.length) throw new Error('Inscription found, but its media type is not a safely supported image.');
    for (const item of media) {
      radar.items.unshift(item);
      radar.items = radar.items.slice(0, 5);
      if (window.__field) window.__field.addInscription(item);
    }
    const first = media[0];
    setRadarStatus('INSCRIPTION ACQUIRED', first.mime.toUpperCase() + ' · ' + fmt.format(first.bytes) + ' bytes · ' + (first.confirmed ? 'confirmed' : 'unconfirmed'), false, first);
    $('inscriptionRadar')?.classList.add('active');
    combatLog('✦ INSCRIPTION ' + first.txid.slice(0, 8).toUpperCase() + ' ENTERED THE BLOCKFIELD', true);
    return true;
  } catch (error) {
    if (!silent) setRadarStatus('NO IMAGE ACQUIRED', error.message || 'Transaction could not be decoded.', true);
    return false;
  } finally {
    radar.loading = false;
  }
}

function scanRecentForInscriptions() {
  if (radar.loading || Date.now() - radar.lastAuto < 20000) return;
  const candidate = state.recent.find((tx) => (tx.vsize || 0) >= 1600 && !radar.seen.has(tx.txid));
  if (!candidate) return;
  radar.lastAuto = Date.now();
  radar.seen.add(candidate.txid);
  if (radar.seen.size > 120) radar.seen = new Set(Array.from(radar.seen).slice(-80));
  loadInscriptionTx(candidate.txid, { silent: true });
}

let logTimer = 0;
function combatLog(message, impact = false) {
  const log = $('battleLog');
  if (!log) return;
  const span = log.querySelector('span');
  if (span) span.textContent = message;
  log.classList.toggle('hit', impact);
  clearTimeout(logTimer);
  logTimer = setTimeout(() => log.classList.remove('hit'), 420);
}

/* ---------- projected block war ---------- */
function createBlockWar() {
  const canvas = $('fieldCanvas');
  const ctx = canvas.getContext('2d');
  const tip = $('fieldTip');
  const colors = [[229,251,117], [255,154,61], [119,185,255]];
  let particles = [];
  let fighters = [];
  let cards = [];
  let sparks = [];
  let rings = [];
  let dpr = 1, W = 0, H = 0;
  let feeMin = 1, feeMax = 20;
  let pointer = { x: -1, y: -1, active: false };
  let cdf = null, cdfTotal = 0;
  let sealFlash = 0, lastTime = 0, lastCollision = 0;

  const padTop = 72, padBottom = 58;
  const arenaRight = () => clamp(W * 0.48, 205, 430);
  const fighterSize = () => clamp(W * 0.105, 72, 108);
  const feeToY = (fee) => {
    const lf = Math.log(clamp(fee, feeMin, feeMax));
    const t = (lf - Math.log(feeMin)) / (Math.log(feeMax) - Math.log(feeMin) || 1);
    return H - padBottom - t * Math.max(1, H - padTop - padBottom);
  };
  const blockCutoff = (index) => {
    const block = state.projectedBlocks[index];
    const range = block?.feeRange;
    if (range?.length) return Math.max(0.1, range[0]);
    return Math.max(0.1, nextCutoff() / Math.pow(1.75, index));
  };
  const feeBand = (fee) => {
    for (let i = 0; i < 3; i++) if (fee >= blockCutoff(i)) return i;
    return -1;
  };

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const oldW = W, oldH = H;
    W = rect.width; H = rect.height;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!fighters.length) initFighters();
    else if (oldW && oldH) {
      for (const f of fighters) {
        f.x = clamp(f.x / oldW * W, fighterSize() * .65, arenaRight() - fighterSize() * .65);
        f.y = clamp(f.y / oldH * H, padTop + fighterSize() * .55, H - padBottom - fighterSize() * .55);
      }
    }
  }

  function initFighters() {
    const right = arenaRight(), s = fighterSize();
    fighters = [
      { x: s * .72, y: H * .31, vx: .62, vy: .29, phase: .4, hit: 0, fill: 0 },
      { x: right - s * .72, y: H * .51, vx: -.54, vy: -.34, phase: 2.6, hit: 0, fill: 0 },
      { x: s * .9, y: H * .73, vx: .49, vy: -.25, phase: 4.8, hit: 0, fill: 0 }
    ];
  }

  function buildSampler() {
    const histogram = state.mempool.fee_histogram || [];
    if (!histogram.length) { cdf = null; return; }
    cdf = []; cdfTotal = 0;
    for (const [fee, weight] of histogram) { cdfTotal += weight; cdf.push([cdfTotal, fee]); }
  }

  function sampleFee() {
    if (cdf && cdfTotal > 0) {
      const pick = Math.random() * cdfTotal;
      for (const [total, fee] of cdf) if (pick <= total) return fee;
    }
    return feeMin * Math.pow(feeMax / feeMin, Math.random());
  }

  function spawn(fee, scatter = false) {
    return {
      fee, x: arenaRight() + 15 + Math.random() * Math.max(30, W - arenaRight() - 20),
      y: null, vx: .55 + Math.random() * .8, size: 2 + Math.random() * 2.8,
      seed: Math.random() * 6.283, real: false, txid: null, vsize: 0, value: 0,
      trail: scatter ? Math.random() * 12 : 0
    };
  }

  function ingest() {
    const histogram = state.mempool.fee_histogram || [];
    let robustMax = state.fees.fastestFee;
    if (histogram.length) {
      const total = histogram.reduce((sum, entry) => sum + entry[1], 0);
      let cumulative = 0;
      for (const [fee, weight] of histogram) {
        cumulative += weight;
        if (cumulative >= total * .02) { robustMax = fee; break; }
      }
    }
    feeMin = Math.max(.1, Math.min(state.fees.minimumFee || 1, blockCutoff(2) * .62));
    feeMax = Math.max(state.fees.fastestFee * 1.5, robustMax, blockCutoff(0) * 3, 8);
    buildSampler();
    const target = Math.round(clamp(78 + state.pressure * 100, 78, 178));
    while (particles.length < target) particles.push(spawn(sampleFee(), true));
    if (particles.length > target) particles.length = target;
    state.recent.slice(0, 12).forEach((tx, index) => {
      const p = particles[index];
      if (!p) return;
      p.fee = txRate(tx); p.txid = tx.txid; p.vsize = tx.vsize || 0; p.value = tx.value || 0;
      p.real = true; p.size = 3 + clamp((tx.vsize || 200) / 340, 0, 5);
      p.x = arenaRight() + 20 + Math.random() * Math.max(40, W - arenaRight() - 30); p.y = null;
    });
    combatLog('LIVE QUEUES LOCKED · ' + fmt.format(state.mempool.count || 0) + ' TRANSACTIONS IN RANGE');
  }

  function addInscription(info) {
    if (cards.some((card) => card.info.id === info.id)) return;
    cards.unshift({
      info, x: W - 70 - Math.random() * Math.max(20, W * .18),
      y: clamp(feeToY(Math.max(info.fee / Math.max(1, info.vsize), feeMin)), padTop + 40, H - padBottom - 40),
      vx: -.55 - Math.random() * .4, vy: (Math.random() - .5) * .55,
      size: clamp(Math.min(W, H) * .09, 48, 68), cooldown: 0, seed: Math.random() * 6.283
    });
    cards = cards.slice(0, 5);
  }

  function burst(x, y, color, count = 10) {
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * 6.283, speed = .6 + Math.random() * 2.2;
      sparks.push({ x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, life: 1, color });
    }
    rings.push({ x, y, life: 1, color });
  }

  function drawArena(time) {
    const right = arenaRight();
    ctx.strokeStyle = 'rgba(229,251,117,.13)'; ctx.lineWidth = 1; ctx.setLineDash([3, 7]);
    ctx.beginPath(); ctx.moveTo(right, padTop - 15); ctx.lineTo(right, H - padBottom + 8); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(150,166,151,.55)'; ctx.font = '500 7px DM Mono, monospace'; ctx.textAlign = 'center';
    ctx.fillText('COMBAT ZONE', right * .5, H - 22);
    ctx.fillText('MEMPOOL INGRESS  →', right + (W - right) * .5, H - 22);
    const sweep = padTop + ((time * .035) % Math.max(1, H - padTop - padBottom));
    const gradient = ctx.createLinearGradient(0, sweep - 28, 0, sweep + 28);
    gradient.addColorStop(0, 'rgba(229,251,117,0)'); gradient.addColorStop(.5, 'rgba(229,251,117,.035)'); gradient.addColorStop(1, 'rgba(229,251,117,0)');
    ctx.fillStyle = gradient; ctx.fillRect(0, sweep - 28, right, 56);
  }

  function drawProfile() {
    const histogram = state.mempool.fee_histogram || [];
    if (!histogram.length) return;
    const maxWeight = histogram.reduce((max, entry) => Math.max(max, entry[1]), 1);
    const right = W, maxWidth = (W - arenaRight()) * .68;
    ctx.beginPath(); ctx.moveTo(right, feeToY(feeMax));
    for (const [fee, weight] of histogram) {
      if (fee < feeMin) continue;
      ctx.lineTo(right - (weight / maxWeight) * maxWidth, feeToY(fee));
    }
    ctx.lineTo(right, feeToY(feeMin)); ctx.closePath();
    const gradient = ctx.createLinearGradient(right - maxWidth, 0, right, 0);
    gradient.addColorStop(0, 'rgba(119,185,255,0)'); gradient.addColorStop(1, 'rgba(122,175,150,.16)');
    ctx.fillStyle = gradient; ctx.fill();
  }

  function drawAxis() {
    const ticks = [0.1, .2, .5, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 377];
    ctx.font = '400 8px DM Mono, monospace'; ctx.textAlign = 'right';
    for (const fee of ticks) {
      if (fee < feeMin || fee > feeMax) continue;
      const y = feeToY(fee);
      ctx.strokeStyle = 'rgba(213,227,198,.045)';
      ctx.beginPath(); ctx.moveTo(arenaRight() + 5, y); ctx.lineTo(W, y); ctx.stroke();
      ctx.fillStyle = '#65736a'; ctx.fillText(String(fee), W - 7, y - 3);
    }
  }

  function drawFeeGates(time) {
    for (let i = 2; i >= 0; i--) {
      const fee = blockCutoff(i), y = feeToY(fee), color = colors[i];
      const pulse = .35 + Math.sin(time * .003 + i * 1.8) * .09;
      ctx.strokeStyle = rgba(color, pulse); ctx.lineWidth = i === 0 ? 1.5 : 1; ctx.setLineDash(i === 0 ? [9, 7] : [4, 8]);
      ctx.beginPath(); ctx.moveTo(arenaRight(), y); ctx.lineTo(W, y); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = rgba(color, .9); ctx.font = '500 8px DM Mono, monospace'; ctx.textAlign = 'left';
      ctx.fillText('B' + (i + 1) + ' GATE · ' + fee.toFixed(1) + ' sat/vB', arenaRight() + 8, y - 5);
    }
  }

  function updateFighters(dt, time) {
    const size = fighterSize(), left = size * .56, right = arenaRight() - size * .56;
    const top = padTop + size * .48, bottom = H - padBottom - size * .48;
    if (!state.paused && !reducedMotion) {
      for (const f of fighters) {
        f.x += f.vx * dt * (1 + state.pressure * .35);
        f.y += f.vy * dt * (1 + state.pressure * .22);
        if (f.x < left || f.x > right) { f.x = clamp(f.x, left, right); f.vx *= -1; burst(f.x, f.y, [229,251,117], 4); }
        if (f.y < top || f.y > bottom) { f.y = clamp(f.y, top, bottom); f.vy *= -1; }
      }
      for (let i = 0; i < fighters.length; i++) for (let j = i + 1; j < fighters.length; j++) {
        const a = fighters[i], b = fighters[j], dx = b.x - a.x, dy = b.y - a.y;
        const distance = Math.hypot(dx, dy) || 1, minDistance = size * .78;
        if (distance >= minDistance) continue;
        const nx = dx / distance, ny = dy / distance, overlap = (minDistance - distance) * .52;
        a.x -= nx * overlap; a.y -= ny * overlap; b.x += nx * overlap; b.y += ny * overlap;
        const relative = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
        if (relative > 0) {
          a.vx -= relative * nx; a.vy -= relative * ny; b.vx += relative * nx; b.vy += relative * ny;
        } else { a.vx *= -1; b.vx *= -1; }
        a.hit = b.hit = 1;
        if (time - lastCollision > 650) {
          lastCollision = time; burst((a.x + b.x) / 2, (a.y + b.y) / 2, [255,154,61], 18);
          const spread = Math.abs((state.projectedBlocks[i]?.medianFee || 0) - (state.projectedBlocks[j]?.medianFee || 0));
          combatLog('B' + (i + 1) + ' BODY-CHECKED B' + (j + 1) + ' · ' + spread.toFixed(1) + ' SAT/VB MEDIAN SPREAD', true);
          if (state.sound) playTone(80 + i * 25, .09, .035);
        }
      }
    }
    fighters.forEach((f) => { f.hit = Math.max(0, f.hit - .045 * dt); });
  }

  function drawFighter(fighter, index, time) {
    const size = fighterSize(), block = state.projectedBlocks[index];
    const fillTarget = block ? clamp(block.blockVSize / 1e6, 0, 1) : .25;
    fighter.fill += (fillTarget - fighter.fill) * .045;
    const color = colors[index], tilt = Math.atan2(fighter.vy, fighter.vx) * .06 + Math.sin(time * .0015 + fighter.phase) * .025;
    ctx.save(); ctx.translate(fighter.x, fighter.y); ctx.rotate(tilt);
    ctx.shadowColor = rgb(color); ctx.shadowBlur = 16 + fighter.hit * 22;
    const glow = ctx.createRadialGradient(0, 0, size * .1, 0, 0, size * .8);
    glow.addColorStop(0, rgba(color, .12 + fighter.hit * .14)); glow.addColorStop(1, rgba(color, 0));
    ctx.fillStyle = glow; ctx.fillRect(-size, -size, size * 2, size * 2);
    ctx.shadowBlur = 0;
    const face = size * .78, x = -face / 2, y = -face / 2, depth = size * .12;
    ctx.fillStyle = rgba(color, .12); ctx.beginPath(); ctx.moveTo(x + face, y); ctx.lineTo(x + face + depth, y - depth); ctx.lineTo(x + face + depth, y + face - depth); ctx.lineTo(x + face, y + face); ctx.closePath(); ctx.fill();
    ctx.fillStyle = rgba(color, .08); ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + depth, y - depth); ctx.lineTo(x + face + depth, y - depth); ctx.lineTo(x + face, y); ctx.closePath(); ctx.fill();
    const faceGradient = ctx.createLinearGradient(x, y, x + face, y + face);
    faceGradient.addColorStop(0, rgba(color, .24 + fighter.hit * .18)); faceGradient.addColorStop(1, 'rgba(5,13,11,.9)');
    ctx.fillStyle = faceGradient; ctx.fillRect(x, y, face, face);
    const cells = 25, filled = Math.round(cells * fighter.fill), cell = face / 5;
    for (let n = 0; n < cells; n++) {
      const cx = x + (n % 5) * cell, cy = y + Math.floor(n / 5) * cell;
      ctx.fillStyle = n >= cells - filled ? rgba(color, .2 + ((n * 17) % 5) * .035) : 'rgba(213,227,198,.018)';
      ctx.fillRect(cx + 1, cy + 1, cell - 2, cell - 2);
    }
    ctx.strokeStyle = rgba(color, .75); ctx.lineWidth = 1.2; ctx.strokeRect(x + .5, y + .5, face - 1, face - 1);
    if (fighter.hit > 0) { ctx.fillStyle = rgba([255,255,255], fighter.hit * .2); ctx.fillRect(x, y, face, face); }
    ctx.textAlign = 'center'; ctx.fillStyle = '#f1f6e9'; ctx.font = '700 ' + clamp(size * .15, 11, 16) + 'px Space Grotesk, sans-serif';
    ctx.fillText('BLOCK ' + (index + 1), 0, -3);
    ctx.font = '600 ' + clamp(size * .11, 8, 12) + 'px DM Mono, monospace'; ctx.fillStyle = rgb(color);
    ctx.fillText(Math.round(fighter.fill * 100) + '%', 0, size * .16);
    ctx.restore();
    ctx.textAlign = 'center'; ctx.font = '500 7px DM Mono, monospace'; ctx.fillStyle = rgba(color, .92);
    ctx.fillText(index === 0 ? 'NEXT CONTENDER' : '+' + index + ' QUEUE', fighter.x, fighter.y - size * .58);
    ctx.fillStyle = '#98aa9b';
    ctx.fillText(block ? fmt.format(block.nTx) + ' tx · ' + block.medianFee.toFixed(1) + ' sat/vB' : 'awaiting template', fighter.x, fighter.y + size * .59);
  }

  function updateParticles(dt, time) {
    let hovered = null;
    for (const p of particles) {
      if (p.y == null) p.y = feeToY(p.fee) + (Math.random() - .5) * 10;
      const band = feeBand(p.fee), laneY = feeToY(p.fee) + Math.sin(time * .002 + p.seed) * 2;
      if (!state.paused && !reducedMotion) {
        if (band >= 0 && fighters[band]) {
          const target = fighters[band], dx = target.x - p.x, dy = target.y - p.y, distance = Math.hypot(dx, dy) || 1;
          const speed = p.vx * (1.25 + state.pressure * .85) * dt;
          p.x += dx / distance * speed; p.y += dy / distance * speed;
          if (distance < fighterSize() * .42) {
            burst(p.x, p.y, colors[band], p.real ? 7 : 3);
            fighters[band].hit = Math.max(fighters[band].hit, .34);
            Object.assign(p, spawn(p.real ? p.fee : sampleFee()));
          }
        } else {
          p.y += (laneY - p.y) * .08 * dt;
          p.x -= p.vx * .32 * dt;
          if (p.x < arenaRight() + 20) p.x = W - 10 - Math.random() * 30;
        }
      }
      const color = feeColor(p.fee), hit = p.real && pointer.active && Math.abs(pointer.x - p.x) < 10 && Math.abs(pointer.y - p.y) < 10;
      if (hit) hovered = { kind: 'tx', p, x: p.x, y: p.y };
      ctx.strokeStyle = rgba(color, band >= 0 ? .12 : .05); ctx.beginPath(); ctx.moveTo(p.x + 14, p.y); ctx.lineTo(p.x, p.y); ctx.stroke();
      ctx.beginPath(); ctx.fillStyle = rgb(color); ctx.globalAlpha = band >= 0 ? 1 : .38;
      ctx.shadowColor = rgb(color); ctx.shadowBlur = p.real ? 12 : (band >= 0 ? 5 : 0);
      ctx.arc(p.x, p.y, p.size * (hit ? 1.65 : 1), 0, 6.283); ctx.fill(); ctx.shadowBlur = 0; ctx.globalAlpha = 1;
      if (p.real && p.x < W - 42) {
        ctx.font = '500 7px DM Mono, monospace'; ctx.textAlign = 'left'; ctx.fillStyle = rgba(color, .78);
        ctx.fillText(p.txid.slice(0, 6), p.x + 7, p.y - 6);
      }
    }
    return hovered;
  }

  function updateCards(dt, time, hovered) {
    const cardHits = [];
    for (const card of cards) {
      const rate = card.info.fee / Math.max(1, card.info.vsize), band = feeBand(rate), half = card.size / 2;
      if (!state.paused && !reducedMotion) {
        card.cooldown = Math.max(0, card.cooldown - dt);
        if (band >= 0 && fighters[band]) {
          const target = fighters[band], dx = target.x - card.x, dy = target.y - card.y, distance = Math.hypot(dx, dy) || 1;
          card.vx += dx / distance * .008 * dt; card.vy += dy / distance * .008 * dt;
          const speed = Math.hypot(card.vx, card.vy);
          if (speed > 1.35) { card.vx = card.vx / speed * 1.35; card.vy = card.vy / speed * 1.35; }
          card.x += card.vx * dt; card.y += card.vy * dt;
          if (distance < fighterSize() * .52 + half && card.cooldown <= 0) {
            card.vx *= -1.5; card.vy *= -1.5; card.cooldown = 90;
            burst(card.x, card.y, [193,140,255], 22); fighters[band].hit = 1;
            combatLog('✦ ORD ' + card.info.txid.slice(0, 7).toUpperCase() + ' CHALLENGED BLOCK ' + (band + 1), true);
            if (state.sound) playTone(520, .12, .045);
          }
        } else {
          card.x += card.vx * dt; card.y += card.vy * dt;
          const left = arenaRight() + half + 12, right = W - half - 10;
          if (card.x < left || card.x > right) { card.x = clamp(card.x, left, right); card.vx *= -1; }
          if (card.y < padTop + half || card.y > H - padBottom - half) { card.y = clamp(card.y, padTop + half, H - padBottom - half); card.vy *= -1; }
        }
      }
      const hit = pointer.active && Math.abs(pointer.x - card.x) <= half && Math.abs(pointer.y - card.y) <= half;
      if (hit) hovered = { kind: 'inscription', card, x: card.x, y: card.y };
      ctx.save(); ctx.translate(card.x, card.y); ctx.rotate(Math.sin(time * .0016 + card.seed) * .045);
      ctx.shadowColor = '#c18cff'; ctx.shadowBlur = hit ? 28 : 17;
      ctx.fillStyle = '#050907'; ctx.fillRect(-half - 4, -half - 4, card.size + 8, card.size + 8);
      ctx.save(); ctx.beginPath(); ctx.roundRect(-half, -half, card.size, card.size, 5); ctx.clip();
      ctx.drawImage(card.info.image, -half, -half, card.size, card.size); ctx.restore();
      ctx.shadowBlur = 0; ctx.strokeStyle = hit ? '#f1ddff' : '#c18cff'; ctx.lineWidth = hit ? 2 : 1;
      ctx.strokeRect(-half - 2, -half - 2, card.size + 4, card.size + 4);
      ctx.fillStyle = '#c18cff'; ctx.fillRect(-half - 3, -half - 14, card.size + 6, 11);
      ctx.fillStyle = '#100919'; ctx.font = '700 7px DM Mono, monospace'; ctx.textAlign = 'center'; ctx.fillText('✦ INSCRIPTION', 0, -half - 6);
      ctx.restore();
      ctx.fillStyle = '#d9baff'; ctx.font = '500 7px DM Mono, monospace'; ctx.textAlign = 'center';
      ctx.fillText(rate.toFixed(2) + ' sat/vB · ' + (band >= 0 ? 'B' + (band + 1) + ' BOUND' : 'WAITING'), card.x, card.y + half + 13);
      cardHits.push(card);
    }
    return hovered;
  }

  function drawEffects(dt) {
    sparks = sparks.filter((spark) => spark.life > 0);
    for (const spark of sparks) {
      spark.x += spark.vx * dt; spark.y += spark.vy * dt; spark.vx *= .97; spark.vy *= .97; spark.life -= .035 * dt;
      ctx.fillStyle = rgba(spark.color, Math.max(0, spark.life)); ctx.fillRect(spark.x, spark.y, 2, 2);
    }
    rings = rings.filter((ring) => ring.life > 0);
    for (const ring of rings) {
      ctx.strokeStyle = rgba(ring.color, ring.life); ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.arc(ring.x, ring.y, (1 - ring.life) * 30, 0, 6.283); ctx.stroke(); ring.life -= .055 * dt;
    }
    if (sealFlash > 0) {
      ctx.fillStyle = rgba([229,251,117], sealFlash * .14); ctx.fillRect(0, 0, W, H); sealFlash -= .025 * dt;
    }
  }

  function tooltip(hovered) {
    if (!tip) return;
    if (!hovered) {
      tip.hidden = true; tip._id = null; tip.classList.remove('inscription'); canvas.style.cursor = 'default'; canvas._hit = null; return;
    }
    if (hovered.kind === 'inscription') {
      const info = hovered.card.info, rate = info.fee / Math.max(1, info.vsize);
      if (tip._id !== info.id) {
        tip._id = info.id; tip.classList.add('inscription');
        tip.innerHTML = '<img class="tip-media" src="' + info.url + '" alt="Bitcoin inscription preview">' +
          '<code>' + info.id.slice(0, 18) + '…</code>' +
          '<div class="tip-row"><span>MEDIA</span><b>' + info.mime + '</b></div>' +
          '<div class="tip-row"><span>ON-CHAIN</span><b>' + fmt.format(info.bytes) + ' bytes</b></div>' +
          '<div class="tip-row"><span>FEE RATE</span><b>' + rate.toFixed(2) + ' sat/vB</b></div>' +
          '<div class="tip-row"><span>STATUS</span><b>' + (info.confirmed ? 'confirmed' : 'unconfirmed') + '</b></div>' +
          '<u>click to open transaction</u>';
      }
      canvas._hit = info.txid;
    } else {
      const p = hovered.p;
      if (tip._id !== p.txid) {
        tip._id = p.txid; tip.classList.remove('inscription');
        tip.innerHTML = '<code>' + p.txid.slice(0, 18) + '…</code>' +
          '<div class="tip-row"><span>FEE RATE</span><b>' + p.fee.toFixed(1) + ' sat/vB</b></div>' +
          '<div class="tip-row"><span>WEIGHT</span><b>' + fmt.format(p.vsize) + ' vB</b></div>' +
          '<div class="tip-row"><span>VALUE</span><b>' + (p.value / 1e8).toFixed(4) + ' BTC</b></div>' +
          '<div class="tip-row"><span>DESTINATION</span><b>' + (feeBand(p.fee) >= 0 ? 'block ' + (feeBand(p.fee) + 1) : 'waiting') + '</b></div>' +
          '<u>click to open transaction</u>';
      }
      canvas._hit = p.txid;
    }
    tip.hidden = false;
    let x = hovered.x + 16; if (x > W - 226) x = hovered.x - 226;
    tip.style.left = clamp(x, 4, W - 220) + 'px';
    tip.style.top = clamp(hovered.y - 30, 4, H - (hovered.kind === 'inscription' ? 238 : 120)) + 'px';
    canvas.style.cursor = 'pointer';
  }

  function frame(time) {
    const dt = Math.min(2.2, (time - lastTime) / 16.67 || 1); lastTime = time;
    ctx.clearRect(0, 0, W, H);
    drawProfile(); drawArena(time); drawAxis(); drawFeeGates(time);
    updateFighters(dt, time);
    let hovered = updateParticles(dt, time);
    fighters.forEach((fighter, index) => drawFighter(fighter, index, time));
    hovered = updateCards(dt, time, hovered);
    drawEffects(dt); tooltip(hovered);
    requestAnimationFrame(frame);
  }

  canvas.addEventListener('mousemove', (event) => {
    const rect = canvas.getBoundingClientRect();
    pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top, active: true };
  });
  canvas.addEventListener('mouseleave', () => { pointer.active = false; if (tip) tip.hidden = true; canvas._hit = null; });
  canvas.addEventListener('click', () => {
    if (canvas._hit) window.open(explorerBase() + '/tx/' + canvas._hit, '_blank', 'noopener,noreferrer');
  });

  resize();
  window.addEventListener('resize', resize);
  requestAnimationFrame(frame);
  window.__field = {
    ingest,
    addInscription,
    seal() {
      sealFlash = 1;
      fighters.forEach((fighter, index) => { fighter.hit = 1; burst(fighter.x, fighter.y, colors[index], 20); });
    }
  };
}

/* ---------- websocket ---------- */
function connectSocket() {
  let socket;
  try {
    socket = new WebSocket(wsUrl());
    socket.addEventListener('open', () => { setText('syncAge', 'STREAM OPEN'); socket.send(JSON.stringify({ action: 'want', data: ['blocks', 'mempool-blocks', 'stats'] })); });
    socket.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.block || m.blocks || m['mempool-blocks'] || m.mempoolInfo) loadLiveData({ quiet: true }); });
    socket.addEventListener('close', () => { setText('syncAge', 'POLLING'); setTimeout(connectSocket, 5000); });
    socket.addEventListener('error', () => socket.close());
  } catch (e) { setText('syncAge', 'POLLING'); }
}

/* ---------- interactions ---------- */
function applySource(base) {
  source.base = normalizeBase(base) || PUBLIC_API;
  source.custom = source.base !== PUBLIC_API; source.degraded = false;
  persistSource(source.base); renderSourceBadge();
  state.height = null; loadLiveData(); connectSocket();
}
function initInteractions() {
  $('infoToggle').addEventListener('click', () => $('infoDialog').showModal());
  $('closeInfo').addEventListener('click', () => $('infoDialog').close());
  $('gotIt').addEventListener('click', () => $('infoDialog').close());
  $('pauseBattle').addEventListener('click', (e) => { state.paused = !state.paused; e.currentTarget.textContent = state.paused ? '▶' : 'Ⅱ'; });
  $('soundToggle').addEventListener('click', (e) => { const on = e.currentTarget.classList.toggle('on'); state.sound = on; e.currentTarget.title = on ? 'Event sound armed' : 'Event sound off'; if (on) playTone(330); });
  const dialog = $('nodeDialog');
  $('nodeBadge').addEventListener('click', () => { $('nodeInput').value = source.custom ? explorerBase() : ''; dialog.showModal(); });
  $('closeNode').addEventListener('click', () => dialog.close());
  $('useNode').addEventListener('click', () => { const v = $('nodeInput').value.trim(); if (!v) { $('nodeHint').textContent = 'Enter your node URL first — e.g. https://mempool.your-start9.local'; return; } dialog.close(); applySource(v); });
  $('usePublic').addEventListener('click', () => { dialog.close(); applySource(PUBLIC_API); });
  const inscriptionDialog = $('inscriptionDialog');
  $('inscriptionRadar').addEventListener('click', () => inscriptionDialog.showModal());
  $('closeInscription').addEventListener('click', () => inscriptionDialog.close());
  $('trackInscription').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true; button.textContent = 'SCANNING WITNESS…';
    const acquired = await loadInscriptionTx($('inscriptionInput').value);
    button.disabled = false; button.textContent = acquired ? 'INSCRIPTION IN THE FIELD' : 'TRY ANOTHER TRANSACTION';
  });
  $('inscriptionInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); $('trackInscription').click(); }
  });
}

setInterval(() => { if (state.syncedAt) setText('syncAge', Math.floor((Date.now() - state.syncedAt) / 1000) + 'S AGO'); }, 1000);

renderSourceBadge();
initInteractions();
createBlockWar();
loadLiveData();
loadInscriptionTx(FEATURED_TXID);
connectSocket();
setInterval(() => loadLiveData({ quiet: true }), 8000);
