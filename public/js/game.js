// GameView: turns server state + events into 3D table visuals and animations.
//
// Every physical tile is one Tile3D, indexed by its position in the wall's draw order, so a
// tile you watch leave the wall is the same object that lands in a hand, a discard row or a
// meld. Events move tiles between zones in a local view model; whenever the event queue is
// empty the view model is checked against the authoritative state and corrected.
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { TABLE, seatAnchors, toWorld, seatYaw, buildChair } from './scene/table.js';
import { Tile3D, TILE } from './scene/tiles3d.js';
import { PlayerAvatar, SEAT_COLORS, setPeople } from './scene/avatars.js';
import { loadPeople } from './scene/people.js';
import { wait, setTweenSpeed, finishAllTweens } from './scene/tween.js';

const Y = TABLE.feltY;
const { W, H, T } = TILE;
const fmt = (n) => Math.round(n || 0).toLocaleString();
export const WIND_CHAR = ['東', '南', '西', '北'];
export const WIND_EN = ['East', 'South', 'West', 'North'];

// Seat-space layout (x = that player's right, z = toward that player).
const L = {
  handZ: 0.425, handCX: 0.045, gap: 0.0016, drawnGap: 0.014,
  meldZ: 0.352, meldRight: 0.46,
  bonusX: -0.46,
  wallZ: 0.305,
  discRight: 0.09, discPerRow: 7, discTopZ: 0.25,
};

// Orientations in seat space.
const Q_UP = new THREE.Quaternion(); // lying face up, top away from the owner
const Q_DOWN = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI);
const Q_STAND = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
const Y_AXIS = new THREE.Vector3(0, 1, 0);

const emptySeat = () => ({ hand: [], drawn: null, discards: [], melds: [], bonus: [], revealed: false });

export class GameView {
  constructor(world, { sfx, onSeatClick }) {
    this.world = world;
    this.scene = world.scene;
    this.sfx = sfx;
    this.onSeatClick = onSeatClick;
    this.mySeat = -1;
    this.room = null;
    this.state = null;
    this.members = new Map();
    this.queue = [];
    this.processing = false;
    this.camView = 'seat';
    this.vm = null;
    this.tiles = [];
    for (let i = 0; i < 144; i++) {
      const t = new Tile3D(-1);
      t.root.visible = false;
      this.scene.add(t.root);
      this.tiles.push(t);
    }

    this.seats = [];
    for (let i = 0; i < TABLE.seats; i++) {
      const a = seatAnchors(i);
      const chair = buildChair();
      chair.position.copy(a.chair);
      chair.rotation.y = a.yaw;
      this.scene.add(chair);

      const avatar = new PlayerAvatar(i);
      avatar.group.position.copy(a.chair).setY(0);
      avatar.group.rotation.y = a.yaw;
      this.scene.add(avatar.group);

      const label = this.makeSeatLabel(i);
      label.obj.position.copy(toWorld(i, 0, 0.62)).setY(Y + 0.1);
      this.scene.add(label.obj);

      const sitBtn = document.createElement('button');
      sitBtn.className = 'sit-btn';
      sitBtn.textContent = 'Sit here';
      sitBtn.addEventListener('click', (e) => { e.stopPropagation(); this.onSeatClick?.(i); });
      const sitObj = new CSS2DObject(sitBtn);
      sitObj.position.copy(a.chair).setY(1.0);
      sitObj.visible = false;
      this.scene.add(sitObj);

      this.seats.push({ i, a, chair, avatar, label, sitObj });
    }

    world.onUpdate((dt) => this.update(dt));
  }

  // Realistic people (High/Medium graphics) or the stylized ones (Low). Loads on first use.
  async setRealisticPeople(on) {
    this.realistic = on;
    let templates = null;
    if (on) {
      try { templates = await (this._people ||= loadPeople()); } catch { templates = null; }
      if (!this.realistic) return;
    }
    setPeople(templates);
    for (const s of this.seats) s.avatar.pickRig();
    this.world.casino?.setPeople?.(templates);
  }

