function matches(content) {
  return query === '' || content.includes(query);
}

function isNewer(a, b) {
  return a.t !== b.t ? a.t > b.t : a.id > b.id;
}

function buildElement(item) {
  const el = document.createElement('div');
  el.className = 'msg entering';
  el.dataset.id = item.id;
  el.tabIndex = 0;

  const textEl = document.createElement('span');
  textEl.className = 'msg-text';
  el.append(textEl);
  item.textEl = textEl;
  item.preview = null;
  const chars = Array.from(item.content); // 이모지 등 서로게이트 쌍이 잘리지 않도록
  if (chars.length > PREVIEW_CHARS) {
    item.preview = chars.slice(0, PREVIEW_CHARS).join('') + '…';
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'more';
    more.textContent = '더보기';
    el.append(more);
    item.moreEl = more;
  }
  renderText(item);

  const reactEl = document.createElement('div');
  reactEl.className = 'reactions';

  const timeEl = document.createElement('time');
  timeEl.className = 'time';
  timeEl.dateTime = new Date(item.t).toISOString();
  timeEl.textContent = formatTime(item.t);

  const foot = document.createElement('div');
  foot.className = 'msg-foot';
  foot.append(reactEl, timeEl);
  el.append(foot);
  el.style.backgroundColor = COLORS[item.color];

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'del';
  del.textContent = '×';
  del.setAttribute('aria-label', '메시지 삭제');
  el.append(del);

  item.el = el;
  item.reactEl = reactEl;
}

// 라벨 부착 각도: 메시지 id + 순번으로 정해지는 의사 난수 (재렌더링해도 각도 유지)
// 크기 1.5°~5°, 방향 ±로 리듬감 부여
function tiltFor(seed) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h >>>= 0;
  const magnitude = 1.5 + ((h % 1000) / 999) * 3.5;
  return (h & 0x10000 ? 1 : -1) * magnitude;
}

// 메시지 본문: 평소엔 긴 글을 미리보기 + 더보기, 검색 중엔 전체 본문 + 검색어 라벨 강조
function renderText(item) {
  const t = item.textEl;
  t.textContent = '';
  if (query && item.content.includes(query)) {
    item.content.split(query).forEach((part, i) => {
      if (i > 0) {
        const mark = document.createElement('mark');
        mark.className = 'label';
        mark.textContent = query;
        mark.style.setProperty('--tilt', `${tiltFor(`${item.id}:${i}`).toFixed(2)}deg`);
        t.append(mark);
      }
      if (part) t.append(part);
    });
    if (item.moreEl) item.moreEl.hidden = true;
  } else {
    t.textContent = item.preview ?? item.content;
    if (item.moreEl) item.moreEl.hidden = false;
  }
}

// 감정표현 줄: 평소엔 카운트가 있는 것만, 선택 시엔 전체 이모지 표시
function renderReactions(item) {
  const mine = isSafeId(item.id) && Object.hasOwn(reacted, item.id) ? reacted[item.id] : [];
  const selected = item.id === selectedId;
  item.reactEl.textContent = '';
  item.total = 0;
  for (const [key, emoji] of REACTIONS) {
    const n = item.reactions[key] || 0;
    item.total += n;
    if (!selected && n === 0) continue;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = mine.includes(key) ? 'react on' : 'react';
    b.dataset.key = key;
    b.textContent = n ? `${emoji} ${n.toLocaleString('ko-KR')}` : emoji;
    b.setAttribute('aria-label', `${emoji} ${n}`);
    item.reactEl.append(b);
  }
  item.reactEl.hidden = item.reactEl.childElementCount === 0;
  scheduleLayout();
}

function addMessage({ id, content, created_at, reactions, color }, pending = false) {
  if (!isSafeId(id) || typeof content !== 'string') return;
  if (!content.trim() || content.length > MAX_BOARD_CONTENT_CHARS || messages.has(id)) return;
  const item = {
    id, content, pending,
    t: parseTimestampMs(created_at),
    color: colorOf(color),
    reactions: normalizeReactions(reactions),
    total: 0,
  };
  buildElement(item);
  item.el.hidden = !matches(content);
  renderReactions(item);

  let lo = 0, hi = order.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (isNewer(order[mid], item)) lo = mid + 1; else hi = mid;
  }
  stack.insertBefore(item.el, order[lo] ? order[lo].el : null);
  order.splice(lo, 0, item);
  messages.set(id, item);
  scheduleLayout();
}

// 이미 있는 메시지면 감정표현만 갱신, 없으면 추가
function upsertRow(row) {
  const item = row && messages.get(row.id);
  if (!item) { addMessage(row || {}); return; }
  item.reactions = normalizeReactions(row.reactions);
  renderReactions(item);
}

