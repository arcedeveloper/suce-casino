// =====================================================================
// SUCE — tiempo real con WebSockets
//
// Mesas PvP: el WebSocket es un "timbre" — el navegador vuelve a pedir el estado
// con las mismas funciones de siempre (que validan permisos en SQL).
// Panel admin: el aviso trae el dato ya listo (fila del jugador, jugada, métricas),
// así el panel se actualiza sin hacer ninguna petición. Solo lo reciben admins.
//
// Protocolo (JSON):
//   cliente → servidor
//     {type:"auth", token:"<JWT>"}            (obligatorio, primer mensaje)
//     {type:"sub",  canal:"lobby:dado_simple"} | "mesa:123" | "admin"
//     {type:"unsub", canal:"..."}
//   servidor → cliente
//     {type:"listo", username}
//     {type:"evento", canal:"...", tipo:"...", ...datos}   (para el canal "admin" los datos viajan en el evento)
//     canal "yo": avisos directos al jugador (saldo nuevo, bloqueado). No requiere suscripción.
//     {type:"error", message:"..."}
// =====================================================================
const { WebSocketServer } = require("ws");

const CANAL_VALIDO = /^(lobby:[a-z_]{1,30}|mesa:\d{1,18}|admin)$/;
const MAX_SUBS_POR_SOCKET = 10;
const MAX_SOCKETS_POR_USUARIO = 6;
const TIMEOUT_AUTH_MS = 8000;
const PING_MS = 30000;

