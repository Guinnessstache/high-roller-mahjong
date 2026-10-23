// Draws every tile face into one canvas atlas, used by the 3D tiles (as a texture) and by the
// on-screen hand (as a CSS sprite). Chinese characters come from a tiny bundled font subset
// (public/fonts/tiles-cjk.woff2) so tiles look right even on PCs without CJK fonts.
import * as THREE from 'three';

export const COLS = 8, ROWS = 6;
export const CELL_W = 160, CELL_H = 212;
const CJK = '"TileCJK", "Noto Serif CJK TC", "Microsoft JhengHei", "PMingLiU", "Songti TC", serif';

const NUMERALS = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
const WINDS = ['東', '南', '西', '北'];
const FLOWERS = ['梅', '蘭', '菊', '竹'];
const SEASONS = ['春', '夏', '秋', '冬'];
const INDEX = (k) => (k < 27 ? String((k % 9) + 1) : k < 31 ? 'ESWN'[k - 27] : k < 34 ? ['R', 'G', 'Wh'][k - 31] : String(((k - 34) % 4) + 1));

const NAVY = '#1b2a5c', RED = '#b8161f', GREEN = '#137046', BLUE = '#1f4fa8';

let atlas = null;
let fontReady = null;

export function loadTileFont() {
  if (!fontReady) {
    fontReady = (async () => {
      try {
        const f = new FontFace('TileCJK', `url(${new URL('../../fonts/tiles-cjk.woff2', import.meta.url)})`, { weight: '700' });
        await f.load();
        document.fonts.add(f);
      } catch { /* fall back to system fonts */ }
    })();
  }
  return fontReady;
}

export function cellOf(k) {
  const i = k < 0 ? COLS * ROWS - 1 : k;
  return { col: i % COLS, row: Math.floor(i / COLS) };
}

function dot(x, cx, cy, r, color) {
  x.fillStyle = color;
  x.beginPath(); x.arc(cx, cy, r, 0, Math.PI * 2); x.fill();
  x.fillStyle = '#fbf6ea';
  x.beginPath(); x.arc(cx, cy, r * 0.68, 0, Math.PI * 2); x.fill();
  x.fillStyle = color;
  x.beginPath(); x.arc(cx, cy, r * 0.5, 0, Math.PI * 2); x.fill();
  x.strokeStyle = '#fbf6ea'; x.lineWidth = r * 0.12;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    x.beginPath(); x.moveTo(cx + Math.cos(a) * r * 0.18, cy + Math.sin(a) * r * 0.18); x.lineTo(cx + Math.cos(a) * r * 0.45, cy + Math.sin(a) * r * 0.45); x.stroke();
  }
}

function stick(x, cx, cy, w, h, color) {
  const dark = color === RED ? '#7d0d14' : color === BLUE ? '#12306a' : '#0b4a2d';
  x.fillStyle = color;
  const r = w / 2;
  x.beginPath();
  x.moveTo(cx - r, cy - h / 2 + r); x.arcTo(cx - r, cy - h / 2, cx, cy - h / 2, r); x.arcTo(cx + r, cy - h / 2, cx + r, cy - h / 2 + r, r);
  x.lineTo(cx + r, cy + h / 2 - r); x.arcTo(cx + r, cy + h / 2, cx, cy + h / 2, r); x.arcTo(cx - r, cy + h / 2, cx - r, cy + h / 2 - r, r);
  x.closePath(); x.fill();
  x.fillStyle = dark;
  for (const t of [-0.5, 0, 0.5]) x.fillRect(cx - r, cy + t * h * 0.92 - w * 0.12, w, w * 0.24);
  x.fillStyle = 'rgba(255,255,255,0.35)';
  x.fillRect(cx - r * 0.35, cy - h / 2 + r, r * 0.3, h - 2 * r);
}

