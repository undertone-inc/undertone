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
const NODE_ENV = process.env.NODE_ENV || "development";

// Match server.js behavior: enable SSL in production unless explicitly disabled.
const sslEnabled =
  String(process.env.DATABASE_SSL || "").toLowerCase() === "true" ||
  (NODE_ENV === "production" && String(process.env.DATABASE_SSL || "").toLowerCase() !== "false");

if (!DATABASE_URL) {
  console.error("❌ Missing DATABASE_URL environment variable.");
  process.exit(1);
}

async function main() {
  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: sslEnabled ? { rejectUnauthorized: false } : false,
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