function removeMessage(id) {
  if (!isSafeId(id)) return;
  const item = messages.get(id);
  if (!item) return;
  item.el.remove();
  order.splice(order.indexOf(item), 1);
  messages.delete(id);
  if (selectedId === id) selectedId = null;
  if (capSelected.has(id)) { capSelected.delete(id); updateCapUI(); }
  if (deleteTarget === id && deleteDialog.open) deleteDialog.close();
  if (Object.hasOwn(reacted, id)) setReacted(id, new Set());
  scheduleLayout();
}

function select(id) {
  const prev = selectedId && messages.get(selectedId);
  selectedId = id;
  if (prev) { prev.el.classList.remove('selected'); renderReactions(prev); }
  const next = id && messages.get(id);
  if (next) { next.el.classList.add('selected'); renderReactions(next); }
}

// ── 패킹 레이아웃 (Skyline Bottom-Left) ──
// 각 박스를 "가장 위쪽, 같은 높이면 가장 왼쪽"의 들어갈 수 있는 자리에 배치해
// 크기가 제각각인 박스 사이의 빈 공간을 최소화한다.
let layoutQueued = false;
function scheduleLayout() {
  if (layoutQueued) return;
  layoutQueued = true;
  requestAnimationFrame(() => { layoutQueued = false; layout(); });
}

// skyline: x 오름차순의 겹치지 않는 구간 [{ x, w, y }] (y = 해당 구간의 현재 바닥선)
function raiseSkyline(sky, x, w, y) {
  const end = x + w;
  const out = [];
  for (const s of sky) {
    const sEnd = s.x + s.w;
    if (sEnd <= x || s.x >= end) { out.push(s); continue; }
    if (s.x < x) out.push({ x: s.x, w: x - s.x, y: s.y });
    if (sEnd > end) out.push({ x: end, w: sEnd - end, y: s.y });
  }
  out.push({ x, w, y });
  out.sort((a, b) => a.x - b.x);
  const merged = [];
  for (const s of out) {
    const p = merged[merged.length - 1];
    if (p && p.y === s.y && p.x + p.w === s.x) p.w += s.w;
    else merged.push({ ...s });
  }
  return merged;
}

function getSortedVisibleMessages(predicate = null) {
  const visible = order.filter((m) => !m.el.hidden && (!predicate || predicate(m)));
  if (sortMode === 'likes') {
    visible.sort((a, b) => (b.total - a.total) || (isNewer(a, b) ? -1 : 1));
  }
  return visible;
}

function packBoxes(sizes, { width, gap, singleColumn = false }) {
  let sky = [{ x: 0, w: width, y: 0 }];
  let height = 0;
  let columnY = 0;
  const positions = sizes.map(([w, h]) => {
    if (singleColumn) {
      const p = { x: Math.max(0, (width - w) / 2), y: columnY };
      columnY += h + gap * 1.5;
      height = p.y + h;
      return p;
    }
    let best = null;
    for (let i = 0; i < sky.length; i++) {
      const x = sky[i].x;
      if (x + w > width + 0.5) break;
      let y = 0;
      for (let j = i; j < sky.length && sky[j].x < x + w; j++) y = Math.max(y, sky[j].y);
      if (!best || y < best.y) best = { x, y };
    }
    if (!best) best = { x: 0, y: Math.max(...sky.map((s) => s.y)) };
    sky = raiseSkyline(sky, best.x, Math.min(w + gap, width - best.x), best.y + h + gap);
    height = Math.max(height, best.y + h);
    return best;
  });
  return { positions, height };
}

function layout() {
  const W = stack.clientWidth;
  const gap = 8 * Number(scale.value);
  const visible = getSortedVisibleMessages();
  // 읽기 일괄 수행 (레이아웃 스래싱 방지)
  const sizes = visible.map((m) => [Math.min(m.el.offsetWidth, W), m.el.offsetHeight]);
  // 검색 중: 확대된 박스를 가운데 1열로 정렬
  const { positions: pos, height } = packBoxes(sizes, { width: W, gap, singleColumn: Boolean(query) });

  // 쓰기 일괄 수행: transform 변경 → CSS transition으로 부드럽게 이동
  const entering = [];
  visible.forEach((m, k) => {
    m.el.style.transform = `translate(${pos[k].x}px, ${pos[k].y}px)`;
    if (m.el.classList.contains('entering')) entering.push(m.el);
  });
  stack.style.height = `${height}px`;

  if (entering.length) {
    void stack.offsetHeight; // 첫 위치를 확정한 뒤 transition 활성화
    for (const el of entering) el.classList.remove('entering');
  }
}

new ResizeObserver(scheduleLayout).observe(board); // 창 크기·스크롤바 변화 시 재배치
if (document.fonts) {
  document.fonts.ready.then(scheduleLayout);
  document.fonts.addEventListener('loadingdone', scheduleLayout); // 손글씨 서체 지연 로드 후 재배치
}