const DOT_LAYOUT = {
  2: [[0.5, 0.28, 'g'], [0.5, 0.72, 'b']],
  3: [[0.24, 0.2, 'b'], [0.5, 0.5, 'r'], [0.76, 0.8, 'g']],
  4: [[0.3, 0.28, 'b'], [0.7, 0.28, 'g'], [0.3, 0.72, 'g'], [0.7, 0.72, 'b']],
  5: [[0.27, 0.24, 'b'], [0.73, 0.24, 'g'], [0.5, 0.5, 'r'], [0.27, 0.76, 'g'], [0.73, 0.76, 'b']],
  6: [[0.3, 0.2, 'g'], [0.7, 0.2, 'g'], [0.3, 0.52, 'r'], [0.7, 0.52, 'r'], [0.3, 0.8, 'r'], [0.7, 0.8, 'r']],
  7: [[0.24, 0.15, 'g'], [0.5, 0.25, 'g'], [0.76, 0.35, 'g'], [0.3, 0.58, 'r'], [0.7, 0.58, 'r'], [0.3, 0.84, 'r'], [0.7, 0.84, 'r']],
  8: [[0.3, 0.14, 'b'], [0.7, 0.14, 'b'], [0.3, 0.38, 'b'], [0.7, 0.38, 'b'], [0.3, 0.62, 'b'], [0.7, 0.62, 'b'], [0.3, 0.86, 'b'], [0.7, 0.86, 'b']],
  9: [[0.22, 0.18, 'b'], [0.5, 0.18, 'b'], [0.78, 0.18, 'b'], [0.22, 0.5, 'r'], [0.5, 0.5, 'r'], [0.78, 0.5, 'r'], [0.22, 0.82, 'g'], [0.5, 0.82, 'g'], [0.78, 0.82, 'g']],
};
const BAM_LAYOUT = {
  2: [[0.5, 0.29, 'g'], [0.5, 0.71, 'g']],
  3: [[0.5, 0.29, 'g'], [0.3, 0.71, 'g'], [0.7, 0.71, 'g']],
  4: [[0.3, 0.29, 'g'], [0.7, 0.29, 'g'], [0.3, 0.71, 'g'], [0.7, 0.71, 'g']],
  5: [[0.24, 0.29, 'g'], [0.76, 0.29, 'g'], [0.5, 0.5, 'r'], [0.24, 0.71, 'g'], [0.76, 0.71, 'g']],
  6: [[0.24, 0.29, 'g'], [0.5, 0.29, 'g'], [0.76, 0.29, 'g'], [0.24, 0.71, 'b'], [0.5, 0.71, 'b'], [0.76, 0.71, 'b']],
  7: [[0.5, 0.17, 'r'], [0.24, 0.5, 'g'], [0.5, 0.5, 'g'], [0.76, 0.5, 'g'], [0.24, 0.83, 'g'], [0.5, 0.83, 'g'], [0.76, 0.83, 'g']],
  8: [[0.18, 0.29, 'g'], [0.39, 0.29, 'g'], [0.61, 0.29, 'g'], [0.82, 0.29, 'g'], [0.18, 0.71, 'b'], [0.39, 0.71, 'b'], [0.61, 0.71, 'b'], [0.82, 0.71, 'b']],
  9: [[0.24, 0.17, 'g'], [0.5, 0.17, 'r'], [0.76, 0.17, 'b'], [0.24, 0.5, 'g'], [0.5, 0.5, 'r'], [0.76, 0.5, 'b'], [0.24, 0.83, 'g'], [0.5, 0.83, 'r'], [0.76, 0.83, 'b']],
};
const COLOR = { r: RED, g: GREEN, b: BLUE };

function bird(x, cx, cy, s) {
  // One Bamboo: a little sparrow on a branch.
  x.save(); x.translate(cx, cy); x.scale(s, s);
  x.fillStyle = GREEN;
  for (let i = -2; i <= 2; i++) { x.beginPath(); x.ellipse(-22 + i * 2, 18, 30, 9, -0.9 + i * 0.32, 0, Math.PI * 2); x.fill(); }
  x.fillStyle = '#c2862b'; x.beginPath(); x.ellipse(6, -4, 26, 20, 0.2, 0, Math.PI * 2); x.fill();
  x.fillStyle = RED; x.beginPath(); x.arc(26, -24, 13, 0, Math.PI * 2); x.fill();
  x.fillStyle = '#e6b23a'; x.beginPath(); x.moveTo(37, -26); x.lineTo(50, -21); x.lineTo(37, -18); x.fill();
  x.fillStyle = '#111'; x.beginPath(); x.arc(29, -27, 2.6, 0, Math.PI * 2); x.fill();
  x.strokeStyle = NAVY; x.lineWidth = 4; x.beginPath(); x.moveTo(-34, 38); x.lineTo(40, 38); x.stroke();
  x.restore();
}

function blossom(x, cx, cy, r, color) {
  x.fillStyle = color;
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
    x.beginPath(); x.ellipse(cx + Math.cos(a) * r * 0.55, cy + Math.sin(a) * r * 0.55, r * 0.5, r * 0.34, a, 0, Math.PI * 2); x.fill();
  }
  x.fillStyle = '#f2c230'; x.beginPath(); x.arc(cx, cy, r * 0.25, 0, Math.PI * 2); x.fill();
}

