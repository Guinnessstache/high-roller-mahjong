// Live 3D hero for the project site. Reuses the game's own table and tile code
// (copied into docs/js/scene by `npm run docs:sync`).
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { buildTable, TABLE, toWorld, seatYaw, seatAnchors, buildChair } from './scene/table.js';
import { Tile3D, TILE } from './scene/tiles3d.js';
import { loadTileFont, buildAtlas } from './scene/tileFaces.js';
import { setMaxAnisotropy, radialGlowTexture } from './scene/textures.js';

const { W, H, T } = TILE;
const Q_DOWN = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI);
const Q_STAND = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
const Q_UP = new THREE.Quaternion();
const yawQ = (seat, local) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), seatYaw(seat)).multiply(local);

// Winning hands shown in turn on the near seat (tile kinds; see server/tiles.js).
const HANDS = [
  { tiles: [31, 31, 31, 32, 32, 32, 33, 33, 33, 0, 1, 2, 18, 18], name: 'Great Three Dragons' },
  { tiles: [9, 9, 9, 10, 11, 12, 13, 14, 15, 16, 17, 17, 17, 13], name: 'Pure One Suit' },
  { tiles: [0, 8, 9, 17, 18, 26, 27, 28, 29, 30, 31, 32, 33, 33], name: 'Thirteen Orphans' },
  { tiles: [27, 27, 27, 28, 28, 28, 29, 29, 29, 30, 30, 30, 4, 4], name: 'Great Four Winds' },
];

