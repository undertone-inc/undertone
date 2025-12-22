// scripts/migrate.js
// Runs db/schema.sql against DATABASE_URL.
// Use: npm run db:migrate
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const dotenv = require("dotenv");

// Load server env vars from .env.server (preferred).
// Falls back to .env for backwards compatibility.
const envServerPath = path.resolve(__dirname, "..", ".env.server");
const envServerResult = dotenv.config({ path: envServerPath });
if (envServerResult.error) {
  dotenv.config();
}

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("❌ Missing DATABASE_URL environment variable.");
  process.exit(1);
}

async function main() {
  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: process.env.PGSSLMODE === "disable" ? false : (process.env.DATABASE_SSL === "false" ? false : undefined),
  });

  const schemaPath = path.join(__dirname, "..", "db", "schema.sql");
  const sql = fs.readFileSync(schemaPath, "utf8");

  try {
    await pool.query(sql);
    console.log("✅ Database schema applied.");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("❌ Migration failed:", err);
  process.exit(1);
});
