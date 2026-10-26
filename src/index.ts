import { Hono } from "hono";
import { cors } from "hono/cors";
import { pool } from "./db";

const app = new Hono();

// CORS wajib: frontend Leaflet jalan di origin/port berbeda dari API.
app.use("*", cors());

// ST_AsGeoJSON di-cast ke ::json supaya pg mengembalikannya sebagai objek,
// bukan string. Helper ini berjaga-jaga kalau hasilnya masih string.
function asGeometry(value: unknown) {
  if (typeof value === "string") return JSON.parse(value);
  return value;
}

function toFeature(row: any, propertyKeys: string[]) {
  const properties: Record<string, unknown> = {};
  for (const key of propertyKeys) properties[key] = row[key];
  return { type: "Feature", geometry: asGeometry(row.geometry), properties };
}

app.get("/", (c) =>
  c.json({
    name: "WebGIS Riau API",
    endpoints: [
      "GET /api/kabupaten",
      "GET /api/kabupaten/:nama",
      "GET /api/hotspots?kabupaten=&dari=&sampai=",
      "GET /api/kebakaran",
      "GET /api/stats",
    ],
  }),
);

app.get("/api/health", async (c) => {
  try {
    await pool.query("SELECT 1");
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ ok: false, error: String(err) }, 500);
  }
});

