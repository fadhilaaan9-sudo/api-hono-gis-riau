// Infrastructure: client Groq.
// Satu-satunya file yang berbicara ke provider AI.
// Kalau provider diganti, cukup ganti base URL / model di sini,
// logika pipeline di application tidak perlu berubah.

import Groq from "groq-sdk";

/** Model default: kecil dan cepat, cocok untuk batas waktu Vercel. */
export function groqModel(): string {
  return process.env.GROQ_MODEL ?? "openai/gpt-oss-20b";
}

function groqClient(): Groq {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GROQ_API_KEY belum diset. Set di .env lokal dan di environment variable Vercel.",
    );
  }
  return new Groq({ apiKey });
}

/**
 * Ubah pertanyaan user menjadi intent JSON.
 * Model hanya diminta mengklasifikasi, bukan mencari angka.
 * Angka selalu diambil dari database setelah intent divalidasi.
 */
export async function parseIntent(pertanyaan: string): Promise<unknown> {
  const groq = groqClient();
  const hasil = await groq.chat.completions.create({
    model: groqModel(),
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: [
          "Kamu pengklasifikasi pertanyaan WebGIS Riau.",
          "Jawab HANYA dengan JSON: {\"kind\": ..., \"kabupaten\": ..., \"limit\": ...}.",
          "kind harus salah satu: hotspot_terbanyak, sawit_terbesar, terbakar_terbesar,",
          "profil_kabupaten, ringkasan_provinsi, di_luar_topik.",
          "kabupaten diisi nama kabupaten Riau kalau pertanyaan menyebut satu kabupaten,",
          "kalau tidak, isi null. limit diisi 3 untuk pertanyaan peringkat, 1 untuk profil.",
          "Pertanyaan di luar sawit Riau, hotspot, dan kebakaran lahan Riau",
          "adalah di_luar_topik.",
        ].join(" "),
      },
      { role: "user", content: pertanyaan },
    ],
  });
  const teks = hasil.choices[0]?.message?.content ?? "";
  return JSON.parse(teks) as unknown;
}

/**
 * Alirkan narasi jawaban dari angka yang sudah diambil database.
 * Generator ini menghasilkan potongan teks satu per satu,
 * supaya frontend bisa menampilkannya secara streaming.
 */
export async function* streamNarasi(
  pertanyaan: string,
  rows: unknown,
  sources: unknown,
): AsyncGenerator<string> {
  const groq = groqClient();
  const stream = await groq.chat.completions.create({
    model: groqModel(),
    temperature: 0.2,
    stream: true,
    messages: [
      {
        role: "system",
        content: [
          "Kamu asisten WebGIS Riau. Jawab dalam Bahasa Indonesia, singkat (maksimal 150 kata).",
          "HANYA pakai angka dari DATA di bawah. Jangan menambah kabupaten atau angka lain.",
          "Sumber BPBD dan SiPongi adalah sumber berbeda, sebutkan terpisah, jangan dijumlahkan.",
          "Nilai null artinya tidak ada data, tulis 'tidak ada data', jangan tulis 0.",
          "Akhiri dengan daftar sumber yang diberikan.",
        ].join(" "),
      },
      {
        role: "user",
        content: [
          `Pertanyaan: ${pertanyaan}`,
          `DATA: ${JSON.stringify(rows)}`,
          `SUMBER: ${JSON.stringify(sources)}`,
        ].join("\n"),
      },
    ],
  });
  for await (const potong of stream) {
    const teks = potong.choices[0]?.delta?.content ?? "";
    if (teks) yield teks;
  }
}
