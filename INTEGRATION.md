# System Prompt (Integration Agent)
Ты — агент интеграции. Твоя задача: обеспечить согласованность фронтенда, бэкенда и DevOps по контрактам, потокам данных, статусам job, JWT и формату ошибок. Следи, чтобы все внешние запросы шли через Gateway и соблюдались стандарты взаимодействия.

# Integration Guide (Frontend ↔ Backend ↔ DevOps)

## 1) Общая идея интеграции
Все внешние запросы идут **только** через Gateway.  
Gateway отвечает за JWT, Swagger, валидацию и единый формат ошибок.

## 2) Стандарты взаимодействия
**Заголовки**
- `Authorization: Bearer <JWT>`
- `X-Request-Id: <uuid>` (Gateway генерирует, остальные прокидывают)

**Единый формат ошибки**
```
{
  "error": {
    "code": "SOME_CODE",
    "message": "Human readable",
    "details": {}
  }
}
```

## 3) Критичные потоки

**Upload → Index**
1. UI → Gateway: `POST /sources` (file)
2. Gateway → Ingestion: `POST /ingest`
3. Ingestion → Parser/OCR: `POST /parse`
4. Ingestion сохраняет чанки → Embedding
5. Embedding → Retrieval: `POST /index`

**Build Course**
1. UI → Gateway: `POST /courses`
2. Gateway → Course Builder: `POST /build`
3. Course Builder → Retrieval: `POST /search`
4. Course Builder → Postgres: сохранение курса

## 4) Схемы статусов (jobs)
Статусы job:
- `queued`
- `processing`
- `embedded`
- `indexed`
- `failed`

UI должен отображать статусы по `GET /sources/{id}`.

## 5) JWT
- Регистрация/логин только через Gateway.
- Gateway добавляет `X-Internal-Token` для доверия внутренних сервисов (опционально).

## 6) Версионирование API
Минимум: `/api/v1/...` в Gateway.

## 7) Конфигурация провайдеров
Переключение `local|api` должно быть:
- configurable через `.env`
- опционально через запрос (override)

## 8) Связь с DevOps
Все сервисы поднимаются через docker-compose:
- имена сервисов используются как DNS (`retrieval`, `embedding`, и т.д.)
- Gateway знает адреса через `.env`

## 9) DoD
- Все запросы проходят через Gateway.
- JWT обязателен для защищённых методов.
- Status‑flow корректно отражается в UI.
