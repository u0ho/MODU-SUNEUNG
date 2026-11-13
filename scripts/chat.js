// ── 1. (수능시험) 영역별 실시간 익명채팅방 (22개 채널, 정원 제한 및 인원 표기) ──
const CHAT_ROOMS = [
  { id: 'all', name: '전체 채팅방', max: 1000 },
  { id: 'kor', name: '국어영역 채팅방', max: 100 },
  { id: 'math', name: '수학영역 채팅방', max: 100 },
  { id: 'eng', name: '영어영역 채팅방', max: 100 },
  { id: 'hist', name: '한국사 채팅방', max: 100 },
  { id: 'eth-life', name: '생활과 윤리 채팅방', max: 100 },
  { id: 'eth-thought', name: '윤리와 사상 채팅방', max: 100 },
  { id: 'geo-kor', name: '한국지리 채팅방', max: 100 },
  { id: 'geo-world', name: '세계지리 채팅방', max: 100 },
  { id: 'hist-ea', name: '동아시아사 채팅방', max: 100 },
  { id: 'hist-world', name: '세계사 채팅방', max: 100 },
  { id: 'pol-law', name: '정치와 법 채팅방', max: 100 },
  { id: 'econ', name: '경제 채팅방', max: 100 },
  { id: 'soc-cul', name: '사회 문화 채팅방', max: 100 },
  { id: 'phy1', name: '물리1 채팅방', max: 100 },
  { id: 'chem1', name: '화학1 채팅방', max: 100 },
  { id: 'bio1', name: '생명1 채팅방', max: 100 },
  { id: 'earth1', name: '지구1 채팅방', max: 100 },
  { id: 'phy2', name: '물리2 채팅방', max: 100 },
  { id: 'chem2', name: '화학2 채팅방', max: 100 },
  { id: 'bio2', name: '생명2 채팅방', max: 100 },
  { id: 'earth2', name: '지구2 채팅방', max: 100 },
];

const CHAT_STORE_KEY = 'board:subjectChats:v2';
const CHAT_NICK_KEY = 'board:chatNick';
const CHAT_PEERS_KEY = 'board:chatPeers';
const CHAT_MINE_KEY = 'board:chatMineIds:v1';
const MAX_CHAT_AUTHOR_CHARS = 32;
const MAX_CHAT_TEXT_CHARS = 300;
const MAX_CHAT_HISTORY = 100;
const MAX_CHAT_MINE_IDS = 200;
const roomListEl = $('roomList');
const chatRoomTitle = $('chatRoomTitle');
const chatRoomCount = $('chatRoomCount');
const chatMyNick = $('chatMyNick');
const chatLog = $('chatLog');
const chatForm = $('chatForm');
const chatInput = $('chatInput');

const myClientId = uuid();
let myNick = '';
try { myNick = localStorage.getItem(CHAT_NICK_KEY) || ''; } catch {}
if (!myNick) {
  myNick = `수험생#${Math.floor(100 + Math.random() * 900)}`;
  try { localStorage.setItem(CHAT_NICK_KEY, myNick); } catch {}
}
chatMyNick.textContent = `내 익명 이름: ${myNick}`;

let currentRoomId = 'all';
const chatMessagesByRoom = new Map();
const roomCounts = new Map();
const localSentChatIds = new Set();

function loadLocalSentChatIds() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CHAT_MINE_KEY) || '[]');
    if (Array.isArray(parsed)) {
      for (const id of parsed.slice(-MAX_CHAT_MINE_IDS)) {
        if (isSafeId(id)) localSentChatIds.add(id);
      }
    }
  } catch {}
}

function markChatMessageMine(id) {
  if (!isSafeId(id)) return;
  localSentChatIds.add(id);
  while (localSentChatIds.size > MAX_CHAT_MINE_IDS) {
    const oldest = localSentChatIds.values().next().value;
    localSentChatIds.delete(oldest);
  }
  try { localStorage.setItem(CHAT_MINE_KEY, JSON.stringify([...localSentChatIds])); } catch {}
}

function normalizeChatMessage(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!isSafeId(raw.id) || typeof raw.author !== 'string' || typeof raw.text !== 'string') return null;
  const author = raw.author.trim();
  const text = raw.text.trim();
  if (!author || author.length > MAX_CHAT_AUTHOR_CHARS) return null;
  if (!text || text.length > MAX_CHAT_TEXT_CHARS) return null;
  const parsedTime = typeof raw.time === 'string' ? Date.parse(raw.time) : NaN;
  if (!Number.isFinite(parsedTime)) return null;
  return {
    id: raw.id,
    author,
    text,
    time: new Date(parsedTime).toISOString(),
  };
}

loadLocalSentChatIds();

