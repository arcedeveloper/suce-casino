// Crea (o resetea la clave de) el usuario admin.
// Uso:  npm run crear-admin -- MiClaveSegura123
//       (usuario por defecto: admin; para otro nombre: npm run crear-admin -- MiClave otroNombre)
require("dotenv").config();
const { Client } = require("pg");

const password = process.argv[2];
const username = (process.argv[3] || "admin").trim().toLowerCase();

(async () => {
  if (!process.env.DATABASE_URL) { console.error("❌ Falta DATABASE_URL en .env"); process.exit(1); }
  if (!password || password.length < 6) {
    console.error("❌ Indicá una clave de al menos 6 caracteres:\n   npm run crear-admin -- TuClaveSegura");
    process.exit(1);
  }
  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: /localhost|127\.0\.0\.1|\.sock|pgtest/.test(process.env.DATABASE_URL || "") ? false : { rejectUnauthorized: false } });
  try {
    await client.connect();
    const { rows } = await client.query(
      `insert into app.usuarios (username, password_hash, rol)
       values ($1, crypt($2, gen_salt('bf')), 'admin')
       on conflict (username) do update set password_hash = excluded.password_hash, rol = 'admin', activo = true
       returning id`, [username, password]);
    await client.query(
      `insert into app.wallets (usuario_id, saldo) values ($1, 0) on conflict (usuario_id) do nothing`, [rows[0].id]);
    console.log(`✅ Admin listo. Usuario: ${username}`);
  } catch (e) {
    console.error("❌ Error:", e.message);
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
})();
