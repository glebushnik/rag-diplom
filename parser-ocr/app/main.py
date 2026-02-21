import io
import os
import uuid
from typing import Any

import fitz
import pytesseract
from docx import Document as DocxDocument
from fastapi import FastAPI, File, Request, UploadFile
from fastapi.responses import JSONResponse
from PIL import Image
from pydantic import BaseModel, Field


class ApiError(Exception):
    def __init__(self, code: str, message: str, status_code: int = 400, details: dict[str, Any] | None = None):
        self.code = code
        self.message = message
        self.status_code = status_code
        self.details = details or {}
        super().__init__(message)


class ChunkOut(BaseModel):
    index: int
    text: str
    lang: str = "ru"
    token_count: int
    metadata: dict[str, Any] = Field(default_factory=dict)


class ParseResponse(BaseModel):
    document_meta: dict[str, Any]
    chunks: list[ChunkOut]


app = FastAPI(title="Parser/OCR Service", version="0.1.0")


def split_to_chunks(text: str, max_chars: int = 1200, overlap: int = 200) -> list[str]:
    normalized = " ".join(text.split())
    if not normalized:
        return []

    chunks: list[str] = []
    start = 0
    length = len(normalized)

    while start < length:
        end = min(start + max_chars, length)
        chunk = normalized[start:end].strip()
        if chunk:
            chunks.append(chunk)
        if end >= length:
            break
        start = max(0, end - overlap)

    return chunks


def token_count(text: str) -> int:
    return len(text.split())


def extract_pdf(file_bytes: bytes) -> tuple[list[tuple[int, str]], int]:
    language = os.getenv("TESSERACT_LANG", "rus")
    pages: list[tuple[int, str]] = []

    with fitz.open(stream=file_bytes, filetype="pdf") as pdf:
        total_pages = pdf.page_count
        for page_index in range(total_pages):
            page = pdf[page_index]
            text = (page.get_text("text") or "").strip()

            if not text:
                pix = page.get_pixmap(dpi=220)
                image_bytes = pix.tobytes("png")
                image = Image.open(io.BytesIO(image_bytes))
                text = pytesseract.image_to_string(image, lang=language).strip()

            if text:
                pages.append((page_index + 1, text))

    return pages, total_pages


def extract_docx(file_bytes: bytes) -> str:
    document = DocxDocument(io.BytesIO(file_bytes))
    paragraphs = [paragraph.text.strip() for paragraph in document.paragraphs if paragraph.text.strip()]
    return "\n".join(paragraphs)


def extract_plain_text(file_bytes: bytes) -> str:
    try:
        return file_bytes.decode("utf-8")
    except UnicodeDecodeError:
        return file_bytes.decode("latin-1", errors="ignore")


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
                "message": "Unexpected parser failure",
                "details": {"request_id": getattr(request.state, "request_id", None)},
            }
        },
    )


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/parse", response_model=ParseResponse)
async def parse(file: UploadFile = File(...)) -> ParseResponse:
    file_bytes = await file.read()
    if not file_bytes:
        raise ApiError(code="EMPTY_FILE", message="Uploaded file is empty", status_code=400)

    filename = file.filename or "document"
    lower_name = filename.lower()
    chunks: list[ChunkOut] = []
    chunk_index = 0
    page_count = 1

    if lower_name.endswith(".pdf"):
        pages, page_count = extract_pdf(file_bytes)
        for page, text in pages:
            for piece in split_to_chunks(text):
                chunks.append(
                    ChunkOut(
                        index=chunk_index,
                        text=piece,
                        token_count=token_count(piece),
                        metadata={"page": page},
                    )
                )
                chunk_index += 1
    elif lower_name.endswith(".docx"):
        doc_text = extract_docx(file_bytes)
        for piece in split_to_chunks(doc_text):
            chunks.append(
                ChunkOut(
                    index=chunk_index,
                    text=piece,
                    token_count=token_count(piece),
                    metadata={"page": 1},
                )
            )
            chunk_index += 1
    else:
        raw_text = extract_plain_text(file_bytes)
        for piece in split_to_chunks(raw_text):
            chunks.append(
                ChunkOut(
                    index=chunk_index,
                    text=piece,
                    token_count=token_count(piece),
                    metadata={"page": 1},
                )
            )
            chunk_index += 1

    if not chunks:
        raise ApiError(code="NO_TEXT_EXTRACTED", message="No text was extracted from the file", status_code=422)

    return ParseResponse(document_meta={"filename": filename, "pages": page_count}, chunks=chunks)
