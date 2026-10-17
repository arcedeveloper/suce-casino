// =====================================================================
// api.js — cliente compartido: habla con el servidor Node (dev-server)
// En tu PC usa http://localhost:3000; en Render usa el mismo dominio del sitio.
// =====================================================================

// ⚠️ CAMBIO IMPORTANTE AQUÍ: Si estás en tu PC usa localhost, si estás en GitHub Pages usa Render.
const API_URL = ["localhost","127.0.0.1"].includes(location.hostname) 
  ? "http://localhost:3000" 
  : "https://suce-casino-backend.onrender.com";
 
// Las páginas de /juegos/ están una carpeta más adentro que el resto
const RAIZ = location.pathname.includes("/juegos/") ? "../" : "";
 
// =====================================================================
// SESIONES SEPARADAS
//   El navegador guarda UNA sola copia de localStorage por sitio, así que antes
//   entrar como jugador pisaba la sesión del admin. Ahora hay dos "ranuras":
//     suce_admin_*    → la usa admin.html
//     suce_jugador_*  → la usan el lobby y los juegos
//   Podés tener las dos abiertas a la vez en el mismo navegador.
// =====================================================================
const SLOT_PAGINA = /(^|\/)admin\.html$/.test(location.pathname) ? "admin" : "jugador";
const slotDeRol = (rol) => (rol === "admin" ? "admin" : "jugador");
const _k = (slot, campo) => `suce_${slot}_${campo}`;
const _leer = (slot, campo) => { try { return sessionStorage.getItem(_k(slot, campo)); } catch (e) { return null; } };
 
// La sesión vive solo en la pestaña (sessionStorage): al cerrar la pestaña o el navegador hay que volver a ingresar con contraseña.
// Limpia las sesiones viejas que quedaban guardadas "para siempre" en localStorage.
(function limpiarSesionesViejas() {
  try {
    ["casino_token", "casino_rol", "casino_username"].forEach((k) => localStorage.removeItem(k));
    ["admin", "jugador"].forEach((sl) => ["token", "rol", "username"].forEach((c) => localStorage.removeItem(`suce_${sl}_${c}`)));
  } catch (e) {}
})();
 
const Auth = {
  slot: SLOT_PAGINA,
  // Sin parámetro: la sesión que corresponde a ESTA página (admin.html → admin; el resto → jugador)
  getToken: (slot = SLOT_PAGINA) => _leer(slot, "token"),
  getRol: (slot = SLOT_PAGINA) => _leer(slot, "rol"),
  getUsername: (slot = SLOT_PAGINA) => _leer(slot, "username"),
  hay: (slot) => !!_leer(slot, "token"),
  setSesion: (token, rol, username) => {
    const slot = slotDeRol(rol);
    sessionStorage.setItem(_k(slot, "token"), token);
    sessionStorage.setItem(_k(slot, "rol"), rol);
    sessionStorage.setItem(_k(slot, "username"), username);
  },
  // Borra la sesión de esa ranura sin redirigir (lo usa la pantalla de login)
  olvidar: (slot = SLOT_PAGINA) => {
    ["token", "rol", "username"].forEach((c) => { try { sessionStorage.removeItem(_k(slot, c)); } catch (e) {} });
  },
  cerrarSesion: (slot = SLOT_PAGINA) => {
    Auth.olvidar(slot);
    window.location.href = RAIZ + "login.html" + (slot === "admin" ? "?rol=admin" : "");
  },
  requiereSesion: (rolRequerido) => {
    const slot = rolRequerido ? slotDeRol(rolRequerido) : SLOT_PAGINA;
    if (!_leer(slot, "token") || (rolRequerido && _leer(slot, "rol") !== rolRequerido)) {
      window.location.href = RAIZ + "login.html" + (slot === "admin" ? "?rol=admin" : "");
    }
  }
};
 
// Si el navegador muestra una página "de caché" al volver atrás y ya no hay sesión, mandar al login
window.addEventListener("pageshow", (e) => {
  if (e.persisted && !/(^|\/)(login|index)\.html$|\/$/.test(location.pathname) && !_leer(SLOT_PAGINA, "token")) {
    window.location.href = RAIZ + "login.html" + (SLOT_PAGINA === "admin" ? "?rol=admin" : "");
  }
});
 
async function llamarRPC(nombreFuncion, parametros = {}) {
  const headers = { "Content-Type": "application/json" };
  const token = Auth.getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
 
  const resp = await fetch(`${API_URL}/rpc/${nombreFuncion}`, {
    method: "POST",
    headers,
    body: JSON.stringify(parametros)
  });
 
  const data = await resp.json().catch(() => null);
 
  if (!resp.ok) {
    const mensaje = data?.message || "Error en el servidor";
    throw new Error(mensaje);
  }
  return data;
}
 
