// Domain: aturan validasi pertanyaan dan nama kabupaten.
// Tidak ada akses jaringan di file ini, hanya aturan murni.

import type { IntentKind } from "./types";

/** 12 kabupaten/kota Riau, sesuai kolom WADMKK (tanpa awalan "Kota "). */
export const KABUPATEN_RIAU: string[] = [
  "Bengkalis",
  "Indragiri Hilir",
  "Indragiri Hulu",
  "Kampar",
  "Kepulauan Meranti",
  "Kuantan Singingi",
  "Pelalawan",
  "Rokan Hilir",
  "Rokan Hulu",
  "Siak",
  "Dumai",
  "Pekanbaru",
];

/** Jenis intent yang boleh diterima dari model. */
export const INTENT_KINDS: IntentKind[] = [
  "hotspot_terbanyak",
  "sawit_terbesar",
  "terbakar_terbesar",
  "profil_kabupaten",
  "ringkasan_provinsi",
  "di_luar_topik",
];

/** Cocokkan nama kabupaten apa adanya menjadi nama kanonik, atau null. */
export function normalisasiKabupaten(nama: string | null | undefined): string | null {
  if (!nama) return null;
  const cari = nama.trim().toLowerCase();
  for (const kanonik of KABUPATEN_RIAU) {
    if (kanonik.toLowerCase() === cari) return kanonik;
  }
  return null;
}

/** Cek apakah nilai dari model benar-benar jenis intent yang dikenal. */
export function isIntentKind(value: unknown): value is IntentKind {
  return typeof value === "string" && (INTENT_KINDS as string[]).includes(value);
}

/** Pesan error untuk pertanyaan yang tidak bisa diproses, atau null kalau valid. */
export function validasiPertanyaan(pertanyaan: string): string | null {
  const bersih = pertanyaan.trim();
  if (bersih.length < 3) return "Pertanyaannya terlalu pendek. Coba tulis pertanyaan lengkap.";
  if (bersih.length > 500) return "Pertanyaannya terlalu panjang (maksimal 500 karakter).";
  return null;
}

/**
 * Penanda percobaan prompt injection yang paling umum.
 * Kalau user menyuruh model mengabaikan instruksi, pipeline menolak
 * tanpa memanggil Groq, supaya kuota tidak terbuang.
 */
export function isPerintahMencurigakan(pertanyaan: string): boolean {
  const kecil = pertanyaan.toLowerCase();
  return (
    kecil.includes("abaikan instruksi") ||
    kecil.includes("ignore previous") ||
    kecil.includes("ignore all previous") ||
    kecil.includes("lupakan instruksi")
  );
}
