import { Hono } from "hono";
import { cors } from "hono/cors";
import { pool } from "./db";
import { aiRoute } from "./ai/routes/aiRoute";

const app = new Hono();

// CORS wajib: frontend Leaflet jalan di origin/port berbeda dari API.
app.use("*", cors());

// Data historis tidak berubah, jadi browser/CDN boleh menyimpannya 1 jam.
// /api/health dikecualikan supaya status selalu dicek langsung.
app.use("/api/*", async (c, next) => {
  await next();
  if (c.req.path !== "/api/health" && !c.req.path.startsWith("/api/ai/")) {
    c.header(
      "Cache-Control",
      "public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400",
    );
  }
});

// ST_AsGeoJSON di-cast ke ::json supaya pg mengembalikannya sebagai objek,
// bukan string. Helper ini berjaga-jaga kalau hasilnya masih string.
function asGeometry(value: unknown) {
  if (typeof value === "string") return JSON.parse(value);
  return value;
}

function toFeature(row: any, propertyKeys: string[]) {
  const properties: Record<string, unknown> = {};
  for (const key of propertyKeys) properties[key] = row[key];
  // Endpoint tanpa geometri (hotspot dan profil) tidak mengirim field
  // geometry sama sekali, supaya payload lebih kecil.
  if (row.geometry === undefined) return { type: "Feature", properties };
  return { type: "Feature", geometry: asGeometry(row.geometry), properties };
}

app.route("/api/ai", aiRoute);

app.get("/", (c) =>
  c.json({
    name: "WebGIS Riau API",
    endpoints: [
      "GET /api/kabupaten",
      "GET /api/kabupaten/:nama",
      "GET /api/hotspots?kabupaten=&dari=&sampai=",
      "GET /api/kebakaran",
      "GET /api/stats",
      "POST /api/ai/ask",
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
// Geometri disederhanakan (toleransi 0,0005 derajat, presisi 5 desimal)
// karena peta dibuka di zoom provinsi; detail penuh tidak terlihat.
app.get("/api/kabupaten", async (c) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, nama, ST_AsGeoJSON(ST_SimplifyPreserveTopology(geom, 0.0005), 5)::json AS geometry
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

// Profil satu kabupaten: sawit rakyat 2024 + terbakar BPBD/SiPongi
// (tanpa geometri: modal hanya memakai angka, poligonnya sudah ada di peta)
// (kolom terpisah, jangan dijumlahkan) + jumlah hotspot + luas poligon kebakaran.
// Nama dicocokkan case-insensitive supaya "kampar" tetap ketemu "Kampar".
app.get("/api/kabupaten/:nama", async (c) => {
  const nama = decodeURIComponent(c.req.param("nama"));
  try {
    const { rows } = await pool.query(
      `SELECT k.id, k.nama,
              s.luas_sawit_rakyat_ha::float AS luas_sawit_rakyat_ha, s.produksi_ton::float AS produksi_ton, s.petani_kk, s.tahun,
              b.luas_ha::float AS terbakar_bpbd_ha, b.periode AS terbakar_bpbd_periode,
              p.luas_ha::float AS terbakar_sipongi_ha, p.periode AS terbakar_sipongi_periode,
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

// Titik panas VIIRS 2026. Geometri Point tidak dikirim: frontend
// menggambar titik dari latitude/longitude. Filter opsional:
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
              h.satellite, h.confidence, h.frp, h.daynight
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
              ST_AsGeoJSON(ST_SimplifyPreserveTopology(geom, 0.0005), 5)::json AS geometry,
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
// Versi lama memakai subquery per kabupaten (12x scan hotspot +
// 12x scan areal), sehingga di laptop ferhen query ini lewat dari
// batas 10 detik Bun dan koneksi diputus. Versi ini memakai CTE:
// hitung hotspot dan luas terbakar SEKALI untuk semua kabupaten,
// baru di-join ke tabel kecil stats. Log durasi dicetak ke terminal
// supaya kalau masih lambat, angka pastinya kelihatan.
app.get("/api/stats", async (c) => {
  const started = Date.now();
  try {
    const { rows } = await pool.query(
      `WITH hotspot_counts AS (
         SELECT k.nama AS kabupaten, COUNT(h.id)::int AS jumlah_hotspot
         FROM kabupaten k
         LEFT JOIN hotspot_2026 h ON ST_Within(h.geom, k.geom)
         GROUP BY k.nama
       ),
       burned_areas AS (
         SELECT k.nama AS kabupaten,
                SUM(ST_Area(ST_Intersection(a.geom, k.geom)::geography) / 10000)
                  AS luas_poligon_kebakaran_ha
         FROM kabupaten k
         JOIN areal_kebakaran a ON ST_Intersects(a.geom, k.geom)
         GROUP BY k.nama
       )
       SELECT k.nama AS kabupaten,
              s.luas_sawit_rakyat_ha::float AS luas_sawit_rakyat_ha, s.produksi_ton::float AS produksi_ton, s.petani_kk, s.tahun,
              b.luas_ha::float AS terbakar_bpbd_ha, b.periode AS terbakar_bpbd_periode,
              p.luas_ha::float AS terbakar_sipongi_ha, p.periode AS terbakar_sipongi_periode,
              COALESCE(hc.jumlah_hotspot, 0) AS jumlah_hotspot,
              COALESCE(ba.luas_poligon_kebakaran_ha, 0) AS luas_poligon_kebakaran_ha
       FROM kabupaten k
       LEFT JOIN stats_sawit s ON s.kabupaten = k.nama
       LEFT JOIN stats_terbakar b ON b.kabupaten = k.nama AND b.sumber LIKE '%BPBD%'
       LEFT JOIN stats_terbakar p ON p.kabupaten = k.nama AND p.sumber LIKE '%SIPONGI%'
       LEFT JOIN hotspot_counts hc ON hc.kabupaten = k.nama
       LEFT JOIN burned_areas ba ON ba.kabupaten = k.nama
       ORDER BY k.nama`,
    );
    console.log(`GET /api/stats ${Date.now() - started}ms`);
    return c.json(rows);
  } catch (err) {
    console.error("GET /api/stats error:", err);
    return c.json({ error: String(err) }, 500);
  }
});

// Bun membunuh request yang idle lebih dari 10 detik secara default,
// dan query spasial di atas (ST_Intersection + luas geography atas
// 1.814 poligon) bisa lewat dari itu di laptop. Naikkan batasnya
// jadi 60 detik supaya query yang sah tidak diputus di tengah jalan.
// Bentuk ini setara dengan "export default app" + port 3000.
export default {
  // Render menyuntikkan PORT (biasanya 10000); di laptop tanpa PORT tetap 3000.
  port: Number(process.env.PORT ?? 3000),
  idleTimeout: 60,
  fetch: app.fetch,
};
