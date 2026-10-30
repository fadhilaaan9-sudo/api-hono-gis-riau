// Domain: tipe data untuk pipeline AI.
// File ini tidak boleh mengimpor Groq, Postgres, atau Hono.
// Tujuannya: logika bisnis bisa dibaca dan diuji tanpa server AI.

/** Jenis pertanyaan yang dikenali pipeline. */
export type IntentKind =
  | "hotspot_terbanyak"
  | "sawit_terbesar"
  | "terbakar_terbesar"
  | "profil_kabupaten"
  | "ringkasan_provinsi"
  | "di_luar_topik";

/** Hasil parsing pertanyaan user menjadi intent. */
export interface AiIntent {
  kind: IntentKind;
  /** Nama kabupaten kanonik (WADMKK), atau null kalau tidak menyebut kabupaten. */
  kabupaten: string | null;
  /** Jumlah baris teratas untuk pertanyaan peringkat. */
  limit: number;
}

/** Satu baris statistik per kabupaten, sesuai /api/stats. */
export interface StatsRowAi {
  kabupaten: string;
  luas_sawit_rakyat_ha: number | null;
  produksi_ton: number | null;
  petani_kk: number | null;
  jumlah_hotspot: number;
  terbakar_bpbd_ha: number | null;
  terbakar_bpbd_periode: string | null;
  terbakar_sipongi_ha: number | null;
  terbakar_sipongi_periode: string | null;
  luas_poligon_kebakaran_ha: number;
}

/** Sumber data yang wajib ditampilkan bersama jawaban. */
export interface AiSource {
  label: string;
  detail: string;
}

/** Event yang dikirim backend ke frontend lewat SSE. */
export type AiStreamEvent =
  | {
      type: "data";
      rows: StatsRowAi[];
      kabupatenSorot: string[];
      sources: AiSource[];
    }
  | { type: "token"; text: string }
  | { type: "done" }
  | { type: "error"; message: string };
