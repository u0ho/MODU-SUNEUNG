// ── 2. 모의 시험 시간 타이머 (초 단위 카운트다운 + 시작/멈춤/기록·초기화 + 수능 타종 효과음) ──
const EXAM_TIMERS = [
  { id: 'kor', name: '국어 영역', minutes: 80 },
  { id: 'math', name: '수학 영역', minutes: 100 },
  { id: 'eng', name: '영어 영역', minutes: 70 },
  { id: 'hist', name: '한국사', minutes: 30 },
  { id: 'inq1', name: '탐구 영역(1)', minutes: 30 },
  { id: 'inq2', name: '탐구 영역(2)', minutes: 30 },
  { id: 'break', name: '쉬는 시간', minutes: 20 },
];

const timerMainCol = $('timerMainCol');
const timerSideCol = $('timerSideCol');
const testChimeBtn = $('testChimeBtn');
const resetAllTimersBtn = $('resetAllTimersBtn');
const timerStates = new Map();

// Web Audio API 기반 수능 시험장 타종 차임벨 (외부 오디오 파일 없이 맑은 4음계 종소리 합성)
let audioCtx = null;
function ensureAudioContext() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  if (!audioCtx) audioCtx = new Ctx();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function playSuneungBell() {
  try {
    if (!ensureAudioContext()) return;

    // 웨스트민스터/수능 시험장 차임벨 멜로디 (솔4 - 도5 - 레5 - 미5, 잠깐 쉬고 미5 - 레5 - 도5 - 솔4)
    const notes = [
      { freq: 392.00, start: 0.0, dur: 0.55 },
      { freq: 523.25, start: 0.55, dur: 0.55 },
      { freq: 587.33, start: 1.10, dur: 0.55 },
      { freq: 659.25, start: 1.65, dur: 1.15 },
      { freq: 659.25, start: 3.00, dur: 0.55 },
      { freq: 587.33, start: 3.55, dur: 0.55 },
      { freq: 523.25, start: 4.10, dur: 0.55 },
      { freq: 392.00, start: 4.65, dur: 1.40 },
    ];
    const baseTime = audioCtx.currentTime + 0.02;

    for (const n of notes) {
      const osc = audioCtx.createOscillator();
      const overtone = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      const overGain = audioCtx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(n.freq, baseTime + n.start);

      overtone.type = 'triangle';
      overtone.frequency.setValueAtTime(n.freq * 2, baseTime + n.start);

      gain.gain.setValueAtTime(0.0001, baseTime + n.start);
      gain.gain.exponentialRampToValueAtTime(0.26, baseTime + n.start + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.0001, baseTime + n.start + n.dur);

      overGain.gain.setValueAtTime(0.0001, baseTime + n.start);
      overGain.gain.exponentialRampToValueAtTime(0.06, baseTime + n.start + 0.02);
      overGain.gain.exponentialRampToValueAtTime(0.0001, baseTime + n.start + n.dur * 0.65);

      osc.connect(gain);
      overtone.connect(overGain);
      gain.connect(audioCtx.destination);
      overGain.connect(audioCtx.destination);

      osc.start(baseTime + n.start);
      osc.stop(baseTime + n.start + n.dur + 0.05);
      overtone.start(baseTime + n.start);
      overtone.stop(baseTime + n.start + n.dur + 0.05);
    }
  } catch (err) {
    console.error('[timer] 효과음 재생 오류', err);
  }
}

