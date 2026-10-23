// =====================================================================
// SUCE — kit de juegos (se carga DESPUÉS de api.js)
//   Mesa      saldo, rack de apuesta, banner de resultado, ronda de juego
//   Efectos   contador animado, lluvia de monedas
//   Sonido    sonidos sintetizados (sin archivos), con botón para silenciar
//   chipSVG   ficha de casino dibujada en SVG
// =====================================================================
const DENOMS = [100, 500, 1000, 5000, 10000, 25000, 50000, 100000];
const COLOR_FICHA = {            // [claro, oscuro, texto]
  100:    ["#fb7185", "#9f1239", "#ffffff"],
  500:    ["#60a5fa", "#1e40af", "#ffffff"],
  1000:   ["#5eead4", "#0f766e", "#042f2e"],
  5000:   ["#c4b5fd", "#5b21b6", "#ffffff"],
  10000:  ["#f0abfc", "#a21caf", "#ffffff"],
  25000:  ["#e2e8f0", "#475569", "#0f172a"],
  50000:  ["#475569", "#020617", "#5eead4"],
  100000: ["#1e293b", "#000000", "#2dd4bf"],
};
const cortoFicha = (d) => (d >= 1000 ? d / 1000 + "K" : String(d));

function chipSVG(d) {
  const [c1, c2, tx] = COLOR_FICHA[d] || COLOR_FICHA[1000];
  const t = cortoFicha(d);
  const fs = t.length >= 4 ? 12 : t.length === 3 ? 14 : 17;
  return `<svg class="chip-svg" viewBox="0 0 64 64" aria-hidden="true">
    <defs><radialGradient id="cg${d}" cx="35%" cy="30%" r="85%"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></radialGradient></defs>
    <circle cx="32" cy="32" r="30" fill="url(#cg${d})"/>
    <circle cx="32" cy="32" r="26.4" fill="none" stroke="#fff" stroke-width="5.4" stroke-dasharray="10.37 10.37" opacity=".92"/>
    <circle cx="32" cy="32" r="30" fill="none" stroke="rgba(0,0,0,.4)" stroke-width="1"/>
    <circle cx="32" cy="32" r="19.4" fill="url(#cg${d})" stroke="rgba(255,255,255,.8)" stroke-width="1.2"/>
    <text x="32" y="${32 + fs * 0.36}" text-anchor="middle" font-family="Poppins, system-ui, sans-serif" font-weight="700" font-size="${fs}" fill="${tx}">${t}</text>
  </svg>`;
}

// ---------------------------------------------------------------------
const $q = (s, r = document) => r.querySelector(s);

const Efectos = {
  reducido: !!(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches),
  esperar: (ms) => new Promise((r) => setTimeout(r, ms)),

  // Cuenta de un número a otro (saldo, premios)
  contar(el, desde, hasta, ms = 700) {
    if (!el) return;
    if (Efectos.reducido || desde === hasta) { el.textContent = fmtFichas(hasta); return; }
    const t0 = performance.now();
    const paso = (t) => {
      const k = Math.min(1, (t - t0) / ms), e = 1 - Math.pow(1 - k, 3);
      el.textContent = fmtFichas(Math.round(desde + (hasta - desde) * e));
      if (k < 1) requestAnimationFrame(paso);
    };
    requestAnimationFrame(paso);
  },

  // Lluvia de monedas sobre un contenedor (la mesa)
  lluvia(host, cantidad = 40) {
    if (Efectos.reducido || !host) return;
    const cv = document.createElement("canvas");
    cv.className = "lluvia";
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = host.clientWidth, h = host.clientHeight;
    cv.width = w * dpr; cv.height = h * dpr;
    host.appendChild(cv);
    const g = cv.getContext("2d"); g.scale(dpr, dpr);
    const ps = Array.from({ length: cantidad }, () => ({
      x: w * (0.15 + Math.random() * 0.7), y: -20 - Math.random() * h * 0.5,
      vx: (Math.random() - 0.5) * 2.4, vy: 1.5 + Math.random() * 3, r: 6 + Math.random() * 6,
      a: Math.random() * 6.28, va: 0.12 + Math.random() * 0.2, chispa: Math.random() < 0.18,
    }));
    const t0 = performance.now();
    (function cuadro(t) {
      const dt = t - t0;
      g.clearRect(0, 0, w, h);
      for (const p of ps) {
        p.vy += 0.11; p.x += p.vx; p.y += p.vy; p.a += p.va;
        const ancho = Math.abs(Math.cos(p.a)) * p.r + 1;
        g.globalAlpha = Math.max(0, 1 - Math.max(0, dt - 1500) / 900);
        if (p.chispa) { g.fillStyle = "#fff"; g.fillRect(p.x, p.y, 2.5, 2.5); continue; }
        const gr = g.createLinearGradient(p.x - ancho, p.y, p.x + ancho, p.y);
        gr.addColorStop(0, "#5eead4"); gr.addColorStop(1, "#0f766e");
        g.fillStyle = gr; g.beginPath(); g.ellipse(p.x, p.y, ancho, p.r, 0, 0, 6.283); g.fill();
        g.strokeStyle = "rgba(255,255,255,.55)"; g.lineWidth = 1; g.stroke();
      }
      if (dt < 2400) requestAnimationFrame(cuadro); else cv.remove();
    })(t0);
  },
};

