// Infrastructure: akses data statistik dari Postgres.
// Sengaja hanya satu query untuk semua intent: datanya hanya 12 baris,
// jadi ambil sekali lalu pilih/urutan dilakukan di application.
// Ini jauh lebih mudah dibaca daripada banyak query per intent.

import { pool } from "../../db";
import type { StatsRowAi } from "../domain/types";

/** Ambil statistik 12 kabupaten, dengan logika yang sama seperti /api/stats. */
export async function getAllStats(): Promise<StatsRowAi[]> {
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
            s.luas_sawit_rakyat_ha::float AS luas_sawit_rakyat_ha,
            s.produksi_ton::float AS produksi_ton,
            s.petani_kk,
            b.luas_ha::float AS terbakar_bpbd_ha,
            b.periode AS terbakar_bpbd_periode,
            p.luas_ha::float AS terbakar_sipongi_ha,
            p.periode AS terbakar_sipongi_periode,
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
  return rows as StatsRowAi[];
}