// ── 이름 필터: DB 호출 없이 메모리 배열에서 includes() ──
// 한글은 최대 4자(가중치 3), 영어 및 외국어는 최대 12자(가중치 1) 제한 (IME 조합 중에는 자르지 않음)
const HANGUL_RE = /[\uAC00-\uD7A3\u3131-\u318E\u1100-\u11FF\uA960-\uA97F\uD7B0-\uD7FF]/;
let shareBtnTimer = 0;

function clampSearch(str) {
  let units = 0;
  let out = '';
  for (const ch of Array.from(str)) {
    const w = HANGUL_RE.test(ch) ? 3 : 1;
    if (units + w > 12) break;
    units += w;
    out += ch;
  }
  return out;
}
function syncUrlQuery(name) {
  try {
    const url = new URL(location.href);
    if (name) url.searchParams.set('name', name);
    else url.searchParams.delete('name');
    history.replaceState(null, '', url);
  } catch {}
}
function applySearch() {
  const clamped = clampSearch(search.value);
  if (clamped !== search.value) search.value = clamped;
  const next = search.value.trim();
  if (next === query) return;
  query = next;
  capEnterBtn.disabled = query === '';
  shareLinkBtn.disabled = query === '';
  if (!query && capturing) setCaptureMode(false);
  board.classList.toggle('searching', query !== '');
  for (const item of order) {
    item.el.hidden = !matches(item.content);
    renderText(item);
  }
  syncUrlQuery(query);
  board.scrollTop = 0;
  scheduleLayout();
}
search.addEventListener('input', (e) => { if (!e.isComposing) applySearch(); });
search.addEventListener('compositionend', applySearch);

// ── 내 응원함 전용 링크 복사 (?name=이름) ──
shareLinkBtn.addEventListener('click', async () => {
  if (!query) return;
  const shareUrl = new URL(location.href);
  shareUrl.searchParams.set('name', query);
  const linkStr = shareUrl.toString();
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(linkStr);
    } else {
      const ta = document.createElement('textarea');
      ta.value = linkStr;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.append(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    clearTimeout(shareBtnTimer);
    shareLinkBtn.textContent = '링크 복사됨 ✓';
    shareBtnTimer = setTimeout(() => { shareLinkBtn.textContent = '링크 복사'; }, 1800);
  } catch (err) {
    console.error('[board] 링크 복사 실패', err);
  }
});

// ── 정렬: 최신순 / 좋아요순 (감정표현 합계, 로드된 메시지 기준 인메모리 정렬) ──
document.querySelectorAll('.sort button').forEach((btn) => {
  btn.addEventListener('click', () => {
    sortMode = btn.dataset.sort;
    document.querySelectorAll('.sort button').forEach((b) => {
      b.setAttribute('aria-pressed', String(b === btn));
    });
    board.scrollTop = 0;
    scheduleLayout();
  });
});

// ── 크기 슬라이더: CSS 변수 하나로 전체 박스 일괄 조절 후 재배치 ──
scale.addEventListener('input', () => {
  document.documentElement.style.setProperty('--s', scale.value);
  scheduleLayout();
});

// ── 백엔드: Supabase(RPC + Broadcast) 또는 로컬 모드 ──
// 원격 이벤트: message(새 글) / delete(삭제) / react(감정표현 최신 카운트)

const LOCAL_PW_VERIFIER_RE = /^s256\$([0-9a-f]{32})\$([0-9a-f]{64})$/;
const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function utf8Bytes(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let cp = str.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < str.length) {
      const lo = str.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
        i++;
      }
    } else if (cp >= 0xd800 && cp <= 0xdfff) {
      cp = 0xfffd;
    }
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  }
  return new Uint8Array(out);
}

function sha256Bytes(msg) {
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const paddedLen = Math.ceil((msg.length + 9) / 64) * 64;
  const buf = new Uint8Array(paddedLen);
  buf.set(msg);
  buf[msg.length] = 0x80;
  const bitLen = msg.length * 8;
  const hi = Math.floor(bitLen / 0x100000000);
  const lo = bitLen >>> 0;
  buf[paddedLen - 8] = (hi >>> 24) & 0xff;
  buf[paddedLen - 7] = (hi >>> 16) & 0xff;
  buf[paddedLen - 6] = (hi >>> 8) & 0xff;
  buf[paddedLen - 5] = hi & 0xff;
  buf[paddedLen - 4] = (lo >>> 24) & 0xff;
  buf[paddedLen - 3] = (lo >>> 16) & 0xff;
  buf[paddedLen - 2] = (lo >>> 8) & 0xff;
  buf[paddedLen - 1] = lo & 0xff;
  const w = new Uint32Array(64);
  for (let off = 0; off < paddedLen; off += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = (buf[off + i * 4] << 24) | (buf[off + i * 4 + 1] << 16) | (buf[off + i * 4 + 2] << 8) | buf[off + i * 4 + 3];
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i++) {
    out[i * 4] = (H[i] >>> 24) & 0xff;
    out[i * 4 + 1] = (H[i] >>> 16) & 0xff;
    out[i * 4 + 2] = (H[i] >>> 8) & 0xff;
    out[i * 4 + 3] = H[i] & 0xff;
  }
  return out;
}

const bytesToHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function deriveLocalPwDigest(salt, pw) {
  const pwBytes = utf8Bytes(String(pw ?? ''));
  const block = new Uint8Array(salt.length + pwBytes.length);
  block.set(salt);
  block.set(pwBytes, salt.length);
  let digest = sha256Bytes(block);
  const roundBuf = new Uint8Array(salt.length + 32);
  roundBuf.set(salt);
  for (let i = 0; i < 255; i++) {
    roundBuf.set(digest, salt.length);
    digest = sha256Bytes(roundBuf);
  }
  return bytesToHex(digest);
}

function makeLocalPwVerifier(pw) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `s256$${bytesToHex(salt)}$${deriveLocalPwDigest(salt, pw)}`;
}

function verifyLocalPwVerifier(pw, stored) {
  if (typeof stored !== 'string') return false;
  const m = LOCAL_PW_VERIFIER_RE.exec(stored);
  if (!m) return false;
  const actual = deriveLocalPwDigest(hexToBytes(m[1]), pw);
  const expected = m[2];
  let diff = actual.length ^ expected.length;
  for (let i = 0; i < expected.length; i++) diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

function normalizeRemoteRow(payload) {
  if (!payload || !isSafeId(payload.id) || typeof payload.content !== 'string') return null;
  if (!payload.content.trim() || payload.content.length > MAX_BOARD_CONTENT_CHARS) return null;
  return {
    id: payload.id,
    content: payload.content,
    created_at: parseTimestampMs(payload.created_at),
    reactions: normalizeReactions(payload.reactions),
    color: colorOf(payload.color),
  };
}

async function verifyDbBroadcast(event, id) {
  if (!db || !isSafeId(id)) return;
  try {
    if (event === 'delete') {
      const { data, error } = await db.from('messages').select('id').eq('id', id).maybeSingle();
      if (!error && !data) removeMessage(id);
      return;
    }
    if (event === 'message') {
      const { data, error } = await db
        .from('messages')
        .select('id, content, created_at, reactions, color')
        .eq('id', id)
        .maybeSingle();
      if (!error && data) upsertRow(data);
      return;
    }
    if (event === 'react' && messages.has(id)) {
      const { data, error } = await db.from('messages').select('reactions').eq('id', id).maybeSingle();
      if (!error && data && messages.has(id)) {
        const item = messages.get(id);
        item.reactions = normalizeReactions(data.reactions);
        renderReactions(item);
      }
    }
  } catch {}
}

function onRemote(event, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
  if (capturing) {
    if (remoteQueue.length < 500) remoteQueue.push([event, payload]);
    return;
  }
  if (db) {
    if (event === 'message' || event === 'delete' || event === 'react') {
      void verifyDbBroadcast(event, payload.id);
    }
    return;
  }
  if (event === 'message') {
    const row = normalizeRemoteRow(payload);
    if (!row) return;
    if (typeof payload.pwHash === 'string' && LOCAL_PW_VERIFIER_RE.test(payload.pwHash)) {
      localPw.set(row.id, payload.pwHash);
    }
    upsertRow(row);
  } else if (event === 'delete') {
    if (isSafeId(payload.id)) removeMessage(payload.id);
  } else if (event === 'react') {
    if (!isSafeId(payload.id)) return;
    const item = messages.get(payload.id);
    if (!item) return;
    item.reactions = normalizeReactions(payload.reactions);
    renderReactions(item);
  }
}

let channel = null;
let localChannel = null;
const localPw = new Map(); // 로컬 모드 전용 (같은 브라우저 안에서만 사용)
let api;

if (db) {
  channel = db.channel('board', {
    config: { presence: { key: uuid() }, broadcast: { self: false } },
  });
  const send = (event, payload) => channel.send({ type: 'broadcast', event, payload });

  async function loadRecent() {
    const { data, error } = await db
      .from('messages')
      .select('id, content, created_at, reactions, color')
      .order('created_at', { ascending: false })
      .limit(INITIAL_LIMIT);
    if (error) { console.error('[board] 메시지 로드 실패', error); return; }
    for (const row of data) upsertRow(row);
  }

  channel
    .on('presence', { event: 'sync' }, () => {
      const count = Object.keys(channel.presenceState()).length;
      presenceEl.textContent = `접속 중 ${count.toLocaleString('ko-KR')}명`;
    })
    .on('broadcast', { event: 'message' }, ({ payload }) => onRemote('message', payload))
    .on('broadcast', { event: 'delete' }, ({ payload }) => onRemote('delete', payload))
    .on('broadcast', { event: 'react' }, ({ payload }) => onRemote('react', payload))
    .subscribe((status, err) => {
      if (status === 'SUBSCRIBED') {
        channel.track({});
        loadRecent(); // 최초 접속 및 재연결 시 누락분 보충
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        console.error('[board] 실시간 연결 오류', status, err);
      }
    });

  api = {
    async post(msg, pw) {
      const { data, error } = await db.rpc('post_message', {
        p_id: msg.id, p_content: msg.content, p_password: pw, p_color: msg.color,
      });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      send('message', row);
      return row;
    },
    async remove(id, pw) {
      const { data, error } = await db.rpc('delete_message', { p_id: id, p_password: pw });
      if (error) throw error;
      if (data === 'deleted') send('delete', { id });
      return data;
    },
    async react(id, key, delta) {
      const { data, error } = await db.rpc('react_message', { p_id: id, p_key: key, p_delta: delta });
      if (error) throw error;
      send('react', { id, reactions: data });
      return data;
    },
  };
} else {
  const LOCAL_STORE_KEY = 'board:localMessages:v2';
  const LOCAL_DELETED_KEY = 'board:deletedSeeds';
  // 기본 응원 메시지는 새로고침해도 시간이 새롭게 바뀌지 않도록 고정 시각 사용
  const SEED_BASE_MS = Date.parse('2026-11-11T18:00:00+09:00');
  // 수능 하루 전 시점 문구('내일')가 포함된 메시지는 삭제
  const SEED_MESSAGES = [
    {
      id: 'seed-02',
      color: 'butter',
      reactions: { love: 8, tear: 3 },
      content: '서연아 지우야 스카에서 맨날 같이 밤새우던 거 드디어 끝이네ㅠㅠ 긴장하지 말고 평소대로만 치고 와! 끝나고 인생네컷 찍으러 가자',
    },
    {
      id: 'seed-07',
      color: 'aqua',
      reactions: { cheer: 5, tear: 2 },
      content: '하윤아 남들이 뭐라 해도 네 페이스가 제일 중요해! 모르는 문제 나와도 멘탈 꽉 잡기!! 뒤에서 계속 응원할게',
    },
    {
      id: 'seed-09',
      color: 'lime',
      reactions: { love: 7, tear: 3 },
      content: '현우야 시험 하나가 인생 전부 아니니까 너무 쫄지 말고 편하게 보고 와! 끝나고 맛있는 거 먹으러 가자',
    },
    {
      id: 'seed-10',
      color: 'sand',
      reactions: { like: 4, fire: 6 },
      content: '유준아 우진아 1교시 조금 어렵게 나와도 "내가 어려우면 남들은 더 망했다" 마인드로 쿨하게 넘겨버려ㅋㅋ 화이팅!',
    },
    {
      id: 'seed-13',
      color: 'sky',
      reactions: { like: 5, love: 6 },
      content: '다은아 소율아 은서야 고3 내내 너네 덕분에 학교 버텼다 진짜ㅠㅠ 우리 셋 다 원하는 대학 붙어서 봄에 과잠 입고 만나자!!',
    },
    {
      id: 'seed-15',
      color: 'mint',
      reactions: { love: 8, like: 4 },
      content: '지민아 수빈아 점심 먹을 때 급하게 먹다가 체하지 말고 천천히 먹어! 탐구 시간까지 집중력 풀충전해서 대박 나자',
    },
    {
      id: 'seed-16',
      color: 'lavender',
      reactions: { cheer: 6, fire: 4 },
      content: '정우야 OMR 밀려 쓰지만 않으면 무조건 성공이다ㅋㅋ 검토할 때 처음 고른 답 괜히 바꾸지 말고 네 첫 느낌을 믿어!',
    },
    {
      id: 'seed-18',
      color: 'aqua',
      reactions: { love: 5, cheer: 5 },
      content: '지원아 현서야 날 추운데 패딩 따뜻하게 입고 핫팩 꼭 챙겨가! 손 시리면 문제 안 풀리니까 따뜻하게 하고 대박 나길',
    },
  ];
  const SEED_DEFAULT_VERIFIER = makeLocalPwVerifier('0000');
  const SEED_MESSAGES_READY = SEED_MESSAGES.map((m, idx) => ({
    ...m,
    created_at: new Date(SEED_BASE_MS - (10 - idx) * 60000).toISOString(),
    pwHash: SEED_DEFAULT_VERIFIER,
  }));

  function getDeletedSeeds() {
    try { return new Set(JSON.parse(localStorage.getItem(LOCAL_DELETED_KEY) || '[]')); }
    catch { return new Set(); }
  }
  function markSeedDeleted(id) {
    const delSet = getDeletedSeeds();
    delSet.add(id);
    try { localStorage.setItem(LOCAL_DELETED_KEY, JSON.stringify([...delSet])); } catch {}
  }
  function resolveRowVerifier(row) {
    if (typeof row?.pwHash === 'string' && LOCAL_PW_VERIFIER_RE.test(row.pwHash)) return row.pwHash;
    if (typeof row?.pw === 'string' && row.pw.length > 0) return makeLocalPwVerifier(row.pw);
    return SEED_DEFAULT_VERIFIER;
  }
  function saveLocalStore() {
    try {
      const dump = order.slice(0, INITIAL_LIMIT).map((m) => ({
        id: m.id,
        content: m.content,
        created_at: new Date(m.t).toISOString(),
        reactions: m.reactions,
        color: m.color,
        pwHash: localPw.get(m.id) || SEED_DEFAULT_VERIFIER,
      }));
      localStorage.setItem(LOCAL_STORE_KEY, JSON.stringify(dump));
    } catch {}
  }
  function loadLocalStore() {
    const delSet = getDeletedSeeds();
    let stored = [];
    try {
      // 이전 v1 캐시 정리
      const prevV1 = localStorage.getItem('board:localMessages');
      if (prevV1) localStorage.removeItem('board:localMessages');
      const parsed = JSON.parse(localStorage.getItem(LOCAL_STORE_KEY) || '[]');
      if (Array.isArray(parsed)) stored = parsed;
    } catch {}
    // 과거 기본 시드 중 '내일'이 포함되었던 시드 ID 목록만 제외 (사용자가 이후 작성할 '내일' 메시지는 정상 보존)
    const REMOVED_SEEDS = new Set([
      'seed-01', 'seed-03', 'seed-04', 'seed-05', 'seed-06',
      'seed-08', 'seed-11', 'seed-12', 'seed-14', 'seed-17',
      'seed-19', 'seed-20',
    ]);
    stored = stored.filter((r) => r && isSafeId(r.id) && !REMOVED_SEEDS.has(r.id));
    const storedMap = new Map(stored.map((r) => [r.id, r]));

    for (const seed of SEED_MESSAGES_READY) {
      if (delSet.has(seed.id)) continue;
      const prev = storedMap.get(seed.id);
      const row = prev
        ? { ...seed, created_at: seed.created_at, reactions: prev.reactions || seed.reactions }
        : seed;
      localPw.set(row.id, resolveRowVerifier(prev || seed));
      upsertRow(row);
      storedMap.delete(seed.id);
    }
    for (const row of storedMap.values()) {
      if (REMOVED_SEEDS.has(row.id)) continue;
      if (typeof row.content !== 'string' || !row.content.trim() || row.content.length > MAX_BOARD_CONTENT_CHARS) continue;
      localPw.set(row.id, resolveRowVerifier(row));
      upsertRow(row);
    }
  }
  loadLocalStore();

  if ('BroadcastChannel' in window) {
    localChannel = new BroadcastChannel('suneung-board');
    localChannel.onmessage = (e) => onRemote(e.data?.event, e.data?.payload);
  }
  const send = (event, payload) => localChannel && localChannel.postMessage({ event, payload });
  api = {
    async post(msg, pw) {
      const pwHash = makeLocalPwVerifier(pw);
      localPw.set(msg.id, pwHash);
      const row = { id: msg.id, content: msg.content, created_at: msg.created_at, reactions: {}, color: msg.color };
      saveLocalStore();
      send('message', { ...row, pwHash });
      return row;
    },
    async remove(id, pw) {
      if (!isSafeId(id) || !messages.has(id)) return 'not_found';
      if (!verifyLocalPwVerifier(pw, localPw.get(id))) return 'wrong_password';
      localPw.delete(id);
      if (id.startsWith('seed-')) markSeedDeleted(id);
      // 삭제 확정 후 저장소에도 반영되도록 지연 저장
      setTimeout(saveLocalStore, 0);
      send('delete', { id });
      return 'deleted';
    },
    async react(id, key, delta, prev) {
      const r = { ...prev, [key]: Math.max(0, (prev[key] || 0) + delta) };
      setTimeout(saveLocalStore, 0);
      send('react', { id, reactions: r });
      return r;
    },
  };
}

// ── 공유 링크(?name=이름)로 접속 시 자동으로 검색어 적용 ──
try {
  const initialName = new URLSearchParams(location.search).get('name');
  if (initialName && initialName.trim()) {
    search.value = initialName.trim();
    applySearch();
  }
} catch {}

// ── 메시지 클릭: 선택(삭제 버튼 + 감정표현 표시) / 더보기 / 감정표현 / 삭제 / 캡쳐 선택 ──
stack.addEventListener('click', (e) => {
  const el = e.target.closest('.msg');
  const item = el && messages.get(el.dataset.id);
  if (!item) return;
  if (capturing) return toggleCapSelect(item);
  const btn = e.target.closest('button');
  if (btn && btn.classList.contains('del')) return openDelete(item);
  if (btn && btn.classList.contains('more')) return openView(item);
  if (btn && btn.classList.contains('react')) return toggleReaction(item, btn.dataset.key);
  select(selectedId === item.id ? null : item.id);
});
stack.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('msg')) {
    e.preventDefault();
    const id = e.target.dataset.id;
    if (capturing) {
      const item = messages.get(id);
      if (item) toggleCapSelect(item);
      return;
    }
    select(selectedId === id ? null : id);
  }
});
document.addEventListener('click', (e) => {
  if (selectedId && !e.target.closest('.msg') && !e.target.closest('dialog')) select(null);
});