// ---------------------------------------------------------------------
const Sonido = {
  on: (() => { try { return (localStorage.getItem("suce_sonido") ?? "on") === "on"; } catch (e) { return true; } })(),
  ctx: null, master: null, buf: {}, _cargado: false,

  // ---- Motor de audio: volumen general + compresor + un poco de eco de sala ----
  _c() {
    if (!this.ctx) {
      try {
        const c = this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        const comp = c.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 4;
        const g = c.createGain(); g.gain.value = 1;
        // eco de sala sintético (ruido que decae)
        const largo = Math.floor(c.sampleRate * 1.5), imp = c.createBuffer(2, largo, c.sampleRate);
        for (let ch = 0; ch < 2; ch++) { const d = imp.getChannelData(ch); for (let i = 0; i < largo; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / largo, 2.6); }
        const conv = c.createConvolver(); conv.buffer = imp;
        const humedo = c.createGain(); humedo.gain.value = 0.2;
        g.connect(comp); g.connect(humedo); humedo.connect(conv); conv.connect(comp); comp.connect(c.destination);
        this.master = g;
      } catch (e) { return null; }
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
    if (!this._cargado) { this._cargado = true; this._cargarArchivos(); }
    return this.ctx;
  },

  // ---- Sonidos reales opcionales: si existe /sonidos/sonidos.json se usan; si no, suena el generado ----
  async _cargarArchivos() {
    try {
      const raiz = typeof RAIZ !== "undefined" ? RAIZ : "../";
      const r = await fetch(raiz + "sonidos/sonidos.json", { cache: "no-cache" });
      if (!r.ok) return;
      const lista = await r.json();
      await Promise.all(Object.entries(lista).map(async ([nombre, archivo]) => {
        try {
          const res = await fetch(raiz + "sonidos/" + archivo); if (!res.ok) return;
          this.buf[nombre] = await this.ctx.decodeAudioData(await res.arrayBuffer());
        } catch (e) {}
      }));
    } catch (e) {}
  },
  _archivo(n, vol = 0.9) {
    const c = this._c(); if (!c) return;
    const src = c.createBufferSource(), g = c.createGain();
    src.buffer = this.buf[n]; src.playbackRate.value = 0.97 + Math.random() * 0.06; g.gain.value = vol;
    src.connect(g).connect(this.master); src.start();
  },

  // ---- Piezas básicas ----
  nota(f, dur = 0.12, tipo = "sine", vol = 0.2, retraso = 0, fHasta = null) {
    const c = this._c(); if (!c) return;
    const o = c.createOscillator(), v = c.createGain(), t = c.currentTime + retraso;
    o.type = tipo; o.frequency.setValueAtTime(f, t);
    if (fHasta) o.frequency.exponentialRampToValueAtTime(fHasta, t + dur);
    v.gain.setValueAtTime(0.0001, t); v.gain.exponentialRampToValueAtTime(vol, t + 0.008); v.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(v).connect(this.master); o.start(t); o.stop(t + dur + 0.03);
  },
  // Campana / metal: varios tonos que no son múltiplos exactos (suena a ficha, moneda, campanilla)
  campana(f, dur = 0.6, vol = 0.16, retraso = 0) {
    [[1, 1, 1], [2.76, 0.55, 0.7], [5.4, 0.3, 0.45], [8.93, 0.14, 0.3]].forEach(([m, a, d]) => this.nota(f * m, dur * d, "sine", vol * a, retraso));
  },
  ruido(dur = 0.04, freq = 2500, vol = 0.25, retraso = 0, q = 1.2) {
    const c = this._c(); if (!c) return;
    const n = Math.max(1, Math.floor(c.sampleRate * dur)), buf = c.createBuffer(1, n, c.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 2);
    const src = c.createBufferSource(), f = c.createBiquadFilter(), v = c.createGain();
    f.type = "bandpass"; f.frequency.value = freq; f.Q.value = q; v.gain.value = vol;
    src.buffer = buf; src.connect(f).connect(v).connect(this.master); src.start(c.currentTime + retraso);
  },
  // Soplido que sube o baja de tono (carta que se desliza, subida de tensión)
  barrido(dur, f0, f1, vol = 0.25, retraso = 0) {
    const c = this._c(); if (!c) return;
    const n = Math.floor(c.sampleRate * dur), buf = c.createBuffer(1, n, c.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.sin(Math.PI * i / n);
    const src = c.createBufferSource(), f = c.createBiquadFilter(), v = c.createGain(), t = c.currentTime + retraso;
    f.type = "bandpass"; f.Q.value = 1.4; f.frequency.setValueAtTime(f0, t); f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    v.gain.value = vol; src.buffer = buf; src.connect(f).connect(v).connect(this.master); src.start(t);
  },
  _r: () => 0.96 + Math.random() * 0.08,   // pequeña variación para que no suene siempre igual

  tocar(n, extra) {
    if (!this.on) return;
    if (this.buf[n]) return this._archivo(n);
    const r = this._r();
    switch (n) {
      case "click":  this.ruido(0.02, 3800, 0.2); this.nota(1200 * r, 0.03, "triangle", 0.06); break;
      case "ficha":  this.campana(2300 * r, 0.4, 0.13); this.campana(3500 * r, 0.25, 0.07, 0.03); this.ruido(0.03, 5200, 0.16); break;
      case "tick":   this.ruido(0.03, 2400 * r, 0.3); this.nota(720 * r, 0.025, "square", 0.05); break;
      case "stop":   this.nota(160, 0.18, "sine", 0.42, 0, 70); this.ruido(0.07, 1000, 0.3); this.ruido(0.03, 3000, 0.2, 0.02); break;
      case "rebote": [0, .09, .17, .23, .28, .32].forEach((t, i) => { this.ruido(0.03, 3200 - i * 250, 0.26 - i * 0.03, t); this.nota((900 - i * 70) * r, 0.03, "square", 0.04, t); }); break;
      case "carta":  this.barrido(0.14, 1200, 5200, 0.3); this.ruido(0.03, 2500, 0.15, 0.12); break;
      case "dado":   [0, .07, .15, .21, .28, .33].forEach((t) => this.ruido(0.04, 1400 + Math.random() * 1600, 0.3, t)); break;
      case "moneda": this.campana(1900 * r, 0.9, 0.16); this.campana(2850 * r, 0.7, 0.09); this.ruido(0.04, 6000, 0.2); break;
      case "win":    [523, 659, 784, 1047].forEach((f, i) => { this.campana(f, 0.8, 0.15, i * 0.1); }); this.campana(2093, 0.9, 0.07, 0.38); this.ruido(0.1, 7000, 0.08, 0.38); break;
      case "bigwin": {
        this.barrido(0.5, 400, 6500, 0.22);
        [523, 659, 784, 1047, 1319, 1568, 2093].forEach((f, i) => { this.campana(f, 1.0, 0.15, 0.45 + i * 0.09); });
        this.nota(131, 0.9, "triangle", 0.3, 0.45); this.nota(196, 0.9, "triangle", 0.22, 0.45);
        for (let i = 0; i < 14; i++) { const t = 0.7 + i * 0.07 + Math.random() * 0.03; this.campana(2200 + Math.random() * 1400, 0.25, 0.08, t); this.ruido(0.03, 5000, 0.12, t); }
        break;
      }
      case "lose":   this.nota(392, 0.35, "sawtooth", 0.09, 0, 250); this.nota(294, 0.55, "sawtooth", 0.09, 0.2, 170); break;
    }
  },
  // Giro: "clic clic clic" que se va frenando durante `ms`. tipo "motor" agrega el zumbido de una máquina girando.
  giro(ms, clics = 38, tipo = "clic") {
    let vivo = true; const timers = [], c = this.on && !Efectos.reducido ? this._c() : null;
    if (c) {
      for (let i = 0; i < clics; i++) {
        const k = i / (clics - 1), cuando = ms * (1 - Math.pow(1 - k, 2.2)) * 0.97;
        timers.push(setTimeout(() => { if (vivo) this.tocar("tick"); }, cuando));
      }
      if (tipo === "motor") {
        const t = c.currentTime, o = c.createOscillator(), f = c.createBiquadFilter(), g = c.createGain(), d = ms / 1000;
        o.type = "sawtooth"; o.frequency.setValueAtTime(70, t); o.frequency.exponentialRampToValueAtTime(190, t + d * 0.25); o.frequency.exponentialRampToValueAtTime(55, t + d);
        f.type = "lowpass"; f.frequency.value = 520;
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.1, t + 0.12); g.gain.setValueAtTime(0.1, t + d * 0.7); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
        o.connect(f).connect(g).connect(this.master); o.start(t); o.stop(t + d + 0.05);
      }
    }
    return () => { vivo = false; timers.forEach(clearTimeout); };
  },
  alternar() {
    this.on = !this.on;
    try { localStorage.setItem("suce_sonido", this.on ? "on" : "off"); } catch (e) {}
    this.pintarBoton(); if (this.on) this.tocar("click");
  },
  pintarBoton() { const b = $q("#btn-sonido"); if (b) { b.textContent = this.on ? "🔊" : "🔇"; b.setAttribute("aria-label", this.on ? "Silenciar" : "Activar sonido"); } },
  montarBoton() {
    const host = $q(".juego-top .derecha"); if (!host || $q("#btn-sonido")) return;
    const b = document.createElement("button");
    b.id = "btn-sonido"; b.className = "btn-icono"; b.type = "button"; b.onclick = () => Sonido.alternar();
    host.prepend(b); this.pintarBoton();
  },
};
// Primer toque en cualquier parte de la página → el audio queda habilitado
["pointerdown", "keydown", "touchstart"].forEach((ev) => document.addEventListener(ev, () => Sonido._c(), { once: true, passive: true }));

// ---------------------------------------------------------------------
// Rack de apuesta: fichas, pila visual y atajos
// ---------------------------------------------------------------------
function crearRack(host, { min, max, inicial, onChange }) {
  const st = { min, max, valor: 0, ultima: null, bloq: false };
  const fichas = DENOMS.filter((d) => d <= max);
  host.classList.add("rack");
  host.innerHTML = `
    <div class="rack-top">
      <div class="rack-valor"><small>Tu apuesta</small><b id="rack-num">0</b></div>
      <div class="pila" id="rack-pila" aria-hidden="true"></div>
    </div>
    <div class="rack-chips" role="group" aria-label="Fichas de apuesta">
      ${fichas.map((d) => `<button type="button" class="chip" data-d="${d}" aria-label="Sumar ${fmtFichas(d)} fichas">${chipSVG(d)}</button>`).join("")}
    </div>
    <div class="rack-acciones">
      <button type="button" class="acc" data-a="borrar">Mínima</button>
      <button type="button" class="acc" data-a="mitad">½</button>
      <button type="button" class="acc" data-a="doble">×2</button>
      <button type="button" class="acc" data-a="max">Máxima</button>
      <button type="button" class="acc" data-a="repetir">Repetir última</button>
    </div>
    <div class="rack-aviso" id="rack-aviso" role="status"></div>`;

  const num = $q("#rack-num", host), pila = $q("#rack-pila", host), aviso = $q("#rack-aviso", host);
  const clamp = (v) => Math.max(st.min, Math.min(st.max, Math.round(v)));
  const redondeo = (v) => (v >= 1000 ? Math.round(v / 100) * 100 : Math.round(v / 10) * 10);

  function pintarPila(animarUltima) {
    let v = st.valor; const out = [];
    for (const d of [...DENOMS].reverse()) while (v >= d && out.length < 40) { out.push(d); v -= d; }
    const visibles = out.slice(0, 7).reverse();
    pila.innerHTML = visibles.map((d) => `<div class="p" ${animarUltima ? "" : 'style="animation:none"'}>${chipSVG(d)}</div>`).join("")
      + (out.length > 7 ? `<span class="extra">+${out.length - 7}</span>` : "");
  }

  function refrescar(animar) {
    num.textContent = fmtFichas(st.valor);
    if (animar) { num.classList.remove("bump"); void num.offsetWidth; num.classList.add("bump"); }
    pintarPila(animar);
    const saldo = Mesa.saldo;
    if (st.valor > saldo) { aviso.textContent = "Tu saldo no alcanza para esta apuesta"; aviso.className = "rack-aviso mal"; }
    else { aviso.textContent = `Límite en este juego: ${fmtFichas(st.min)} a ${fmtFichas(st.max)}`; aviso.className = "rack-aviso"; }
    host.querySelectorAll("button").forEach((b) => (b.disabled = st.bloq));
    if (onChange) onChange(st.valor, ctrl.valido());
  }

  function poner(v, animar = true) { st.valor = clamp(v); refrescar(animar); }

  host.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b || st.bloq) return;
    Sonido.tocar("ficha");
    if (b.dataset.d) { poner(st.valor + Number(b.dataset.d)); return; }
    const a = b.dataset.a;
    if (a === "borrar") poner(st.min);
    else if (a === "mitad") poner(redondeo(st.valor / 2));
    else if (a === "doble") poner(st.valor * 2);
    else if (a === "max") poner(Math.min(st.max, Math.max(st.min, Mesa.saldo)));
    else if (a === "repetir" && st.ultima) poner(st.ultima);
  });

  const ctrl = {
    get valor() { return st.valor; },
    get min() { return st.min; },
    get max() { return st.max; },
    valido: () => st.valor >= st.min && st.valor <= st.max && st.valor <= Mesa.saldo,
    bloquear(b) { st.bloq = !!b; refrescar(false); },
    recordar() { st.ultima = st.valor; },
    refrescar: () => refrescar(false),
    poner,
    aviso(txt, mal = true) { aviso.textContent = txt; aviso.className = "rack-aviso" + (mal ? " mal" : ""); },
  };
  poner(inicial, false);
  return ctrl;
}