  makeSeatLabel(i) {
    const el = document.createElement('div');
    el.className = 'seat-label';
    el.innerHTML = `
      <div class="sl-reaction"></div>
      <div class="sl-action"></div>
      <div class="sl-top"><span class="sl-wind"></span><span class="sl-dot"></span><span class="sl-name"></span><span class="sl-tag"></span><span class="sl-mic">🎙</span></div>
      <div class="sl-stack"></div>
      <div class="sl-timer"><div></div></div>`;
    const obj = new CSS2DObject(el);
    obj.visible = false;
    return {
      obj, el,
      name: el.querySelector('.sl-name'),
      stack: el.querySelector('.sl-stack'),
      tag: el.querySelector('.sl-tag'),
      wind: el.querySelector('.sl-wind'),
      action: el.querySelector('.sl-action'),
      timer: el.querySelector('.sl-timer > div'),
      timerWrap: el.querySelector('.sl-timer'),
      dot: el.querySelector('.sl-dot'),
      mic: el.querySelector('.sl-mic'),
      reaction: el.querySelector('.sl-reaction'),
    };
  }

  // ---------------- camera ----------------
  applyCamera() {
    const w = this.world;
    const mine = this.mySeat >= 0 ? this.mySeat : 0;
    const portrait = w.camera.aspect < 1;
    if (this.camView === 'orbit') {
      w.setCameraGoal(w.camera.position.clone(), new THREE.Vector3(0, Y, 0), 'orbit');
      return;
    }
    if (this.camView === 'overhead') {
      w.setCameraGoal(toWorld(mine, 0, portrait ? 0.32 : 0.42).setY(portrait ? 2.25 : 1.85), toWorld(mine, 0, 0.04).setY(Y), 'overhead');
      return;
    }
    if (this.mySeat >= 0) {
      const pos = toWorld(mine, 0, portrait ? 0.74 : 0.86).setY(portrait ? 1.62 : 1.34);
      const look = toWorld(mine, 0, portrait ? 0.02 : 0.06).setY(Y);
      w.setCameraGoal(pos, look, 'seat');
    } else {
      w.setCameraGoal(toWorld(0, 0, 1.55).setY(1.7), new THREE.Vector3(0, Y, 0), 'seat');
    }
  }

  setCameraView(view) {
    this.camView = view;
    this.applyCamera();
  }

  // ---------------- room / members ----------------
  setRoom(room, myPid) {
    this.room = room;
    this.myPid = myPid;
    this.members = new Map(room.members.map((m) => [m.pid, m]));
    this.refreshSeats();
  }

  memberForSeat(seat) {
    const s = this.state?.table.seats[seat];
    return s ? this.members.get(s.id) || null : null;
  }

  // ---------------- state ----------------
  applyState(state) {
    const prevSeat = this.mySeat;
    this.state = state;
    this.mySeat = state.you.seat;
    if (prevSeat !== this.mySeat) { this.applyCamera(); if (this.vm) this.layout(); }
    if (!this.processing && this.queue.length === 0) this.reconcile();
    else this.refreshSeats();
  }

  // ---------------- wall geometry ----------------
  get N() { return this.vm?.N || 144; }
  get perSide() { return this.N / 8; } // stacks per side

  // Wall slot for draw-order index i. Draws run clockwise round the wall from the break; the
  // front end takes the top tile of each stack first, and so does the back (replacement) end.
  wallPose(i) {
    const vm = this.vm;
    const S = vm.N / 2;
    const n = this.perSide;
    const stack = (vm.breakStack + Math.floor(i / 2)) % S;
    const top = i < vm.N / 2 ? i % 2 === 0 : i % 2 === 1;
    const seat = (4 - Math.floor(stack / n)) % 4;
    const x = ((n - 1) / 2 - (stack % n)) * W;
    const pos = toWorld(seat, x, L.wallZ).setY(Y + T / 2 + (top ? T : 0) + 0.0003);
    return { pos, quat: this.seatQuat(seat, Q_DOWN) };
  }

  seatQuat(seat, local) {
    return new THREE.Quaternion().setFromAxisAngle(Y_AXIS, seatYaw(seat)).multiply(local);
  }

  // ---------------- view model ----------------
  newVm(N, dealer, handNumber) {
    const n = N / 8;
    const q = (4 - dealer) % 4; // the dealer's side in wall order
    const offset = 2 + ((handNumber * 5) % Math.max(1, n - 4));
    const vm = {
      N, dealer, handNumber, wallFront: 0, wallBack: 0,
      breakStack: q * n + offset,
      seats: [0, 1, 2, 3].map(emptySeat),
      lastDiscard: null,
      pendingKong: null,
    };
    this.vm = vm;
    for (let i = 0; i < 144; i++) {
      const t = this.tiles[i];
      t.root.visible = i < N;
      t.setKind(-1);
      t.setGlow(false);
    }
    return vm;
  }