function drawFace(x, k, ox, oy, corners) {
  const W = CELL_W, H = CELL_H;
  x.save();
  x.translate(ox, oy);
  const g = x.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#fffdf6'); g.addColorStop(1, '#f1ead8');
  x.fillStyle = g; x.fillRect(0, 0, W, H);
  x.textAlign = 'center'; x.textBaseline = 'middle';
  if (k < 0) { x.restore(); return; }
  if (k < 9) {
    x.fillStyle = NAVY; x.font = `700 64px ${CJK}`; x.fillText(NUMERALS[k], W / 2, H * 0.3);
    x.fillStyle = RED; x.font = `700 74px ${CJK}`; x.fillText('萬', W / 2, H * 0.68);
  } else if (k < 18) {
    const n = k - 9 + 1;
    if (n === 1) {
      dot(x, W / 2, H / 2, 56, RED);
      x.strokeStyle = GREEN; x.lineWidth = 5; x.beginPath(); x.arc(W / 2, H / 2, 64, 0, Math.PI * 2); x.stroke();
    } else for (const [px, py, c] of DOT_LAYOUT[n]) dot(x, 18 + px * (W - 36), 16 + py * (H - 32), n >= 7 ? 17 : n >= 5 ? 20 : 24, COLOR[c]);
  } else if (k < 27) {
    const n = k - 18 + 1;
    if (n === 1) bird(x, W / 2, H / 2, 1.25);
    else for (const [px, py, c] of BAM_LAYOUT[n]) stick(x, 14 + px * (W - 28), 14 + py * (H - 28), n >= 8 ? 15 : 19, n >= 7 ? 52 : 70, COLOR[c]);
  } else if (k < 31) {
    x.fillStyle = NAVY; x.font = `700 112px ${CJK}`; x.fillText(WINDS[k - 27], W / 2, H * 0.53);
  } else if (k === 31) {
    x.fillStyle = RED; x.font = `700 118px ${CJK}`; x.fillText('中', W / 2, H * 0.53);
  } else if (k === 32) {
    x.fillStyle = GREEN; x.font = `700 112px ${CJK}`; x.fillText('發', W / 2, H * 0.53);
  } else if (k === 33) {
    x.strokeStyle = BLUE; x.lineWidth = 7; x.strokeRect(26, 30, W - 52, H - 60);
    x.lineWidth = 3; x.strokeRect(38, 42, W - 76, H - 84);
  } else {
    const flower = k < 38;
    const i = (k - 34) % 4;
    const colors = flower ? ['#d6407a', '#8a4fc0', '#e08a1e', GREEN] : ['#2f9a5a', '#d6402a', '#c47a1e', '#3a6fc0'];
    blossom(x, W / 2, H * 0.38, 46, colors[i]);
    x.fillStyle = flower ? RED : BLUE;
    x.font = `700 64px ${CJK}`; x.fillText((flower ? FLOWERS : SEASONS)[i], W / 2, H * 0.76);
  }
  if (corners || k >= 34) {
    x.font = '800 30px Inter, Arial, sans-serif';
    x.textAlign = 'left'; x.textBaseline = 'top';
    x.fillStyle = k >= 38 ? BLUE : k >= 34 ? RED : k === 31 ? RED : k === 32 ? GREEN : NAVY;
    x.fillText(INDEX(k), 9, 6);
  }
  x.restore();
}

export function buildAtlas({ corners = true } = {}) {
  const c = atlas?.canvas || document.createElement('canvas');
  c.width = COLS * CELL_W; c.height = ROWS * CELL_H;
  const x = c.getContext('2d');
  x.clearRect(0, 0, c.width, c.height);
  for (let k = -1; k < 42; k++) { const { col, row } = cellOf(k); drawFace(x, k, col * CELL_W, row * CELL_H, corners); }
  if (!atlas) {
    const texture = new THREE.CanvasTexture(c);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 8;
    atlas = { canvas: c, texture, url: '' };
  } else atlas.texture.needsUpdate = true;
  atlas.url = c.toDataURL('image/png');
  document.documentElement.style.setProperty('--tile-atlas', `url(${atlas.url})`);
  return atlas;
}

export function getAtlas() { return atlas || buildAtlas(); }

// UV rectangle for a kind, in texture space.
export function uvRect(k) {
  const { col, row } = cellOf(k);
  const inset = 2;
  return {
    u0: (col * CELL_W + inset) / (COLS * CELL_W),
    u1: ((col + 1) * CELL_W - inset) / (COLS * CELL_W),
    v0: 1 - ((row + 1) * CELL_H - inset) / (ROWS * CELL_H),
    v1: 1 - (row * CELL_H + inset) / (ROWS * CELL_H),
  };
}

// CSS for an on-screen tile showing kind k (background sprite).
export function tileCss(k) {
  const { col, row } = cellOf(k);
  return `background-position:${(col / (COLS - 1)) * 100}% ${(row / (ROWS - 1)) * 100}%`;
}
