// 3D mahjong tiles: an ivory-and-jade rounded block with a printed face.
// Local frame: face on +Y, the top of the printed face toward -Z, width along X.
// Each tile glides toward a target pose every frame, with a small hop on long moves.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { getAtlas, uvRect } from './tileFaces.js';

export const TILE = { W: 0.032, H: 0.042, T: 0.023 };

let shared = null;
function ensureShared() {
  if (shared) return shared;
  const { W, H, T } = TILE;
  const body = new RoundedBoxGeometry(W, T, H, 3, 0.0024);
  // Two-tone: ivory face half, jade back half.
  const pos = body.attributes.position;
  const col = new Float32Array(pos.count * 3);
  const ivory = new THREE.Color(0xf4efe0), jade = new THREE.Color(0x0c6b4e), tmp = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / (T / 2); // -1 .. 1
    const t = THREE.MathUtils.smoothstep(y, -0.32, -0.12);
    tmp.copy(jade).lerp(ivory, t);
    col.set([tmp.r, tmp.g, tmp.b], i * 3);
  }
  body.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const atlas = getAtlas();
  shared = {
    body,
    bodyMat: new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.32, metalness: 0, clearcoat: 0.7, clearcoatRoughness: 0.18 }),
    faceMat: new THREE.MeshStandardMaterial({ map: atlas.texture, roughness: 0.38, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2 }),
    faces: new Map(),
    glowMat: new THREE.MeshBasicMaterial({ color: 0xffd36b, transparent: true, opacity: 0.55, depthWrite: false, toneMapped: false }),
  };
  return shared;
}

function faceGeometry(k) {
  const s = ensureShared();
  if (s.faces.has(k)) return s.faces.get(k);
  const { W, H, T } = TILE;
  const g = new THREE.PlaneGeometry(W * 0.84, H * 0.86);
  const { u0, u1, v0, v1 } = uvRect(k);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) ? u1 : u0, uv.getY(i) ? v1 : v0);
  g.rotateX(-Math.PI / 2);
  g.translate(0, T / 2 + 0.0002, 0);
  s.faces.set(k, g);
  return g;
}

export class Tile3D {
  constructor(kind = -1) {
    const s = ensureShared();
    this.root = new THREE.Group();
    this.body = new THREE.Mesh(s.body, s.bodyMat);
    this.body.castShadow = true;
    this.body.receiveShadow = true;
    this.face = new THREE.Mesh(faceGeometry(-1), s.faceMat);
    this.root.add(this.body, this.face);
    this.kind = null;
    this.setKind(kind);
    this.target = { pos: new THREE.Vector3(), quat: new THREE.Quaternion() };
    this.base = new THREE.Vector3(); // position without the hop
    this.placed = false;
    this.speed = 9;
    this.root.matrixAutoUpdate = true;
  }

  setKind(k) {
    if (k === this.kind) return;
    this.kind = k;
    this.face.geometry = faceGeometry(k ?? -1);
  }

  setGlow(on) {
    if (on && !this.glow) {
      const { W, H } = TILE;
      this.glow = new THREE.Mesh(new THREE.PlaneGeometry(W * 1.35, H * 1.3).rotateX(-Math.PI / 2), ensureShared().glowMat);
      this.glow.position.y = -TILE.T / 2 - 0.0008;
      this.glow.renderOrder = -1;
      this.root.add(this.glow);
    }
    if (this.glow) this.glow.visible = !!on;
  }

  // Move toward a pose. snap: jump there now.
  setTarget(pos, quat, snap = false) {
    this.target.pos.copy(pos);
    this.target.quat.copy(quat);
    if (snap || !this.placed) {
      this.base.copy(pos);
      this.root.position.copy(pos);
      this.root.quaternion.copy(quat);
      this.placed = true;
    }
  }

  update(dt) {
    const k = 1 - Math.exp(-dt * this.speed);
    const d = this.base.distanceTo(this.target.pos);
    if (d < 0.0002 && this.root.quaternion.angleTo(this.target.quat) < 0.002) {
      this.base.copy(this.target.pos);
      this.root.position.copy(this.base);
      this.root.quaternion.copy(this.target.quat);
      return false;
    }
    this.base.lerp(this.target.pos, k);
    this.root.quaternion.slerp(this.target.quat, k);
    this.root.position.copy(this.base);
    this.root.position.y += Math.min(0.06, d * 0.35); // hop over other tiles
    return true;
  }
}