  takeFront() { const vm = this.vm; return vm.wallFront < vm.N ? vm.wallFront++ : -1; }
  takeBack() { const vm = this.vm; vm.wallBack++; return vm.N - vm.wallBack; }

  // A hand mesh of the given kind (for my own seat), or any (others').
  pickFromHand(seat, kind, preferDrawn = false) {
    const s = this.vm.seats[seat];
    const all = s.drawn !== null ? [...s.hand, s.drawn] : s.hand.slice();
    let idx = -1;
    if (seat === this.mySeat || s.revealed) {
      if (s.drawn !== null && this.tiles[s.drawn].kind === kind) idx = s.drawn;
      else idx = all.find((t) => this.tiles[t].kind === kind) ?? -1;
    }
    if (idx < 0) {
      if (preferDrawn && s.drawn !== null) idx = s.drawn;
      else idx = all.length ? all[Math.floor(Math.random() * all.length)] : -1;
    }
    if (idx < 0) return -1;
    if (s.drawn === idx) s.drawn = null;
    else { s.hand.splice(s.hand.indexOf(idx), 1); if (s.drawn !== null) { s.hand.push(s.drawn); s.drawn = null; } }
    return idx;
  }

  mergeDrawn(seat) {
    const s = this.vm.seats[seat];
    if (s.drawn !== null) { s.hand.push(s.drawn); s.drawn = null; }
  }

  // ---------------- layout ----------------
  layout(snap = false) {
    const vm = this.vm;
    if (!vm) return;
    const st = this.state?.table;
    const inWall = new Set();
    for (let i = vm.wallFront; i < vm.N - vm.wallBack; i++) {
      inWall.add(i);
      const p = this.wallPose(i);
      this.tiles[i].setTarget(p.pos, p.quat, snap);
      this.tiles[i].setGlow(false);
    }
    for (let seat = 0; seat < 4; seat++) {
      const s = vm.seats[seat];
      // Hand
      const mine = seat === this.mySeat;
      let hand = s.hand.slice();
      if (mine || s.revealed) hand.sort((a, b) => this.tiles[a].kind - this.tiles[b].kind);
      const count = hand.length + (s.drawn !== null ? 1 : 0);
      const width = count * (W + L.gap) + (s.drawn !== null ? L.drawnGap : 0);
      let x = L.handCX - width / 2 + W / 2;
      const handQuat = this.seatQuat(seat, s.revealed ? Q_UP : Q_STAND);
      const hy = s.revealed ? Y + T / 2 : Y + H / 2;
      const hz = s.revealed ? L.handZ - 0.012 : L.handZ;
      for (const idx of hand) {
        this.tiles[idx].setTarget(toWorld(seat, x, hz).setY(hy), handQuat, snap);
        x += W + L.gap;
      }
      if (s.drawn !== null) {
        x += L.drawnGap;
        this.tiles[s.drawn].setTarget(toWorld(seat, x, hz).setY(hy), handQuat, snap);
      }
      // Bonus tiles (flowers / seasons), left of the hand.
      let bx = L.bonusX + W / 2;
      for (const idx of s.bonus) {
        this.tiles[idx].setTarget(toWorld(seat, bx, L.handZ).setY(Y + T / 2), this.seatQuat(seat, Q_UP), snap);
        bx += W + L.gap;
      }
      // Melds, from the right edge leftward.
      let mx = L.meldRight;
      for (const m of s.melds) {
        const n = m.tiles.length;
        const tiles = m.type === 'kong' && !m.concealed && m.added ? m.tiles.slice(0, 3) : m.tiles;
        for (let k = tiles.length - 1; k >= 0; k--) {
          const idx = tiles[k];
          const faceDown = m.concealed && (k === 0 || k === n - 1);
          this.tiles[idx].setTarget(toWorld(seat, mx - W / 2, L.meldZ).setY(Y + T / 2), this.seatQuat(seat, faceDown ? Q_DOWN : Q_UP), snap);
          if (k === 1 && m.added) {
            // The added kong tile sits on top of the middle tile.
            this.tiles[m.tiles[3]].setTarget(toWorld(seat, mx - W / 2, L.meldZ).setY(Y + T * 1.5 + 0.0005), this.seatQuat(seat, Q_UP), snap);
          }
          mx -= W + L.gap;
        }
        mx -= 0.01;
      }
      // Discards: rows of 7 in a pinwheel round the center.
      const left = L.discRight - L.discPerRow * W;
      s.discards.forEach((idx, k) => {
        const row = Math.floor(k / L.discPerRow);
        const col = k % L.discPerRow;
        const dx = left + W / 2 + col * W;
        const dz = L.discTopZ - row * (H + 0.002);
        this.tiles[idx].setTarget(toWorld(seat, dx, dz).setY(Y + T / 2), this.seatQuat(seat, Q_UP), snap);
        this.tiles[idx].setGlow(idx === vm.lastDiscard && !!st?.claiming);
      });
    }
    if (vm.pendingKong) {
      const { seat, idx } = vm.pendingKong;
      // Held up over the pung while others decide whether to rob it.
      const m = vm.seats[seat].melds.find((mm) => mm.type === 'pung' && this.tiles[mm.tiles[0]].kind === this.tiles[idx].kind);
      const base = m ? this.tiles[m.tiles[1]].target.pos.clone() : toWorld(seat, 0, L.meldZ).setY(Y);
      this.tiles[idx].setTarget(base.setY(Y + T * 2.5), this.seatQuat(seat, Q_UP), snap);
      this.tiles[idx].setGlow(true);
    }
    this.placeMarkers();
  }