function crearRealtime(httpServer, { jwt, jwtSecret }) {
  const wss = new WebSocketServer({ server: httpServer, path: "/ws", maxPayload: 4096 });
  const canales = new Map();            // canal -> Set<socket>
  const porUsuario = new Map();         // userId -> cantidad de sockets
  const socketsUsuario = new Map();     // userId -> Set<socket> (para avisarle directo a un jugador)
  const ultimoEnvio = new Map();        // canal -> timestamp (para throttle)
  const pendientes = new Map();         // canal -> timer (throttle trailing)

  function enviar(ws, obj) {
    if (ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  function desuscribirTodo(ws) {
    for (const canal of ws.canales || []) {
      const set = canales.get(canal);
      if (set) { set.delete(ws); if (set.size === 0) canales.delete(canal); }
    }
    ws.canales = new Set();
  }

  wss.on("connection", (ws) => {
    ws.autenticado = false;
    ws.canales = new Set();
    ws.viva = true;

    const timerAuth = setTimeout(() => { if (!ws.autenticado) ws.close(4001, "auth timeout"); }, TIMEOUT_AUTH_MS);

    ws.on("pong", () => { ws.viva = true; });

    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return enviar(ws, { type: "error", message: "JSON inválido" }); }

      if (msg.type === "auth") {
        if (ws.autenticado) return;
        try {
          const claims = jwt.verify(String(msg.token || ""), jwtSecret);
          const n = porUsuario.get(claims.sub) || 0;
          if (n >= MAX_SOCKETS_POR_USUARIO) return ws.close(4003, "demasiadas conexiones");
          porUsuario.set(claims.sub, n + 1);
          if (!socketsUsuario.has(claims.sub)) socketsUsuario.set(claims.sub, new Set());
          socketsUsuario.get(claims.sub).add(ws);
          ws.autenticado = true;
          ws.userId = claims.sub;
          ws.rol = claims.rol;
          ws.expMs = (claims.exp || 0) * 1000;
          clearTimeout(timerAuth);
          enviar(ws, { type: "listo", username: claims.username });
          // Presencia: primera pestaña de este usuario → "se conectó"
          if (n === 0) emitir("admin", { tipo: "presencia", id: claims.sub, username: claims.username, online: true });
        } catch {
          ws.close(4002, "token inválido");
        }
        return;
      }

      if (!ws.autenticado) return ws.close(4002, "no autenticado");

      if (msg.type === "sub") {
        const canal = String(msg.canal || "");
        if (!CANAL_VALIDO.test(canal)) return enviar(ws, { type: "error", message: "Canal inválido" });
        if (canal === "admin" && ws.rol !== "admin") return enviar(ws, { type: "error", message: "No autorizado" });
        if (ws.canales.size >= MAX_SUBS_POR_SOCKET && !ws.canales.has(canal)) {
          return enviar(ws, { type: "error", message: "Demasiadas suscripciones" });
        }
        ws.canales.add(canal);
        if (!canales.has(canal)) canales.set(canal, new Set());
        canales.get(canal).add(ws);
        enviar(ws, { type: "suscripto", canal });
        // Al entrar al panel admin, le mandamos quién está en línea ahora mismo
        if (canal === "admin") enviar(ws, { type: "evento", canal: "admin", tipo: "presencia_snapshot", online: [...porUsuario.keys()] });
      } else if (msg.type === "unsub") {
        const canal = String(msg.canal || "");
        ws.canales.delete(canal);
        const set = canales.get(canal);
        if (set) { set.delete(ws); if (set.size === 0) canales.delete(canal); }
      }
    });

    ws.on("close", () => {
      clearTimeout(timerAuth);
      desuscribirTodo(ws);
      if (ws.autenticado) {
        const n = (porUsuario.get(ws.userId) || 1) - 1;
        if (n <= 0) {
          porUsuario.delete(ws.userId);
          emitir("admin", { tipo: "presencia", id: ws.userId, online: false });   // se desconectó la última pestaña
        } else porUsuario.set(ws.userId, n);
        const mios = socketsUsuario.get(ws.userId);
        if (mios) { mios.delete(ws); if (mios.size === 0) socketsUsuario.delete(ws.userId); }
      }
    });
    ws.on("error", () => {});
  });

  // Latido: detecta conexiones muertas y sesiones vencidas
  const latido = setInterval(() => {
    const ahora = Date.now();
    for (const ws of wss.clients) {
      if (!ws.viva || (ws.autenticado && ws.expMs && ahora > ws.expMs)) { ws.terminate(); continue; }
      ws.viva = false;
      ws.ping();
    }
  }, PING_MS);
  wss.on("close", () => clearInterval(latido));

  // --- API para el resto del servidor ---
  function notificar(canal, tipo = "cambio") {
    const set = canales.get(canal);
    if (!set) return 0;
    const txt = JSON.stringify({ type: "evento", canal, tipo });
    let n = 0;
    for (const ws of set) if (ws.readyState === 1) { ws.send(txt); n++; }
    return n;
  }

  // Avisa a todos los lobbies (o solo al de un juego)
  function notificarLobbies(juego, tipo = "cambio") {
    if (juego) return notificar("lobby:" + juego, tipo);
    let n = 0;
    for (const canal of canales.keys()) if (canal.startsWith("lobby:")) n += notificar(canal, tipo);
    return n;
  }

  // Para canales muy movidos (admin): como mucho 1 aviso por intervalo
  function notificarLimitado(canal, tipo = "cambio", cadaMs = 1500) {
    const ahora = Date.now();
    const desde = ahora - (ultimoEnvio.get(canal) || 0);
    if (desde >= cadaMs) {
      ultimoEnvio.set(canal, ahora);
      return notificar(canal, tipo);
    }
    if (!pendientes.has(canal)) {
      pendientes.set(canal, setTimeout(() => {
        pendientes.delete(canal);
        ultimoEnvio.set(canal, Date.now());
        notificar(canal, tipo);
      }, cadaMs - desde));
    }
  }

  // Envía un evento con datos a un canal (los datos solo llegan a quien está suscripto)
  function emitir(canal, datos) {
    const set = canales.get(canal);
    if (!set) return 0;
    const txt = JSON.stringify({ type: "evento", canal, ...datos });
    let n = 0;
    for (const ws of set) if (ws.readyState === 1) { ws.send(txt); n++; }
    return n;
  }
  const oyentes = (canal) => (canales.get(canal) ? canales.get(canal).size : 0);

  // Aviso directo a un jugador (todas sus pestañas), sin necesidad de suscribirse
  function notificarUsuario(userId, tipo, datos = {}) {
    const set = socketsUsuario.get(String(userId));
    if (!set) return 0;
    const txt = JSON.stringify({ type: "evento", canal: "yo", tipo, ...datos });
    let n = 0;
    for (const ws of set) if (ws.readyState === 1) { ws.send(txt); n++; }
    return n;
  }

  // Corta las conexiones de un jugador (por ejemplo, al bloquearlo)
  function expulsar(userId) {
    const set = socketsUsuario.get(String(userId));
    if (!set) return;
    for (const ws of [...set]) { enviar(ws, { type: "evento", canal: "yo", tipo: "bloqueado" }); ws.close(4004, "bloqueado"); }
  }

  // Traduce "se ejecutó esta función" → "avisá a estos canales"
  function avisarCambios(fn, body = {}) {
    try {
      if (fn === "pvp_crear_mesa") {
        const juego = /^[a-z_]{1,30}$/.test(body.p_juego || "") ? body.p_juego : "carta_alta";
        notificarLobbies(juego);
      } else if (fn === "pvp_unirse_mesa" || fn === "pvp_cancelar_mesa") {
        const id = String(body.p_mesa_id ?? "").replace(/\D/g, "");
        if (id) notificar("mesa:" + id);
        notificarLobbies(null);
      }
    } catch (e) { console.error("Error avisando por WebSocket:", e.message); }
  }

  function estadisticas() {
    return { conectados: wss.clients.size, canales: canales.size };
  }

  return { wss, notificar, notificarLobbies, notificarLimitado, avisarCambios, emitir, oyentes, notificarUsuario, expulsar, estadisticas };
}

module.exports = { crearRealtime };