// 이전 버전 기본 채팅 캐시 정리 후 저장된 채팅 기록 불러오기 (기본 채팅 없음)
try { localStorage.removeItem('board:subjectChats:v1'); } catch {}
let savedChatObj = {};
try { savedChatObj = JSON.parse(localStorage.getItem(CHAT_STORE_KEY) || '{}') || {}; } catch {}
for (const r of CHAT_ROOMS) {
  const list = Array.isArray(savedChatObj[r.id])
    ? savedChatObj[r.id]
      .filter((m) => m && !String(m.id || '').startsWith('chat-seed-'))
      .map(normalizeChatMessage)
      .filter(Boolean)
      .slice(-MAX_CHAT_HISTORY)
    : [];
  chatMessagesByRoom.set(r.id, list);
  roomCounts.set(r.id, r.id === 'all' ? 1 : 0);
}

function saveChatStore() {
  try {
    const out = {};
    for (const [rid, arr] of chatMessagesByRoom) {
      out[rid] = arr.slice(-100);
    }
    localStorage.setItem(CHAT_STORE_KEY, JSON.stringify(out));
  } catch {}
}

// 로컬 탭 간 참여 중인 방 현황 동기화 + Supabase 실시간 채널 연동
function readLocalPeerCounts() {
  const map = new Map();
  for (const r of CHAT_ROOMS) map.set(r.id, 0);
  try {
    const peers = JSON.parse(localStorage.getItem(CHAT_PEERS_KEY) || '{}') || {};
    const now = Date.now();
    let dirty = false;
    for (const [cid, info] of Object.entries(peers)) {
      if (!info || now - info.ts > 15000) {
        delete peers[cid];
        dirty = true;
        continue;
      }
      if (map.has(info.room)) map.set(info.room, map.get(info.room) + 1);
    }
    if (dirty) localStorage.setItem(CHAT_PEERS_KEY, JSON.stringify(peers));
  } catch {}
  return map;
}

function heartbeatLocalPeer() {
  try {
    const peers = JSON.parse(localStorage.getItem(CHAT_PEERS_KEY) || '{}') || {};
    peers[myClientId] = { room: currentRoomId, ts: Date.now() };
    localStorage.setItem(CHAT_PEERS_KEY, JSON.stringify(peers));
  } catch {}
  refreshRoomCounts();
}

function refreshRoomCounts() {
  const peerMap = readLocalPeerCounts();
  if (channel && typeof channel.presenceState === 'function') {
    const st = channel.presenceState() || {};
    const supMap = new Map();
    for (const r of CHAT_ROOMS) supMap.set(r.id, 0);
    for (const metas of Object.values(st)) {
      const rm = (Array.isArray(metas) && metas[0]?.chatRoom) || 'all';
      if (supMap.has(rm)) supMap.set(rm, supMap.get(rm) + 1);
    }
    for (const r of CHAT_ROOMS) {
      peerMap.set(r.id, Math.max(peerMap.get(r.id) || 0, supMap.get(r.id) || 0));
    }
  }
  for (const r of CHAT_ROOMS) {
    const count = Math.min(r.max, peerMap.get(r.id) || (r.id === currentRoomId ? 1 : 0));
    roomCounts.set(r.id, count);
  }
  renderRoomList();
  updateChatHeader();
}

function getRoomMeta(roomId) {
  return CHAT_ROOMS.find((r) => r.id === roomId) || CHAT_ROOMS[0];
}

function renderRoomList() {
  if (!roomListEl.children.length) {
    for (const r of CHAT_ROOMS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'room-item';
      btn.dataset.room = r.id;
      btn.setAttribute('role', 'option');
      const nameSpan = document.createElement('span');
      nameSpan.textContent = r.name;
      const capSpan = document.createElement('span');
      capSpan.className = 'room-cap';
      btn.append(nameSpan, capSpan);
      roomListEl.append(btn);
    }
  }
  for (const btn of roomListEl.children) {
    const rid = btn.dataset.room;
    const meta = getRoomMeta(rid);
    const cnt = roomCounts.get(rid) || 0;
    const selected = rid === currentRoomId;
    btn.setAttribute('aria-selected', String(selected));
    const capSpan = btn.querySelector('.room-cap');
    capSpan.textContent = `${cnt.toLocaleString('ko-KR')} / ${meta.max.toLocaleString('ko-KR')}명`;
    capSpan.classList.toggle('full', cnt >= meta.max);
  }
}

function updateChatHeader() {
  const meta = getRoomMeta(currentRoomId);
  const cnt = roomCounts.get(currentRoomId) || 1;
  chatRoomTitle.textContent = meta.name;
  chatRoomCount.textContent = `참여 ${cnt.toLocaleString('ko-KR')} / ${meta.max.toLocaleString('ko-KR')}명`;
}

