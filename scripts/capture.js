// ── 캡처 모드: 기능 일시정지 + 선택된 메시지 박스만 이미지로 캡처 ──
function updateCapUI() {
  const n = capSelected.size;
  capSaveBtn.textContent = `선택 캡처 (${n})`;
  capStoryBtn.textContent = `스토리 9:16 (${n})`;
  capSaveBtn.disabled = n === 0;
  capStoryBtn.disabled = n === 0;
}

function toggleCapSelect(item) {
  if (capSelected.has(item.id)) {
    capSelected.delete(item.id);
    item.el.classList.remove('cap-selected');
  } else {
    capSelected.add(item.id);
    item.el.classList.add('cap-selected');
  }
  updateCapUI();
}

function setCaptureMode(active) {
  capturing = active;
  document.body.classList.toggle('capturing', active);
  capEnterBtn.hidden = active;
  shareLinkBtn.hidden = active;
  capActions.hidden = !active;
  search.disabled = active;
  scale.disabled = active;
  text.disabled = active;
  pwInput.disabled = active;
  if (active) {
    select(null);
    togglePalette(false);
    updateCapUI();
  } else {
    for (const id of capSelected) messages.get(id)?.el.classList.remove('cap-selected');
    capSelected.clear();
    updateCapUI();
    while (remoteQueue.length) {
      const [ev, pl] = remoteQueue.shift();
      onRemote(ev, pl);
    }
  }
}

// ── 종이 질감 타일 생성 (화면 CSS --paper 및 캔버스 캡처 공용, 고운 켄트지 입자) ──
let paperPatternTile = null;
function hash2d(x, y, salt = 0) {
  let h = Math.imul((x & 255) + salt * 131, 374761393) + Math.imul((y & 255) + salt * 977, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function smoothNoise(x, y, scale, salt) {
  const gx = x / scale, gy = y / scale;
  const x0 = Math.floor(gx), y0 = Math.floor(gy);
  const fx = gx - x0, fy = gy - y0;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const period = 256 / scale;
  const nx0 = ((x0 % period) + period) % period;
  const ny0 = ((y0 % period) + period) % period;
  const nx1 = (nx0 + 1) % period;
  const ny1 = (ny0 + 1) % period;
  const a = hash2d(nx0, ny0, salt), b = hash2d(nx1, ny0, salt);
  const c = hash2d(nx0, ny1, salt), d = hash2d(nx1, ny1, salt);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function buildPaperTile() {
  if (paperPatternTile) return paperPatternTile;
  const size = 256;
  const tc = document.createElement('canvas');
  tc.width = size;
  tc.height = size;
  const tctx = tc.getContext('2d');
  const img = tctx.createImageData(size, size);
  const d = img.data;

  // 256x256 타일을 128x128 CSS px(0.5px 단위)로 매핑해 입자를 곱고 은은하게 표현
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const soft = smoothNoise(x, y, 2, 1);
      const fine = hash2d(x, y, 2);
      const v = soft * 0.45 + fine * 0.55;
      const grain = Math.max(0, v - 0.42);
      d[i] = 56;
      d[i + 1] = 52;
      d[i + 2] = 46;
      d[i + 3] = Math.min(11, Math.round(grain * 18));
    }
  }
  tctx.putImageData(img, 0, 0);
  paperPatternTile = tc;
  return tc;
}
function getPaperPattern(ctx) {
  const pat = ctx.createPattern(buildPaperTile(), 'repeat');
  if (pat && pat.setTransform) pat.setTransform(new DOMMatrix().scale(0.5, 0.5));
  return pat;
}
try {
  const tileUrl = buildPaperTile().toDataURL('image/png');
  document.documentElement.style.setProperty('--paper', `url("${tileUrl}")`);
} catch {}

function drawRoundRect(ctx, x, y, w, h, r) {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, rad);
}

// 텍스트 노드를 브라우저 줄바꿈 위치 그대로 캔버스에 그리기 (약간 도톰한 손글씨 스트로크 적용)
function drawTextNodeLines(ctx, textNode, elRect, bx, by, font, color) {
  const str = textNode.data;
  if (!str) return;
  const range = document.createRange();
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.lineWidth = 0.5;
  ctx.strokeStyle = color;

  let segStart = 0;
  let segRect = null;
  for (let i = 0; i < str.length; i++) {
    range.setStart(textNode, i);
    range.setEnd(textNode, i + 1);
    const r = range.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (!segRect) {
      segStart = i;
      segRect = r;
    } else if (Math.abs(r.top - segRect.top) > 3) {
      const lineStr = str.slice(segStart, i);
      const tx = bx + (segRect.left - elRect.left);
      const ty = by + (segRect.top - elRect.top) + segRect.height / 2;
      ctx.strokeText(lineStr, tx, ty);
      ctx.fillText(lineStr, tx, ty);
      segStart = i;
      segRect = r;
    }
  }
  if (segRect) {
    const lineStr = str.slice(segStart);
    const tx = bx + (segRect.left - elRect.left);
    const ty = by + (segRect.top - elRect.top) + segRect.height / 2;
    ctx.strokeText(lineStr, tx, ty);
    ctx.fillText(lineStr, tx, ty);
  }
}

