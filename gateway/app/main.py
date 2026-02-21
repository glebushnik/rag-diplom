import os
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Literal

import httpx
import psycopg
from fastapi import Depends, FastAPI, File, Form, Request, UploadFile
from fastapi.responses import JSONResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt
from passlib.context import CryptContext
from pydantic import BaseModel, EmailStr


class ApiError(Exception):
    def __init__(self, code: str, message: str, status_code: int = 400, details: dict[str, Any] | None = None):
        self.code = code
        self.message = message
        self.status_code = status_code
        self.details = details or {}
        super().__init__(message)


class RegisterRequest(BaseModel):
    email: EmailStr
    password: str


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class UserResponse(BaseModel):
    id: str
    email: EmailStr


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"


class SourceAcceptedResponse(BaseModel):
    source_id: str
    job_id: str
    status: str


class SourceDetailsResponse(BaseModel):
    id: str
    type: str
    name: str
    status: str
    job: dict[str, Any] | None = None


class CourseCreateRequest(BaseModel):
    source_id: str
    title: str
    goal: str
    level: str
    provider_override: Literal["local", "api"] | None = None


class CourseCreateResponse(BaseModel):
    course_id: str
    structure: dict[str, Any]


class CourseDetailsResponse(BaseModel):
    id: str
    title: str
    goal: str
    level: str
    structure: dict[str, Any]


app = FastAPI(title="Gateway Service", version="0.1.0")
password_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
bearer_security = HTTPBearer(auto_error=False)


def postgres_url() -> str:
    value = os.getenv("POSTGRES_URL", "")
    if not value:
        raise ApiError(code="MISSING_POSTGRES_URL", message="POSTGRES_URL is required", status_code=500)
    return value


def jwt_secret() -> str:
    value = os.getenv("JWT_SECRET", "")
    if not value:
        raise ApiError(code="MISSING_JWT_SECRET", message="JWT_SECRET is required", status_code=500)
    return value


def jwt_algorithm() -> str:
    return os.getenv("JWT_ALGORITHM", "HS256")


def db_connect() -> psycopg.Connection:
    return psycopg.connect(postgres_url(), autocommit=True)


def create_access_token(user_id: str, email: str) -> str:
    lifetime_minutes = int(os.getenv("JWT_EXPIRE_MINUTES", "60"))
    expires_at = datetime.now(timezone.utc) + timedelta(minutes=lifetime_minutes)
    payload = {"sub": user_id, "email": email, "exp": expires_at}
    return jwt.encode(payload, jwt_secret(), algorithm=jwt_algorithm())


async def current_user(credentials: HTTPAuthorizationCredentials = Depends(bearer_security)) -> dict[str, str]:
    if credentials is None:
        raise ApiError(code="UNAUTHORIZED", message="Authorization token is required", status_code=401)

    try:
        payload = jwt.decode(credentials.credentials, jwt_secret(), algorithms=[jwt_algorithm()])
        user_id = payload.get("sub")
        if not user_id:
            raise ApiError(code="UNAUTHORIZED", message="Token payload is invalid", status_code=401)
    except JWTError as error:
        raise ApiError(code="UNAUTHORIZED", message="Token is invalid or expired", status_code=401) from error

    with db_connect() as connection:
        with connection.cursor() as cursor:
            cursor.execute("SELECT id, email FROM users WHERE id = %s", (user_id,))
            row = cursor.fetchone()

    if not row:
        raise ApiError(code="UNAUTHORIZED", message="User does not exist", status_code=401)

    return {"id": str(row[0]), "email": row[1]}


async def forward_error(response: httpx.Response) -> None:
    details: dict[str, Any] = {"status_code": response.status_code}
    code = "UPSTREAM_ERROR"
    message = "Internal service error"

    try:
        payload = response.json()
        error = payload.get("error") if isinstance(payload, dict) else None
        if isinstance(error, dict):
            code = str(error.get("code", code))
            message = str(error.get("message", message))
            details = error.get("details") if isinstance(error.get("details"), dict) else details
        else:
            details["body"] = payload
    except Exception:
        details["body"] = response.text[:500]

    raise ApiError(code=code, message=message, status_code=502, details=details)