function formatTimerSec(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${pad2(m)}:${pad2(sec)}`;
}

function updateTimerClockGraphic(st, animateFlip = true) {
  const rem = Math.max(0, Math.floor(st.remainingSec));
  const m = Math.floor(rem / 60);
  const s = rem % 60;

  // 플립 시계 디지털 숫자 업데이트 (3자리 분 지원: 100분 → 1,0,0)
  const mStr = m >= 100 ? String(m).padStart(3, '0') : pad2(m);
  const sStr = pad2(s);
  if (st.minHundredsEl) {
    st.minHundredsEl.hidden = m < 100;
  }
  const nextChars = m >= 100
    ? [mStr[0], mStr[1], mStr[2], sStr[0], sStr[1]]
    : ['0', mStr[0], mStr[1], sStr[0], sStr[1]];

  st.flipDigits.forEach((el, idx) => {
    const ch = nextChars[idx];
    if (el.textContent !== ch) {
      el.textContent = ch;
      if (animateFlip && st.status === 'running') {
        el.classList.remove('flipping');
        void el.offsetWidth;
        el.classList.add('flipping');
      }
    }
  });
}

function updateTimerCardUI(st, animateFlip = true) {
  updateTimerClockGraphic(st, animateFlip);
  st.cardEl.classList.toggle('running', st.status === 'running');
  st.cardEl.classList.toggle('finished', st.remainingSec === 0 && st.status !== 'running');

  // 시작 버튼: 동작 중이거나 남은 시간이 0초이면 비활성화
  st.startBtn.disabled = st.status === 'running' || st.remainingSec === 0;
  // 멈춤 버튼: 동작 중일 때만 활성화
  st.pauseBtn.disabled = st.status !== 'running';

  // 기록 / 초기화 버튼 전환:
  // - 동작 중(running): '기록' 버튼으로 동작
  // - 멈춤(paused): '초기화' 버튼으로 변경
  // - 초기 상태(idle): 기록이 남아있으면 '초기화', 아니면 비활성 '기록'
  if (st.status === 'paused') {
    st.actionBtn.textContent = '초기화';
    st.actionBtn.disabled = false;
  } else if (st.status === 'running') {
    st.actionBtn.textContent = '기록';
    st.actionBtn.disabled = false;
  } else {
    st.actionBtn.textContent = st.records.length > 0 ? '초기화' : '기록';
    st.actionBtn.disabled = st.records.length === 0;
  }

  st.recordsEl.hidden = st.records.length === 0;
}

function renderTimerRecords(st) {
  st.recordsEl.textContent = '';
  st.records.forEach((rec, i) => {
    const li = document.createElement('li');
    li.className = 'timer-record-item';
    const left = document.createElement('span');
    left.textContent = `#${i + 1} 경과 ${rec.elapsed}`;
    const right = document.createElement('span');
    right.textContent = `남은 시간 ${rec.remaining}`;
    li.append(left, right);
    st.recordsEl.append(li);
  });
  st.recordsEl.scrollTop = st.recordsEl.scrollHeight;
}

function resetTimerState(st) {
  clearInterval(st.intervalId);
  st.intervalId = 0;
  st.status = 'idle';
  st.remainingSec = st.defaultSec;
  st.records = [];
  renderTimerRecords(st);
  updateTimerCardUI(st, false);
}

function startExamTimer(st) {
  if (st.status === 'running' || st.remainingSec <= 0) return;
  // 첫 클릭 시 오디오 컨텍스트 잠금 해제
  try { ensureAudioContext(); } catch {}

  st.status = 'running';
  st.deadlineMs = Date.now() + st.remainingSec * 1000;
  clearInterval(st.intervalId);
  st.intervalId = setInterval(() => {
    const leftSec = Math.max(0, Math.ceil((st.deadlineMs - Date.now()) / 1000));
    if (leftSec === st.remainingSec && leftSec > 0) return;
    st.remainingSec = leftSec;
    if (leftSec <= 0) {
      clearInterval(st.intervalId);
      st.intervalId = 0;
      st.status = 'paused'; // 종료 후 멈춤 상태로 전환되어 '초기화' 버튼이 즉시 활성화됨
      updateTimerCardUI(st, true);
      playSuneungBell();
      return;
    }
    updateTimerCardUI(st, true);
  }, 200);
  updateTimerCardUI(st, false);
}

function pauseExamTimer(st) {
  if (st.status !== 'running') return;
  clearInterval(st.intervalId);
  st.intervalId = 0;
  st.remainingSec = Math.max(0, Math.ceil((st.deadlineMs - Date.now()) / 1000));
  st.status = 'paused';
  updateTimerCardUI(st, false);
}

function recordOrResetExamTimer(st) {
  if (st.status === 'running') {
    const elapsedSec = st.defaultSec - st.remainingSec;
    st.records.push({
      elapsed: formatTimerSec(elapsedSec),
      remaining: formatTimerSec(st.remainingSec),
    });
    renderTimerRecords(st);
    updateTimerCardUI(st, false);
  } else {
    // 멈춤 상태에서 클릭 시 기본 설정 시간으로 초기화
    resetTimerState(st);
  }
}