// ── 감정표현: 낙관적 반영 → 서버 확정 카운트로 교체, 실패 시 롤백 ──
async function toggleReaction(item, key) {
  if (item.pending || !REACTION_KEYS.has(key)) return;
  const mine = new Set(Object.hasOwn(reacted, item.id) ? reacted[item.id] : []);
  const delta = mine.has(key) ? -1 : 1;
  const prev = item.reactions;
  item.reactions = { ...prev, [key]: Math.max(0, (prev[key] || 0) + delta) };
  if (delta > 0) mine.add(key); else mine.delete(key);
  setReacted(item.id, mine);
  renderReactions(item);
  try {
    const counts = await api.react(item.id, key, delta, prev);
    if (messages.has(item.id)) {
      item.reactions = normalizeReactions(counts);
      renderReactions(item);
    }
  } catch (err) {
    if (delta > 0) mine.delete(key); else mine.add(key);
    setReacted(item.id, mine);
    if (messages.has(item.id)) { item.reactions = prev; renderReactions(item); }
    console.error('[board] 감정표현 실패', err);
  }
}

// ── 더보기 팝업 ──
function openView(item) {
  viewText.textContent = item.content;
  viewDialog.style.backgroundColor = COLORS[item.color]; // 원래 박스와 같은 배경색
  viewDialog.showModal();
}
$('viewClose').addEventListener('click', () => viewDialog.close());