async function login(username, password) {
  const data = await llamarRPC("login", { p_username: username, p_password: password });
  Auth.setSesion(data.token, data.rol, data.username);
  return data;
}
 
async function obtenerMiSaldo() {
  return await llamarRPC("mi_saldo", {});
}
 
async function jugarTragamonedas(apuesta) {
  return await llamarRPC("jugar_tragamonedas", { p_apuesta: apuesta });
}
 
async function obtenerActividadReciente() {
  return await llamarRPC("actividad_reciente", {});
}
 
async function obtenerRanking() {
  return await llamarRPC("ranking_jugadores", {});
}
async function jugarMoneda(apuesta, eleccion) {
  return await llamarRPC("jugar_moneda", { p_apuesta: apuesta, p_eleccion: eleccion });
}
 
async function jugarDados(apuesta, eleccion) {
  return await llamarRPC("jugar_dados", { p_apuesta: apuesta, p_eleccion: eleccion });
}
 
async function jugarHilo(apuesta, eleccion) {
  return await llamarRPC("jugar_hilo", { p_apuesta: apuesta, p_eleccion: eleccion });
}
 
async function jugarCartaAlta(apuesta) {
  return await llamarRPC("jugar_carta_alta", { p_apuesta: apuesta });
}
 
async function jugarRuleta(apuesta, tipo, valor) {
  return await llamarRPC("jugar_ruleta", { p_apuesta: apuesta, p_tipo: tipo, p_valor: valor });
}
 
async function jugarKeno(apuesta, numero) {
  return await llamarRPC("jugar_keno", { p_apuesta: apuesta, p_numero: numero });
}
 
async function jugarRasca(apuesta) {
  return await llamarRPC("jugar_rasca", { p_apuesta: apuesta });
}
 
async function jugarRueda(apuesta) {
  return await llamarRPC("jugar_rueda", { p_apuesta: apuesta });
}
 
async function pvpCrearMesa(apuesta, juego = "carta_alta") {
  return await llamarRPC("pvp_crear_mesa", { p_apuesta: apuesta, p_juego: juego });
}
 
async function pvpMesasDisponibles(juego = "carta_alta") {
  return await llamarRPC("pvp_mesas_disponibles", { p_juego: juego });
}
 
async function pvpUnirseMesa(mesaId) {
  return await llamarRPC("pvp_unirse_mesa", { p_mesa_id: mesaId });
}
 
async function pvpEstadoMesa(mesaId) {
  return await llamarRPC("pvp_estado_mesa", { p_mesa_id: mesaId });
}
 
async function pvpCancelarMesa(mesaId) {
  return await llamarRPC("pvp_cancelar_mesa", { p_mesa_id: mesaId });
}
 
async function adminCrearUsuario(username, password) {
  // La contraseña viaja en texto plano SOLO porque va sobre HTTPS; el hash
  // (bcrypt vía crypt()) se calcula del lado del servidor, nunca en el navegador.
  return await llamarRPC("admin_crear_usuario", { p_username: username, p_password: password });
}
 
async function adminCargarFichas(usuarioId, monto) {
  return await llamarRPC("admin_cargar_fichas", { p_usuario_id: usuarioId, p_monto: monto });
}
 
// ---- Panel admin ----
const adminMetricas = () => llamarRPC("admin_metricas");
const adminListaUsuarios = () => llamarRPC("admin_lista_usuarios");
const adminDetalleUsuario = (id) => llamarRPC("admin_detalle_usuario", { p_usuario_id: id });
const adminActividad = (limite = 40) => llamarRPC("admin_actividad", { p_limite: limite });
const adminBloquearUsuario = (id, bloquear) => llamarRPC("admin_bloquear_usuario", { p_usuario_id: id, p_bloquear: bloquear });
const adminQuitarFichas = (id, monto) => llamarRPC("admin_quitar_fichas", { p_usuario_id: id, p_monto: monto });
const adminResetearPassword = (id, password) => llamarRPC("admin_resetear_password", { p_usuario_id: id, p_password: password });
 