export async function startHero(container, { onFail } = {}) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  } catch (e) {
    onFail?.(e);
    return null;
  }
  await loadTileFont();
  buildAtlas({ corners: true });
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  container.appendChild(renderer.domElement);
  setMaxAnisotropy(Math.min(8, renderer.capabilities.getMaxAnisotropy()));

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0604);
  scene.fog = new THREE.FogExp2(0x0b0604, 0.12);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.3;
  const camera = new THREE.PerspectiveCamera(38, 1, 0.05, 40);

  scene.add(new THREE.HemisphereLight(0xffe2c0, 0x2a1008, 0.35));
  const spot = new THREE.SpotLight(0xffe0b0, 9, 9, Math.PI / 4.5, 0.6, 2);
  spot.position.set(0, 3.1, 0.2);
  spot.target.position.set(0, TABLE.height, 0);
  spot.castShadow = true;
  spot.shadow.mapSize.set(2048, 2048);
  spot.shadow.bias = -0.0002;
  spot.shadow.normalBias = 0.01;
  scene.add(spot, spot.target);
  const warm = new THREE.PointLight(0xff5a30, 6, 8, 2);
  warm.position.set(-2.5, 2.2, -2);
  scene.add(warm);

  const floor = new THREE.Mesh(new THREE.CircleGeometry(8, 64).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x2a0a10, roughness: 0.95 }));
  floor.receiveShadow = true;
  scene.add(floor);
  const table = buildTable('high');
  scene.add(table.group);
  table.dealerMarker.position.copy(toWorld(0, -0.42, TABLE.half + TABLE.rim * 0.5)).setY(TABLE.height + TABLE.rimH + 0.006);
  for (const i of [1, 2, 3]) {
    const a = seatAnchors(i);
    const chair = buildChair();
    chair.position.copy(a.chair);
    chair.rotation.y = a.yaw;
    scene.add(chair);
  }

  // Red-lantern bokeh suggesting the casino floor.
  const glowTex = radialGlowTexture('rgba(255,200,120,1)', 'rgba(255,160,80,0)');
  const bokeh = new THREE.Group();
  const colors = [0xff3a20, 0xffc070, 0xff4d6d, 0xffe066, 0xd11a1a];
  for (let i = 0; i < 70; i++) {
    const m = new THREE.SpriteMaterial({ map: glowTex, color: colors[i % colors.length], transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.35 + Math.random() * 0.4 });
    const s = new THREE.Sprite(m);
    const ang = Math.random() * Math.PI * 2, r = 5 + Math.random() * 6;
    s.position.set(Math.cos(ang) * r, 0.6 + Math.random() * 3.5, Math.sin(ang) * r);
    const sc = 0.3 + Math.random() * 0.7;
    s.scale.set(sc, sc, 1);
    s.userData.phase = Math.random() * 10;
    bokeh.add(s);
  }
  scene.add(bokeh);

  const Y = TABLE.feltY;
  const tiles = [];
  const add = (kind, pos, quat) => { const t = new Tile3D(kind); t.setTarget(pos, quat, true); scene.add(t.root); tiles.push(t); return t; };
  // Walls (partly drawn) and the other players' hands.
  for (let seat = 0; seat < 4; seat++) {
    const n = seat === 0 ? 12 : seat === 1 ? 9 : 18;
    for (let j = 0; j < n; j++) for (let lv = 0; lv < 2; lv++) {
      add(-1, toWorld(seat, (8.5 - j) * W, 0.305).setY(Y + T / 2 + lv * T + 0.0003), yawQ(seat, Q_DOWN));
    }
    if (seat) for (let j = 0; j < 13; j++) add(-1, toWorld(seat, 0.045 + (j - 6) * (W + 0.0016), 0.425).setY(Y + H / 2), yawQ(seat, Q_STAND));
  }
  // Discards in the center.
  const rand = (a) => a[Math.floor(Math.random() * a.length)];
  const pool = [...Array(34).keys()];
  for (let seat = 0; seat < 4; seat++) {
    const n = 5 + Math.floor(Math.random() * 6);
    for (let k = 0; k < n; k++) {
      const row = Math.floor(k / 7), col = k % 7;
      add(rand(pool), toWorld(seat, 0.09 - 7 * W + W / 2 + col * W, 0.25 - row * (H + 0.002)).setY(Y + T / 2), yawQ(seat, Q_UP));
    }
  }
  // The near hand: stands, then lays down a winning hand.
  const mine = HANDS[0].tiles.map(() => add(-1, new THREE.Vector3(), Q_UP));
  const place = (faceUp) => mine.forEach((t, j) => {
    const x = 0.045 + (j - 6.5) * (W + 0.0016) + (j === 13 ? 0.014 : 0);
    t.setTarget(toWorld(0, x, faceUp ? 0.413 : 0.425).setY(faceUp ? Y + T / 2 : Y + H / 2), yawQ(0, faceUp ? Q_UP : Q_STAND));
  });
  place(false);
  mine.forEach((t) => t.setTarget(t.target.pos, t.target.quat, true));

  let onHand = null;
  let running = true;
  let handIdx = 0;
  const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));
  (async function loop() {
    while (running) {
      const h = HANDS[handIdx++ % HANDS.length];
      const sorted = h.tiles.slice(0, 13).sort((a, b) => a - b).concat(h.tiles[13]);
      mine.forEach((t, j) => t.setKind(sorted[j]));
      place(false);
      await sleep(2.2);
      place(true);
      onHand?.(h.name);
      await sleep(5);
    }
  })();

  const resize = () => {
    const w = container.clientWidth, h = container.clientHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.fov = w / h < 1 ? 58 : 36;
    if (w > 900) camera.setViewOffset(w, h, -w * 0.2, h * 0.04, w, h);
    else camera.setViewOffset(w, h, 0, h * 0.2, w, h);
    camera.updateProjectionMatrix();
  };
  resize();
  new ResizeObserver(resize).observe(container);

  let visible = true;
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; }, { threshold: 0.01 }).observe(container);
  const mouse = new THREE.Vector2();
  window.addEventListener('pointermove', (e) => mouse.set(e.clientX / innerWidth - 0.5, e.clientY / innerHeight - 0.5), { passive: true });

  const clock = new THREE.Timer();
  let t = 0;
  const look = new THREE.Vector3(0, Y, 0.12);
  renderer.setAnimationLoop(() => {
    clock.update();
    const dt = Math.min(0.1, clock.getDelta());
    if (!visible || document.hidden) return;
    t += reduceMotion ? 0 : dt;
    for (const x of tiles) x.update(dt);
    const ang = Math.PI / 2 + 0.35 + Math.sin(t * 0.08) * 0.25 + mouse.x * 0.12;
    const r = 1.75 - Math.sin(t * 0.11) * 0.1;
    camera.position.set(Math.cos(ang) * r, 1.45 + Math.sin(t * 0.13) * 0.06 - mouse.y * 0.1, Math.sin(ang) * r);
    camera.lookAt(look);
    bokeh.children.forEach((s) => { s.material.opacity = 0.25 + 0.3 * (0.5 + 0.5 * Math.sin(t * 1.3 + s.userData.phase)); });
    renderer.render(scene, camera);
  });

  return {
    onHand(fn) { onHand = fn; },
    stop() { running = false; renderer.setAnimationLoop(null); },
  };
}
