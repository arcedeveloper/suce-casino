// =====================================================================
// SUCE — Panel admin en vivo
//
// Cada vez que pasa algo (jugada, carga de fichas, bloqueo, mesa PvP...), este
// módulo NO hace que el panel recargue todo. Hace tres cosas baratas:
//   1) "usuarios": agrupa los jugadores afectados durante 600 ms y manda SU FILA
//      actualizada (una consulta indexada por tanda, sin importar cuántas jugadas hubo).
//   2) "partidas": manda las jugadas nuevas para el feed (sin tocar la base).
//   3) "metricas": recalcula los totales como máximo 1 vez cada 5 s.
// Y si no hay ningún admin conectado, no consulta nada.
// =====================================================================
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AGRUPAR_USUARIOS_MS = 600;
const MIN_ENTRE_METRICAS_MS = 5000;

function crearAdminLive({ pool, rt }) {
  const usuariosPend = new Set();
  let partidasPend = [];
  let timerUsuarios = null, timerMetricas = null, ultimaMetricas = 0;
  const hayAdmin = () => rt.oyentes("admin") > 0;

  function marcarUsuario(id) {
    if (typeof id === "string" && UUID.test(id)) { usuariosPend.add(id.toLowerCase()); programar(); }
  }
  function programar() {
    if (!timerUsuarios) timerUsuarios = setTimeout(vaciar, AGRUPAR_USUARIOS_MS);
  }

  async function vaciar() {
    timerUsuarios = null;
    if (!hayAdmin()) { usuariosPend.clear(); partidasPend = []; return; }
    const ids = [...usuariosPend]; usuariosPend.clear();
    const partidas = partidasPend; partidasPend = [];
    try {
      if (ids.length) {
        const { rows } = await pool.query("select to_jsonb(v) as j from app.v_resumen_usuarios v where v.id = any($1::uuid[])", [ids]);
        rt.emitir("admin", { tipo: "usuarios", usuarios: rows.map((r) => r.j) });
      }
    } catch (e) { console.error("admin-live (usuarios):", e.message); }
    if (partidas.length) rt.emitir("admin", { tipo: "partidas", partidas });
    programarMetricas();
  }

  function programarMetricas() {
    if (timerMetricas) return;
    const espera = Math.max(0, MIN_ENTRE_METRICAS_MS - (Date.now() - ultimaMetricas));
    timerMetricas = setTimeout(async () => {
      timerMetricas = null;
      if (!hayAdmin()) return;
      ultimaMetricas = Date.now();
      try {
        const { rows } = await pool.query("select app.metricas_admin() as m");
        rt.emitir("admin", { tipo: "metricas", metricas: rows[0].m });
      } catch (e) { console.error("admin-live (métricas):", e.message); }
    }, espera);
  }

  // Se llama después de cada función ejecutada con éxito
  async function registrar(fn, body = {}, claims = {}, resultado) {
    try {
      if (fn.startsWith("jugar_")) {
        if (hayAdmin()) {
          marcarUsuario(claims.sub);
          partidasPend.push({ username: claims.username, juego: fn.slice(6), apuesta: Number(body.p_apuesta) || 0,
                              ganancia: Number(resultado && resultado.ganancia) || 0, creado_en: new Date().toISOString() });
        }
      } else if (fn === "pvp_crear_mesa") {
        if (hayAdmin()) marcarUsuario(claims.sub);
      } else if (fn === "pvp_unirse_mesa" || fn === "pvp_cancelar_mesa") {
        if (hayAdmin()) {
          marcarUsuario(claims.sub);
          const id = String(body.p_mesa_id ?? "").replace(/\D/g, "");
          if (id) {
            const { rows } = await pool.query("select creador_id, oponente_id from app.mesas_pvp where id = $1::bigint", [id]);
            if (rows[0]) { marcarUsuario(rows[0].creador_id); marcarUsuario(rows[0].oponente_id); }
          }
        }
      } else if (fn === "admin_cargar_fichas" || fn === "admin_quitar_fichas") {
        marcarUsuario(body.p_usuario_id);
        // El jugador ve su saldo nuevo al instante en su pantalla
        rt.notificarUsuario(body.p_usuario_id, "saldo", { saldo: Number(resultado) });
      } else if (fn === "admin_bloquear_usuario") {
        marcarUsuario(body.p_usuario_id);
        if (body.p_bloquear === true) rt.expulsar(body.p_usuario_id);
      } else if (fn === "admin_crear_usuario") {
        marcarUsuario(resultado);
      } else if (fn === "admin_resetear_password") {
        marcarUsuario(body.p_usuario_id);
      }
    } catch (e) { console.error("admin-live:", e.message); }
  }

  return { registrar };
}

module.exports = { crearAdminLive };
