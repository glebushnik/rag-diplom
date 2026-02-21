# Backend MVP (RAG microservices)

## Services
- `gateway` (FastAPI): external API, JWT, request routing
- `ingestion-java` (Spring Boot): file ingestion and pipeline orchestration
- `parser-ocr` (FastAPI): parsing PDF/DOCX/TXT + OCR fallback
- `embedding` (FastAPI): embeddings with `local|api`
- `retrieval` (FastAPI + FAISS): indexing and semantic search
- `course-builder` (FastAPI): course generation with `local|api`
- `frontend` (React + Vite + Nginx): web UI for Gateway API
- `postgres` (PostgreSQL): shared data storage

## Quick start
1. Copy env file:
```bash
cp .env.example .env
```

2. Start all services:
```bash
docker compose up --build
```

3. Open docs:
- Gateway: `http://localhost:8000/docs`
- Ingestion (Java): `http://localhost:8080/swagger-ui`
- Parser/OCR: `http://localhost:8001/docs`
- Embedding: `http://localhost:8002/docs`
- Retrieval: `http://localhost:8003/docs`
- Course Builder: `http://localhost:8004/docs`
- Frontend: `http://localhost:3000`

## External API (Gateway)
- `POST /api/v1/auth/register`
- `POST /api/v1/auth/login`
- `POST /api/v1/sources`
- `GET /api/v1/sources/{id}`
- `POST /api/v1/courses`
- `GET /api/v1/courses/{id}`

Contracts: `contracts/api-contracts.md`.

## DB and migrations
Migration SQL: `migrations/001_init.sql`.

Tables:
- `users`
- `sources`
- `documents`
- `chunks`
- `jobs`
- `courses`

## Expected status flow
`queued -> processing -> embedded -> indexed` (or `failed`).

## Notes
- Python сервисы в Docker используют `uv` для установки зависимостей.
- Set `EMBEDDING_PROVIDER=local|api`.
- Set `LLM_PROVIDER=local|api`.
- When API provider URLs are empty, services use local fallback behavior.

## Frontend UX update
- Обновлен минималистичный стиль Flowa с акцентом на palette `mint/sky/peach`.
- Лэндинг упрощен: меньше текста, больше визуального flow и коротких CTA.
- В app-шапке кнопка `Лендинг` заменена на `На главную`.
- В админке добавлены быстрые переходы `В кабинет` и `На главную` (возврат из `/admin`).
