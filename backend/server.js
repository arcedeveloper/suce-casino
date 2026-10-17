// =====================================================================
// SUCE — servidor backend (reemplaza a PostgREST)
//  - POST /rpc/<funcion>  → ejecuta api.<funcion>(...) en Neon
//  - /rpc/login           → verifica usuario/clave y devuelve un JWT
// =====================================================================
require("dotenv").config();
const http = require("http");
const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const { Pool, types } = require("pg");
const { crearRealtime } = require("./realtime");
const { crearAdminLive } = require("./admin-live");

const { DATABASE_URL, JWT_SECRET } = process.env;
const PORT = process.env.PORT || 3000;

if (!DATABASE_URL || !JWT_SECRET) {
  console.error("\n❌ Falta configurar el archivo .env (DATABASE_URL y JWT_SECRET).");
  console.error("   Copiá .env.example a .env y completalo.\n");
  process.exit(1);
}

// bigint de Postgres llega como texto por defecto; lo convertimos a número
types.setTypeParser(20, (v) => parseInt(v, 10));

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: /localhost|127\.0\.0\.1|\.sock|pgtest/.test(process.env.DATABASE_URL || "") ? false : { rejectUnauthorized: false }, // Neon exige SSL
  max: 10,
});

const app = express();

// ⚠️ CAMBIO AQUÍ: Permitir peticiones desde GitHub Pages y Localhost
app.use(cors({
  origin: ['https://arcedeveloper.github.io', 'http://localhost:3000', 'http://127.0.0.1:3000'],
  credentials: true
}));

app.use(express.json());

const NOMBRE_VALIDO = /^[a-z_][a-z0-9_]*$/;

// ---- Tiempo real (WebSockets): se crea más abajo junto al servidor HTTP ----
let rt = null, adminLive = null;
function avisarCambios(fn, body, claims, resultado) {
  if (!rt) return;
  rt.avisarCambios(fn, body);                                  // mesas / lobbies PvP
  if (adminLive) adminLive.registrar(fn, body, claims, resultado);  // panel admin + avisos al jugador
}

// Chequeo de salud (útil para Render y para ver cuánta gente está conectada)
app.get("/health", (req, res) => res.json({ ok: true, ws: rt ? rt.estadisticas() : null }));

// ---- Lee el token (si viene) y arma los "claims" de la sesión ----
function leerClaims(req) {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) return {};
  try {
    return jwt.verify(auth.slice(7), JWT_SECRET);
  } catch {
    return null; // token inválido o vencido
  }
}

// ---- LOGIN: verifica en la base y firma el JWT acá en Node ----
app.post("/rpc/login", async (req, res) => {
  const { p_username, p_password } = req.body || {};
  if (!p_username || !p_password) {
    return res.status(400).json({ message: "Completá usuario y contraseña" });
  }
  try {
    const { rows } = await pool.query(
      `select id, username, rol
         from app.usuarios
        where username = $1 and activo = true
          and password_hash = crypt($2, password_hash)`,
      [String(p_username).trim().toLowerCase(), p_password]
    );
    if (rows.length === 0) {
      return res.status(401).json({ message: "Usuario o contraseña incorrectos" });
    }
    const u = rows[0];
    const token = jwt.sign(
      { sub: u.id, rol: u.rol, username: u.username },
      JWT_SECRET,
      { expiresIn: "12h" }
    );
    res.json({ token, rol: u.rol, username: u.username });
  } catch (e) {
    console.error("Error en login:", e.message);
    res.status(500).json({ message: "Error del servidor al iniciar sesión" });
  }
});

// ---- Cualquier otra función: api.<nombre>(parámetros con nombre) ----
app.post("/rpc/:fn", async (req, res) => {
  const fn = req.params.fn;
  if (!NOMBRE_VALIDO.test(fn)) return res.status(400).json({ message: "Función inválida" });

  const claims = leerClaims(req);
  if (claims === null) {
    return res.status(401).json({ message: "JWT expired: volvé a iniciar sesión" });
  }

  const body = req.body || {};
  const claves = Object.keys(body);
  if (!claves.every((k) => NOMBRE_VALIDO.test(k))) {
    return res.status(400).json({ message: "Parámetros inválidos" });
  }

  // select * from api.fn(p_a := $1, p_b := $2)
  const args = claves.map((k, i) => `${k} := $${i + 1}`).join(", ");
  const valores = claves.map((k) => body[k]);

  const client = await pool.connect();
  try {
    await client.query("begin");
    // Las funciones SQL leen quién sos desde este setting (igual que con PostgREST)
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    const { rows } = await client.query(`select * from api.${fn}(${args})`, valores);
    await client.query("commit");

    // Función que devuelve un solo valor (jsonb, bigint, void...) → columna con el nombre de la función
    const esEscalar = rows.length === 1 && Object.keys(rows[0]).length === 1 && fn in rows[0];
    const resultado = esEscalar ? rows[0][fn] : rows;
    avisarCambios(fn, body, claims, resultado);   // WebSocket: mesas PvP, panel admin, saldo del jugador
    res.json(resultado);   // escalar → valor; función que devuelve tabla → lista
  } catch (e) {
    await client.query("rollback").catch(() => {});
    // 42883 = la función no existe
    const status = e.code === "42883" ? 404 : 400;
    res.status(status).json({ message: e.message });
  } finally {
    client.release();
  }
});

// ⚠️ QUITAMOS LA LÍNEA DE express.static PORQUE EL FRONTEND AHORA ESTÁ EN GITHUB PAGES

const server = http.createServer(app);
rt = crearRealtime(server, { jwt, jwtSecret: JWT_SECRET });
adminLive = crearAdminLive({ pool, rt });   // empuja datos en vivo al panel admin

server.listen(PORT, () => {
  console.log(`\n✅ SUCE Backend corriendo en el puerto ${PORT}`);
  console.log(`   Tiempo real (WebSocket) activo\n`);
});
