# getlearn.ai Core Backend

> **Learner Intelligence Infrastructure**: Model data kanonik dan API untuk evaluasi penguasaan materi (*mastery*), deteksi kesenjangan belajar (*learning gaps*), dan rekomendasi aksi berikutnya (*next-best-action*), dirancang independen dari LMS mana pun.

---

## 🌟 Fitur Platform (Fase 0 - Fase 5)

- **Spesifikasi Standar OpenAPI 3.1** ([`docs/openapi.yaml`](./docs/openapi.yaml)): 7 Entitas kanonik, auth standard `BearerAuth` API Key.
- **Backend Fastify + TypeScript**: Arsitektur modular berkecepatan tinggi dengan validasi schema Zod dan Swagger UI.
- **Database PostgreSQL Terkelola + pgvector (Railway)**: Multi-tenant dengan isolasi `tenant_id`, vector similarity search 768-dim, dan Prisma ORM.
- **Event Ingestion dengan Idempotency**: `POST /v1/events` dengan deduplikasi `event_id` per tenant untuk mencegah double counting.
- **Kalkulasi Mastery & Bayesian Knowledge Tracing**: Estimasi penguasaan konsep real-time, deteksi skill gap, dan rekomendasi konten remedial via pgvector cosine search.
- **Official Python SDK (`getlearn-ai`)**: Zero external dependencies, typed model data, dan konektor siap pakai untuk Frappe LMS (`doc_events` hooks).
- **AI Study Coach & Chat Engine**: Pembukaan sesi otomatis berbasis kelemahan siswa, Socratic guardrails pencegah kebocoran kunci jawaban, lesson citations, dan dukungan audio TTS voice.
- **Multimodal Content Ingestion & Indexing Pipeline**:
  - `pdf`: Diunduh via `fetch` dan diunggah ke Gemini Files API (`ai.files.upload`), diekstrak teks terstrukturnya (termasuk tabel/grafik) via `generateContent`, lalu di-chunk dan di-embed ke `content_chunks` (pgvector).
  - `video` (YouTube): URL publik `youtube.com`/`youtu.be` dikirim langsung sebagai `fileData.fileUri` ke Gemini tanpa unduh, diekstrak transkrip dan poin pembelajarannya secara otomatis.
  - `video` (Self-hosted): Video langsung diunduh dan diunggah ke Gemini Files API untuk ekstraksi multimodal.
  - `scorm`: **Pembagian Tanggung Jawab (Separation of Concerns)** — Paket SCORM diproses dan diekstrak di sisi LMS connector (misalnya fork Frappe LMS Nusadaya), bukan di getlearn-core. LMS connector mengirimkan `raw_text` hasil ekstraksi ke `POST /v1/content-items`.
  - **Asynchronous Background Indexing**: Registrasi materi dengan `source_uri` merespons secara instan dengan `indexing_status: pending`, sementara proses ekstraksi Gemini berjalan di background secara non-blocking dan dapat di-poll statusnya via `GET /v1/content-items/:id`.
- **Web Frontend Dashboards**:
  - **Client Portal** (`/dashboard`): Analitik penguasaan kurikulum, daftar siswa & intervensi targeted, sandbox chat Socratic coach, dan vector RAG explorer.
  - **Superadmin Control Plane** (`/superadmin`): Observabilitas fleet tenant, instant provisioning, dan credit top-up.

---

## 🚀 Live Production di Railway

- **Client Portal**: [https://getlearn-core-production.up.railway.app/dashboard](https://getlearn-core-production.up.railway.app/dashboard)
- **Superadmin Control Plane**: [https://getlearn-core-production.up.railway.app/superadmin](https://getlearn-core-production.up.railway.app/superadmin)
- **Swagger Docs**: [https://getlearn-core-production.up.railway.app/docs](https://getlearn-core-production.up.railway.app/docs)
- **Health Check**: [https://getlearn-core-production.up.railway.app/health](https://getlearn-core-production.up.railway.app/health)
- **GitHub Repository**: [https://github.com/tirtana888/getlearn-core](https://github.com/tirtana888/getlearn-core)

---

## 🛠️ Panduan Pengembangan Lokal

### 1. Prasyarat
- Node.js >= 20
- PostgreSQL (atau gunakan TCP Proxy Railway)

### 2. Instalasi Dependensi
```bash
npm install
```

### 3. Konfigurasi Environment (`.env`)
```env
PORT=3000
NODE_ENV=development
DATABASE_URL="postgresql://user:pass@host:port/dbname"
DEV_API_KEY="<generate-nilai-acak-sendiri>"
```

### 4. Sinkronisasi Database
```bash
npm run prisma:push
```

### 5. Jalankan Server Dev
```bash
npm run dev
```
Akses server lokal di `http://localhost:3000` dan dokumentasi Swagger di `http://localhost:3000/docs`.

### 6. Pengujian End-to-End
```bash
npm run test:e2e
```

---

## 🗺️ Endpoint API Utama

| Metode | Endpoint | Deskripsi |
|---|---|---|
| `GET` | `/health` | Health check service |
| `GET` | `/docs` | Swagger UI documentation |
| `POST` | `/v1/objectives` | Registrasi Learning Objective |
| `POST` | `/v1/content-items` | Registrasi Content Item (teks/video/pdf/scorm) |
| `POST` | `/v1/assessment-items` | Registrasi soal & pemetaan objektif |
| `POST` | `/v1/events` | Ingest event asesmen (idempotent via `event_id`) |
| `GET` | `/v1/learners/:id/mastery` | Skor mastery per objektif untuk learner |
| `GET` | `/v1/learners/:id/gaps` | Daftar gap belajar (skor $< 0.70$) |
| `GET` | `/v1/learners/:id/next-action` | Rekomendasi aksi belajar terbaik berikutnya |
| `POST` | `/v1/admin/tenants` | Onboarding tenant baru & generate API key |
