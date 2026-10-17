// Ejecuta db/schema.sql en tu base de Neon. Se puede correr varias veces sin romper nada.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

(async () => {
  if (!process.env.DATABASE_URL) {
    console.error("❌ Falta DATABASE_URL en el archivo .env");
    process.exit(1);
  }
  const sql = fs.readFileSync(path.join(__dirname, "..", "db", "schema.sql"), "utf8");
  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: /localhost|127\.0\.0\.1|\.sock|pgtest/.test(process.env.DATABASE_URL || "") ? false : { rejectUnauthorized: false } });
  try {
    await client.connect();
    await client.query(sql);
    console.log("✅ Base de datos lista (tablas y funciones creadas en Neon).");
    console.log("   Siguiente paso: npm run crear-admin");
  } catch (e) {
    console.error("❌ Error aplicando el schema:", e.message);
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
})();
