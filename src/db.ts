import { Pool } from "pg";

// Bun otomatis membaca .env, jadi DATABASE_URL tidak perlu di-load manual.
// .env lokal ferhen harus mengarah ke database webgis (localhost, user postgres).
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});
