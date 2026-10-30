// Application: orkestrasi pipeline AI, langkah demi langkah.
// 1. Validasi pertanyaan -> 2. Parse intent lewat Groq ->
// 3. Validasi intent (allowlist) -> 4. Ambil data dari database ->
// 5. Kirim data ke frontend -> 6. Alirkan narasi dari Groq.
// AI tidak pernah menentukan angka sendiri; angka selalu dari database.

import type { AiIntent, AiSource, AiStreamEvent, StatsRowAi } from "../domain/types";
import {
  isIntentKind,
  isPerintahMencurigakan,
  normalisasiKabupaten,
  validasiPertanyaan,
} from "../domain/guard";
import { parseIntent, streamNarasi } from "../infrastructure/groqClient";
import { getAllStats } from "../infrastructure/statsRepository";

/** Sumber data, selalu ditampilkan bersama jawaban. */
function daftarSumber(): AiSource[] {
  return [
    { label: "Sawit rakyat 2024", detail: "Dinas Perkebunan Riau (stats_sawit)" },
    { label: "Hotspot 2026", detail: "FIRMS VIIRS, dipotong ke wilayah Riau" },
    { label: "Luas terbakar BPBD", detail: "BPBD Riau, sumber terpisah dari SiPongi" },
    { label: "Luas terbakar SiPongi", detail: "SiPongi, sumber terpisah dari BPBD" },
    { label: "Poligon kebakaran", detail: "Kemenhut, periode berjalan Jan-Jul 2026" },
  ];
}

/** Urutkan menurun, nilai null selalu di belakang. */
function urutMenurun(rows: StatsRowAi[], ambil: (r: StatsRowAi) => number | null): StatsRowAi[] {
  return [...rows].sort((a, b) => (ambil(b) ?? -1) - (ambil(a) ?? -1));
}

/** Pilih baris sesuai intent. Mengembalikan pesan error kalau tidak ada data. */
function pilihBaris(
  intent: AiIntent,
  semua: StatsRowAi[],
): { rows: StatsRowAi[]; error: string | null } {
  const limit = Math.min(Math.max(intent.limit || 3, 1), 12);
  switch (intent.kind) {
    case "hotspot_terbanyak":
      return { rows: urutMenurun(semua, (r) => r.jumlah_hotspot).slice(0, limit), error: null };
    case "sawit_terbesar":
      return { rows: urutMenurun(semua, (r) => r.luas_sawit_rakyat_ha).slice(0, limit), error: null };
    case "terbakar_terbesar":
      return { rows: urutMenurun(semua, (r) => r.terbakar_bpbd_ha).slice(0, limit), error: null };
    case "profil_kabupaten": {
      const baris = semua.find((r) => r.kabupaten === intent.kabupaten);
      if (!baris) return { rows: [], error: `Kabupaten tidak ditemukan: ${intent.kabupaten}` };
      return { rows: [baris], error: null };
    }
    case "ringkasan_provinsi":
      return { rows: semua, error: null };
    default:
      return { rows: [], error: null };
  }
}

export async function* jalankanPipeline(pertanyaan: string): AsyncGenerator<AiStreamEvent> {
  // Langkah 1: validasi dasar, tanpa memanggil Groq.
  const errorValidasi = validasiPertanyaan(pertanyaan);
  if (errorValidasi) {
    yield { type: "error", message: errorValidasi };
    return;
  }
  if (isPerintahMencurigakan(pertanyaan)) {
    yield {
      type: "token",
      text: "Maaf, saya hanya bisa menjawab pertanyaan seputar sawit, hotspot, dan kebakaran lahan di Riau berdasarkan data di peta ini.",
    };
    yield { type: "done" };
    return;
  }

  try {
    // Langkah 2 dan 3: parse intent, lalu validasi dengan allowlist.
    const mentah = (await parseIntent(pertanyaan)) as {
      kind?: unknown;
      kabupaten?: unknown;
      limit?: unknown;
    };
    if (!isIntentKind(mentah.kind)) {
      yield { type: "error", message: "Pertanyaan tidak bisa dipahami sebagai pertanyaan WebGIS Riau." };
      return;
    }
    if (mentah.kind === "di_luar_topik") {
      yield {
        type: "token",
        text: "Maaf, saya hanya bisa menjawab pertanyaan seputar sawit, hotspot, dan kebakaran lahan di Riau berdasarkan data di peta ini.",
      };
      yield { type: "done" };
      return;
    }
    const kabupaten = normalisasiKabupaten(
      typeof mentah.kabupaten === "string" ? mentah.kabupaten : null,
    );
    if (mentah.kind === "profil_kabupaten" && !kabupaten) {
      yield {
        type: "error",
        message: "Sebutkan satu kabupaten Riau yang datanya ingin dilihat, misalnya Siak atau Kampar.",
      };
      return;
    }
    const intent: AiIntent = {
      kind: mentah.kind,
      kabupaten,
      limit: typeof mentah.limit === "number" ? mentah.limit : 3,
    };

    // Langkah 4 dan 5: ambil data, pilih baris, kirim ke frontend dulu.
    const semua = await getAllStats();
    const { rows, error } = pilihBaris(intent, semua);
    if (error) {
      yield { type: "error", message: error };
      return;
    }
    const sources = daftarSumber();
    yield {
      type: "data",
      rows,
      kabupatenSorot: rows.map((r) => r.kabupaten),
      sources,
    };

    // Langkah 6: alirkan narasi dari angka yang sudah pasti.
    for await (const potong of streamNarasi(pertanyaan, rows, sources)) {
      yield { type: "token", text: potong };
    }
    yield { type: "done" };
  } catch (err) {
    // Jangan bocorkan stack trace atau pesan internal ke frontend.
    console.error("Pipeline AI gagal:", err);
    yield {
      type: "error",
      message:
        "AI sedang tidak bisa menjawab. Coba lagi sebentar, atau lihat langsung tabel statistik di panel Layer & Kontrol.",
    };
  }
}