  placeMarkers() {
    const st = this.state?.table;
    const mk = this.world.table.dealerMarker;
    if (!st || !this.vm) { mk.visible = false; return; }
    mk.visible = true;
    const p = toWorld(this.vm.dealer, -0.42, TABLE.half + TABLE.rim * 0.5);
    mk.position.set(p.x, Y + TABLE.rimH + 0.006, p.z);
  }

  // ---------------- reconcile with the authoritative state ----------------
  reconcile() {
    const st = this.state;
    if (!st) return;
    const t = st.table;
    if (!t.wallTotal || t.phase === 'idle' && !t.results) {
      // Between hands with nothing to show: tidy table.
      if (!t.wallTotal) { this.tiles.forEach((x) => { x.root.visible = false; }); this.vm = null; }
      this.refreshSeats();
      return;
    }
    if (this.vm && t.handNumber < this.vm.handNumber) { this.refreshSeats(); return; } // events ran ahead of the state
    if (!this.vm || this.vm.handNumber !== t.handNumber || this.vm.N !== t.wallTotal) {
      this.newVm(t.wallTotal, t.dealer, t.handNumber);
      this.rebuild(t);
      this.applyKinds(t);
      this.layout(true);
      this.refreshSeats();
      return;
    }
    const vm = this.vm;
    let ok = vm.wallFront === t.wallFront && vm.wallBack === t.wallBack && !!vm.pendingKong === !!t.pendingKong;
    for (let i = 0; i < 4 && ok; i++) {
      const s = t.seats[i]; const v = vm.seats[i];
      if (!s) { ok = v.hand.length === 0; continue; }
      const handN = v.hand.length + (v.drawn !== null ? 1 : 0);
      const wantHand = s.hand ? s.hand.length : s.handCount;
      ok = handN === wantHand && v.discards.length === s.discards.length && v.bonus.length === s.bonus.length
        && v.melds.length === s.melds.length && v.melds.every((m, k) => m.tiles.length === s.melds[k].tiles.length);
    }
    if (!ok) this.rebuild(t);
    this.applyKinds(t);
    this.layout();
    this.refreshSeats();
  }

  // Assign every tile object to a zone from scratch (joining mid-hand, or after a mismatch).
  rebuild(t) {
    const vm = this.vm;
    vm.dealer = t.dealer;
    vm.wallFront = t.wallFront;
    vm.wallBack = t.wallBack;
    const taken = [];
    for (let i = 0; i < t.wallFront; i++) taken.push(i);
    for (let i = vm.N - t.wallBack; i < vm.N; i++) taken.push(i);
    let p = 0;
    const next = () => taken[p++];
    vm.pendingKong = t.pendingKong ? { seat: t.pendingKong.seat, idx: next() } : null;
    for (let seat = 0; seat < 4; seat++) {
      const s = t.seats[seat];
      const v = vm.seats[seat] = emptySeat();
      if (!s) continue;
      v.bonus = s.bonus.map(() => next());
      v.melds = s.melds.map((m) => ({ type: m.type, concealed: m.concealed, added: false, tiles: m.tiles.map(() => next()) }));
      v.discards = s.discards.map(() => next());
      const n = s.hand ? s.hand.length : s.handCount;
      for (let k = 0; k < n; k++) v.hand.push(next());
      const drawnHere = t.phase === 'turn' && t.toAct === seat && n % 3 === 2;
      if (drawnHere && v.hand.length) v.drawn = v.hand.pop();
    }
    if (t.lastDiscard) {
      const d = vm.seats[t.lastDiscard.seat].discards;
      vm.lastDiscard = d[d.length - 1] ?? null;
    }
    for (const x of taken.slice(p)) this.tiles[x].root.visible = false; // shouldn't happen
  }

