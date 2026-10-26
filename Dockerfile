# API WebGIS Riau: Hono + Bun + pg, database di Neon (PostGIS).
# Bun menjalankan TypeScript langsung, jadi tidak ada langkah build.
FROM oven/bun:1 AS base
WORKDIR /app

# Install dependensi dulu: lapisan ini ter-cache selama
# package.json/bun.lock tidak berubah.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Salin kode sumber. .dockerignore menjaga node_modules/.env/.git
# tidak ikut masuk ke image.
COPY src ./src

# Render menyuntikkan PORT (biasanya 10000) dan mendeteksi port yang
# dibuka container; kode memakai process.env.PORT dengan fallback 3000.
# DATABASE_URL diisi lewat Environment di dashboard Render, bukan di sini.
ENV NODE_ENV=production
CMD ["bun", "src/index.ts"]