function createTimerFlipClock() {
  const wrap = document.createElement('div');
  wrap.className = 'timer-flip';

  // 분(minutes) 유닛: 백의 자리(100분 이상일 때만 표시) + 십의 자리 + 일의 자리
  const minUnit = document.createElement('div');
  minUnit.className = 'flip-unit';
  const minPair = document.createElement('div');
  minPair.className = 'flip-pair';
  const mH = document.createElement('span');
  mH.className = 'flip-digit';
  mH.textContent = '1';
  mH.hidden = true;
  const mT = document.createElement('span');
  mT.className = 'flip-digit';
  mT.textContent = '0';
  const mO = document.createElement('span');
  mO.className = 'flip-digit';
  mO.textContent = '0';
  minPair.append(mH, mT, mO);
  const minLbl = document.createElement('span');
  minLbl.className = 'flip-label';
  minLbl.textContent = 'min';
  minUnit.append(minPair, minLbl);

  const sep = document.createElement('span');
  sep.className = 'flip-sep';
  sep.setAttribute('aria-hidden', 'true');

  // 초(seconds) 유닛
  const secUnit = document.createElement('div');
  secUnit.className = 'flip-unit';
  const secPair = document.createElement('div');
  secPair.className = 'flip-pair';
  const sT = document.createElement('span');
  sT.className = 'flip-digit';
  sT.textContent = '0';
  const sO = document.createElement('span');
  sO.className = 'flip-digit';
  sO.textContent = '0';
  secPair.append(sT, sO);
  const secLbl = document.createElement('span');
  secLbl.className = 'flip-label';
  secLbl.textContent = 'sec';
  secUnit.append(secPair, secLbl);

  wrap.append(minUnit, sep, secUnit);
  return {
    wrap,
    minHundredsEl: mH,
    flipDigits: [mH, mT, mO, sT, sO],
  };
}

for (const def of EXAM_TIMERS) {
  const defaultSec = def.minutes * 60;
  const isBreak = def.id === 'break';
  const card = document.createElement('article');
  card.className = isBreak ? 'timer-card break-card' : 'timer-card';

  const head = document.createElement('div');
  head.className = 'timer-card-head';
  const title = document.createElement('h3');
  title.className = 'timer-name';
  title.textContent = def.name;
  const badge = document.createElement('span');
  badge.className = 'timer-default-badge';
  badge.textContent = `기본 ${def.minutes}분`;
  head.append(title, badge);

  const bodyRow = document.createElement('div');
  bodyRow.className = 'timer-body-row';
  const { wrap: flipWrap, minHundredsEl, flipDigits } = createTimerFlipClock();

  const controls = document.createElement('div');
  controls.className = 'timer-controls';
  const startBtn = document.createElement('button');
  startBtn.type = 'button';
  startBtn.className = 'timer-btn start';
  startBtn.textContent = '시작';

  const pauseBtn = document.createElement('button');
  pauseBtn.type = 'button';
  pauseBtn.className = 'timer-btn pause';
  pauseBtn.textContent = '멈춤';
  pauseBtn.disabled = true;

  const actionBtn = document.createElement('button');
  actionBtn.type = 'button';
  actionBtn.className = 'timer-btn';
  actionBtn.textContent = '기록';
  actionBtn.disabled = true;

  controls.append(startBtn, pauseBtn, actionBtn);
  bodyRow.append(flipWrap, controls);

  const recordsEl = document.createElement('ul');
  recordsEl.className = 'timer-records';
  recordsEl.hidden = true;

  card.append(head, bodyRow, recordsEl);
  if (isBreak) timerSideCol.append(card);
  else timerMainCol.append(card);

  const st = {
    id: def.id,
    name: def.name,
    defaultSec,
    remainingSec: defaultSec,
    status: 'idle',
    deadlineMs: 0,
    intervalId: 0,
    records: [],
    cardEl: card,
    minHundredsEl,
    flipDigits,
    startBtn,
    pauseBtn,
    actionBtn,
    recordsEl,
  };
  timerStates.set(def.id, st);
  updateTimerCardUI(st, false);

  startBtn.addEventListener('click', () => startExamTimer(st));
  pauseBtn.addEventListener('click', () => pauseExamTimer(st));
  actionBtn.addEventListener('click', () => recordOrResetExamTimer(st));
}

testChimeBtn.addEventListener('click', playSuneungBell);
resetAllTimersBtn.addEventListener('click', () => {
  for (const st of timerStates.values()) resetTimerState(st);
});
