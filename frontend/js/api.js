// =====================================================================
// api.js — cliente compartido para hablar con PostgREST
// Cambiá API_URL por donde tengas corriendo tu PostgREST (local o deploy,
// ej: Render → "https://tu-app.onrender.com")
// =====================================================================
const API_URL = "http://localhost:3000"; // local mientras probás

const Auth = {
  getToken: () => localStorage.getItem("casino_token"),
  getRol: () => localStorage.getItem("casino_rol"),
  getUsername: () => localStorage.getItem("casino_username"),
  setSesion: (token, rol, username) => {
    localStorage.setItem("casino_token", token);
    localStorage.setItem("casino_rol", rol);
    localStorage.setItem("casino_username", username);
  },
  cerrarSesion: () => {
    localStorage.removeItem("casino_token");
    localStorage.removeItem("casino_rol");
    localStorage.removeItem("casino_username");
    window.location.href = "login.html";
  },
  requiereSesion: (rolRequerido) => {
    const token = Auth.getToken();
    if (!token) { window.location.href = "login.html"; return; }
    if (rolRequerido && Auth.getRol() !== rolRequerido) {
      window.location.href = "login.html";
    }
  }
};

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