  // Faces from the authoritative state.
  applyKinds(t) {
    const vm = this.vm;
    const st = this.state;
    if (vm.pendingKong && t.pendingKong) this.tiles[vm.pendingKong.idx].setKind(t.pendingKong.tile);
    for (let seat = 0; seat < 4; seat++) {
      const s = t.seats[seat];
      const v = vm.seats[seat];
      if (!s) continue;
      s.bonus.forEach((k, j) => this.tiles[v.bonus[j]]?.setKind(k));
      s.discards.forEach((k, j) => this.tiles[v.discards[j]]?.setKind(k));
      s.melds.forEach((m, j) => m.tiles.forEach((k, q) => this.tiles[v.melds[j]?.tiles[q]]?.setKind(k)));
      v.revealed = !!s.hand;
      let known = null;
      if (s.hand) known = s.hand.slice();
      else if (seat === this.mySeat) known = st.you.hand.slice();
      const all = v.drawn !== null ? [...v.hand, v.drawn] : v.hand.slice();
      if (known && known.length === all.length) {
        // Drawn tile keeps its own face; the rest are dealt out sorted.
        const drawnKind = seat === this.mySeat && v.drawn !== null ? st.you.drawn : null;
        if (drawnKind !== null && drawnKind !== undefined && known.includes(drawnKind)) {
          known.splice(known.indexOf(drawnKind), 1);
          this.tiles[v.drawn].setKind(drawnKind);
          known.sort((a, b) => a - b).forEach((k, j) => this.tiles[v.hand[j]].setKind(k));
        } else {
          known.sort((a, b) => a - b);
          this.mergeDrawn(seat);
          known.forEach((k, j) => this.tiles[v.hand[j]].setKind(k));
        }
      } else {
        all.forEach((idx) => this.tiles[idx].setKind(-1));
      }
    }
  }

  // ---------------- seats / labels ----------------
  refreshSeats() {
    const st = this.state;
    if (!st) return;
    const t = st.table;
    const meSeated = this.mySeat >= 0;
    for (let i = 0; i < TABLE.seats; i++) {
      const s = t.seats[i];
      const seat = this.seats[i];
      const Lb = seat.label;
      if (!s) {
        seat.avatar.clear();
        Lb.obj.visible = false;
        seat.sitObj.visible = !meSeated;
        continue;
      }
      seat.sitObj.visible = false;
      const m = this.members.get(s.id);
      const color = m ? m.color : i;
      seat.avatar.setPlayer(s.name, color);
      seat.avatar.setCamOn(!!(m && m.media && m.media.cam && !this.hiddenVideo?.has(m.pid)));
      seat.avatar.group.visible = i !== this.mySeat;
      const won = t.results?.type === 'win' && t.results.winner === i && t.phase === 'over';
      seat.avatar.state = won ? 'winner' : 'idle';
      Lb.obj.visible = i !== this.mySeat;
      Lb.name.textContent = s.name;
      Lb.stack.textContent = `${fmt(s.points)} pts`;
      Lb.dot.style.background = SEAT_COLORS[color % 8];
      Lb.wind.textContent = t.gameActive || t.handNumber ? WIND_CHAR[s.wind] : '';
      Lb.wind.title = `${WIND_EN[s.wind]} seat`;
      Lb.wind.classList.toggle('dealer', s.wind === 0);
      const tags = [];
      if (s.wind === 0 && t.handNumber) tags.push('DEALER');
      if (s.sittingOut && !s.ghost) tags.push('AWAY');
      if (s.ghost) tags.push('LEFT');
      if (m && !m.connected) tags.push('OFFLINE');
      if (m && m.bot) tags.push('BOT');
      Lb.tag.textContent = tags.join(' · ');
      Lb.el.classList.toggle('acting', t.toAct === i);
      Lb.mic.style.display = m && m.media && m.media.mic ? '' : 'none';
    }
    this.updateTimers();
  }

