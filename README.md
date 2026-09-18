# getlearn.ai Core Backend

> **Learner Intelligence Infrastructure**: Model data kanonik dan API untuk evaluasi penguasaan materi (*mastery*), deteksi kesenjangan belajar (*learning gaps*), dan rekomendasi aksi berikutnya (*next-best-action*), dirancang independen dari LMS mana pun.

---

## 🌟 Fitur Utama (Fase 0 & Fase 1)

- **Spesifikasi Standar OpenAPI 3.1** ([`docs/openapi.yaml`](./docs/openapi.yaml)):
  - 7 Entitas kanonik: `Tenant`, `Learner`, `LearningObjective`, `ContentItem`, `AssessmentItem`, `AssessmentEvent`, `MasteryRecord`.
  - Auth standard: `BearerAuth` API Key (terintegrasi dengan Unkey / Dev key).
- **Backend Fastify + TypeScript**:
  - Arsitektur modular berkecepatan tinggi dengan validasi schema Zod.
  - Dokumentasi interaktif Swagger UI di `/docs`.
- **Database PostgreSQL Terkelola (Railway)**:
  - Multi-tenant dengan isolasi `tenant_id` dan dukungan Row-Level Security (RLS) & `pgvector`.
  - Pengelolaan skema modern menggunakan Prisma ORM.
- **Event Ingestion dengan Idempotency**:
  - `POST /v1/events` dengan deduplikasi `event_id` per tenant untuk mencegah *double count* saat network retry.
- **Kalkulasi Mastery & Rekomendasi Naif (Fase 1)**:
  - Menghitung skor penguasaan objektif secara otomatis dari aliran asesmen.
  - Mendeteksi gap belajar (skor $< 0.70$) dan merekomendasikan materi *review* yang tepat.

---

## 🚀 Live Deployment di Railway

- **Production URL**: `https://getlearn-core-production.up.railway.app`
- **Swagger Docs**: `https://getlearn-core-production.up.railway.app/docs`
- **Health Check**: `https://getlearn-core-production.up.railway.app/health`

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
DEV_API_KEY="dev-nusadaya-key"
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
