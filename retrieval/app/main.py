import json
import os
import threading
import uuid
from pathlib import Path
from typing import Any

import faiss
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


class EmbeddingIn(BaseModel):
    chunk_id: str
    vector: list[float]
    dim: int


class ChunkMeta(BaseModel):
    chunk_id: str
    document_id: str
    index: int
    text: str
    metadata: dict[str, Any] = Field(default_factory=dict)


class IndexRequest(BaseModel):
    source_id: str
    embeddings: list[EmbeddingIn]
    chunks: list[ChunkMeta]


class IndexResponse(BaseModel):
    source_id: str
    indexed: int


class SearchRequest(BaseModel):
    source_id: str
    query_vector: list[float] | None = None
    query_text: str | None = None
    top_k: int = 5


class SearchResult(BaseModel):
    chunk_id: str
    text: str
    metadata: dict[str, Any]
    score: float


class SearchResponse(BaseModel):
    results: list[SearchResult]


app = FastAPI(title="Retrieval Service", version="0.1.0")
DATA_DIR = Path(os.getenv("FAISS_DATA_DIR", "/data/faiss"))
DATA_DIR.mkdir(parents=True, exist_ok=True)
LOCK = threading.Lock()


def index_path(source_id: str) -> Path:
    return DATA_DIR / f"index_{source_id}.faiss"


def meta_path(source_id: str) -> Path:
    return DATA_DIR / f"meta_{source_id}.json"


def load_meta(source_id: str) -> list[dict[str, Any]]:
    path = meta_path(source_id)
    if not path.exists():
        return []
    with path.open("r", encoding="utf-8") as file:
        return json.load(file)


def save_meta(source_id: str, items: list[dict[str, Any]]) -> None:
    path = meta_path(source_id)
    with path.open("w", encoding="utf-8") as file:
        json.dump(items, file, ensure_ascii=False)


def get_query_vector_from_text(query_text: str, request_id: str) -> list[float]:
    embedding_url = os.getenv("EMBEDDING_URL", "http://embedding:8000")
    payload = {
        "chunks": [
            {
                "chunk_id": "query",
                "document_id": "query",
                "index": 0,
                "text": query_text,
                "lang": "ru",
                "token_count": len(query_text.split()),
                "metadata": {},
            }
        ]
    }
    response = httpx.post(
        f"{embedding_url}/embed",
        json=payload,
        headers={"X-Request-Id": request_id},
        timeout=30.0,
    )

    if response.status_code >= 400:
        raise ApiError(
            code="EMBEDDING_CALL_FAILED",
            message="Failed to build query embedding",
            status_code=502,
            details={"status_code": response.status_code, "body": response.text[:500]},
        )

    data = response.json()
    embeddings = data.get("embeddings", [])
    if not embeddings:
        raise ApiError(code="EMPTY_QUERY_VECTOR", message="Embedding provider returned no vectors", status_code=502)

    return embeddings[0]["vector"]


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
                "message": "Unexpected retrieval failure",
                "details": {"request_id": getattr(request.state, "request_id", None)},
            }
        },
    )


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/index", response_model=IndexResponse)
def index_chunks(payload: IndexRequest) -> IndexResponse:
    if not payload.embeddings:
        raise ApiError(code="EMPTY_EMBEDDINGS", message="No embeddings provided", status_code=400)

    dim = payload.embeddings[0].dim
    if dim <= 0:
        raise ApiError(code="INVALID_DIM", message="Embedding dim must be positive", status_code=400)

    for item in payload.embeddings:
        if item.dim != dim:
            raise ApiError(code="MIXED_DIM", message="All embeddings must share the same dimension", status_code=400)
        if len(item.vector) != dim:
            raise ApiError(
                code="DIMENSION_MISMATCH",
                message="Vector length does not match embedding dim",
                status_code=400,
                details={"chunk_id": item.chunk_id},
            )

    chunk_map = {chunk.chunk_id: chunk.model_dump() for chunk in payload.chunks}
    vectors = np.array([embedding.vector for embedding in payload.embeddings], dtype=np.float32)
    faiss.normalize_L2(vectors)

    with LOCK:
        path = index_path(payload.source_id)
        if path.exists():
            index = faiss.read_index(str(path))
            if index.d != dim:
                raise ApiError(
                    code="INDEX_DIMENSION_MISMATCH",
                    message="Existing FAISS index dimension does not match incoming vectors",
                    status_code=409,
                    details={"existing_dim": int(index.d), "incoming_dim": dim},
                )
        else:
            index = faiss.IndexFlatIP(dim)

        index.add(vectors)
        faiss.write_index(index, str(path))

        meta_items = load_meta(payload.source_id)
        for embedding in payload.embeddings:
            metadata = chunk_map.get(embedding.chunk_id, {"chunk_id": embedding.chunk_id, "text": "", "metadata": {}})
            meta_items.append(metadata)
        save_meta(payload.source_id, meta_items)

    return IndexResponse(source_id=payload.source_id, indexed=len(payload.embeddings))


@app.post("/search", response_model=SearchResponse)
def search(payload: SearchRequest, request: Request) -> SearchResponse:
    if payload.top_k <= 0:
        raise ApiError(code="INVALID_TOP_K", message="top_k must be greater than zero", status_code=400)

    path = index_path(payload.source_id)
    if not path.exists():
        return SearchResponse(results=[])

    query_vector = payload.query_vector
    if query_vector is None:
        if not payload.query_text:
            raise ApiError(code="MISSING_QUERY", message="Provide query_vector or query_text", status_code=400)
        query_vector = get_query_vector_from_text(payload.query_text, getattr(request.state, "request_id", str(uuid.uuid4())))

    with LOCK:
        index = faiss.read_index(str(path))
        if len(query_vector) != index.d:
            raise ApiError(
                code="QUERY_DIMENSION_MISMATCH",
                message="Query vector dimension does not match index",
                status_code=400,
                details={"index_dim": int(index.d), "query_dim": len(query_vector)},
            )

        metadata = load_meta(payload.source_id)
        if not metadata:
            return SearchResponse(results=[])

        query = np.array([query_vector], dtype=np.float32)
        faiss.normalize_L2(query)
        limit = min(payload.top_k, len(metadata))
        scores, indices = index.search(query, limit)

    results: list[SearchResult] = []
    for rank, idx in enumerate(indices[0]):
        if idx < 0 or idx >= len(metadata):
            continue
        item = metadata[idx]
        results.append(
            SearchResult(
                chunk_id=item.get("chunk_id", ""),
                text=item.get("text", ""),
                metadata=item.get("metadata", {}),
                score=float(scores[0][rank]),
            )
        )

    return SearchResponse(results=results)
