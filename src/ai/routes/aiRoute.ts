// Routes: endpoint HTTP untuk pipeline AI.
// Tugas file ini hanya tiga hal: baca body, batasi laju, dan alirkan SSE.
// Semua logika bisnis ada di application, bukan di sini.

import { Hono } from "hono";
import { jalankanPipeline } from "../application/aiPipeline";
import type { AiStreamEvent } from "../domain/types";

const app = new Hono();

/**
 * Rate limit sederhana untuk demo (maksimal 30 pertanyaan per menit per IP).
 * Catatan jujur: di serverless, map ini hidup per instance, jadi ini
 * pengaman demo, bukan rate limit produksi terdistribusi.
 */
const hitPerIp = new Map<string, number[]>();
function kenaRateLimit(ip: string): boolean {
  const sekarang = Date.now();
  const riwayat = (hitPerIp.get(ip) ?? []).filter((waktu) => sekarang - waktu < 60_000);
  riwayat.push(sekarang);
  hitPerIp.set(ip, riwayat);
  return riwayat.length > 30;
}

/** Ubah generator pipeline menjadi body SSE yang bisa dibaca fetch(). */
function keSse(pipeline: AsyncGenerator<AiStreamEvent>): ReadableStream {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      try {
        for await (const event of pipeline) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        }
      } finally {
        controller.close();
      }
    },
  });
}

app.post("/ask", async (c) => {
  const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  if (kenaRateLimit(ip)) {
    return c.json({ error: "Terlalu banyak pertanyaan. Coba lagi satu menit lagi." }, 429);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Body harus JSON dengan field pertanyaan." }, 400);
  }
  const pertanyaan = (body as { pertanyaan?: unknown }).pertanyaan;
  if (typeof pertanyaan !== "string" || pertanyaan.trim() === "") {
    return c.json({ error: "Field pertanyaan wajib diisi." }, 400);
  }

  return new Response(keSse(jalankanPipeline(pertanyaan)), {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
});

export const aiRoute = app;