  updateTimers() {
    const st = this.state;
    if (!st) return;
    const t = st.table;
    const now = Date.now();
    const total = Math.max(1, st.turnTotal || 20000);
    const left = st.deadline ? Math.max(0, st.deadline - now) : 0;
    for (let i = 0; i < TABLE.seats; i++) {
      const Lb = this.seats[i].label;
      if (t.toAct === i && st.deadline) {
        Lb.timerWrap.style.display = '';
        Lb.timer.style.width = `${(left / total) * 100}%`;
        Lb.timer.style.background = left < 5000 ? '#ff4d4d' : left < 10000 ? '#ffc53d' : '#5ee08a';
      } else Lb.timerWrap.style.display = 'none';
    }
    const live = t.phase === 'turn' || t.phase === 'claim' || t.phase === 'robkong';
    if (live && st.deadline && (t.toAct >= 0 || st.you.legal)) {
      const mine = !!st.you.legal;
      const name = t.toAct >= 0 ? t.seats[t.toAct]?.name || '' : '';
      this.onTimer?.({ seat: t.toAct, name, left, total, mine, claim: t.phase !== 'turn' });
    } else if (live && t.toAct >= 0) {
      this.onTimer?.({ seat: t.toAct, name: t.seats[t.toAct]?.name || '', left: 0, total: 0, mine: false, noClock: true });
    } else this.onTimer?.(null);
  }

  showAction(seat, text, cls = '') {
    if (seat < 0) return;
    const Lb = this.seats[seat].label;
    Lb.action.textContent = text;
    Lb.action.className = `sl-action show ${cls}`;
    clearTimeout(Lb.actionTimer);
    Lb.actionTimer = setTimeout(() => { Lb.action.className = 'sl-action'; }, 2400);
    if (seat === this.mySeat) this.onMyAction?.(text, cls);
  }

  showReaction(seat, emoji) {
    if (seat < 0) return;
    const Lb = this.seats[seat].label;
    const span = document.createElement('span');
    span.textContent = emoji;
    Lb.reaction.appendChild(span);
    setTimeout(() => span.remove(), 2200);
  }

  // ---------------- events ----------------
  handleEvents(events) {
    this.queue.push(...events);
    if (this.queue.length > 40 || document.hidden) setTweenSpeed(100);
    if (!this.processing) this.pump();
  }

  async pump() {
    this.processing = true;
    while (this.queue.length) {
      const ev = this.queue.shift();
      this.fast = this.queue.length > 12 || document.hidden;
      setTweenSpeed(this.fast ? 100 : this.queue.length > 4 ? 2 : 1);
      try { await this.play(ev); } catch (e) { console.error('event anim error', e); }
    }
    setTweenSpeed(1);
    this.fast = false;
    this.processing = false;
    this.reconcile();
  }

  async pause(s) { if (!this.fast && !this.instant) await wait(s); } // instant: tests / very slow devices