// ---------------------------------------------------------------------
// La mesa de juego
// ---------------------------------------------------------------------
const Mesa = {
  saldo: 0,
  ctrl: null,
  ocupado: false,
  _timerResultado: null,

  pintarSaldo(n, animar) {
    const el = $q("#saldo"); if (!el) return;
    if (animar) Efectos.contar(el, Mesa.saldo, n, 700); else el.textContent = fmtFichas(n);
  },
  setSaldo(n, animar = true) {
    n = Number(n) || 0;
    Mesa.pintarSaldo(n, animar); Mesa.saldo = n;
    if (Mesa.ctrl) Mesa.ctrl.refrescar();
  },
  // lo llama api.js cuando el servidor avisa de un saldo nuevo (ej: el admin cargó fichas)
  saldoExterno(n) { Mesa.saldo = Number(n) || 0; if (Mesa.ctrl) Mesa.ctrl.refrescar(); },

  async iniciar({ juego, rack = "#rack", inicial = 1000, onApuesta } = {}) {
    try { Mesa.saldo = Number(await obtenerMiSaldo()) || 0; } catch (e) { Mesa.saldo = 0; }
    Mesa.pintarSaldo(Mesa.saldo, false);
    let lim = { min: 100, max: 100000, activo: true };
    try {
      const j = (await catalogoJuegos()).find((x) => x.id === juego);
      if (j) lim = { min: Number(j.apuesta_min), max: Number(j.apuesta_max), activo: j.activo };
    } catch (e) {}
    Mesa.ctrl = crearRack($q(rack), { min: lim.min, max: lim.max, inicial: Math.min(Math.max(inicial, lim.min), lim.max), onChange: onApuesta });
    Sonido.montarBoton();
    if (!lim.activo) { Mesa.ctrl.aviso("Este juego está apagado por ahora."); Mesa.ctrl.bloquear(true); }
    return Mesa.ctrl;
  },

  // Ejecuta una ronda: bloquea, llama a tu función con la apuesta, y siempre desbloquea
  async ronda(btn, fn) {
    if (Mesa.ocupado || !Mesa.ctrl) return;
    if (!Mesa.ctrl.valido()) {
      Mesa.ctrl.aviso(Mesa.ctrl.valor > Mesa.saldo ? "Tu saldo no alcanza para esta apuesta" : "Revisá el monto de la apuesta");
      return;
    }
    Mesa.ocupado = true; if (btn) btn.disabled = true;
    Mesa.ctrl.bloquear(true); Mesa.ocultarResultado();
    try { Mesa.ctrl.recordar(); await fn(Mesa.ctrl.valor); }
    catch (e) { Mesa.ctrl.aviso(e.message || "No se pudo jugar", true); }
    finally { Mesa.ocupado = false; if (btn) btn.disabled = false; Mesa.ctrl.bloquear(false); }
  },

  ocultarResultado() {
    clearTimeout(Mesa._timerResultado);
    const el = $q("#resultado"); if (el) el.classList.remove("on");
  },

  // Banner de resultado + efectos. `ganancia` es lo que COBRA el jugador (0 si perdió).
  resultado({ apuesta, ganancia, detalle, duracion = 2800 }) {
    const el = $q("#resultado"); if (!el) return;
    const neto = ganancia - apuesta;
    let cls, grande, chico = detalle || "";
    if (ganancia > apuesta) {
      cls = "gana"; grande = `¡Ganaste ${fmtFichas(neto)}!`; chico = chico || `Cobrás ${fmtFichas(ganancia)} fichas`;
      const mult = ganancia / apuesta;
      Efectos.lluvia(el.parentElement, Math.min(90, Math.round(26 + mult * 9)));
      Sonido.tocar(mult >= 5 ? "bigwin" : "win");
    } else if (ganancia === apuesta) {
      cls = "empata"; grande = "Apuesta devuelta"; Sonido.tocar("click");
    } else if (ganancia > 0) {
      cls = "pierde"; grande = `Recuperás ${fmtFichas(ganancia)}`; chico = chico || `Perdés ${fmtFichas(apuesta - ganancia)}`; Sonido.tocar("lose");
    } else {
      cls = "pierde"; grande = "Sin premio"; chico = chico || `−${fmtFichas(apuesta)} fichas`; Sonido.tocar("lose");
    }
    el.className = "resultado " + cls;
    el.innerHTML = `<div class="grande">${grande}</div><div class="chico">${chico}</div>`;
    void el.offsetWidth; el.classList.add("on");
    const m = $q("#mensaje"); if (m) m.textContent = `${grande} ${chico}`;
    clearTimeout(Mesa._timerResultado);
    Mesa._timerResultado = setTimeout(() => el.classList.remove("on"), duracion);
  },
};