// ── 캡처 하단 '모두의 수능' 스탬프 로고 이미지 (투명 배경 스탬프 잉크 처리) ──
const STAMP_LOGO_DATA_URL = 'data:image/png;base64,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';
const stampLogoImg = new Image();
stampLogoImg.src = STAMP_LOGO_DATA_URL;

async function waitForCaptureAssets() {
  if (document.fonts) await document.fonts.ready;
  if (!stampLogoImg.complete) {
    await new Promise((res) => {
      stampLogoImg.onload = res;
      stampLogoImg.onerror = res;
    });
  }
}

function computeCaptureFrame(sizes, rawPos, isStory) {
  let minX = Infinity, minY = Infinity, maxX = 0, maxY = 0;
  sizes.forEach(([w, h], i) => {
    minX = Math.min(minX, rawPos[i].x);
    minY = Math.min(minY, rawPos[i].y);
    maxX = Math.max(maxX, rawPos[i].x + w);
    maxY = Math.max(maxY, rawPos[i].y + h);
  });

  const contentW = maxX - minX;
  const contentH = maxY - minY;
  const pad = 20;
  const stampFooterH = 52;
  let cw = Math.max(180, Math.ceil(contentW + pad * 2));
  let ch = Math.ceil(contentH + pad * 2 + stampFooterH);
  let offsetX = Math.round((cw - contentW) / 2);
  let offsetY = pad;

  if (isStory) {
    const minStoryW = Math.max(540, Math.ceil(contentW + 72));
    const minStoryH = Math.max(960, Math.ceil(contentH + 220));
    if (minStoryW * 16 >= minStoryH * 9) {
      cw = minStoryW;
      ch = Math.round((cw * 16) / 9);
    } else {
      ch = minStoryH;
      cw = Math.round((ch * 9) / 16);
    }
    offsetX = Math.round((cw - contentW) / 2);
    offsetY = Math.round((ch - contentH) / 2);
  }

  return { minX, minY, contentW, contentH, cw, ch, offsetX, offsetY };
}

function drawCaptureCardSurface(ctx, m, bx, by, w, h, elRect, pattern, line) {
  // 1. 메시지 카드 배경 + 그림자 + 종이 질감 + 줄노트 라인 + 테두리
  ctx.save();
  ctx.shadowColor = 'rgba(17, 17, 17, 0.06)';
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 2;
  drawRoundRect(ctx, bx, by, w, h, 24);
  ctx.fillStyle = COLORS[m.color] || '#FFFFFF';
  ctx.fill();
  ctx.restore();

  ctx.save();
  drawRoundRect(ctx, bx, by, w, h, 24);
  ctx.clip();
  if (pattern) {
    ctx.fillStyle = pattern;
    ctx.fillRect(bx, by, w, h);
  }
  // 줄노트 라인: 글 길이에 맞춰 텍스트 행 사이사이에만 표시 (가장 상단 및 가장 하단 라인 제거)
  const textRect = m.textEl.getBoundingClientRect();
  const textTop = by + (textRect.top - elRect.top);
  const textBottom = textTop + textRect.height;
  const cardStyle = getComputedStyle(m.el);
  const cardFontSize = parseFloat(cardStyle.fontSize) || 20;
  const ruleStep = parseFloat(getComputedStyle(m.textEl).lineHeight) || (cardFontSize * (query ? 1.9 : 1.55));
  const lineLeft = bx + (textRect.left - elRect.left);
  const lineRight = bx + w - (textRect.left - elRect.left);
  ctx.strokeStyle = 'rgba(56, 59, 64, 0.065)';
  ctx.lineWidth = 0.8;
  for (let ry = textTop + ruleStep; ry <= textBottom - 4; ry += ruleStep) {
    ctx.beginPath();
    ctx.moveTo(lineLeft, ry);
    ctx.lineTo(lineRight, ry);
    ctx.stroke();
  }
  ctx.restore();

  drawRoundRect(ctx, bx, by, w, h, 24);
  ctx.strokeStyle = line;
  ctx.lineWidth = 1;
  ctx.stroke();
}