  async play(ev) {
    const st = this.state;
    switch (ev.type) {
      case 'deal': {
        const vm = this.newVm(ev.wallTotal, ev.dealer, ev.handNumber);
        this.layout(true);
        this.sfx?.play('shuffle');
        this.onDeal?.(ev);
        await this.pause(0.9);
        const order = [0, 1, 2, 3].map((k) => (ev.dealer + k) % 4);
        for (let r = 0; r < 3; r++) {
          for (const s of order) {
            for (let k = 0; k < 4; k++) vm.seats[s].hand.push(this.takeFront());
            this.layout();
            this.sfx?.play('draw');
            await this.pause(0.11);
          }
        }
        for (const s of order) vm.seats[s].hand.push(this.takeFront());
        vm.seats[ev.dealer].drawn = this.takeFront();
        if (st && this.mySeat >= 0 && st.table.handNumber === ev.handNumber) {
          const mine = vm.seats[this.mySeat];
          const kinds = st.you.hand.slice().sort((a, b) => a - b);
          const all = mine.drawn !== null ? [...mine.hand, mine.drawn] : mine.hand;
          if (kinds.length === all.length) all.forEach((idx, j) => this.tiles[idx].setKind(kinds[j]));
        }
        this.layout();
        await this.pause(0.45);
        break;
      }
      case 'bonus': {
        const vm = this.vm;
        if (!vm) break;
        const s = vm.seats[ev.seat];
        let idx;
        if (ev.src === 'hand') {
          idx = this.pickFromHand(ev.seat, ev.tile);
          s.hand.push(vm.N - ev.wb); // replacement from the back of the wall
          vm.wallBack = ev.wb;
        } else if (ev.src === 'front') { idx = ev.wf - 1; vm.wallFront = ev.wf; this.mergeDrawn(ev.seat); }
        else { idx = vm.N - ev.wb; vm.wallBack = ev.wb; this.mergeDrawn(ev.seat); }
        if (idx < 0 || idx === undefined) break;
        this.tiles[idx].setKind(ev.tile);
        s.bonus.push(idx);
        this.showAction(ev.seat, 'FLOWER', 'bonus');
        this.layout();
        this.sfx?.play('tile');
        await this.pause(0.35);
        break;
      }
      case 'draw': {
        const vm = this.vm;
        if (!vm) break;
        const idx = ev.src === 'back' ? vm.N - ev.wb : ev.wf - 1;
        vm.wallFront = ev.wf;
        vm.wallBack = ev.wb;
        this.mergeDrawn(ev.seat);
        vm.lastDiscard = null;
        if (vm.pendingKong) {
          // Nobody robbed the kong: the tile joins the pung.
          const pk = vm.pendingKong;
          const m = pk.meld || vm.seats[pk.seat].melds.find((mm) => mm.type === 'pung' && this.tiles[mm.tiles[0]].kind === this.tiles[pk.idx].kind);
          if (m) { m.type = 'kong'; m.added = true; m.tiles.push(pk.idx); }
          vm.pendingKong = null;
        }
        vm.seats[ev.seat].drawn = idx;
        if (ev.seat === this.mySeat && st?.you.drawn !== null && st?.you.drawn !== undefined && st.table.toAct === this.mySeat) this.tiles[idx].setKind(st.you.drawn);
        else this.tiles[idx].setKind(-1);
        this.layout();
        this.sfx?.play('draw');
        await this.pause(0.18);
        break;
      }
      case 'discard': {
        const vm = this.vm;
        if (!vm) break;
        const idx = this.pickFromHand(ev.seat, ev.tile, Math.random() < 0.55);
        if (idx < 0) break;
        this.tiles[idx].setKind(ev.tile);
        vm.seats[ev.seat].discards.push(idx);
        vm.lastDiscard = idx;
        this.layout();
        this.sfx?.play('tile');
        this.onDiscard?.(ev);
        await this.pause(0.3);
        break;
      }
      case 'claim': {
        const vm = this.vm;
        if (!vm) break;
        const from = vm.seats[ev.from];
        const claimed = from.discards.pop();
        const s = vm.seats[ev.seat];
        this.mergeDrawn(ev.seat);
        const own = ev.tiles.slice();
        own.splice(own.indexOf(ev.tile), 1);
        const idxs = own.map((k) => { const i = this.pickFromHand(ev.seat, k); if (i >= 0) this.tiles[i].setKind(k); return i; }).filter((i) => i >= 0);
        const tiles = [...idxs];
        const at = ev.action === 'chow' ? ev.tiles.indexOf(ev.tile) : 1;
        tiles.splice(Math.min(at, tiles.length), 0, claimed);
        s.melds.push({ type: ev.action, concealed: false, added: false, tiles });
        vm.lastDiscard = null;
        this.showAction(ev.seat, ev.action.toUpperCase() + '!', ev.action);
        this.sfx?.play('claim');
        this.layout();
        await this.pause(0.55);
        break;
      }
      case 'kong': {
        const vm = this.vm;
        if (!vm) break;
        const s = vm.seats[ev.seat];
        const idxs = [];
        for (let k = 0; k < 4; k++) { const i = this.pickFromHand(ev.seat, ev.tile); if (i >= 0) { this.tiles[i].setKind(ev.tile); idxs.push(i); } }
        s.melds.push({ type: 'kong', concealed: true, added: false, tiles: idxs });
        this.showAction(ev.seat, 'KONG!', 'kong');
        this.sfx?.play('claim');
        this.layout();
        await this.pause(0.5);
        break;
      }
      case 'addKong': {
        const vm = this.vm;
        if (!vm) break;
        const i = this.pickFromHand(ev.seat, ev.tile);
        if (i < 0) break;
        this.tiles[i].setKind(ev.tile);
        const m = vm.seats[ev.seat].melds.find((mm) => mm.type === 'pung' && this.tiles[mm.tiles[0]].kind === ev.tile);
        if (m && !(st?.table.pendingKong)) { m.type = 'kong'; m.added = true; m.tiles.push(i); }
        else vm.pendingKong = { seat: ev.seat, idx: i, meld: m };
        this.showAction(ev.seat, 'KONG!', 'kong');
        this.sfx?.play('claim');
        this.layout();
        await this.pause(0.5);
        break;
      }
      case 'win': {
        const vm = this.vm;
        if (!vm) break;
        const s = vm.seats[ev.seat];
        this.mergeDrawn(ev.seat);
        if (ev.robbingKong && vm.pendingKong) {
          s.hand.push(vm.pendingKong.idx);
          vm.pendingKong = null;
        } else if (ev.from !== null && ev.from !== undefined) {
          const d = vm.seats[ev.from].discards.pop();
          if (d !== undefined) s.hand.push(d);
        }
        vm.lastDiscard = null;
        this.showAction(ev.seat, ev.selfDrawn ? 'SELF-DRAWN!' : 'MAHJONG!', 'win');
        this.sfx?.play(ev.seat === this.mySeat ? 'bigwin' : 'win');
        this.seats[ev.seat].avatar.state = 'winner';
        // Hands are revealed from the state that follows.
        await this.pause(0.4);
        this.onWin?.(ev);
        break;
      }
      case 'drawGame':
        this.onDrawGame?.(ev);
        await this.pause(0.4);
        break;
      default:
        break;
    }
  }

