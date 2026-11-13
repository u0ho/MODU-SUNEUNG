// ── 설정: Supabase 프로젝트 값으로 교체 ──
const SUPABASE_URL = 'https://etszdzaxuepohcxgcwqf.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_dphBR5bEFviL4j1gtTxmgQ_dik7gKKZ';
const INITIAL_LIMIT = 300;  // 접속 시 로드할 최신 메시지 수
const PREVIEW_CHARS = 100;  // 이 길이를 넘으면 박스에는 일부만 보이고 '더보기'로 전체 보기
const MAX_BOARD_CONTENT_CHARS = 500;
const MAX_REACTION_COUNT = 999999999;
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const isSafeId = (id) =>
  typeof id === 'string' && SAFE_ID_RE.test(id) && id !== '__proto__' && !Object.prototype[id];

function parseTimestampMs(raw, fallback = Date.now()) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : fallback;
  if (typeof raw !== 'string') return fallback;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// 감정표현 (키는 DB 함수 react_message의 허용 목록과 동일해야 함)
const REACTIONS = [['like', '👍'], ['love', '❤️'], ['cheer', '💪'], ['fire', '🔥'], ['tear', '🥹']];
const REACTION_KEYS = new Set(REACTIONS.map(([k]) => k));

// 메시지 배경 컬러: 기본(흰색) + 연한 파스텔 10종 (키는 DB 체크 제약과 동일해야 함)
const COLORS = {
  white: '#FFFFFF',
  rose: '#FFE4E6', peach: '#FFE8D6', butter: '#FFF5CC', lime: '#ECF8D0', mint: '#D9F5E5',
  aqua: '#D6F3F3', sky: '#DCEEFF', periwinkle: '#E3E6FF', lavender: '#EEE5FF', sand: '#F3ECE2',
};
const colorOf = (key) => (Object.hasOwn(COLORS, key) ? key : 'white');

const pad2 = (n) => String(n).padStart(2, '0');
function formatTime(t) {
  const d = new Date(t);
  return `${d.getMonth() + 1}.${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// 설정 전이거나 CDN 로드 실패 시에도 화면 동작이 멈추지 않도록 로컬 모드로 동작
const configured = !SUPABASE_URL.includes('YOUR-PROJECT') && !SUPABASE_ANON_KEY.startsWith('YOUR-');
const sanitizedUrl = SUPABASE_URL.replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, '');
const db = configured && window.supabase
  ? window.supabase.createClient(sanitizedUrl, SUPABASE_ANON_KEY)
  : null;
if (!db) console.warn('[board] Supabase 미설정 → 로컬 모드 (같은 브라우저 탭 간에만 실시간 공유)');

const $ = (id) => document.getElementById(id);
const board = $('board'), stack = $('stack'), search = $('search'), scale = $('scale');
const form = $('composer'), text = $('text'), pwInput = $('pw'), presenceEl = $('presence');
const viewDialog = $('viewDialog'), viewText = $('viewText');
const deleteDialog = $('deleteDialog'), deleteForm = $('deleteForm'), deletePw = $('deletePw');
const deleteError = $('deleteError'), deleteSubmit = $('deleteSubmit');

// crypto.randomUUID는 HTTPS/localhost에서만 제공되므로 대체 구현 포함
function uuid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// 서버/브로드캐스트에서 온 감정표현 값은 허용 키 + 1..MAX_REACTION_COUNT 유한 정수만 남긴다
function normalizeReactions(raw) {
  const out = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const key of REACTION_KEYS) {
      if (!Object.hasOwn(raw, key)) continue;
      const v = Number(raw[key]);
      if (Number.isFinite(v) && v >= 1) {
        out[key] = Math.min(Math.floor(v), MAX_REACTION_COUNT);
      }
    }
  }
  return out;
}

// 내가 누른 감정표현 (브라우저에 저장, 프로토타입 키 조회 차단을 위해 null-prototype 객체 사용)
function loadReacted() {
  const map = Object.create(null);
  try {
    const parsed = JSON.parse(localStorage.getItem('board:reacted'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [id, keys] of Object.entries(parsed)) {
        if (!isSafeId(id) || !Array.isArray(keys)) continue;
        const cleanKeys = keys.filter((k) => REACTION_KEYS.has(k));
        if (cleanKeys.length) map[id] = cleanKeys;
      }
    }
  } catch {}
  return map;
}
let reacted = loadReacted();
function setReacted(id, set) {
  if (!isSafeId(id)) return;
  if (set.size) reacted[id] = [...set]; else delete reacted[id];
  try { localStorage.setItem('board:reacted', JSON.stringify(reacted)); } catch {}
}

const shareLinkBtn = $('shareLinkBtn');
const capEnterBtn = $('capEnterBtn'), capActions = $('capActions');
const capSaveBtn = $('capSaveBtn'), capStoryBtn = $('capStoryBtn'), capCancelBtn = $('capCancelBtn');

// ── 공유 인메모리 상태 ──
const messages = new Map();
const order = [];
let query = '';
let sortMode = 'latest';
let selectedId = null;
let capturing = false;
const capSelected = new Set();
const remoteQueue = [];

// ── 수능 D-day 시계 (11월 19일 오전 00시 KST 기준) ──
const suneungYear = new Date().getFullYear();
const TARGET_DDAY = Date.parse(`${suneungYear}-11-19T00:00:00+09:00`);
const ddayDigits = Array.from(document.querySelectorAll('#ddayClock .flip-digit'));
let clockInitialized = false;

function updateClocks() {
  const diff = Math.max(0, TARGET_DDAY - Date.now());
  const days = pad2(Math.min(99, Math.floor(diff / 86400000)));
  const hours = pad2(Math.floor((diff % 86400000) / 3600000));
  const minutes = pad2(Math.floor((diff % 3600000) / 60000));
  const next = `${days}${hours}${minutes}`;
  ddayDigits.forEach((el, i) => {
    if (el.textContent !== next[i]) {
      el.textContent = next[i];
      if (clockInitialized) {
        el.classList.remove('flipping');
        void el.offsetWidth;
        el.classList.add('flipping');
      }
    }
  });
  clockInitialized = true;
}
updateClocks();
setInterval(updateClocks, 1000);