// ---------------------------------------------------------------------
// Piezas visuales compartidas: cartas, dados, selector de opciones
// ---------------------------------------------------------------------
const PALOS = ["♠", "♥", "♦", "♣"];
const NOM_CARTA = { 1: "A", 11: "J", 12: "Q", 13: "K" };
// Carta con dorso y frente; sumale la clase "abierta" para darla vuelta
function cartaHTML(n, palo) {
  palo = palo || PALOS[Math.floor(Math.random() * 4)];
  const r = n ? NOM_CARTA[n] || n : "";
  const rojo = palo === "♥" || palo === "♦";
  return `<div class="carta"><div class="cara dorso"></div>
    <div class="cara frente${rojo ? " rojo" : ""}"><b class="esq">${r}<i>${palo}</i></b><span class="palo">${palo}</span><b class="esq inv">${r}<i>${palo}</i></b></div></div>`;
}
// Dado con puntos (1 a 6)
const PUNTOS = { 1: [5], 2: [1, 9], 3: [1, 5, 9], 4: [1, 3, 7, 9], 5: [1, 3, 5, 7, 9], 6: [1, 3, 4, 6, 7, 9] };
function dadoHTML(n) {
  return Array.from({ length: 9 }, (_, i) => `<i${(PUNTOS[n] || []).includes(i + 1) ? ' class="pt"' : ""}></i>`).join("");
}
// Botones de opción: devuelve ctrl con .valor; llama onChange(valor)
function crearOpciones(host, onChange) {
  const st = { valor: null };
  host.addEventListener("click", (e) => {
    const b = e.target.closest("button.opcion"); if (!b || b.disabled) return;
    host.querySelectorAll("button.opcion").forEach((x) => x.classList.toggle("sel", x === b));
    st.valor = b.dataset.v; Sonido.tocar("click"); if (onChange) onChange(st.valor);
  });
  return { get valor() { return st.valor; }, bloquear(b) { host.querySelectorAll("button").forEach((x) => (x.disabled = b)); } };
}
