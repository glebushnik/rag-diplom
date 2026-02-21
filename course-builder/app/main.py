import json
import os
import uuid
from typing import Any, Literal

import httpx
import psycopg
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel


class ApiError(Exception):
    def __init__(self, code: str, message: str, status_code: int = 400, details: dict[str, Any] | None = None):
        self.code = code
        self.message = message
        self.status_code = status_code
        self.details = details or {}
        super().__init__(message)


class BuildRequest(BaseModel):
    source_id: str
    user_id: str | None = None
    title: str
    goal: str
    level: str
    provider_override: Literal["local", "api"] | None = None


class BuildResponse(BaseModel):
    course_id: str
    structure: dict[str, Any]
    provider: Literal["local", "api"]


app = FastAPI(title="Course Builder Service", version="0.1.0")


def postgres_url() -> str:
    value = os.getenv("POSTGRES_URL", "")
    if not value:
        raise ApiError(code="MISSING_POSTGRES_URL", message="POSTGRES_URL is required", status_code=500)
    return value


async def get_retrieval_context(payload: BuildRequest, request_id: str) -> list[dict[str, Any]]:
    retrieval_url = os.getenv("RETRIEVAL_URL", "http://retrieval:8000")
    top_k = int(os.getenv("COURSE_TOP_K", "8"))

    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.post(
            f"{retrieval_url}/search",
            json={"source_id": payload.source_id, "query_text": payload.goal, "top_k": top_k},
            headers={"X-Request-Id": request_id},
        )

    if response.status_code >= 400:
        raise ApiError(
            code="RETRIEVAL_FAILED",
            message="Retrieval service returned an error",
            status_code=502,
            details={"status_code": response.status_code, "body": response.text[:500]},
        )

    data = response.json()
    return data.get("results", [])


def build_local_structure(payload: BuildRequest, context_chunks: list[dict[str, Any]]) -> dict[str, Any]:
    modules: list[dict[str, Any]] = []

    if not context_chunks:
        modules.append(
            {
                "title": "Модуль 1: Введение",
                "lessons": [
                    {
                        "title": "Урок 1: Базовые понятия",
                        "summary": f"Цель курса: {payload.goal}",
                    }
                ],
            }
        )
    else:
        group_size = 2
        selected = context_chunks[:8]
        for idx in range(0, len(selected), group_size):
            group = selected[idx : idx + group_size]
            module_number = (idx // group_size) + 1
            lessons = []
            for lesson_number, chunk in enumerate(group, start=1):
                text = chunk.get("text", "")
                summary = text[:260].strip()
                if len(text) > 260:
                    summary += "..."
                lessons.append(
                    {
                        "title": f"Урок {module_number}.{lesson_number}",
                        "summary": summary,
                        "source_chunk_id": chunk.get("chunk_id"),
                        "score": chunk.get("score"),
                    }
                )

            modules.append(
                {
                    "title": f"Модуль {module_number}",
                    "lessons": lessons,
                }
            )

    return {
        "title": payload.title,
        "goal": payload.goal,
        "level": payload.level,
        "modules": modules,
    }


async def build_via_api(payload: BuildRequest, context_chunks: list[dict[str, Any]], request_id: str) -> dict[str, Any]:
    llm_api_url = os.getenv("LLM_API_URL", "").strip()
    if not llm_api_url:
        return build_local_structure(payload, context_chunks)

    async with httpx.AsyncClient(timeout=60.0) as client:
        response = await client.post(
            llm_api_url,
            json={
                "title": payload.title,
                "goal": payload.goal,
                "level": payload.level,
                "context": context_chunks,
            },
            headers={"X-Request-Id": request_id},
        )

    if response.status_code >= 400:
        raise ApiError(
            code="LLM_API_FAILED",
            message="LLM API provider returned an error",
            status_code=502,
            details={"status_code": response.status_code, "body": response.text[:500]},
        )

    data = response.json()
    if isinstance(data, dict) and isinstance(data.get("structure"), dict):
        return data["structure"]
    if isinstance(data, dict):
        return data

    raise ApiError(code="LLM_API_INVALID_RESPONSE", message="LLM API provider returned invalid response", status_code=502)


def save_course(payload: BuildRequest, structure: dict[str, Any]) -> str:
    course_id = str(uuid.uuid4())
    query = """
        INSERT INTO courses (id, source_id, user_id, title, goal, level, structure_json)
        VALUES (%s, %s, %s, %s, %s, %s, %s::jsonb)
    """

    with psycopg.connect(postgres_url(), autocommit=True) as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                query,
                (
                    course_id,
                    payload.source_id,
                    payload.user_id,
                    payload.title,
                    payload.goal,
                    payload.level,
                    json.dumps(structure, ensure_ascii=False),
                ),
            )

    return course_id


@app.middleware("http")
async def request_id_middleware(request: Request, call_next):
    request_id = request.headers.get("X-Request-Id", str(uuid.uuid4()))
    request.state.request_id = request_id
    response = await call_next(request)
    response.headers["X-Request-Id"] = request_id
    return response


@app.exception_handler(ApiError)
async def api_error_handler(request: Request, exc: ApiError):
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": {"code": exc.code, "message": exc.message, "details": exc.details}},
    )


@app.exception_handler(Exception)
async def unhandled_error_handler(request: Request, exc: Exception):
    return JSONResponse(
        status_code=500,
        content={
            "error": {
                "code": "INTERNAL_ERROR",
                "message": "Unexpected course builder failure",
                "details": {"request_id": getattr(request.state, "request_id", None)},
            }
        },
    )


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/build", response_model=BuildResponse)
async def build_course(payload: BuildRequest, request: Request) -> BuildResponse:
    provider = payload.provider_override or os.getenv("LLM_PROVIDER", "local")
    if provider not in {"local", "api"}:
        raise ApiError(code="INVALID_PROVIDER", message="provider must be local or api", status_code=400)

    request_id = getattr(request.state, "request_id", str(uuid.uuid4()))
    context_chunks = await get_retrieval_context(payload, request_id)

    if provider == "api":
        structure = await build_via_api(payload, context_chunks, request_id)
    else:
        structure = build_local_structure(payload, context_chunks)

    course_id = save_course(payload, structure)
    return BuildResponse(course_id=course_id, structure=structure, provider=provider)
