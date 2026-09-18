# getlearn.ai Phase 0 & Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the foundational getlearn.ai backend service: canonical OpenAPI 3.1 spec (Phase 0), Fastify + TypeScript skeleton connected to Railway PostgreSQL via Prisma (Phase 1), with tenant isolation, idempotent event ingestion, and naive mastery calculation.

**Architecture:** A standalone Fastify REST API service interacting with Railway PostgreSQL using Prisma ORM. Requests are authenticated via Bearer API keys (Unkey-compatible) extracting `tenantId`. Event ingestion `/v1/events` handles idempotency and triggers synchronous recalculation of `MasteryRecord` and next-action recommendation.

**Tech Stack:** Node.js, TypeScript, Fastify, Prisma ORM, Railway PostgreSQL, `@fastify/swagger`, Zod.

## Global Constraints
- Every entity table in PostgreSQL MUST have a `tenantId` foreign key.
- `/v1/events` must be idempotent based on `event_id` per tenant.
- No learner PII (name/email) stored; only opaque LMS IDs (`externalRef`).
- Database host: Railway PostgreSQL (`getlearn-ai` project).

---

### Task 1: Canonical OpenAPI 3.1 Specification (Fase 0)

**Files:**
- Create: `docs/openapi.yaml`

**Interfaces:**
- Produces: Standardized OpenAPI 3.1 YAML defining all schemas (`Tenant`, `Learner`, `LearningObjective`, `ContentItem`, `AssessmentItem`, `AssessmentEvent`, `MasteryRecord`, `Recommendation`), endpoints, security schemes (`BearerAuth`), and error envelope.

- [ ] **Step 1: Write `docs/openapi.yaml`**
- [ ] **Step 2: Validate OpenAPI syntax with a linter / schema validator**

---

### Task 2: Project Scaffolding & Fastify Server Setup

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/config/env.ts`
- Create: `src/app.ts`
- Create: `src/server.ts`

**Interfaces:**
- Produces: Runnable Fastify app listening on `PORT` (default 3000) with CORS, JSON parsing, error handling, health check route `GET /health`, and Swagger UI mounted at `/docs`.

- [ ] **Step 1: Initialize package.json and install dependencies**
- [ ] **Step 2: Configure tsconfig.json**
- [ ] **Step 3: Implement env config, app.ts, and server.ts**
- [ ] **Step 4: Verify server starts and responds to `GET /health`**

---

### Task 3: Prisma Schema & Railway PostgreSQL Connection

**Files:**
- Create: `prisma/schema.prisma`
- Create: `.env`
- Create: `src/lib/prisma.ts`

**Interfaces:**
- Consumes: Railway PostgreSQL TCP Proxy connection URL.
- Produces: Prisma Client singleton with models: `Tenant`, `Learner`, `LearningObjective`, `ContentItem`, `AssessmentItem`, `AssessmentEvent`, `MasteryRecord`.

- [ ] **Step 1: Create `.env` with Railway PostgreSQL `DATABASE_URL`**
- [ ] **Step 2: Write `prisma/schema.prisma` with all multi-tenant models**
- [ ] **Step 3: Run `npx prisma db push` to synchronize tables to Railway PostgreSQL**
- [ ] **Step 4: Create `src/lib/prisma.ts` exporting initialized `PrismaClient`**

---

### Task 4: Authentication Middleware & Dev Tenant Resolver

**Files:**
- Create: `src/services/unkey.service.ts`
- Create: `src/middlewares/auth.middleware.ts`

**Interfaces:**
- Consumes: Authorization header `Bearer <token>`.
- Produces: Fastify preHandler hook attaching `req.tenantId` and `req.tenant`. Auto-seeds or resolves a default development tenant (`dev-tenant-nusadaya`) when running in local development mode or using dev keys.

- [ ] **Step 1: Write `unkey.service.ts`**
- [ ] **Step 2: Write `auth.middleware.ts`**
- [ ] **Step 3: Write unit/integration test for auth middleware**

---

### Task 5: Registration Routes (Objectives, Content, Assessments)

**Files:**
- Create: `src/modules/objectives/routes.ts`
- Create: `src/modules/content-items/routes.ts`
- Create: `src/modules/assessment-items/routes.ts`

**Interfaces:**
- Consumes: Authenticated tenant context.
- Produces:
  - `POST /v1/objectives` (upsert learning objectives)
  - `POST /v1/content-items` (upsert content item metadata)
  - `POST /v1/assessment-items` (upsert question prompts)

- [ ] **Step 1: Implement objectives routes**
- [ ] **Step 2: Implement content-items routes**
- [ ] **Step 3: Implement assessment-items routes**
- [ ] **Step 4: Register routes in `app.ts` and test with curl/requests**

---

### Task 6: Event Ingestion with Idempotency & Naive Mastery Calculator

**Files:**
- Create: `src/services/mastery.service.ts`
- Create: `src/modules/events/routes.ts`

**Interfaces:**
- Consumes: `POST /v1/events` payload (`event_id`, `event_type`, `external_learner_id`, `payload: { item_id, is_correct, raw_response }`).
- Produces:
  - Idempotent event storage (`AssessmentEvent`).
  - Automated update of `MasteryRecord` for all linked `objectiveIds`.

- [ ] **Step 1: Implement `mastery.service.ts` naive calculation formula**
- [ ] **Step 2: Implement `src/modules/events/routes.ts` with duplicate event check**
- [ ] **Step 3: Test idempotency and score updates**

---

### Task 7: Learner Intelligence Query Routes

**Files:**
- Create: `src/modules/learners/routes.ts`

**Interfaces:**
- Consumes: Learner ID parameter.
- Produces:
  - `GET /v1/learners/:id/mastery`
  - `GET /v1/learners/:id/gaps` (filter score < 0.70)
  - `GET /v1/learners/:id/next-action` (priority recommendation)

- [ ] **Step 1: Implement learner query endpoints**
- [ ] **Step 2: Connect next-action logic to identify weakest objective**
- [ ] **Step 3: Test responses for simulated learners**

---

### Task 8: End-to-End Integration Test Suite

**Files:**
- Create: `scripts/test-e2e.ts`

**Interfaces:**
- Exercises the entire Phase 0 & 1 lifecycle:
  1. Registers objectives and assessment items
  2. Submits answers for a learner (both correct and incorrect)
  3. Verifies mastery scores are calculated accurately
  4. Queries learner gaps and next action
  5. Re-submits an identical `event_id` to confirm idempotent deduplication

- [ ] **Step 1: Write `scripts/test-e2e.ts`**
- [ ] **Step 2: Run test against Railway PostgreSQL and assert 100% success**