// ── 삭제: 암호 확인 팝업 ──
let deleteTarget = null;
function openDelete(item) {
  if (item.pending) return;
  deleteTarget = item.id;
  deletePw.value = '';
  deleteError.hidden = true;
  deleteDialog.showModal();
  deletePw.focus();
}
$('deleteCancel').addEventListener('click', () => deleteDialog.close());
deleteDialog.addEventListener('close', () => { deleteTarget = null; });

deleteForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = deleteTarget;
  if (!id) return;
  deleteSubmit.disabled = true;
  try {
    const result = await api.remove(id, deletePw.value);
    if (result === 'deleted' || result === 'not_found') {
      deleteDialog.close();
      removeMessage(id);
      return;
    }
    deleteError.textContent = result === 'locked'
      ? '암호를 여러 번 틀려 10분간 삭제할 수 없습니다.'
      : '암호가 일치하지 않습니다.';
    deleteError.hidden = false;
    deletePw.select();
  } catch (err) {
    deleteError.textContent = '삭제 중 오류가 발생했습니다. 다시 시도해 주세요.';
    deleteError.hidden = false;
    console.error('[board] 삭제 실패', err);
  } finally {
    deleteSubmit.disabled = false;
  }
});

// 팝업 바깥(배경) 클릭 시 닫기
for (const dlg of [viewDialog, deleteDialog]) {
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
}