// =====================================================================
// Tiempo real (WebSocket) — avisos del servidor: "algo cambió, volvé a pedir"
//   const off = Realtime.suscribir("lobby:dado_simple", (evento) => { ...refrescar... });
//   Realtime.alCambiarEstado((conectado) => { ... });
// Se reconecta solo. Si no hay conexión, las páginas usan un polling de respaldo.
// =====================================================================
const Realtime = (() => {
  const subs = new Map();          // canal -> Set<callback>
  const oyentesEstado = new Set();
  let ws = null, listo = false, yaConecto = false, intentos = 0, timerReconexion = null, pingTimer = null, cerradoAMano = false;
 
  const urlWS = () => (API_URL || location.origin).replace(/^http/, "ws") + "/ws";
 
  function avisarEstado() { oyentesEstado.forEach((cb) => { try { cb(listo); } catch (e) {} }); }
  function enviar(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
 
  function conectar() {
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
    const token = Auth.getToken();
    if (!token) return;
    cerradoAMano = false;
    try { ws = new WebSocket(urlWS()); } catch (e) { return reintentar(); }
 
    ws.onopen = () => enviar({ type: "auth", token });
    ws.onmessage = (m) => {
      let msg; try { msg = JSON.parse(m.data); } catch { return; }
      if (msg.type === "listo") {
        listo = true; intentos = 0;
        subs.forEach((_, canal) => { if (canal !== "yo") enviar({ type: "sub", canal }); });   // re-suscribe tras reconectar
        avisarEstado();
        // Si es una RE-conexión, pudimos perdernos eventos: pedimos refresco (la 1ª conexión no hace falta)
        if (yaConecto) subs.forEach((cbs, canal) => cbs.forEach((cb) => { try { cb({ canal, tipo: "reconectado" }); } catch (e) {} }));
        yaConecto = true;
        clearInterval(pingTimer);
        pingTimer = setInterval(() => enviar({ type: "ping" }), 25000);
      } else if (msg.type === "evento") {
        if (msg.canal === "yo" && msg.tipo === "bloqueado") return cuentaBloqueada();
        (subs.get(msg.canal) || []).forEach((cb) => { try { cb(msg); } catch (e) { console.error(e); } });
      }
    };
    ws.onclose = (ev) => {
      const estabaListo = listo;
      listo = false; clearInterval(pingTimer);
      if (estabaListo) avisarEstado();
      if (ev.code === 4004) { cuentaBloqueada(); return; }       // 4004 = cuenta bloqueada por el admin
      if (!cerradoAMano && ev.code !== 4002) reintentar();   // 4002 = token inválido: no insistir
    };
    ws.onerror = () => {};
  }
 
  let avisoBloqueo = false;
  function cuentaBloqueada() {
    if (avisoBloqueo) return;
    avisoBloqueo = true; cerradoAMano = true;
    alert("Tu cuenta fue bloqueada. Hablá con el administrador.");
    Auth.cerrarSesion();
  }
 
  function reintentar() {
    clearTimeout(timerReconexion);
    const espera = Math.min(15000, 1000 * 2 ** Math.min(intentos++, 4)) + Math.random() * 500;
    timerReconexion = setTimeout(conectar, espera);
  }
 
  return {
    get conectado() { return listo; },
    suscribir(canal, cb) {
      if (!subs.has(canal)) subs.set(canal, new Set());
      subs.get(canal).add(cb);
      if (listo && canal !== "yo") enviar({ type: "sub", canal });
      conectar();
      return () => {                      // función para desuscribirse
        const set = subs.get(canal);
        if (!set) return;
        set.delete(cb);
        if (set.size === 0) { subs.delete(canal); if (canal !== "yo") enviar({ type: "unsub", canal }); }
      };
    },
    alCambiarEstado(cb) { oyentesEstado.add(cb); return () => oyentesEstado.delete(cb); },
    cerrar() { cerradoAMano = true; clearTimeout(timerReconexion); if (ws) ws.close(); },
  };
})();
 
// Páginas de jugador: el saldo se actualiza solo (ej: el admin te cargó fichas) y,
// si te bloquean, se cierra la sesión al instante.
document.addEventListener("DOMContentLoaded", () => {
  const el = document.getElementById("saldo");
  if (!el || !Auth.getToken() || Auth.getRol() === "admin") return;
  const poner = (n) => {
    if (typeof n !== "number" || !isFinite(n)) return;
    el.textContent = fmtFichas(n);
    if (typeof Mesa !== "undefined") Mesa.saldoExterno(n);   // el rack de apuesta se entera del saldo nuevo
    el.classList.remove("saldo-flash"); void el.offsetWidth; el.classList.add("saldo-flash");
  };
  Realtime.suscribir("yo", async (ev) => {
    if (ev.tipo === "saldo") poner(ev.saldo);
    else if (ev.tipo === "reconectado") { try { poner(await obtenerMiSaldo()); } catch (e) {} }
  });
});
 
// ---- Fichas: formato y catálogo de juegos (límites de apuesta) ----
const fmtFichas = (n) => Number(n || 0).toLocaleString("es-PY");
const catalogoJuegos = () => llamarRPC("catalogo_juegos");
const adminConfigJuego = (id, min, max, activo) => llamarRPC("admin_config_juego", { p_id: id, p_min: min, p_max: max, p_activo: activo });