function drawSearchLabelMark(ctx, node, elRect, bx, by, ink, pattern) {
  const mr = node.getBoundingClientRect();
  const mx = bx + (mr.left - elRect.left);
  const my = by + (mr.top - elRect.top);
  const mw = mr.width;
  const mh = mr.height;
  const tilt = parseFloat(node.style.getPropertyValue('--tilt')) || 0;
  const mStyle = getComputedStyle(node);
  const mFontSize = parseFloat(mStyle.fontSize) || 24;

  // 회전된 이중 테두리 라벨지 배경
  ctx.save();
  ctx.translate(mx + mw / 2, my + mh / 2);
  ctx.rotate((tilt * Math.PI) / 180);
  ctx.translate(-mw / 2, -mh / 2);

  const rOuter = mFontSize * 0.2;
  const bOuter = Math.max(1.5, mFontSize * 0.08);
  drawRoundRect(ctx, 0, 0, mw, mh, rOuter);
  ctx.fillStyle = '#FFFFFF';
  ctx.fill();
  if (pattern) {
    ctx.save();
    ctx.clip();
    ctx.fillStyle = pattern;
    ctx.fillRect(0, 0, mw, mh);
    ctx.restore();
  }
  ctx.strokeStyle = '#E04B35';
  ctx.lineWidth = bOuter;
  ctx.stroke();

  const inset = bOuter + Math.max(1.2, mFontSize * 0.07);
  if (mw > inset * 2 && mh > inset * 2) {
    drawRoundRect(ctx, inset, inset, mw - inset * 2, mh - inset * 2, Math.max(2, rOuter - inset));
    ctx.strokeStyle = '#E04B35';
    ctx.lineWidth = Math.max(1, mFontSize * 0.04);
    ctx.stroke();
  }
  ctx.restore();

  // 수평 유지 손글씨 텍스트
  ctx.save();
  ctx.font = `${mStyle.fontWeight} ${mStyle.fontSize} ${mStyle.fontFamily}`;
  ctx.fillStyle = ink;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(node.textContent, mx + mw / 2, my + mh / 2 + mFontSize * 0.03);
  ctx.restore();
}

function drawCaptureCardBodyAndFooter(ctx, m, elRect, bx, by, ink, line, pattern) {
  // 2. 본문 텍스트 및 검색 라벨지(mark.label)
  const textStyle = getComputedStyle(m.textEl);
  const textFont = `${textStyle.fontWeight} ${textStyle.fontSize} ${textStyle.fontFamily}`;

  for (const node of m.textEl.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      drawTextNodeLines(ctx, node, elRect, bx, by, textFont, ink);
    } else if (node.nodeType === Node.ELEMENT_NODE && node.classList.contains('label')) {
      drawSearchLabelMark(ctx, node, elRect, bx, by, ink, pattern);
    }
  }

  // '더보기' 버튼이 표시 중이면 함께 그리기
  if (m.moreEl && !m.moreEl.hidden) {
    const mr = m.moreEl.getBoundingClientRect();
    const moreStyle = getComputedStyle(m.moreEl);
    ctx.save();
    ctx.font = `${moreStyle.fontWeight} ${moreStyle.fontSize} ${moreStyle.fontFamily}`;
    ctx.fillStyle = ink;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const mx = bx + (mr.left - elRect.left);
    const my = by + (mr.top - elRect.top) + mr.height / 2;
    ctx.fillText(m.moreEl.textContent, mx, my);
    ctx.beginPath();
    ctx.moveTo(mx, by + (mr.bottom - elRect.top) - 2);
    ctx.lineTo(mx + mr.width, by + (mr.bottom - elRect.top) - 2);
    ctx.strokeStyle = ink;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }

  // 3. 감정표현 버튼들
  if (!m.reactEl.hidden) {
    for (const btn of m.reactEl.children) {
      const br = btn.getBoundingClientRect();
      const rx = bx + (br.left - elRect.left);
      const ry = by + (br.top - elRect.top);
      const rw = br.width;
      const rh = br.height;
      const bStyle = getComputedStyle(btn);

      drawRoundRect(ctx, rx, ry, rw, rh, rh / 2);
      ctx.fillStyle = '#FFFFFF';
      ctx.fill();
      ctx.strokeStyle = btn.classList.contains('on') ? ink : line;
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.font = `${bStyle.fontWeight} ${bStyle.fontSize} ${bStyle.fontFamily}`;
      ctx.fillStyle = ink;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(btn.textContent, rx + rw / 2, ry + rh / 2 + 0.5);
    }
  }

  // 4. 우측 하단 날짜·시간
  const timeEl = m.el.querySelector('.time');
  if (timeEl) {
    const tr = timeEl.getBoundingClientRect();
    const tStyle = getComputedStyle(timeEl);
    ctx.save();
    ctx.font = `${tStyle.fontWeight} ${tStyle.fontSize} ${tStyle.fontFamily}`;
    ctx.fillStyle = 'rgba(37, 37, 37, 0.45)';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(timeEl.textContent, bx + (tr.right - elRect.left), by + (tr.top - elRect.top) + tr.height / 2);
    ctx.restore();
  }
}

