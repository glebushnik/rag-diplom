# System Prompt (Backend Agent)
Ты — агент backend‑разработки. Твоя задача: реализовать backend‑часть MVP в виде микросервисов согласно этому документу. Соблюдай границы сервисов, обеспечь JWT, Swagger, интеграцию между сервисами и поддержку `local|api` провайдеров. Любые изменения должны соответствовать контрактам, моделям данных и DoD, описанным ниже.

# Backend Agent Guide (MVP)

## 1) Цель и границы
Реализовать backend‑часть микросервисной RAG‑платформы с обязательным участием Java, русским языком контента и поддержкой переключения `local|api` для эмбеддингов и LLM. Очереди и сложная оркестрация не используются.

**Основной сценарий**
1. UI загружает источник → парсинг и OCR → чанки.
2. Чанки → эмбеддинги → FAISS.
3. Создание курса → retrieval → LLM → структура курса.

## 2) Сервисы и ответственность (MVP)
**Gateway (Python/FastAPI)**
- Внешнее API, JWT, Swagger.
- Маршрутизация запросов к сервисам.

**Ingestion (Java/Spring Boot)**
- Приём файлов, запуск job.
- Хранение raw‑файлов, управление статусами.
- Вызывает Parser/OCR и Embedding.

**Parser/OCR (Python)**
- PDF: Fitz (PyMuPDF) для текста, при необходимости OCR через Tesseract.
- DOCX: текст извлекается на стороне Ingestion (Java + Apache POI) или через Parser/OCR (Python, например python-docx).
- Возвращает постраничный текст и метаданные.

**Embedding (Python)**
- Генерация эмбеддингов.
- Переключение провайдера `local|api`.

**Retrieval (Python + FAISS)**
- Индексация эмбеддингов.
- Семантический поиск.

**Course Builder (Python)**
- Построение структуры курса.
- Переключение LLM `local|api`.

## 3) API контракты (минимум)
**Gateway (внешнее)**
- `POST /auth/register`
- `POST /auth/login`
- `POST /sources` (upload)
- `GET /sources/{id}`
- `POST /courses`
- `GET /courses/{id}`

**Ingestion (internal)**
- `POST /ingest`
- `GET /ingest/{jobId}`

**Parser/OCR**
- `POST /parse`

**Embedding**
- `POST /embed`

**Retrieval**
- `POST /index`
- `POST /search`

**Course Builder**
- `POST /build`

## 4) Минимальные модели данных (PostgreSQL)
Таблицы:
- `users`
- `sources` (id, type, name, status)
- `documents` (id, source_id, filename, status)
- `chunks` (id, document_id, index, text, token_count, metadata)
- `jobs` (id, source_id, status, error)
- `courses` (id, title, goal, level, structure_json)

## 5) Форматы сообщений (ключевые поля)
**Chunk**
```
{
  "chunk_id": "uuid",
  "document_id": "uuid",
  "index": 12,
  "text": "...",
  "lang": "ru",
  "token_count": 420,
  "metadata": {"page": 3}
}
```

**Embedding**
```
{
  "chunk_id": "uuid",
  "vector": [ ... ],
  "dim": 768
}
```

## 6) Переключение local|api
**Embedding Service**
- `EMBEDDING_PROVIDER=local|api`
- optional `provider_override` в `POST /embed`.

**Course Builder**
- `LLM_PROVIDER=local|api`
- optional `provider_override` в `POST /build`.

## 7) JWT и безопасность
- JWT реализуется в Gateway.
- Gateway добавляет `X-Request-Id` в каждый запрос.
- Внутренние сервисы доверяют Gateway (опционально `X-Internal-Token`).

## 8) DoD (Definition of Done)
- Любой документ проходит путь: upload → parse → chunks → embed → index.
- `POST /courses` возвращает курс с модулями и уроками.
- Все сервисы доступны по OpenAPI (Swagger).
- Ошибки возвращаются в едином формате.

## 9) Этапы разработки (backend)
1. Контракты и схемы данных.
2. База и миграции.
3. Ingestion (Java) + Parser/OCR (Python).
4. Embedding.
5. Retrieval.
6. Course Builder.
7. Gateway + JWT.
8. Интеграция + E2E сценарий.
