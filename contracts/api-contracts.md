# API Contracts (MVP)

## Общие правила
- Внешний API: только через Gateway (`/api/v1/...`).
- JWT обязателен для защищенных эндпоинтов.
- `X-Request-Id` генерируется в Gateway и прокидывается дальше.
- Единый формат ошибки:

```json
{
  "error": {
    "code": "SOME_CODE",
    "message": "Human readable",
    "details": {}
  }
}
```

## Gateway (external)
### `POST /api/v1/auth/register`
Request:
```json
{
  "email": "user@example.com",
  "password": "strong-password"
}
```
Response `201`:
```json
{
  "id": "uuid",
  "email": "user@example.com"
}
```

### `POST /api/v1/auth/login`
Request:
```json
{
  "email": "user@example.com",
  "password": "strong-password"
}
```
Response `200`:
```json
{
  "access_token": "jwt",
  "token_type": "bearer"
}
```

### `POST /api/v1/sources`
Multipart: `file`, `type` (optional).
Response `202`:
```json
{
  "source_id": "uuid",
  "job_id": "uuid",
  "status": "queued"
}
```

### `GET /api/v1/sources/{id}`
Response `200`:
```json
{
  "id": "uuid",
  "type": "document",
  "name": "file.pdf",
  "status": "indexed",
  "job": {
    "id": "uuid",
    "status": "indexed",
    "error": null
  }
}
```

### `POST /api/v1/courses`
Request:
```json
{
  "source_id": "uuid",
  "title": "Курс",
  "goal": "Освоить тему",
  "level": "beginner",
  "provider_override": "local"
}
```
Response `201`:
```json
{
  "course_id": "uuid",
  "structure": {
    "title": "Курс",
    "modules": []
  }
}
```

### `GET /api/v1/courses/{id}`
Response `200`:
```json
{
  "id": "uuid",
  "title": "Курс",
  "goal": "Освоить тему",
  "level": "beginner",
  "structure": {}
}
```

## Ingestion (internal)
### `POST /ingest`
Multipart: `file`, `sourceId`, `documentId` (optional), `userId` (optional), `sourceType` (optional).
Response `200`:
```json
{
  "jobId": "uuid",
  "sourceId": "uuid",
  "documentId": "uuid",
  "status": "indexed"
}
```

### `GET /ingest/{jobId}`
Response `200`:
```json
{
  "jobId": "uuid",
  "sourceId": "uuid",
  "status": "processing",
  "error": null
}
```

## Parser/OCR
### `POST /parse`
Multipart: `file`.
Response `200`:
```json
{
  "document_meta": {
    "filename": "file.pdf",
    "pages": 3
  },
  "chunks": [
    {
      "index": 0,
      "text": "...",
      "lang": "ru",
      "token_count": 42,
      "metadata": {"page": 1}
    }
  ]
}
```

## Embedding
### `POST /embed`
Request:
```json
{
  "provider_override": "local",
  "chunks": [
    {
      "chunk_id": "uuid",
      "document_id": "uuid",
      "index": 0,
      "text": "...",
      "lang": "ru",
      "token_count": 42,
      "metadata": {"page": 1}
    }
  ]
}
```
Response `200`:
```json
{
  "provider": "local",
  "embeddings": [
    {
      "chunk_id": "uuid",
      "vector": [0.1, 0.2],
      "dim": 2
    }
  ]
}
```

## Retrieval
### `POST /index`
Request:
```json
{
  "source_id": "uuid",
  "embeddings": [
    {
      "chunk_id": "uuid",
      "vector": [0.1, 0.2],
      "dim": 2
    }
  ],
  "chunks": [
    {
      "chunk_id": "uuid",
      "document_id": "uuid",
      "index": 0,
      "text": "...",
      "metadata": {"page": 1}
    }
  ]
}
```
Response `200`:
```json
{
  "source_id": "uuid",
  "indexed": 1
}
```

### `POST /search`
Request:
```json
{
  "source_id": "uuid",
  "query_vector": [0.1, 0.2],
  "top_k": 5
}
```
Response `200`:
```json
{
  "results": [
    {
      "chunk_id": "uuid",
      "text": "...",
      "metadata": {"page": 1},
      "score": 0.91
    }
  ]
}
```

## Course Builder
### `POST /build`
Request:
```json
{
  "source_id": "uuid",
  "user_id": "uuid",
  "title": "Курс",
  "goal": "Освоить тему",
  "level": "beginner",
  "provider_override": "local"
}
```
Response `200`:
```json
{
  "course_id": "uuid",
  "structure": {
    "title": "Курс",
    "modules": []
  },
  "provider": "local"
}
```