// Daftar 12 kabupaten sebagai GeoJSON (poligon BIG, nama = kolom WADMKK).
app.get("/api/kabupaten", async (c) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, nama, ST_AsGeoJSON(geom)::json AS geometry
       FROM kabupaten ORDER BY nama`,
    );
    return c.json({
      type: "FeatureCollection",
      features: rows.map((r) => toFeature(r, ["id", "nama"])),
    });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// Profil satu kabupaten: geometri + sawit rakyat 2024 + terbakar BPBD/SiPongi
// (kolom terpisah, jangan dijumlahkan) + jumlah hotspot + luas poligon kebakaran.
// Nama dicocokkan case-insensitive supaya "kampar" tetap ketemu "Kampar".
app.get("/api/kabupaten/:nama", async (c) => {
  const nama = decodeURIComponent(c.req.param("nama"));
  try {
    const { rows } = await pool.query(
      `SELECT k.id, k.nama, ST_AsGeoJSON(k.geom)::json AS geometry,
              s.luas_sawit_rakyat_ha, s.produksi_ton, s.petani_kk, s.tahun,
              b.luas_ha AS terbakar_bpbd_ha, b.periode AS terbakar_bpbd_periode,
              p.luas_ha AS terbakar_sipongi_ha, p.periode AS terbakar_sipongi_periode,
              (SELECT COUNT(*)::int FROM hotspot_2026 h
                WHERE ST_Within(h.geom, k.geom)) AS jumlah_hotspot,
              (SELECT COALESCE(SUM(ST_Area(ST_Intersection(a.geom, k.geom)::geography) / 10000), 0)
                 FROM areal_kebakaran a WHERE ST_Intersects(a.geom, k.geom)
              ) AS luas_poligon_kebakaran_ha
       FROM kabupaten k
       LEFT JOIN stats_sawit s ON s.kabupaten = k.nama
       LEFT JOIN stats_terbakar b ON b.kabupaten = k.nama AND b.sumber LIKE '%BPBD%'
       LEFT JOIN stats_terbakar p ON p.kabupaten = k.nama AND p.sumber LIKE '%SIPONGI%'
       WHERE LOWER(k.nama) = LOWER($1)`,
      [nama],
    );
    if (rows.length === 0) {
      return c.json({ error: `Kabupaten tidak ditemukan: ${nama}` }, 404);
    }
    const r = rows[0];
    return c.json(
      toFeature(r, [
        "id",
        "nama",
        "luas_sawit_rakyat_ha",
        "produksi_ton",
        "petani_kk",
        "tahun",
        "terbakar_bpbd_ha",
        "terbakar_bpbd_periode",
        "terbakar_sipongi_ha",
        "terbakar_sipongi_periode",
        "jumlah_hotspot",
        "luas_poligon_kebakaran_ha",
      ]),
    );
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// Titik panas VIIRS 2026. Filter opsional:
//   ?kabupaten=Kampar  (titik di dalam poligon kabupaten itu)
//   ?dari=2026-01-01&sampai=2026-10-23  (berdasar acq_date)
app.get("/api/hotspots", async (c) => {
  const kabupaten = c.req.query("kabupaten");
  const dari = c.req.query("dari");
  const sampai = c.req.query("sampai");
  const conditions: string[] = [];
  const params: unknown[] = [];
  let join = "";
  if (kabupaten) {
    join = "JOIN kabupaten k ON ST_Within(h.geom, k.geom)";
    params.push(kabupaten);
    conditions.push(`LOWER(k.nama) = LOWER($${params.length})`);
  }
  if (dari) {
    params.push(dari);
    conditions.push(`h.acq_date >= $${params.length}`);
  }
  if (sampai) {
    params.push(sampai);
    conditions.push(`h.acq_date <= $${params.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  try {
    const { rows } = await pool.query(
      `SELECT h.id, h.latitude, h.longitude, h.acq_date, h.acq_time,
              h.satellite, h.confidence, h.frp, h.daynight,
              ST_AsGeoJSON(h.geom)::json AS geometry
       FROM hotspot_2026 h ${join} ${where}
       ORDER BY h.acq_date, h.id LIMIT 10000`,
      params,
    );
    return c.json({
      type: "FeatureCollection",
      features: rows.map((r) =>
        toFeature(r, [
          "id",
          "latitude",
          "longitude",
          "acq_date",
          "acq_time",
          "satellite",
          "confidence",
          "frp",
          "daynight",
        ]),
      ),
    });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// Poligon areal kebakaran Kemenhut Jan-Jul 2026 (hasil clip ke Riau).
// Kolom ket/periode/namobj sesuai skema v2; kalau endpoint ini error
// "column does not exist", cek ejaan kolom asli dengan \d areal_kebakaran.
app.get("/api/kebakaran", async (c) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, ket, akurasi, periode, namobj,
              ST_AsGeoJSON(geom)::json AS geometry,
              ST_Area(geom::geography) / 10000 AS luas_ha
       FROM areal_kebakaran ORDER BY id`,
    );
    return c.json({
      type: "FeatureCollection",
      features: rows.map((r) =>
        toFeature(r, ["id", "ket", "akurasi", "periode", "namobj", "luas_ha"]),
      ),
    });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// Statistik per kabupaten untuk panel/choropleth: sawit rakyat 2024,
// terbakar BPBD dan SiPongi sebagai kolom terpisah, jumlah hotspot,
// dan luas poligon kebakaran hasil ST_Intersection (Q1 + Q2 + Q3).
app.get("/api/stats", async (c) => {
  try {
    const { rows } = await pool.query(
      `SELECT k.nama AS kabupaten,
              s.luas_sawit_rakyat_ha, s.produksi_ton, s.petani_kk, s.tahun,
              b.luas_ha AS terbakar_bpbd_ha, b.periode AS terbakar_bpbd_periode,
              p.luas_ha AS terbakar_sipongi_ha, p.periode AS terbakar_sipongi_periode,
              (SELECT COUNT(*)::int FROM hotspot_2026 h
                WHERE ST_Within(h.geom, k.geom)) AS jumlah_hotspot,
              (SELECT COALESCE(SUM(ST_Area(ST_Intersection(a.geom, k.geom)::geography) / 10000), 0)
                 FROM areal_kebakaran a WHERE ST_Intersects(a.geom, k.geom)
              ) AS luas_poligon_kebakaran_ha
       FROM kabupaten k
       LEFT JOIN stats_sawit s ON s.kabupaten = k.nama
       LEFT JOIN stats_terbakar b ON b.kabupaten = k.nama AND b.sumber LIKE '%BPBD%'
       LEFT JOIN stats_terbakar p ON p.kabupaten = k.nama AND p.sumber LIKE '%SIPONGI%'
       ORDER BY k.nama`,
    );
    return c.json(rows);
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

export default app;