  // ---------------- per-frame ----------------
  update(dt) {
    for (const t of this.tiles) if (t.root.visible) t.update(dt);
    const st = this.state;
    const toAct = st?.table.toAct;
    const actor = toAct != null && toAct >= 0 ? this.seats[toAct] : null;
    if (actor) (this._lookAt ||= new THREE.Vector3()).copy(actor.a.chair).setY(1.2);
    for (const s of this.seats) {
      s.avatar.lookAt = actor && actor !== s ? this._lookAt : null;
      s.avatar.update(dt, this.world.camera, toAct === s.i);
    }
    // Turn bar on the felt in front of whoever's turn it is; drains as a countdown.
    const bar = this.world.table.turnBar;
    if (st && toAct >= 0 && st.table.phase === 'turn') {
      const p = toWorld(toAct, 0, TABLE.half - 0.012);
      bar.position.set(p.x, Y + 0.0015, p.z);
      bar.rotation.y = seatYaw(toAct);
      const total = Math.max(1, st.turnTotal || 20000);
      const left = st.deadline ? Math.max(0, st.deadline - Date.now()) : total;
      const frac = st.deadline ? Math.min(1, left / total) : 1;
      bar.scale.x = Math.max(0.02, frac);
      bar.material.color.set(left < 5000 && st.deadline ? 0xff4d4d : left < 10000 && st.deadline ? 0xffc53d : 0x5ee08a);
      bar.visible = true;
      if (st.deadline && left < 5000 && this.mySeat === toAct) {
        const sec = Math.ceil(left / 1000);
        if (sec !== this.lastTick && sec > 0) { this.lastTick = sec; this.sfx?.play('tick'); }
      }
    } else bar.visible = false;
    this.timerAcc = (this.timerAcc || 0) + dt;
    if (this.timerAcc > 0.2) { this.timerAcc = 0; this.updateTimers(); }
  }

  setSpeaking(pid, level) {
    for (const s of this.seats) {
      const seatState = this.state?.table.seats[s.i];
      if (seatState && seatState.id === pid) {
        s.avatar.speaking = level;
        s.label.el.classList.toggle('speaking', level > 0.15);
      }
    }
  }

  setVideoForPid(pid, videoEl) {
    for (const s of this.seats) {
      const seatState = this.state?.table.seats[s.i];
      if (seatState && seatState.id === pid) s.avatar.setVideo(videoEl);
    }
  }

  rebindVideos(videoMap) {
    for (const s of this.seats) {
      const seatState = this.state?.table.seats[s.i];
      const v = seatState ? videoMap.get(seatState.id) : null;
      s.avatar.setVideo(v || null);
      const m = seatState ? this.members.get(seatState.id) : null;
      s.avatar.setCamOn(!!(m && m.media && m.media.cam && !this.hiddenVideo?.has(m.pid)));
    }
  }

  skipAnimations() { finishAllTweens(); }
}
