# Modul AI WebGIS Riau

Pipeline AI tinggal di backend `api-hono-gis-riau`, bukan backend baru.
Endpoint: `POST /api/ai/ask` dengan body `{ "pertanyaan": "..." }`.
Jawaban dikirim sebagai SSE: event `data` dulu (baris + kabupaten sorot + sumber),
lalu event `token` berkali-kali, ditutup event `done` atau `error`.

## Struktur (clean architecture, dibaca dari luar ke dalam)

```
src/ai/
  domain/        Aturan murni, tanpa Groq/Postgres/Hono
    types.ts     IntentKind, StatsRowAi, AiSource, AiStreamEvent
    guard.ts     Daftar 12 kabupaten, allowlist intent, validasi pertanyaan
  application/   Orkestrasi pipeline
    aiPipeline.ts  guard -> parse intent -> validasi -> query -> data -> narasi
  infrastructure/ Bicara ke dunia luar
    groqClient.ts      parseIntent (JSON) + streamNarasi (streaming)
    statsRepository.ts Satu query statistik 12 kabupaten (mirip /api/stats)
  routes/        HTTP saja
    aiRoute.ts   POST /ask, rate limit demo, ubah pipeline jadi SSE
```

## Aturan data (jangan dilanggar)

- Angka selalu dari database lewat query allowlist. AI hanya merangkai narasi.
- BPBD dan SiPongi adalah sumber berbeda, tampilkan terpisah, jangan dijumlahkan.
- Nilai null artinya tidak ada data, bukan 0.
- Nama kabupaten memakai kolom WADMKK, tanpa awalan "Kota ".

## Environment variable

- `GROQ_API_KEY`: wajib, simpan di `.env` lokal dan di Vercel. Jangan di-commit.
- `GROQ_MODEL`: opsional, default `openai/gpt-oss-20b`.

## Tes lokal

1. Pastikan `DATABASE_URL` mengarah ke database webgis dan `GROQ_API_KEY` sudah diset.
2. Jalankan `bun run --hot src/index.ts` di folder `api-hono-gis-riau`.
3. Kirim pertanyaan dengan curl, contoh:
   `curl -N -X POST http://localhost:3000/api/ai/ask -H "Content-Type: application/json" -d '{"pertanyaan":"Kabupaten mana yang paling banyak hotspot 2026?"}'`
4. Cek: event `data` muncul dulu, lalu token mengalir, lalu `done`.
   Bandingkan angka di event `data` dengan `GET /api/stats`.