// ── 배경 컬러 선택 (마지막 선택을 브라우저에 기억) ──
const colorBtn = $('colorBtn'), palette = $('palette');
let currentColor = 'white';
try { currentColor = colorOf(localStorage.getItem('board:color')); } catch {}

function setColor(key) {
  currentColor = colorOf(key);
  colorBtn.style.backgroundColor = COLORS[currentColor];
  for (const b of palette.children) b.setAttribute('aria-checked', String(b.dataset.color === currentColor));
  try { localStorage.setItem('board:color', currentColor); } catch {}
}
function togglePalette(open) {
  palette.hidden = !open;
  colorBtn.setAttribute('aria-expanded', String(open));
}
for (const [key, hex] of Object.entries(COLORS)) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'swatch';
  b.dataset.color = key;
  b.style.backgroundColor = hex;
  b.setAttribute('role', 'radio');
  b.setAttribute('aria-label', key);
  palette.append(b);
}
setColor(currentColor);
colorBtn.addEventListener('click', () => togglePalette(palette.hidden));
palette.addEventListener('click', (e) => {
  const b = e.target.closest('.swatch');
  if (!b) return;
  setColor(b.dataset.color);
  togglePalette(false);
  text.focus();
});
document.addEventListener('click', (e) => {
  if (!palette.hidden && !e.target.closest('#palette, #colorBtn')) togglePalette(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !palette.hidden) togglePalette(false);
});