function renderChatMessages() {
  const meta = getRoomMeta(currentRoomId);
  const list = chatMessagesByRoom.get(currentRoomId) || [];
  chatLog.textContent = '';

  const notice = document.createElement('div');
  notice.className = 'chat-notice';
  notice.textContent = `${meta.name}에 입장했습니다. (최대 정원 ${meta.max.toLocaleString('ko-KR')}명 · 클린한 응원 문화를 지켜주세요)`;
  chatLog.append(notice);

  for (const item of list) {
    appendChatBubbleDOM(item);
  }
  chatLog.scrollTop = chatLog.scrollHeight;
}

function appendChatBubbleDOM(item) {
  const row = document.createElement('div');
  const isMine = localSentChatIds.has(item.id);
  row.className = `chat-bubble-row${isMine ? ' mine' : ''}`;

  const meta = document.createElement('div');
  meta.className = 'chat-meta';
  const author = document.createElement('span');
  author.className = 'chat-author';
  author.textContent = item.author;
  const time = document.createElement('span');
  time.textContent = formatTime(item.time || new Date().toISOString());
  meta.append(author, time);

  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble';
  bubble.textContent = item.text;

  row.append(meta, bubble);
  chatLog.append(row);
}

function joinChatRoom(roomId) {
  const meta = getRoomMeta(roomId);
  const currentCnt = roomCounts.get(roomId) || 0;
  if (roomId !== currentRoomId && currentCnt >= meta.max) {
    alert(`${meta.name}의 참여 인원(${meta.max.toLocaleString('ko-KR')}명)이 가득 차 입장할 수 없습니다.`);
    return;
  }
  currentRoomId = meta.id;
  heartbeatLocalPeer();
  if (channel && channel.state === 'joined') {
    try { channel.track({ chatRoom: currentRoomId }); } catch {}
  }
  if (localChannel) {
    localChannel.postMessage({ event: 'chat-presence', payload: { clientId: myClientId, room: currentRoomId } });
  }
  renderRoomList();
  updateChatHeader();
  renderChatMessages();
}

roomListEl.addEventListener('click', (e) => {
  const btn = e.target.closest('.room-item');
  if (!btn) return;
  joinChatRoom(btn.dataset.room);
});

function receiveChatMessage(roomId, msgObj) {
  if (!chatMessagesByRoom.has(roomId)) return;
  const cleanMsg = normalizeChatMessage(msgObj);
  if (!cleanMsg) return;
  const arr = chatMessagesByRoom.get(roomId);
  if (arr.some((m) => m.id === cleanMsg.id)) return;
  if (arr.length >= MAX_CHAT_HISTORY) arr.splice(0, arr.length - MAX_CHAT_HISTORY + 1);
  arr.push(cleanMsg);
  saveChatStore();
  if (roomId === currentRoomId) {
    appendChatBubbleDOM(cleanMsg);
    chatLog.scrollTop = chatLog.scrollHeight;
  }
}

chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const txt = chatInput.value.trim();
  if (!txt || txt.length > MAX_CHAT_TEXT_CHARS) return;
  const meta = getRoomMeta(currentRoomId);
  const cnt = roomCounts.get(currentRoomId) || 1;
  if (cnt > meta.max) {
    alert(`${meta.name} 정원(${meta.max}명)을 초과하여 메시지를 보낼 수 없습니다.`);
    return;
  }
  const msgObj = {
    id: uuid(),
    author: myNick,
    text: txt,
    time: new Date().toISOString(),
  };
  chatInput.value = '';
  markChatMessageMine(msgObj.id);
  receiveChatMessage(currentRoomId, msgObj);

  if (channel && channel.state === 'joined') {
    channel.send({ type: 'broadcast', event: 'subject-chat', payload: { roomId: currentRoomId, msg: msgObj } });
  }
  if (localChannel) {
    localChannel.postMessage({ event: 'subject-chat', payload: { roomId: currentRoomId, msg: msgObj } });
  }
});

if (localChannel) {
  const prevHandler = localChannel.onmessage;
  localChannel.onmessage = (e) => {
    const ev = e.data?.event;
    const pl = e.data?.payload;
    if (ev === 'subject-chat' && pl && typeof pl === 'object') {
      receiveChatMessage(pl.roomId, pl.msg);
      return;
    }
    if (ev === 'chat-presence' && pl && typeof pl === 'object') {
      refreshRoomCounts();
      return;
    }
    if (prevHandler) prevHandler(e);
  };
}

if (channel) {
  channel.on('broadcast', { event: 'subject-chat' }, ({ payload }) => {
    if (payload && typeof payload === 'object' && payload.roomId && payload.msg) {
      receiveChatMessage(payload.roomId, payload.msg);
    }
  });
}

window.addEventListener('beforeunload', () => {
  try {
    const peers = JSON.parse(localStorage.getItem(CHAT_PEERS_KEY) || '{}') || {};
    delete peers[myClientId];
    localStorage.setItem(CHAT_PEERS_KEY, JSON.stringify(peers));
  } catch {}
});

heartbeatLocalPeer();
setInterval(heartbeatLocalPeer, 5000);
renderChatMessages();