function drawCaptureStamp(ctx, frame, isStory, pattern) {
  // 5. 캡처 이미지 하단 '모두의 수능' 스탬프 로고 (약간 더 키운 스탬프 형태로 배치)
  if (!stampLogoImg.complete || stampLogoImg.naturalWidth <= 0) return;
  const { cw, ch, offsetY, contentH } = frame;
  const aspect = stampLogoImg.naturalWidth / stampLogoImg.naturalHeight;
  const stampH = isStory ? 38 : 32;
  const stampW = Math.round(stampH * aspect);
  const stampCenterX = cw / 2;
  const stampCenterY = isStory
    ? Math.min(ch - 46, Math.max(offsetY + contentH + 46, ch - 64))
    : offsetY + contentH + Math.round((ch - (offsetY + contentH)) / 2);

  ctx.save();
  ctx.translate(stampCenterX, stampCenterY);
  ctx.rotate((-1.2 * Math.PI) / 180);
  ctx.globalAlpha = 0.84;
  ctx.drawImage(stampLogoImg, -stampW / 2, -stampH / 2, stampW, stampH);
  if (pattern) {
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = pattern;
    ctx.fillRect(-stampW / 2, -stampH / 2, stampW, stampH);
  }
  ctx.restore();
}

function exportCanvasPng(canvas, isStory) {
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const now = new Date();
    const stamp = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
    a.href = url;
    a.download = isStory ? `suneung-story-${stamp}.png` : `suneung-messages-${stamp}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setCaptureMode(false);
  }, 'image/png');
}

async function captureSelected(mode = 'pack') {
  const isStory = mode === 'story';
  const visible = getSortedVisibleMessages((m) => capSelected.has(m.id));
  if (!visible.length) return;

  await waitForCaptureAssets();

  const W = stack.clientWidth;
  const gap = 8 * Number(scale.value);
  const sizes = visible.map((m) => [Math.min(m.el.offsetWidth, W), m.el.offsetHeight]);

  // 선택된 박스들만 빈 공간 없이 패킹 배치
  const { positions: rawPos } = packBoxes(sizes, { width: W, gap, singleColumn: Boolean(query || isStory) });
  const frame = computeCaptureFrame(sizes, rawPos, isStory);
  const dpr = Math.min(3, Math.max(2, window.devicePixelRatio || 2));

  const canvas = document.createElement('canvas');
  canvas.width = frame.cw * dpr;
  canvas.height = frame.ch * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const pattern = getPaperPattern(ctx);
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, frame.cw, frame.ch);
  if (pattern) {
    ctx.fillStyle = pattern;
    ctx.fillRect(0, 0, frame.cw, frame.ch);
  }

  const ink = '#383B40';
  const line = '#E5E7EB';
  visible.forEach((m, idx) => {
    const [w, h] = sizes[idx];
    const bx = rawPos[idx].x - frame.minX + frame.offsetX;
    const by = rawPos[idx].y - frame.minY + frame.offsetY;
    const elRect = m.el.getBoundingClientRect();
    drawCaptureCardSurface(ctx, m, bx, by, w, h, elRect, pattern, line);
    drawCaptureCardBodyAndFooter(ctx, m, elRect, bx, by, ink, line, pattern);
  });

  drawCaptureStamp(ctx, frame, isStory, pattern);
  exportCanvasPng(canvas, isStory);
}

capEnterBtn.addEventListener('click', () => {
  if (!query) return;
  setCaptureMode(true);
});
capCancelBtn.addEventListener('click', () => setCaptureMode(false));
capSaveBtn.addEventListener('click', () => captureSelected('pack'));
capStoryBtn.addEventListener('click', () => captureSelected('story'));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && capturing) setCaptureMode(false);
});