// ── 입력창 자동 높이 조절 (최대 4줄까지 확장, Enter로 전송 / Shift+Enter로 줄바꿈) ──
function resizeComposerText() {
  text.style.height = 'auto';
  const maxH = 108; // 4줄 높이 (줄높이 약 21.75px * 4 + 상하 패딩 20px)
  const nextH = Math.max(42, Math.min(text.scrollHeight, maxH));
  text.style.height = `${nextH}px`;
  text.style.overflowY = text.scrollHeight > maxH ? 'auto' : 'hidden';
}
text.addEventListener('input', resizeComposerText);
text.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    form.requestSubmit();
  }
});

// ── 전송: 낙관적 업데이트 (암호는 서버에서 해시 저장) ──
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const content = text.value.trim();
  const pw = pwInput.value;
  if (!content) return;
  if (pw.length < 4) { pwInput.reportValidity(); return; }

  const msg = { id: uuid(), content, created_at: new Date().toISOString(), reactions: {}, color: currentColor };
  addMessage(msg, true); // 즉시 상단 좌측에 표시
  text.value = '';
  resizeComposerText();
  if (sortMode === 'latest') board.scrollTop = 0;

  try {
    const row = await api.post(msg, pw);
    const item = messages.get(msg.id);
    if (item) item.pending = false;
    upsertRow(row);
  } catch (err) {
    removeMessage(msg.id); // 실패 시 롤백하고 입력 내용 복원
    if (!text.value) {
      text.value = content;
      resizeComposerText();
    }
    console.error('[board] 전송 실패', err);
  }
});

// ── 상단 가장 우측 아이콘 + 드롭다운 메뉴 (응원 보드 / 실시간 채팅 / 모의 타이머) ──
const chatPage = $('chatPage'), timerPage = $('timerPage');
const searchLabelWrap = $('searchLabelWrap'), pageHeading = $('pageHeading'), boardTools = $('boardTools');
const menuWrap = $('menuWrap'), menuBtn = $('menuBtn'), menuDropdown = $('menuDropdown');
const menuItems = Array.from(document.querySelectorAll('.menu-item'));
let currentPage = 'board';

function toggleMenu(open) {
  const next = typeof open === 'boolean' ? open : menuDropdown.hidden;
  menuDropdown.hidden = !next;
  menuBtn.setAttribute('aria-expanded', String(next));
}

function switchPage(page) {
  if (!['board', 'chat', 'timer'].includes(page)) page = 'board';
  if (capturing && page !== 'board') setCaptureMode(false);
  currentPage = page;

  for (const item of menuItems) {
    item.setAttribute('aria-checked', String(item.dataset.page === page));
  }
  toggleMenu(false);

  const isBoard = page === 'board';
  board.hidden = !isBoard;
  scale.hidden = !isBoard;
  form.hidden = !isBoard;
  searchLabelWrap.hidden = !isBoard;
  boardTools.hidden = !isBoard;

  chatPage.hidden = page !== 'chat';
  timerPage.hidden = page !== 'timer';

  if (isBoard) {
    pageHeading.hidden = true;
    scheduleLayout();
  } else {
    pageHeading.hidden = false;
    pageHeading.textContent = page === 'chat' ? '실시간 채팅' : '모의 시험 시간 타이머';
  }
}

menuBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleMenu();
});
menuItems.forEach((item) => {
  item.addEventListener('click', () => switchPage(item.dataset.page));
});
document.addEventListener('click', (e) => {
  if (!menuDropdown.hidden && !menuWrap.contains(e.target)) toggleMenu(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !menuDropdown.hidden) toggleMenu(false);
});

// ── 사용법 안내 팝업: 접속 시 자동 표시 ('오늘 하루 안 보기' 선택 시 당일 동안만 숨김) ──
const GUIDE_HIDE_DATE_KEY = 'board:guideHideDate';
const guideDialog = $('guideDialog');

function getGuideTodayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function openGuide() {
  if (!guideDialog.open) guideDialog.showModal();
}

guideDialog.addEventListener('click', (e) => { if (e.target === guideDialog) guideDialog.close(); });
$('guideClose').addEventListener('click', () => guideDialog.close());
$('guideHideToday').addEventListener('click', () => {
  try { localStorage.setItem(GUIDE_HIDE_DATE_KEY, getGuideTodayKey()); } catch {}
  guideDialog.close();
});
$('guideOpenBtn').addEventListener('click', () => {
  toggleMenu(false);
  openGuide();
});

let hideGuideToday = false;
try {
  localStorage.removeItem('board:guideSeen');
  hideGuideToday = localStorage.getItem(GUIDE_HIDE_DATE_KEY) === getGuideTodayKey();
} catch {}
if (!hideGuideToday) openGuide();