async def call_internal(
    method: str,
    url: str,
    request_id: str,
    json_payload: dict[str, Any] | None = None,
    data_payload: dict[str, Any] | None = None,
    files_payload: dict[str, Any] | None = None,
) -> httpx.Response:
    headers = {"X-Request-Id": request_id}
    internal_token = os.getenv("INTERNAL_TOKEN", "").strip()
    if internal_token:
        headers["X-Internal-Token"] = internal_token

    async with httpx.AsyncClient(timeout=120.0) as client:
        response = await client.request(
            method=method,
            url=url,
            headers=headers,
            json=json_payload,
            data=data_payload,
            files=files_payload,
        )

    if response.status_code >= 400:
        await forward_error(response)

    return response


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
                "message": "Unexpected gateway failure",
                "details": {"request_id": getattr(request.state, "request_id", None)},
            }
        },
    )


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/v1/auth/register", response_model=UserResponse, status_code=201)
def register(payload: RegisterRequest) -> UserResponse:
    if len(payload.password) < 8:
        raise ApiError(code="WEAK_PASSWORD", message="Password must contain at least 8 characters", status_code=400)

    password_hash = password_context.hash(payload.password)

    with db_connect() as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO users (email, password_hash)
                VALUES (%s, %s)
                ON CONFLICT (email) DO NOTHING
                RETURNING id, email
                """,
                (payload.email, password_hash),
            )
            row = cursor.fetchone()

    if not row:
        raise ApiError(code="EMAIL_ALREADY_EXISTS", message="User with this email already exists", status_code=409)

    return UserResponse(id=str(row[0]), email=row[1])


@app.post("/api/v1/auth/login", response_model=TokenResponse)
def login(payload: LoginRequest) -> TokenResponse:
    with db_connect() as connection:
        with connection.cursor() as cursor:
            cursor.execute("SELECT id, email, password_hash FROM users WHERE email = %s", (payload.email,))
            row = cursor.fetchone()

    if not row or not password_context.verify(payload.password, row[2]):
        raise ApiError(code="INVALID_CREDENTIALS", message="Email or password is incorrect", status_code=401)

    token = create_access_token(str(row[0]), row[1])
    return TokenResponse(access_token=token)


@app.post("/api/v1/sources", response_model=SourceAcceptedResponse, status_code=202)
async def upload_source(
    request: Request,
    user: dict[str, str] = Depends(current_user),
    file: UploadFile = File(...),
    source_type: str = Form(default="document", alias="type"),
) -> SourceAcceptedResponse:
    file_bytes = await file.read()
    if not file_bytes:
        raise ApiError(code="EMPTY_FILE", message="Uploaded file is empty", status_code=400)

    source_id = str(uuid.uuid4())
    ingestion_url = os.getenv("INGESTION_URL", "http://ingestion-java:8080")
    response = await call_internal(
        method="POST",
        url=f"{ingestion_url}/ingest",
        request_id=getattr(request.state, "request_id", str(uuid.uuid4())),
        data_payload={"sourceId": source_id, "userId": user["id"], "sourceType": source_type},
        files_payload={"file": (file.filename or "document", file_bytes, file.content_type or "application/octet-stream")},
    )

    try:
        payload = response.json()
    except Exception as error:
        raise ApiError(code="INVALID_UPSTREAM_PAYLOAD", message="Ingestion returned invalid payload", status_code=502) from error

    return SourceAcceptedResponse(
        source_id=str(payload.get("sourceId", source_id)),
        job_id=str(payload.get("jobId", "")),
        status=str(payload.get("status", "queued")),
    )


@app.get("/api/v1/sources/{source_id}", response_model=SourceDetailsResponse)
def source_details(source_id: str, user: dict[str, str] = Depends(current_user)) -> SourceDetailsResponse:
    query = """
        SELECT s.id, s.type, s.name, s.status, j.id AS job_id, j.status AS job_status, j.error
        FROM sources s
        LEFT JOIN LATERAL (
            SELECT id, status, error
            FROM jobs
            WHERE source_id = s.id
            ORDER BY created_at DESC
            LIMIT 1
        ) j ON TRUE
        WHERE s.id = %s
          AND (s.user_id = %s OR s.user_id IS NULL)
    """

    with db_connect() as connection:
        with connection.cursor() as cursor:
            cursor.execute(query, (source_id, user["id"]))
            row = cursor.fetchone()

    if not row:
        raise ApiError(code="SOURCE_NOT_FOUND", message="Source not found", status_code=404)

    job = None
    if row[4]:
        job = {"id": str(row[4]), "status": row[5], "error": row[6]}

    return SourceDetailsResponse(id=str(row[0]), type=row[1], name=row[2], status=row[3], job=job)


@app.post("/api/v1/courses", response_model=CourseCreateResponse, status_code=201)
async def create_course(
    payload: CourseCreateRequest,
    request: Request,
    user: dict[str, str] = Depends(current_user),
) -> CourseCreateResponse:
    builder_url = os.getenv("COURSE_BUILDER_URL", "http://course-builder:8000")
    response = await call_internal(
        method="POST",
        url=f"{builder_url}/build",
        request_id=getattr(request.state, "request_id", str(uuid.uuid4())),
        json_payload={
            "source_id": payload.source_id,
            "user_id": user["id"],
            "title": payload.title,
            "goal": payload.goal,
            "level": payload.level,
            "provider_override": payload.provider_override,
        },
    )

    data = response.json()
    return CourseCreateResponse(course_id=str(data.get("course_id")), structure=data.get("structure", {}))


@app.get("/api/v1/courses/{course_id}", response_model=CourseDetailsResponse)
def course_details(course_id: str, user: dict[str, str] = Depends(current_user)) -> CourseDetailsResponse:
    with db_connect() as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT id, title, goal, level, structure_json
                FROM courses
                WHERE id = %s
                  AND (user_id = %s OR user_id IS NULL)
                """,
                (course_id, user["id"]),
            )
            row = cursor.fetchone()

    if not row:
        raise ApiError(code="COURSE_NOT_FOUND", message="Course not found", status_code=404)

    structure = row[4]
    if isinstance(structure, str):
        try:
            import json

            structure = json.loads(structure)
        except Exception:
            structure = {}

    return CourseDetailsResponse(id=str(row[0]), title=row[1], goal=row[2], level=row[3], structure=structure or {})
