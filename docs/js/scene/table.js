// Mahjong table geometry + seat layout.
//
// Seats sit on the four sides: seat 0 at +Z, seat 1 at +X, seat 2 at -Z, seat 3 at -X, so play
// (seat 0 -> 1 -> 2 -> 3) runs counter-clockwise seen from above, like a real table.
// "Seat space" is a 2D frame per seat: +x = that player's right, +z = toward that player.
import * as THREE from 'three';
import { mahjongFeltTexture, woodTexture } from './textures.js';

export const TABLE = {
  half: 0.5,        // felt half-width
  rim: 0.07,        // wooden rim width
  rimH: 0.028,      // rim height above the felt
  height: 0.76,     // felt surface height
  chair: 0.98,      // chair distance from the center
  seats: 4,
};
TABLE.feltY = TABLE.height;

export const seatYaw = (i) => i * (Math.PI / 2);

// Seat-space (x, z) to world (y = 0).
export function toWorld(seat, x, z, out = new THREE.Vector3()) {
  const a = seatYaw(seat);
  const c = Math.cos(a), s = Math.sin(a);
  return out.set(x * c + z * s, 0, -x * s + z * c);
}

export function seatAnchors(i) {
  const yaw = seatYaw(i);
  const chair = toWorld(i, 0, TABLE.chair);
  const edge = toWorld(i, 0, TABLE.half + TABLE.rim * 0.5);
  const inward = toWorld(i, 0, -1);
  const playerRight = toWorld(i, 1, 0);
  return { yaw, chair, edge, inward, playerRight, label: toWorld(i, 0, TABLE.half - 0.02) };
}

export function buildTable(quality = 'high') {
  const g = new THREE.Group();
  g.name = 'mahjongTable';
  const { half, rim, rimH, height } = TABLE;

  // Felt
  const felt = new THREE.Mesh(
    new THREE.PlaneGeometry(half * 2, half * 2).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ map: mahjongFeltTexture('#0b5a46'), roughness: 0.95, metalness: 0 }),
  );
  felt.position.y = height;
  felt.receiveShadow = true;
  g.add(felt);

  // Rosewood rim (four mitred-looking boards) with a brass inlay line.
  const wood = new THREE.MeshPhysicalMaterial({ map: woodTexture('#3a140c', [3, 1], 9), roughness: 0.32, metalness: 0.05, clearcoat: 0.6, clearcoatRoughness: 0.25 });
  const brass = new THREE.MeshStandardMaterial({ color: 0xd8ad4f, roughness: 0.22, metalness: 1 });
  const len = half * 2 + rim * 2;
  for (let i = 0; i < 4; i++) {
    const board = new THREE.Mesh(new THREE.BoxGeometry(len, rimH + 0.03, rim), wood);
    const p = toWorld(i, 0, half + rim / 2);
    board.position.set(p.x, height + (rimH - 0.03) / 2, p.z);
    board.rotation.y = seatYaw(i);
    board.castShadow = true;
    board.receiveShadow = true;
    g.add(board);
    const inlay = new THREE.Mesh(new THREE.BoxGeometry(len - 0.02, 0.002, 0.006), brass);
    const q = toWorld(i, 0, half + rim * 0.55);
    inlay.position.set(q.x, height + rimH + 0.001, q.z);
    inlay.rotation.y = seatYaw(i);
    g.add(inlay);
  }
  // Brass corner caps
  for (const [x, z] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const cap = new THREE.Mesh(new THREE.BoxGeometry(rim + 0.004, 0.004, rim + 0.004), brass);
    cap.position.set(x * (half + rim / 2), height + rimH + 0.002, z * (half + rim / 2));
    g.add(cap);
  }

  // Apron and legs
  const apron = new THREE.Mesh(new THREE.BoxGeometry(len - 0.03, 0.12, len - 0.03), wood);
  apron.position.y = height - 0.075;
  apron.castShadow = true;
  g.add(apron);
  const legGeo = new THREE.BoxGeometry(0.075, height - 0.1, 0.075);
  for (const [x, z] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const leg = new THREE.Mesh(legGeo, wood);
    leg.position.set(x * (len / 2 - 0.09), (height - 0.1) / 2, z * (len / 2 - 0.09));
    leg.castShadow = true;
    g.add(leg);
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.03, 0.09), brass);
    foot.position.set(leg.position.x, 0.015, leg.position.z);
    g.add(foot);
  }

  // Turn indicator: a glowing strip along the active player's edge of the felt (drains as a countdown).
  const turnBar = new THREE.Mesh(
    new THREE.PlaneGeometry(half * 2 - 0.04, 0.012).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x5ee08a, transparent: true, opacity: 0.9, depthWrite: false, toneMapped: false }),
  );
  turnBar.position.y = height + 0.0015;
  turnBar.visible = false;
  turnBar.name = 'turnBar';
  g.add(turnBar);

  // Dealer marker: a red-and-gold "East" disc beside the dealer.
  const markTex = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const x = c.getContext('2d');
    x.fillStyle = '#b3121f'; x.beginPath(); x.arc(64, 64, 62, 0, Math.PI * 2); x.fill();
    x.lineWidth = 6; x.strokeStyle = '#e8c15a'; x.beginPath(); x.arc(64, 64, 54, 0, Math.PI * 2); x.stroke();
    x.fillStyle = '#ffe9a8'; x.font = 'bold 66px "TileCJK", "Noto Serif CJK TC", serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText('東', 64, 68);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  })();
  const dealerMarker = new THREE.Mesh(
    new THREE.CylinderGeometry(0.028, 0.028, 0.01, 40),
    [new THREE.MeshStandardMaterial({ color: 0xd8ad4f, metalness: 1, roughness: 0.3 }), new THREE.MeshStandardMaterial({ map: markTex, roughness: 0.4 }), new THREE.MeshStandardMaterial({ color: 0x8a0d16 })],
  );
  dealerMarker.castShadow = true;
  dealerMarker.position.set(0, height + rimH + 0.007, 0);
  dealerMarker.name = 'dealerMarker';
  g.add(dealerMarker);

  return { group: g, turnBar, dealerMarker, felt, markTex };
}

// Casino chair placed at a seat.
let chairParts = null;
export function buildChair() {
  if (!chairParts) {
    chairParts = {
      seatGeo: new THREE.CylinderGeometry(0.24, 0.22, 0.1, 24),
      backGeo: new THREE.BoxGeometry(0.46, 0.5, 0.08, 1, 1, 1),
      poleGeo: new THREE.CylinderGeometry(0.035, 0.035, 0.42, 12),
      baseGeo: new THREE.CylinderGeometry(0.26, 0.28, 0.03, 24),
      fabric: new THREE.MeshPhysicalMaterial({ color: 0x7a0c14, roughness: 0.75, sheen: 1, sheenColor: new THREE.Color(0xcc3344), sheenRoughness: 0.5 }),
      metal: new THREE.MeshStandardMaterial({ color: 0xc9a04a, roughness: 0.25, metalness: 1 }),
    };
  }
  const p = chairParts;
  const g = new THREE.Group();
  const seat = new THREE.Mesh(p.seatGeo, p.fabric); seat.position.y = 0.5; seat.castShadow = true;
  const back = new THREE.Mesh(p.backGeo, p.fabric); back.position.set(0, 0.8, 0.2); back.rotation.x = -0.12; back.castShadow = true;
  const pole = new THREE.Mesh(p.poleGeo, p.metal); pole.position.y = 0.24;
  const base = new THREE.Mesh(p.baseGeo, p.metal); base.position.y = 0.015; base.receiveShadow = true;
  g.add(seat, back, pole, base);
  return g;
}
