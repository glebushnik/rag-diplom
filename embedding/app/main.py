import hashlib
import os
import uuid
from typing import Any, Literal

import httpx
import numpy as np
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field


class ApiError(Exception):
    def __init__(self, code: str, message: str, status_code: int = 400, details: dict[str, Any] | None = None):
        self.code = code
        self.message = message
        self.status_code = status_code
        self.details = details or {}
        super().__init__(message)


class ChunkIn(BaseModel):
    chunk_id: str
    document_id: str
    index: int
    text: str
    lang: str = "ru"
    token_count: int
    metadata: dict[str, Any] = Field(default_factory=dict)


class EmbedRequest(BaseModel):
    chunks: list[ChunkIn]
    provider_override: Literal["local", "api"] | None = None


class EmbeddingOut(BaseModel):
    chunk_id: str
    vector: list[float]
    dim: int


class EmbedResponse(BaseModel):
    provider: Literal["local", "api"]
    embeddings: list[EmbeddingOut]


app = FastAPI(title="Embedding Service", version="0.1.0")


def embed_local(text: str, dim: int) -> list[float]:
    vector = np.zeros(dim, dtype=np.float32)
    tokens = [token for token in text.lower().split() if token]

    if not tokens:
        tokens = ["__empty__"]

    for token in tokens:
        digest = hashlib.blake2b(token.encode("utf-8"), digest_size=32).digest()
        for i, value in enumerate(digest):
            idx = (i * 131 + value) % dim
            vector[idx] += (value / 255.0) - 0.5

    norm = np.linalg.norm(vector)
    if norm > 0:
        vector /= norm

    return vector.astype(float).tolist()


async def embed_via_api(request_id: str, payload: EmbedRequest) -> EmbedResponse:
    api_url = os.getenv("EMBEDDING_API_URL", "").strip()
    if not api_url:
        return EmbedResponse(
            provider="api",
            embeddings=[
                EmbeddingOut(
                    chunk_id=chunk.chunk_id,
                    vector=embed_local(chunk.text, int(os.getenv("EMBEDDING_DIM", "768"))),
                    dim=int(os.getenv("EMBEDDING_DIM", "768")),
                )
                for chunk in payload.chunks
            ],
        )

    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.post(
            api_url,
            json=payload.model_dump(),
            headers={"X-Request-Id": request_id},
        )

    if response.status_code >= 400:
        raise ApiError(
            code="EMBEDDING_API_FAILED",
            message="Embedding API provider returned an error",
            status_code=502,
            details={"status_code": response.status_code, "body": response.text[:500]},
        )

    try:
        data = response.json()
        return EmbedResponse(**data)
    except Exception as error:
        raise ApiError(
            code="EMBEDDING_API_INVALID_RESPONSE",
            message="Embedding API provider returned invalid payload",
            status_code=502,
            details={"error": str(error)},
        ) from error


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
                "message": "Unexpected embedding failure",
                "details": {"request_id": getattr(request.state, "request_id", None)},
            }
        },
    )


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/embed", response_model=EmbedResponse)
async def embed(payload: EmbedRequest, request: Request) -> EmbedResponse:
    if not payload.chunks:
        raise ApiError(code="EMPTY_CHUNKS", message="At least one chunk is required", status_code=400)

    provider = payload.provider_override or os.getenv("EMBEDDING_PROVIDER", "local")
    if provider not in {"local", "api"}:
        raise ApiError(code="INVALID_PROVIDER", message="provider must be local or api", status_code=400)

    dim = int(os.getenv("EMBEDDING_DIM", "768"))
    if dim <= 0:
        raise ApiError(code="INVALID_DIM", message="EMBEDDING_DIM must be > 0", status_code=500)

    if provider == "api":
        return await embed_via_api(getattr(request.state, "request_id", str(uuid.uuid4())), payload)

    embeddings = [
        EmbeddingOut(chunk_id=chunk.chunk_id, vector=embed_local(chunk.text, dim), dim=dim)
        for chunk in payload.chunks
    ]
    return EmbedResponse(provider="local", embeddings=embeddings)
