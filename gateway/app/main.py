import asyncio
import hashlib
import json
import os
import secrets
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Literal

import httpx
import psycopg
from fastapi import BackgroundTasks, Cookie, Depends, FastAPI, File, Form, Header, Query, Request, Response, UploadFile
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt
from passlib.context import CryptContext
from pydantic import BaseModel, EmailStr, Field
from psycopg.rows import dict_row


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


class SignupRequest(BaseModel):
    email: EmailStr
    password: str
    name: str = Field(min_length=1, max_length=120)


class RefreshRequest(BaseModel):
    refresh_token: str | None = None


class PasswordForgotRequest(BaseModel):
    email: EmailStr


class PasswordResetRequest(BaseModel):
    token: str
    password: str


class MePatchRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)


class WorkspaceCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    type: Literal["personal", "team", "business"] | None = None


class WorkspacePatchRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)


class WorkspaceMemberCreateRequest(BaseModel):
    email: EmailStr
    role: Literal["owner", "admin", "editor", "viewer"]


class WorkspaceMemberPatchRequest(BaseModel):
    role: Literal["owner", "admin", "editor", "viewer"]


class MaterialCreateRequest(BaseModel):
    workspace_id: str
    type: Literal["file", "url", "text"]
    title: str | None = None
    source_url: str | None = None
    text: str | None = None
    mime: str | None = None
    size_bytes: int | None = None


class MaterialFileInitRequest(BaseModel):
    workspace_id: str
    title: str | None = None
    mime: str | None = None
    size_bytes: int | None = None


class MaterialFileCompleteRequest(BaseModel):
    material_id: str


class CourseCreateApiRequest(BaseModel):
    workspace_id: str
    title: str | None = None
    goal: str | None = None
    level: Literal["beginner", "basic", "advanced"] | None = "beginner"
    format: Literal["quick", "standard", "deep"] | None = "standard"
    pace_minutes_per_day: int | None = None


class CoursePatchRequest(BaseModel):
    title: str | None = None
    description: str | None = None
    goal: str | None = None
    level: Literal["beginner", "basic", "advanced"] | None = None
    format: Literal["quick", "standard", "deep"] | None = None
    visibility: Literal["private", "shared_link", "workspace"] | None = None
    pace_minutes_per_day: int | None = None


class OutlineLessonRequest(BaseModel):
    id: str | None = None
    title: str
    order: int


class OutlineModuleRequest(BaseModel):
    id: str | None = None
    title: str
    order: int
    lessons: list[OutlineLessonRequest] = Field(default_factory=list)


class OutlinePatchRequest(BaseModel):
    modules: list[OutlineModuleRequest]


class BuildOptions(BaseModel):
    detail_level: str | None = None
    more_practice: bool = False


class BuildPlanRequest(BaseModel):
    material_ids: list[str] = Field(default_factory=list)
    goal: str
    level: Literal["beginner", "basic", "advanced"]
    format: Literal["quick", "standard", "deep"]
    pace_minutes_per_day: int | None = None
    options: BuildOptions = Field(default_factory=BuildOptions)


class BuildRunRequest(BaseModel):
    material_ids: list[str] = Field(default_factory=list)
    options: BuildOptions = Field(default_factory=BuildOptions)


class LessonRegenerateRequest(BaseModel):
    style: str | None = None
    focus: str | None = None


class PracticeAttemptRequest(BaseModel):
    answers: list[dict[str, Any]] = Field(default_factory=list)
    client_time_ms: int | None = None


class ProgressLessonRequest(BaseModel):
    lessonId: str | None = None
    lesson_id: str | None = None


class ShareCreateRequest(BaseModel):
    expires_at: datetime | None = None


class FeedbackCreateRequest(BaseModel):
    type: Literal["bug", "content", "billing", "other"]
    message: str
    course_id: str | None = None
    lesson_id: str | None = None
    meta: dict[str, Any] = Field(default_factory=dict)


class BillingCheckoutRequest(BaseModel):
    plan: Literal["free", "pro", "team", "business"]
    workspace_id: str | None = None


class AdminUserPatchRequest(BaseModel):
    status: Literal["active", "blocked", "deleted"] | None = None
    plan: Literal["free", "pro", "team", "business"] | None = None


class AdminCourseRebuildRequest(BaseModel):
    step: Literal["materials", "plan", "content", "practice", "finalize"] | None = "content"


class TemplateCreateRequest(BaseModel):
    name: str
    description: str | None = ""
    template_schema: dict[str, Any] = Field(default_factory=dict, alias="schema")


class TemplatePatchRequest(BaseModel):
    name: str | None = None
    description: str | None = None
    template_schema: dict[str, Any] | None = Field(default=None, alias="schema")


class AdminFeedbackPatchRequest(BaseModel):
    status: Literal["new", "in_progress", "resolved"]


class CourseCreateRequest(BaseModel):
    source_id: str
    title: str
    goal: str
    level: str
    provider_override: Literal["local", "api"] | None = None


app = FastAPI(title="Gateway Service", version="2.0.0")
password_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
bearer_security = HTTPBearer(auto_error=False)
started_at = datetime.now(timezone.utc)


PLAN_LIMITS: dict[str, dict[str, int]] = {
    "free": {
        "courses_created_this_month": 3,
        "materials_total_bytes": 100 * 1024 * 1024,
        "build_minutes": 60,
        "team_members": 1,
    },
    "pro": {
        "courses_created_this_month": 20,
        "materials_total_bytes": 5 * 1024 * 1024 * 1024,
        "build_minutes": 600,
        "team_members": 1,
    },
    "team": {
        "courses_created_this_month": 100,
        "materials_total_bytes": 50 * 1024 * 1024 * 1024,
        "build_minutes": 3000,
        "team_members": 20,
    },
    "business": {
        "courses_created_this_month": 1000,
        "materials_total_bytes": 500 * 1024 * 1024 * 1024,
        "build_minutes": 20000,
        "team_members": 200,
    },
}

PLAN_PRICING = {
    "free": {"monthly_usd": 0},
    "pro": {"monthly_usd": 19},
    "team": {"monthly_usd": 79},
    "business": {"monthly_usd": 299},
}

STATIC_EXAMPLES = {
    "language-quick": {
        "id": "language-quick",
        "title": "Spanish for Travel",
        "description": "Quick course with focused dialogs for airport, hotel, and restaurant.",
        "details": {
            "level": "beginner",
            "format": "quick",
            "lessons": 8,
        },
    },
    "frontend-deep": {
        "id": "frontend-deep",
        "title": "Frontend System Design",
        "description": "Deep path through architecture, performance, and reliability.",
        "details": {
            "level": "advanced",
            "format": "deep",
            "lessons": 24,
        },
    },
}

rate_limit_state: dict[str, list[float]] = {}


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)


def json_load(value: Any, default: Any) -> Any:
    if value is None:
        return default
    if isinstance(value, (dict, list)):
        return value
    if isinstance(value, str):
        try:
            return json.loads(value)
        except Exception:
            return default
    return default


def bool_env(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.lower() in {"1", "true", "yes", "on"}


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


def db_connect(*, autocommit: bool = True) -> psycopg.Connection:
    return psycopg.connect(postgres_url(), autocommit=autocommit)


def db_fetchone(query: str, params: tuple[Any, ...] = ()) -> dict[str, Any] | None:
    with db_connect() as connection:
        with connection.cursor(row_factory=dict_row) as cursor:
            cursor.execute(query, params)
            return cursor.fetchone()


def db_fetchall(query: str, params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
    with db_connect() as connection:
        with connection.cursor(row_factory=dict_row) as cursor:
            cursor.execute(query, params)
            return list(cursor.fetchall())


def db_execute(query: str, params: tuple[Any, ...] = ()) -> int:
    with db_connect() as connection:
        with connection.cursor() as cursor:
            cursor.execute(query, params)
            return cursor.rowcount


def hash_token(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def create_access_token(user_id: str, email: str, role: str = "user", plan: str = "free") -> str:
    lifetime_minutes = int(os.getenv("JWT_EXPIRE_MINUTES", "60"))
    expires_at = now_utc() + timedelta(minutes=lifetime_minutes)
    payload = {
        "sub": user_id,
        "email": email,
        "role": role,
        "plan": plan,
        "exp": expires_at,
    }
    return jwt.encode(payload, jwt_secret(), algorithm=jwt_algorithm())


def create_refresh_token(user_id: str) -> tuple[str, datetime]:
    token = secrets.token_urlsafe(48)
    expires_at = now_utc() + timedelta(days=int(os.getenv("REFRESH_EXPIRE_DAYS", "30")))
    token_hash = hash_token(token)
    db_execute(
        """
        INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
        VALUES (%s, %s, %s)
        """,
        (user_id, token_hash, expires_at),
    )
    return token, expires_at


def revoke_refresh_token(token: str) -> None:
    db_execute(
        """
        UPDATE refresh_tokens
        SET revoked_at = NOW()
        WHERE token_hash = %s
          AND revoked_at IS NULL
        """,
        (hash_token(token),),
    )


def get_refresh_user(token: str) -> dict[str, Any] | None:
    return db_fetchone(
        """
        SELECT u.id, u.email, u.name, u.role, u.plan, u.status
        FROM refresh_tokens rt
        JOIN users u ON u.id = rt.user_id
        WHERE rt.token_hash = %s
          AND rt.revoked_at IS NULL
          AND rt.expires_at > NOW()
          AND u.deleted_at IS NULL
        """,
        (hash_token(token),),
    )


def set_refresh_cookie(response: Response, token: str, expires_at: datetime) -> None:
    max_age = int((expires_at - now_utc()).total_seconds())
    response.set_cookie(
        key="refresh_token",
        value=token,
        httponly=True,
        secure=bool_env("COOKIE_SECURE", False),
        samesite="lax",
        max_age=max(0, max_age),
        path="/",
    )


def clear_refresh_cookie(response: Response) -> None:
    response.delete_cookie("refresh_token", path="/")


def issue_auth_payload(response: Response, user: dict[str, Any]) -> dict[str, Any]:
    access_token = create_access_token(
        user_id=str(user["id"]),
        email=str(user["email"]),
        role=str(user.get("role") or "user"),
        plan=str(user.get("plan") or "free"),
    )
    refresh_token, refresh_expires_at = create_refresh_token(str(user["id"]))
    set_refresh_cookie(response, refresh_token, refresh_expires_at)
    return {
        "access_token": access_token,
        "token_type": "bearer",
        "expires_at": (now_utc() + timedelta(minutes=int(os.getenv("JWT_EXPIRE_MINUTES", "60")))).isoformat(),
        "user": serialize_user(user),
    }


def enforce_rate_limit(scope: str, key: str, limit: int, window_seconds: int) -> None:
    now_ts = time.time()
    bucket_key = f"{scope}:{key}"
    timestamps = [ts for ts in rate_limit_state.get(bucket_key, []) if ts >= now_ts - window_seconds]
    if len(timestamps) >= limit:
        raise ApiError(
            code="RATE_LIMITED",
            message="Too many requests. Please try again later.",
            status_code=429,
            details={"scope": scope, "retry_in_seconds": window_seconds},
        )
    timestamps.append(now_ts)
    rate_limit_state[bucket_key] = timestamps


def validate_plan(value: str) -> None:
    if value not in PLAN_LIMITS:
        raise ApiError(code="INVALID_PLAN", message="Unsupported plan", status_code=400)


def plan_limits(plan: str) -> dict[str, int]:
    return PLAN_LIMITS.get(plan, PLAN_LIMITS["free"])


def calculate_usage(user_id: str, user_plan: str) -> dict[str, Any]:
    month_start = now_utc().replace(day=1, hour=0, minute=0, second=0, microsecond=0)

    courses_row = db_fetchone(
        """
        SELECT COUNT(*)::int AS total
        FROM courses
        WHERE owner_user_id = %s
          AND deleted_at IS NULL
          AND created_at >= %s
        """,
        (user_id, month_start),
    )

    materials_row = db_fetchone(
        """
        SELECT COALESCE(SUM(size_bytes), 0)::bigint AS total
        FROM materials
        WHERE uploader_user_id = %s
          AND deleted_at IS NULL
        """,
        (user_id,),
    )

    builds_row = db_fetchone(
        """
        SELECT COALESCE(
          SUM(
            EXTRACT(EPOCH FROM (COALESCE(finished_at, NOW()) - COALESCE(started_at, created_at)))
          ),
          0
        ) AS seconds_total
        FROM course_builds cb
        JOIN courses c ON c.id = cb.course_id
        WHERE c.owner_user_id = %s
          AND cb.created_at >= %s
        """,
        (user_id, month_start),
    )

    members_row = db_fetchone(
        """
        SELECT COUNT(DISTINCT wm.user_id)::int AS total
        FROM workspaces w
        JOIN workspace_members wm ON wm.workspace_id = w.id
        WHERE w.owner_user_id = %s
          AND w.type IN ('team', 'business')
        """,
        (user_id,),
    )

    counters = {
        "courses_created_this_month": int((courses_row or {}).get("total") or 0),
        "materials_total_bytes": int((materials_row or {}).get("total") or 0),
        "build_minutes": int(round(float((builds_row or {}).get("seconds_total") or 0) / 60)),
        "team_members": int((members_row or {}).get("total") or 0),
    }
    limits = plan_limits(user_plan)
    return {
        "plan": user_plan,
        "counters": counters,
        "limits": limits,
    }


def enforce_plan_limit(user: dict[str, Any], limit_type: str, incoming_value: int = 0) -> None:
    usage = calculate_usage(str(user["id"]), str(user.get("plan") or "free"))
    used = int(usage["counters"].get(limit_type, 0))
    limit = int(usage["limits"].get(limit_type, 0))
    if limit > 0 and used + incoming_value > limit:
        raise ApiError(
            code="PLAN_LIMIT_REACHED",
            message="Current plan limit reached",
            status_code=402,
            details={"limit_type": limit_type, "used": used, "limit": limit},
        )


def serialize_user(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "email": row["email"],
        "name": row.get("name") or "",
        "role": row.get("role") or "user",
        "plan": row.get("plan") or "free",
        "status": row.get("status") or "active",
        "created_at": row.get("created_at"),
        "last_login_at": row.get("last_login_at"),
    }


def ensure_personal_workspace(user_id: str, user_name: str) -> dict[str, Any]:
    existing = db_fetchone(
        """
        SELECT id, name, owner_user_id, type, created_at
        FROM workspaces
        WHERE owner_user_id = %s
          AND type = 'personal'
        ORDER BY created_at ASC
        LIMIT 1
        """,
        (user_id,),
    )
    if existing:
        member = db_fetchone(
            """
            SELECT id
            FROM workspace_members
            WHERE workspace_id = %s
              AND user_id = %s
            """,
            (existing["id"], user_id),
        )
        if not member:
            db_execute(
                """
                INSERT INTO workspace_members (workspace_id, user_id, role)
                VALUES (%s, %s, 'owner')
                ON CONFLICT (workspace_id, user_id) DO NOTHING
                """,
                (existing["id"], user_id),
            )
        return existing

    workspace_name = f"{user_name} personal"
    row = db_fetchone(
        """
        INSERT INTO workspaces (name, owner_user_id, type)
        VALUES (%s, %s, 'personal')
        RETURNING id, name, owner_user_id, type, created_at
        """,
        (workspace_name, user_id),
    )
    if not row:
        raise ApiError(code="WORKSPACE_CREATE_FAILED", message="Could not create personal workspace", status_code=500)

    db_execute(
        """
        INSERT INTO workspace_members (workspace_id, user_id, role)
        VALUES (%s, %s, 'owner')
        ON CONFLICT (workspace_id, user_id) DO NOTHING
        """,
        (row["id"], user_id),
    )
    return row


def create_user_account(email: str, password: str, name: str) -> dict[str, Any]:
    if len(password) < 8:
        raise ApiError(code="WEAK_PASSWORD", message="Password must contain at least 8 characters", status_code=400)

    password_hash = password_context.hash(password)
    user = db_fetchone(
        """
        INSERT INTO users (email, password_hash, name)
        VALUES (%s, %s, %s)
        ON CONFLICT (email) DO NOTHING
        RETURNING id, email, name, role, plan, status, created_at, last_login_at
        """,
        (email, password_hash, name),
    )

    if not user:
        raise ApiError(code="EMAIL_ALREADY_EXISTS", message="User with this email already exists", status_code=409)

    ensure_personal_workspace(str(user["id"]), str(user.get("name") or "User"))
    return user


def get_workspace_access(workspace_id: str, user: dict[str, Any], allowed_roles: set[str] | None = None) -> dict[str, Any]:
    row = db_fetchone(
        """
        SELECT
          w.id,
          w.name,
          w.owner_user_id,
          w.type,
          w.created_at,
          w.updated_at,
          COALESCE(wm.role, CASE WHEN w.owner_user_id = %s THEN 'owner' END) AS member_role
        FROM workspaces w
        LEFT JOIN workspace_members wm
          ON wm.workspace_id = w.id
         AND wm.user_id = %s
        WHERE w.id = %s
        """,
        (user["id"], user["id"], workspace_id),
    )
    if not row:
        raise ApiError(code="NOT_FOUND", message="Workspace not found", status_code=404)

    if user.get("role") == "admin":
        return row

    if not row.get("member_role"):
        raise ApiError(code="FORBIDDEN", message="No access to workspace", status_code=403)

    if allowed_roles and row["member_role"] not in allowed_roles:
        raise ApiError(code="FORBIDDEN", message="Insufficient workspace role", status_code=403)

    return row


def get_course_access(course_id: str, user: dict[str, Any], write: bool = False) -> dict[str, Any]:
    row = db_fetchone(
        """
        SELECT
          c.id,
          c.workspace_id,
          c.owner_user_id,
          c.user_id,
          c.title,
          c.description,
          c.goal,
          c.level,
          c.format,
          c.pace_minutes_per_day,
          c.status,
          c.visibility,
          c.outline_json,
          c.progress_json,
          c.structure_json,
          c.created_at,
          c.updated_at,
          c.archived_at,
          w.name AS workspace_name,
          COALESCE(wm.role, CASE WHEN w.owner_user_id = %s THEN 'owner' END) AS member_role
        FROM courses c
        LEFT JOIN workspaces w ON w.id = c.workspace_id
        LEFT JOIN workspace_members wm
          ON wm.workspace_id = c.workspace_id
         AND wm.user_id = %s
        WHERE c.id = %s
          AND c.deleted_at IS NULL
        """,
        (user["id"], user["id"], course_id),
    )

    if not row:
        raise ApiError(code="NOT_FOUND", message="Course not found", status_code=404)

    if user.get("role") == "admin":
        return row

    is_owner = str(row.get("owner_user_id") or "") == str(user["id"])

    if row.get("workspace_id"):
        role = row.get("member_role")
        if not role and not is_owner:
            raise ApiError(code="FORBIDDEN", message="No access to course", status_code=403)

        if row.get("visibility") == "private" and not is_owner and role not in {"owner", "admin"}:
            raise ApiError(code="FORBIDDEN", message="Course is private", status_code=403)

        if write and not is_owner and role not in {"owner", "admin", "editor"}:
            raise ApiError(code="FORBIDDEN", message="Insufficient course permissions", status_code=403)
    else:
        if not is_owner:
            raise ApiError(code="FORBIDDEN", message="No access to course", status_code=403)

    return row


def get_material_access(material_id: str, user: dict[str, Any], write: bool = False) -> dict[str, Any]:
    row = db_fetchone(
        """
        SELECT m.*, COALESCE(wm.role, CASE WHEN w.owner_user_id = %s THEN 'owner' END) AS member_role
        FROM materials m
        JOIN workspaces w ON w.id = m.workspace_id
        LEFT JOIN workspace_members wm ON wm.workspace_id = w.id AND wm.user_id = %s
        WHERE m.id = %s
          AND m.deleted_at IS NULL
        """,
        (user["id"], user["id"], material_id),
    )

    if not row:
        raise ApiError(code="NOT_FOUND", message="Material not found", status_code=404)

    if user.get("role") == "admin":
        return row

    role = row.get("member_role")
    if not role:
        raise ApiError(code="FORBIDDEN", message="No access to material", status_code=403)

    if write and role not in {"owner", "admin", "editor"}:
        raise ApiError(code="FORBIDDEN", message="Insufficient material permissions", status_code=403)

    return row


def ensure_materials_belong_to_workspace(material_ids: list[str], workspace_id: str, user: dict[str, Any]) -> list[dict[str, Any]]:
    if not material_ids:
        return []

    rows = db_fetchall(
        """
        SELECT m.id, m.title, m.status, m.workspace_id
        FROM materials m
        JOIN workspaces w ON w.id = m.workspace_id
        LEFT JOIN workspace_members wm ON wm.workspace_id = w.id AND wm.user_id = %s
        WHERE m.id = ANY(%s)
          AND m.deleted_at IS NULL
          AND (wm.user_id IS NOT NULL OR w.owner_user_id = %s OR %s = 'admin')
        """,
        (user["id"], material_ids, user["id"], user.get("role", "user")),
    )

    if len(rows) != len(set(material_ids)):
        raise ApiError(code="NOT_FOUND", message="One or more materials not found", status_code=404)

    for row in rows:
        if str(row["workspace_id"]) != workspace_id:
            raise ApiError(code="CONFLICT", message="Materials belong to another workspace", status_code=409)
    return rows


def parse_lesson_id(payload: ProgressLessonRequest) -> str:
    lesson_id = payload.lesson_id or payload.lessonId
    if not lesson_id:
        raise ApiError(code="VALIDATION_ERROR", message="lessonId is required", status_code=400)
    return lesson_id


def ensure_user_course_state(user_id: str, course_id: str) -> dict[str, Any]:
    existing = db_fetchone(
        """
        SELECT *
        FROM user_course_states
        WHERE user_id = %s
          AND course_id = %s
        """,
        (user_id, course_id),
    )
    if existing:
        return existing

    created = db_fetchone(
        """
        INSERT INTO user_course_states (user_id, course_id)
        VALUES (%s, %s)
        RETURNING *
        """,
        (user_id, course_id),
    )
    if not created:
        raise ApiError(code="STATE_CREATE_FAILED", message="Could not initialize course state", status_code=500)
    return created


def build_upload_url(material_id: str) -> str:
    base = os.getenv("MATERIAL_UPLOAD_BASE_URL", "https://storage.local/upload")
    return f"{base}/{material_id}"


def make_course_progress(course_id: str) -> dict[str, Any]:
    total_row = db_fetchone("SELECT COUNT(*)::int AS total FROM lessons WHERE course_id = %s", (course_id,))
    total_lessons = int((total_row or {}).get("total") or 0)
    return {
        "percent": 0,
        "completed_lessons": 0,
        "total_lessons": total_lessons,
        "streak": 0,
    }


def build_outline_template(
    title: str,
    goal: str,
    level: str,
    format_name: str,
    detail_level: str | None,
    more_practice: bool,
    material_titles: list[str],
) -> dict[str, Any]:
    format_to_modules = {
        "quick": 2,
        "standard": 4,
        "deep": 6,
    }
    modules_count = format_to_modules.get(format_name, 4)

    if detail_level == "high":
        modules_count += 1
    if detail_level == "low":
        modules_count = max(1, modules_count - 1)

    lessons_per_module = 2 + (1 if more_practice else 0)
    source_hint = ", ".join(material_titles[:3]) if material_titles else "user materials"

    modules: list[dict[str, Any]] = []
    lesson_idx = 1
    for module_order in range(1, modules_count + 1):
        lessons = []
        for inner_order in range(1, lessons_per_module + 1):
            lessons.append(
                {
                    "title": f"Lesson {lesson_idx}: {goal[:40]}",
                    "order": inner_order,
                }
            )
            lesson_idx += 1
        modules.append(
            {
                "title": f"Module {module_order} ({level})",
                "order": module_order,
                "lessons": lessons,
            }
        )

    return {
        "title": title,
        "goal": goal,
        "level": level,
        "format": format_name,
        "source_hint": source_hint,
        "modules": modules,
    }


def create_content_blocks(lesson_title: str, goal: str, style: str | None = None, focus: str | None = None) -> list[dict[str, Any]]:
    style_text = style or "balanced"
    focus_text = focus or goal
    return [
        {
            "type": "main",
            "title": "Main idea",
            "text": f"{lesson_title}: key concepts explained in {style_text} style.",
        },
        {
            "type": "details",
            "title": "More details",
            "text": f"Deep dive into {focus_text} with practical reasoning.",
        },
        {
            "type": "example",
            "title": "Example",
            "text": f"Hands-on scenario for {lesson_title}.",
        },
    ]


def create_practice_questions(lesson_title: str, more_practice: bool) -> list[dict[str, Any]]:
    questions = [
        {
            "id": f"q-{uuid.uuid4()}",
            "type": "single",
            "question": f"What is the main objective of '{lesson_title}'?",
            "options": [
                "Memorize terms",
                "Apply the concept in context",
                "Skip to advanced topics",
            ],
            "correct": "Apply the concept in context",
            "explanation": "The lesson is built around practical usage.",
        },
        {
            "id": f"q-{uuid.uuid4()}",
            "type": "single",
            "question": "What is the best next step after understanding the theory?",
            "options": ["Practice", "Restart", "Ignore feedback"],
            "correct": "Practice",
            "explanation": "Practice converts theory into a durable skill.",
        },
    ]

    if more_practice:
        questions.append(
            {
                "id": f"q-{uuid.uuid4()}",
                "type": "single",
                "question": "Why are examples included in the lesson?",
                "options": ["Decoration", "Transfer to real situations", "Randomness"],
                "correct": "Transfer to real situations",
                "explanation": "Examples anchor abstract ideas in real tasks.",
            }
        )
    return questions


def replace_outline(course_id: str, outline: dict[str, Any]) -> dict[str, Any]:
    modules_input = outline.get("modules") if isinstance(outline, dict) else []
    modules = modules_input if isinstance(modules_input, list) else []

    with db_connect(autocommit=False) as connection:
        with connection.cursor(row_factory=dict_row) as cursor:
            cursor.execute("DELETE FROM lessons WHERE course_id = %s", (course_id,))
            cursor.execute("DELETE FROM course_modules WHERE course_id = %s", (course_id,))

            normalized_modules: list[dict[str, Any]] = []
            for module in sorted(modules, key=lambda value: int(value.get("order") or 0)):
                cursor.execute(
                    """
                    INSERT INTO course_modules (course_id, title, sort_order)
                    VALUES (%s, %s, %s)
                    RETURNING id
                    """,
                    (course_id, module.get("title") or "Module", int(module.get("order") or 0)),
                )
                module_row = cursor.fetchone()
                if not module_row:
                    raise ApiError(code="OUTLINE_SAVE_FAILED", message="Could not create module", status_code=500)

                module_id = str(module_row["id"])
                lessons = module.get("lessons") if isinstance(module.get("lessons"), list) else []
                normalized_lessons: list[dict[str, Any]] = []

                for lesson in sorted(lessons, key=lambda value: int(value.get("order") or 0)):
                    cursor.execute(
                        """
                        INSERT INTO lessons (course_id, module_id, title, sort_order, status, estimated_minutes, content_blocks)
                        VALUES (%s, %s, %s, %s, 'draft', 10, '[]'::jsonb)
                        RETURNING id
                        """,
                        (course_id, module_id, lesson.get("title") or "Lesson", int(lesson.get("order") or 0)),
                    )
                    lesson_row = cursor.fetchone()
                    if not lesson_row:
                        raise ApiError(code="OUTLINE_SAVE_FAILED", message="Could not create lesson", status_code=500)
                    normalized_lessons.append(
                        {
                            "id": str(lesson_row["id"]),
                            "title": lesson.get("title") or "Lesson",
                            "order": int(lesson.get("order") or 0),
                        }
                    )

                normalized_modules.append(
                    {
                        "id": module_id,
                        "title": module.get("title") or "Module",
                        "order": int(module.get("order") or 0),
                        "lessons": normalized_lessons,
                    }
                )

            cursor.execute(
                """
                UPDATE courses
                SET outline_json = %s::jsonb,
                    updated_at = NOW()
                WHERE id = %s
                """,
                (json_dumps({"modules": normalized_modules}), course_id),
            )
        connection.commit()

    return {"modules": normalized_modules}


def finalize_course_content(course_id: str, more_practice: bool = False) -> dict[str, Any]:
    lessons = db_fetchall(
        """
        SELECT id, title
        FROM lessons
        WHERE course_id = %s
        ORDER BY sort_order ASC
        """,
        (course_id,),
    )

    if not lessons:
        course_row = db_fetchone("SELECT title, goal, level, format, outline_json FROM courses WHERE id = %s", (course_id,))
        if not course_row:
            raise ApiError(code="NOT_FOUND", message="Course not found", status_code=404)

        outline = json_load(course_row.get("outline_json"), {"modules": []})
        if not outline.get("modules"):
            generated = build_outline_template(
                title=str(course_row.get("title") or "Course"),
                goal=str(course_row.get("goal") or "Learn"),
                level=str(course_row.get("level") or "beginner"),
                format_name=str(course_row.get("format") or "standard"),
                detail_level=None,
                more_practice=more_practice,
                material_titles=[],
            )
            replace_outline(course_id, generated)
        lessons = db_fetchall(
            """
            SELECT id, title
            FROM lessons
            WHERE course_id = %s
            ORDER BY sort_order ASC
            """,
            (course_id,),
        )

    goal_row = db_fetchone("SELECT goal, title FROM courses WHERE id = %s", (course_id,))
    goal = str((goal_row or {}).get("goal") or "Learn")

    lesson_count = 0
    practice_count = 0
    for lesson in lessons:
        lesson_id = str(lesson["id"])
        blocks = create_content_blocks(str(lesson["title"]), goal)
        db_execute(
            """
            UPDATE lessons
            SET content_blocks = %s::jsonb,
                status = 'ready',
                estimated_minutes = 12,
                updated_at = NOW()
            WHERE id = %s
            """,
            (json_dumps(blocks), lesson_id),
        )
        lesson_count += 1

        questions = create_practice_questions(str(lesson["title"]), more_practice)
        exists = db_fetchone("SELECT id FROM practice_blocks WHERE lesson_id = %s", (lesson_id,))
        if exists:
            db_execute(
                """
                UPDATE practice_blocks
                SET questions = %s::jsonb,
                    updated_at = NOW()
                WHERE id = %s
                """,
                (json_dumps(questions), exists["id"]),
            )
        else:
            db_execute(
                """
                INSERT INTO practice_blocks (course_id, lesson_id, questions)
                VALUES (%s, %s, %s::jsonb)
                """,
                (course_id, lesson_id, json_dumps(questions)),
            )
        practice_count += 1

    progress = make_course_progress(course_id)
    structure = {
        "title": (goal_row or {}).get("title") or "Course",
        "modules": json_load((db_fetchone("SELECT outline_json FROM courses WHERE id = %s", (course_id,)) or {}).get("outline_json"), {}).get("modules", []),
    }
    db_execute(
        """
        UPDATE courses
        SET status = 'ready',
            structure_json = %s::jsonb,
            progress_json = %s::jsonb,
            updated_at = NOW()
        WHERE id = %s
        """,
        (json_dumps(structure), json_dumps(progress), course_id),
    )

    return {
        "lessons_ready": lesson_count,
        "practice_blocks": practice_count,
    }


def process_build_job(build_id: str) -> None:
    try:
        build = db_fetchone("SELECT * FROM course_builds WHERE id = %s", (build_id,))
        if not build:
            return

        if build.get("status") == "canceled":
            return

        course_id = str(build["course_id"])
        input_payload = json_load(build.get("input_json"), {})

        db_execute(
            """
            UPDATE course_builds
            SET status = 'running',
                progress_pct = 10,
                started_at = NOW(),
                user_message = 'Build started',
                updated_at = NOW()
            WHERE id = %s
            """,
            (build_id,),
        )

        if build.get("step") == "plan":
            db_execute("UPDATE course_builds SET progress_pct = 35 WHERE id = %s", (build_id,))

            material_rows = []
            material_ids = input_payload.get("material_ids")
            if isinstance(material_ids, list) and material_ids:
                material_rows = db_fetchall(
                    "SELECT id, title FROM materials WHERE id = ANY(%s)",
                    (material_ids,),
                )

            course = db_fetchone("SELECT title, goal, level, format FROM courses WHERE id = %s", (course_id,))
            if not course:
                raise ApiError(code="NOT_FOUND", message="Course not found", status_code=404)

            outline = build_outline_template(
                title=str(input_payload.get("title") or course.get("title") or "Course"),
                goal=str(input_payload.get("goal") or course.get("goal") or "Learn"),
                level=str(input_payload.get("level") or course.get("level") or "beginner"),
                format_name=str(input_payload.get("format") or course.get("format") or "standard"),
                detail_level=(input_payload.get("options") or {}).get("detail_level") if isinstance(input_payload.get("options"), dict) else None,
                more_practice=bool((input_payload.get("options") or {}).get("more_practice")) if isinstance(input_payload.get("options"), dict) else False,
                material_titles=[str(row.get("title") or "") for row in material_rows],
            )

            db_execute(
                """
                UPDATE courses
                SET goal = %s,
                    level = %s,
                    format = %s,
                    pace_minutes_per_day = %s,
                    title = %s,
                    status = 'draft',
                    updated_at = NOW()
                WHERE id = %s
                """,
                (
                    str(outline.get("goal") or "Learn"),
                    str(outline.get("level") or "beginner"),
                    str(outline.get("format") or "standard"),
                    input_payload.get("pace_minutes_per_day"),
                    str(outline.get("title") or "Course"),
                    course_id,
                ),
            )

            normalized_outline = replace_outline(course_id, outline)
            db_execute("UPDATE course_builds SET progress_pct = 80 WHERE id = %s", (build_id,))

            db_execute(
                """
                UPDATE course_builds
                SET status = 'done',
                    progress_pct = 100,
                    result_json = %s::jsonb,
                    user_message = 'Plan is ready',
                    finished_at = NOW(),
                    updated_at = NOW()
                WHERE id = %s
                """,
                (json_dumps({"outline": normalized_outline}), build_id),
            )
            return

        db_execute("UPDATE course_builds SET progress_pct = 45 WHERE id = %s", (build_id,))
        result = finalize_course_content(
            course_id,
            more_practice=bool((input_payload.get("options") or {}).get("more_practice")) if isinstance(input_payload.get("options"), dict) else False,
        )
        db_execute("UPDATE course_builds SET progress_pct = 85 WHERE id = %s", (build_id,))
        db_execute(
            """
            UPDATE course_builds
            SET status = 'done',
                progress_pct = 100,
                result_json = %s::jsonb,
                user_message = 'Course is ready',
                finished_at = NOW(),
                updated_at = NOW()
            WHERE id = %s
            """,
            (json_dumps(result), build_id),
        )
    except Exception as exc:
        build = db_fetchone("SELECT course_id FROM course_builds WHERE id = %s", (build_id,))
        db_execute(
            """
            UPDATE course_builds
            SET status = 'failed',
                error_code = 'BUILD_FAILED',
                error_message = %s,
                user_message = 'Build failed',
                debug_message = %s,
                finished_at = NOW(),
                updated_at = NOW()
            WHERE id = %s
            """,
            (str(exc)[:300], repr(exc)[:500], build_id),
        )
        if build:
            db_execute("UPDATE courses SET status = 'failed', updated_at = NOW() WHERE id = %s", (build["course_id"],))


def create_build(
    background_tasks: BackgroundTasks,
    course_id: str,
    step: str,
    payload: dict[str, Any],
    user: dict[str, Any],
    idempotency_key: str | None,
) -> dict[str, Any]:
    if user.get("role") != "admin":
        running = db_fetchone(
            """
            SELECT id
            FROM course_builds
            WHERE course_id = %s
              AND status IN ('queued', 'running')
            LIMIT 1
            """,
            (course_id,),
        )
        if running:
            raise ApiError(code="CONFLICT", message="Build is already running", status_code=409)

    if idempotency_key:
        existing = db_fetchone(
            """
            SELECT id, status, step, progress_pct
            FROM course_builds
            WHERE course_id = %s
              AND idempotency_key = %s
            ORDER BY created_at DESC
            LIMIT 1
            """,
            (course_id, idempotency_key),
        )
        if existing:
            return {
                "build_id": str(existing["id"]),
                "status": existing["status"],
                "step": existing["step"],
                "progress_pct": existing["progress_pct"],
                "idempotent": True,
            }

    enforce_plan_limit(user, "build_minutes", incoming_value=1)

    row = db_fetchone(
        """
        INSERT INTO course_builds (course_id, step, status, progress_pct, input_json, idempotency_key)
        VALUES (%s, %s, 'queued', 0, %s::jsonb, %s)
        RETURNING id, status, step, progress_pct
        """,
        (course_id, step, json_dumps(payload), idempotency_key),
    )
    if not row:
        raise ApiError(code="BUILD_CREATE_FAILED", message="Could not create build", status_code=500)

    db_execute("UPDATE courses SET status = 'building', updated_at = NOW() WHERE id = %s", (course_id,))
    background_tasks.add_task(process_build_job, str(row["id"]))

    return {
        "build_id": str(row["id"]),
        "status": row["status"],
        "step": row["step"],
        "progress_pct": row["progress_pct"],
        "idempotent": False,
    }


def serialize_workspace(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "name": row["name"],
        "owner_user_id": str(row["owner_user_id"]),
        "type": row.get("type") or "personal",
        "role": row.get("member_role") or "owner",
        "created_at": row.get("created_at"),
        "updated_at": row.get("updated_at"),
    }


def serialize_material(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "workspace_id": str(row["workspace_id"]),
        "uploader_user_id": str(row["uploader_user_id"]) if row.get("uploader_user_id") else None,
        "type": row["type"],
        "title": row.get("title") or "",
        "source_url": row.get("source_url"),
        "text": row.get("text_content"),
        "file_key": row.get("file_key"),
        "mime": row.get("mime"),
        "size_bytes": row.get("size_bytes"),
        "status": row.get("status"),
        "error_code": row.get("error_code"),
        "error_message": row.get("error_message"),
        "created_at": row.get("created_at"),
        "updated_at": row.get("updated_at"),
    }


def serialize_course(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "workspace_id": str(row["workspace_id"]) if row.get("workspace_id") else None,
        "owner_user_id": str(row["owner_user_id"]) if row.get("owner_user_id") else None,
        "title": row.get("title") or "",
        "description": row.get("description") or "",
        "goal": row.get("goal") or "",
        "level": row.get("level") or "beginner",
        "format": row.get("format") or "standard",
        "pace_minutes_per_day": row.get("pace_minutes_per_day"),
        "status": row.get("status") or "draft",
        "visibility": row.get("visibility") or "private",
        "progress": json_load(row.get("progress_json"), {}),
        "created_at": row.get("created_at"),
        "updated_at": row.get("updated_at"),
    }


def serialize_build(row: dict[str, Any], include_debug: bool = False) -> dict[str, Any]:
    payload = {
        "id": str(row["id"]),
        "course_id": str(row["course_id"]),
        "status": row.get("status"),
        "step": row.get("step"),
        "progress_pct": row.get("progress_pct"),
        "error_code": row.get("error_code"),
        "error_message": row.get("error_message"),
        "user_message": row.get("user_message"),
        "result": json_load(row.get("result_json"), {}),
        "created_at": row.get("created_at"),
        "updated_at": row.get("updated_at"),
    }
    if include_debug:
        payload["debug_message"] = row.get("debug_message")
    return payload


async def current_user(credentials: HTTPAuthorizationCredentials = Depends(bearer_security)) -> dict[str, Any]:
    if credentials is None:
        raise ApiError(code="UNAUTHORIZED", message="Authorization token is required", status_code=401)

    try:
        payload = jwt.decode(credentials.credentials, jwt_secret(), algorithms=[jwt_algorithm()])
        user_id = payload.get("sub")
        if not user_id:
            raise ApiError(code="UNAUTHORIZED", message="Token payload is invalid", status_code=401)
    except JWTError as error:
        raise ApiError(code="UNAUTHORIZED", message="Token is invalid or expired", status_code=401) from error

    user = db_fetchone(
        """
        SELECT id, email, name, role, plan, status, created_at, last_login_at, deleted_at
        FROM users
        WHERE id = %s
        """,
        (user_id,),
    )

    if not user or user.get("deleted_at") is not None:
        raise ApiError(code="UNAUTHORIZED", message="User does not exist", status_code=401)

    if user.get("status") == "blocked":
        raise ApiError(code="FORBIDDEN", message="User is blocked", status_code=403)

    return user


async def admin_user(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    if user.get("role") != "admin":
        raise ApiError(code="FORBIDDEN", message="Admin role required", status_code=403)
    return user


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
                "details": {
                    "request_id": getattr(request.state, "request_id", None),
                },
            }
        },
    )


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/public/pricing")
def public_pricing() -> dict[str, Any]:
    return {
        "plans": [
            {
                "plan": plan,
                "price": PLAN_PRICING[plan],
                "limits": PLAN_LIMITS[plan],
            }
            for plan in ["free", "pro", "team", "business"]
        ]
    }


@app.get("/api/public/examples")
def public_examples() -> dict[str, Any]:
    rows = db_fetchall(
        """
        SELECT id, title, description, details
        FROM public_examples
        WHERE is_active = TRUE
        ORDER BY created_at DESC
        """
    )
    if rows:
        return {
            "items": [
                {
                    "id": str(row["id"]),
                    "title": row["title"],
                    "description": row["description"],
                }
                for row in rows
            ]
        }

    return {"items": list(STATIC_EXAMPLES.values())}


@app.get("/api/public/examples/{example_id}")
def public_example_details(example_id: str) -> dict[str, Any]:
    row = db_fetchone(
        """
        SELECT id, title, description, details
        FROM public_examples
        WHERE id::text = %s
          AND is_active = TRUE
        """,
        (example_id,),
    )

    if row:
        return {
            "id": str(row["id"]),
            "title": row["title"],
            "description": row["description"],
            "details": json_load(row.get("details"), {}),
        }

    static = STATIC_EXAMPLES.get(example_id)
    if static:
        return static

    raise ApiError(code="NOT_FOUND", message="Example not found", status_code=404)


@app.post("/api/auth/signup", status_code=201)
def auth_signup(payload: SignupRequest, request: Request, response: Response) -> dict[str, Any]:
    rate_key = request.client.host if request.client else payload.email
    enforce_rate_limit("auth.signup", str(rate_key), limit=20, window_seconds=60)
    user = create_user_account(payload.email, payload.password, payload.name)
    return issue_auth_payload(response, user)


@app.post("/api/auth/login")
def auth_login(payload: LoginRequest, request: Request, response: Response) -> dict[str, Any]:
    rate_key = request.client.host if request.client else payload.email
    enforce_rate_limit("auth.login", str(rate_key), limit=30, window_seconds=60)

    user = db_fetchone(
        """
        SELECT id, email, name, role, plan, status, password_hash, deleted_at
        FROM users
        WHERE email = %s
        """,
        (payload.email,),
    )

    if not user or user.get("deleted_at") is not None or not password_context.verify(payload.password, user.get("password_hash") or ""):
        raise ApiError(code="INVALID_CREDENTIALS", message="Email or password is incorrect", status_code=401)

    if user.get("status") == "blocked":
        raise ApiError(code="FORBIDDEN", message="User is blocked", status_code=403)

    db_execute("UPDATE users SET last_login_at = NOW() WHERE id = %s", (user["id"],))
    ensure_personal_workspace(str(user["id"]), str(user.get("name") or "User"))
    return issue_auth_payload(response, user)


@app.post("/api/auth/logout")
def auth_logout(response: Response, refresh_token: str | None = Cookie(default=None)) -> dict[str, Any]:
    if refresh_token:
        revoke_refresh_token(refresh_token)
    clear_refresh_cookie(response)
    return {"status": "ok"}


@app.post("/api/auth/refresh")
def auth_refresh(
    response: Response,
    payload: RefreshRequest | None = None,
    refresh_token_cookie: str | None = Cookie(default=None, alias="refresh_token"),
) -> dict[str, Any]:
    token = (payload.refresh_token if payload else None) or refresh_token_cookie
    if not token:
        raise ApiError(code="UNAUTHORIZED", message="Refresh token is required", status_code=401)

    user = get_refresh_user(token)
    if not user:
        raise ApiError(code="UNAUTHORIZED", message="Refresh token is invalid or expired", status_code=401)

    revoke_refresh_token(token)
    return issue_auth_payload(response, user)


@app.post("/api/auth/password/forgot")
def auth_password_forgot(payload: PasswordForgotRequest) -> dict[str, Any]:
    user = db_fetchone("SELECT id FROM users WHERE email = %s AND deleted_at IS NULL", (payload.email,))
    issued_token: str | None = None

    if user:
        issued_token = secrets.token_urlsafe(32)
        token_hash = hash_token(issued_token)
        expires_at = now_utc() + timedelta(minutes=30)
        db_execute(
            """
            INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
            VALUES (%s, %s, %s)
            """,
            (user["id"], token_hash, expires_at),
        )

    response = {
        "status": "ok",
        "message": "If the account exists, reset instructions were generated.",
    }
    if bool_env("DEBUG_RETURN_RESET_TOKEN", False) and issued_token:
        response["reset_token"] = issued_token
    return response


@app.post("/api/auth/password/reset")
def auth_password_reset(payload: PasswordResetRequest) -> dict[str, Any]:
    if len(payload.password) < 8:
        raise ApiError(code="WEAK_PASSWORD", message="Password must contain at least 8 characters", status_code=400)

    token_row = db_fetchone(
        """
        SELECT id, user_id
        FROM password_reset_tokens
        WHERE token_hash = %s
          AND used_at IS NULL
          AND expires_at > NOW()
        """,
        (hash_token(payload.token),),
    )
    if not token_row:
        raise ApiError(code="INVALID_TOKEN", message="Reset token is invalid or expired", status_code=400)

    db_execute(
        """
        UPDATE users
        SET password_hash = %s,
            updated_at = NOW()
        WHERE id = %s
        """,
        (password_context.hash(payload.password), token_row["user_id"]),
    )
    db_execute("UPDATE password_reset_tokens SET used_at = NOW() WHERE id = %s", (token_row["id"],))

    return {"status": "ok"}


@app.get("/api/me")
def get_me(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    workspace = ensure_personal_workspace(str(user["id"]), str(user.get("name") or "User"))
    return {
        **serialize_user(user),
        "personal_workspace_id": str(workspace["id"]),
    }


@app.patch("/api/me")
def patch_me(payload: MePatchRequest, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    row = db_fetchone(
        """
        UPDATE users
        SET name = %s,
            updated_at = NOW()
        WHERE id = %s
        RETURNING id, email, name, role, plan, status, created_at, last_login_at
        """,
        (payload.name, user["id"]),
    )
    if not row:
        raise ApiError(code="NOT_FOUND", message="User not found", status_code=404)
    return serialize_user(row)


@app.get("/api/me/usage")
def me_usage(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return calculate_usage(str(user["id"]), str(user.get("plan") or "free"))


@app.delete("/api/me")
def me_delete(response: Response, user: dict[str, Any] = Depends(current_user), refresh_token: str | None = Cookie(default=None)) -> dict[str, Any]:
    db_execute(
        """
        UPDATE users
        SET status = 'deleted',
            deleted_at = NOW(),
            updated_at = NOW()
        WHERE id = %s
        """,
        (user["id"],),
    )
    db_execute("UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = %s AND revoked_at IS NULL", (user["id"],))
    if refresh_token:
        revoke_refresh_token(refresh_token)
    clear_refresh_cookie(response)
    return {"status": "deletion_requested"}


@app.get("/api/workspaces")
def list_workspaces(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    rows = db_fetchall(
        """
        SELECT DISTINCT
          w.id,
          w.name,
          w.owner_user_id,
          w.type,
          w.created_at,
          w.updated_at,
          COALESCE(wm.role, CASE WHEN w.owner_user_id = %s THEN 'owner' END) AS member_role
        FROM workspaces w
        LEFT JOIN workspace_members wm ON wm.workspace_id = w.id AND wm.user_id = %s
        WHERE w.owner_user_id = %s OR wm.user_id = %s OR %s = 'admin'
        ORDER BY w.created_at DESC
        """,
        (user["id"], user["id"], user["id"], user["id"], user.get("role", "user")),
    )
    return {"items": [serialize_workspace(row) for row in rows]}


@app.post("/api/workspaces", status_code=201)
def create_workspace(payload: WorkspaceCreateRequest, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    desired_type = payload.type or ("team" if user.get("plan") in {"team", "business"} else "personal")
    if desired_type in {"team", "business"} and user.get("plan") not in {"team", "business"}:
        raise ApiError(
            code="PLAN_LIMIT_REACHED",
            message="Upgrade plan to create team workspaces",
            status_code=402,
            details={"limit_type": "team_members"},
        )

    row = db_fetchone(
        """
        INSERT INTO workspaces (name, owner_user_id, type)
        VALUES (%s, %s, %s)
        RETURNING id, name, owner_user_id, type, created_at, updated_at
        """,
        (payload.name, user["id"], desired_type),
    )
    if not row:
        raise ApiError(code="WORKSPACE_CREATE_FAILED", message="Could not create workspace", status_code=500)

    db_execute(
        """
        INSERT INTO workspace_members (workspace_id, user_id, role)
        VALUES (%s, %s, 'owner')
        ON CONFLICT (workspace_id, user_id) DO NOTHING
        """,
        (row["id"], user["id"]),
    )

    row["member_role"] = "owner"
    return serialize_workspace(row)


@app.get("/api/workspaces/{ws_id}")
def get_workspace(ws_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return serialize_workspace(get_workspace_access(ws_id, user))


@app.patch("/api/workspaces/{ws_id}")
def patch_workspace(ws_id: str, payload: WorkspacePatchRequest, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    workspace = get_workspace_access(ws_id, user, allowed_roles={"owner", "admin"})
    row = db_fetchone(
        """
        UPDATE workspaces
        SET name = %s,
            updated_at = NOW()
        WHERE id = %s
        RETURNING id, name, owner_user_id, type, created_at, updated_at
        """,
        (payload.name, workspace["id"]),
    )
    if not row:
        raise ApiError(code="NOT_FOUND", message="Workspace not found", status_code=404)

    row["member_role"] = workspace["member_role"]
    return serialize_workspace(row)


@app.get("/api/workspaces/{ws_id}/members")
def workspace_members(ws_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    get_workspace_access(ws_id, user)
    rows = db_fetchall(
        """
        SELECT wm.id, wm.user_id, wm.role, wm.created_at, u.email, u.name
        FROM workspace_members wm
        JOIN users u ON u.id = wm.user_id
        WHERE wm.workspace_id = %s
        ORDER BY wm.created_at ASC
        """,
        (ws_id,),
    )
    return {
        "items": [
            {
                "id": str(row["id"]),
                "user_id": str(row["user_id"]),
                "email": row["email"],
                "name": row.get("name") or "",
                "role": row["role"],
                "created_at": row["created_at"],
            }
            for row in rows
        ]
    }


@app.post("/api/workspaces/{ws_id}/members", status_code=201)
def add_workspace_member(ws_id: str, payload: WorkspaceMemberCreateRequest, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    workspace = get_workspace_access(ws_id, user, allowed_roles={"owner", "admin"})

    if workspace.get("type") in {"team", "business"}:
        enforce_plan_limit(user, "team_members", incoming_value=1)

    member_user = db_fetchone(
        """
        SELECT id, email, name
        FROM users
        WHERE email = %s
          AND deleted_at IS NULL
        """,
        (payload.email,),
    )
    if not member_user:
        raise ApiError(code="NOT_FOUND", message="User not found", status_code=404)

    if payload.role == "owner" and str(member_user["id"]) != str(workspace["owner_user_id"]):
        raise ApiError(code="FORBIDDEN", message="Only workspace owner can have owner role", status_code=403)

    row = db_fetchone(
        """
        INSERT INTO workspace_members (workspace_id, user_id, role)
        VALUES (%s, %s, %s)
        ON CONFLICT (workspace_id, user_id)
        DO UPDATE SET role = EXCLUDED.role, updated_at = NOW()
        RETURNING id, workspace_id, user_id, role, created_at
        """,
        (ws_id, member_user["id"], payload.role),
    )
    if not row:
        raise ApiError(code="WORKSPACE_MEMBER_FAILED", message="Could not add workspace member", status_code=500)

    return {
        "id": str(row["id"]),
        "workspace_id": str(row["workspace_id"]),
        "user_id": str(row["user_id"]),
        "email": member_user["email"],
        "name": member_user.get("name") or "",
        "role": row["role"],
        "created_at": row["created_at"],
    }


@app.patch("/api/workspaces/{ws_id}/members/{member_id}")
def patch_workspace_member(
    ws_id: str,
    member_id: str,
    payload: WorkspaceMemberPatchRequest,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    workspace = get_workspace_access(ws_id, user, allowed_roles={"owner", "admin"})
    member = db_fetchone(
        """
        SELECT id, user_id, role
        FROM workspace_members
        WHERE id = %s
          AND workspace_id = %s
        """,
        (member_id, ws_id),
    )
    if not member:
        raise ApiError(code="NOT_FOUND", message="Workspace member not found", status_code=404)

    if str(member["user_id"]) == str(workspace["owner_user_id"]) and payload.role != "owner":
        raise ApiError(code="FORBIDDEN", message="Cannot downgrade workspace owner", status_code=403)

    row = db_fetchone(
        """
        UPDATE workspace_members
        SET role = %s,
            updated_at = NOW()
        WHERE id = %s
        RETURNING id, workspace_id, user_id, role, created_at, updated_at
        """,
        (payload.role, member_id),
    )
    if not row:
        raise ApiError(code="NOT_FOUND", message="Workspace member not found", status_code=404)

    return {
        "id": str(row["id"]),
        "workspace_id": str(row["workspace_id"]),
        "user_id": str(row["user_id"]),
        "role": row["role"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


@app.delete("/api/workspaces/{ws_id}/members/{member_id}")
def delete_workspace_member(ws_id: str, member_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    workspace = get_workspace_access(ws_id, user, allowed_roles={"owner", "admin"})
    member = db_fetchone(
        """
        SELECT id, user_id
        FROM workspace_members
        WHERE id = %s
          AND workspace_id = %s
        """,
        (member_id, ws_id),
    )
    if not member:
        raise ApiError(code="NOT_FOUND", message="Workspace member not found", status_code=404)

    if str(member["user_id"]) == str(workspace["owner_user_id"]):
        raise ApiError(code="FORBIDDEN", message="Cannot remove workspace owner", status_code=403)

    db_execute("DELETE FROM workspace_members WHERE id = %s", (member_id,))
    return {"status": "deleted"}


@app.post("/api/materials")
def create_material(payload: MaterialCreateRequest, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    workspace = get_workspace_access(payload.workspace_id, user, allowed_roles={"owner", "admin", "editor"})

    inferred_size = payload.size_bytes or 0
    if payload.type == "text" and payload.text:
        inferred_size = len(payload.text.encode("utf-8"))

    if inferred_size > 0:
        enforce_plan_limit(user, "materials_total_bytes", incoming_value=inferred_size)

    material_status = "uploaded" if payload.type == "file" else "ready"
    file_key = f"materials/{payload.workspace_id}/{uuid.uuid4()}" if payload.type == "file" else None

    row = db_fetchone(
        """
        INSERT INTO materials (
          workspace_id,
          uploader_user_id,
          type,
          title,
          source_url,
          text_content,
          file_key,
          mime,
          size_bytes,
          status
        )
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        RETURNING *
        """,
        (
            workspace["id"],
            user["id"],
            payload.type,
            payload.title or "",
            payload.source_url,
            payload.text,
            file_key,
            payload.mime,
            inferred_size if inferred_size > 0 else None,
            material_status,
        ),
    )
    if not row:
        raise ApiError(code="MATERIAL_CREATE_FAILED", message="Could not create material", status_code=500)

    response = serialize_material(row)
    if payload.type == "file":
        response["upload_url"] = build_upload_url(str(row["id"]))
        response["material_id"] = str(row["id"])
    return response


@app.post("/api/materials/file/init")
def init_file_material(payload: MaterialFileInitRequest, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    workspace = get_workspace_access(payload.workspace_id, user, allowed_roles={"owner", "admin", "editor"})

    if payload.size_bytes and payload.size_bytes > 0:
        enforce_plan_limit(user, "materials_total_bytes", incoming_value=payload.size_bytes)

    file_key = f"materials/{payload.workspace_id}/{uuid.uuid4()}"
    row = db_fetchone(
        """
        INSERT INTO materials (
          workspace_id,
          uploader_user_id,
          type,
          title,
          file_key,
          mime,
          size_bytes,
          status
        )
        VALUES (%s, %s, 'file', %s, %s, %s, %s, 'uploaded')
        RETURNING id, file_key, status
        """,
        (workspace["id"], user["id"], payload.title or "", file_key, payload.mime, payload.size_bytes),
    )
    if not row:
        raise ApiError(code="MATERIAL_CREATE_FAILED", message="Could not initialize file upload", status_code=500)

    return {
        "upload_url": build_upload_url(str(row["id"])),
        "file_key": row["file_key"],
        "material_id": str(row["id"]),
        "status": row["status"],
    }


@app.post("/api/materials/file/complete")
def complete_file_material(payload: MaterialFileCompleteRequest, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    material = get_material_access(payload.material_id, user, write=True)
    if material["type"] != "file":
        raise ApiError(code="CONFLICT", message="Material is not file-based", status_code=409)

    db_execute(
        """
        UPDATE materials
        SET status = 'processing',
            updated_at = NOW()
        WHERE id = %s
        """,
        (material["id"],),
    )

    db_execute(
        """
        UPDATE materials
        SET status = 'ready',
            error_code = NULL,
            error_message = NULL,
            updated_at = NOW()
        WHERE id = %s
        """,
        (material["id"],),
    )

    row = db_fetchone("SELECT * FROM materials WHERE id = %s", (material["id"],))
    if not row:
        raise ApiError(code="NOT_FOUND", message="Material not found", status_code=404)
    return serialize_material(row)


@app.get("/api/materials")
def list_materials(workspace_id: str = Query(...), user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    get_workspace_access(workspace_id, user)
    rows = db_fetchall(
        """
        SELECT *
        FROM materials
        WHERE workspace_id = %s
          AND deleted_at IS NULL
        ORDER BY created_at DESC
        """,
        (workspace_id,),
    )
    return {"items": [serialize_material(row) for row in rows]}


@app.get("/api/materials/{material_id}")
def get_material(material_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    row = get_material_access(material_id, user)
    return serialize_material(row)


@app.delete("/api/materials/{material_id}")
def delete_material(material_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    row = get_material_access(material_id, user, write=True)
    db_execute(
        """
        UPDATE materials
        SET deleted_at = NOW(),
            updated_at = NOW()
        WHERE id = %s
        """,
        (row["id"],),
    )
    return {"status": "deleted"}


@app.post("/api/materials/{material_id}/retry")
def retry_material(material_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    row = get_material_access(material_id, user, write=True)
    if row.get("status") != "failed":
        raise ApiError(code="CONFLICT", message="Material is not in failed state", status_code=409)

    db_execute(
        """
        UPDATE materials
        SET status = 'processing',
            error_code = NULL,
            error_message = NULL,
            updated_at = NOW()
        WHERE id = %s
        """,
        (row["id"],),
    )
    db_execute("UPDATE materials SET status = 'ready', updated_at = NOW() WHERE id = %s", (row["id"],))

    refreshed = db_fetchone("SELECT * FROM materials WHERE id = %s", (row["id"],))
    if not refreshed:
        raise ApiError(code="NOT_FOUND", message="Material not found", status_code=404)
    return serialize_material(refreshed)


@app.get("/api/courses")
def list_courses(
    workspace_id: str | None = Query(default=None),
    status: str | None = Query(default=None),
    q: str | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    offset = (page - 1) * page_size

    conditions = ["c.deleted_at IS NULL"]
    params: list[Any] = [user["id"], user["id"], user["id"], user.get("role", "user")]

    if workspace_id:
        conditions.append("c.workspace_id = %s")
        params.append(workspace_id)

    if status:
        conditions.append("c.status = %s")
        params.append(status)

    if q:
        conditions.append("(c.title ILIKE %s OR c.goal ILIKE %s)")
        params.extend([f"%{q}%", f"%{q}%"])

    query = f"""
        SELECT
          c.id,
          c.workspace_id,
          c.owner_user_id,
          c.title,
          c.description,
          c.goal,
          c.level,
          c.format,
          c.pace_minutes_per_day,
          c.status,
          c.visibility,
          c.progress_json,
          c.created_at,
          c.updated_at,
          COALESCE(wm.role, CASE WHEN w.owner_user_id = %s THEN 'owner' END) AS member_role
        FROM courses c
        LEFT JOIN workspaces w ON w.id = c.workspace_id
        LEFT JOIN workspace_members wm ON wm.workspace_id = c.workspace_id AND wm.user_id = %s
        WHERE (c.owner_user_id = %s OR wm.user_id IS NOT NULL OR %s = 'admin')
          AND {' AND '.join(conditions)}
        ORDER BY c.updated_at DESC
        LIMIT %s OFFSET %s
    """
    params.extend([page_size, offset])

    rows = db_fetchall(query, tuple(params))
    return {
        "items": [serialize_course(row) for row in rows],
        "page": page,
        "page_size": page_size,
    }


@app.post("/api/courses", status_code=201)
def create_course(payload: CourseCreateApiRequest, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    get_workspace_access(payload.workspace_id, user, allowed_roles={"owner", "admin", "editor"})
    enforce_plan_limit(user, "courses_created_this_month", incoming_value=1)

    row = db_fetchone(
        """
        INSERT INTO courses (
          workspace_id,
          owner_user_id,
          user_id,
          title,
          description,
          goal,
          level,
          format,
          pace_minutes_per_day,
          status,
          visibility,
          structure_json,
          outline_json,
          progress_json
        )
        VALUES (%s, %s, %s, %s, '', %s, %s, %s, %s, 'draft', 'private', '{}'::jsonb, '{"modules":[]}'::jsonb, '{"percent":0,"completed_lessons":0,"total_lessons":0,"streak":0}'::jsonb)
        RETURNING *
        """,
        (
            payload.workspace_id,
            user["id"],
            user["id"],
            payload.title or "Untitled course",
            payload.goal or "",
            payload.level or "beginner",
            payload.format or "standard",
            payload.pace_minutes_per_day,
        ),
    )
    if not row:
        raise ApiError(code="COURSE_CREATE_FAILED", message="Could not create course", status_code=500)
    return serialize_course(row)


@app.get("/api/courses/{course_id}")
def get_course(course_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    row = get_course_access(course_id, user)
    return serialize_course(row)


@app.patch("/api/courses/{course_id}")
def patch_course(course_id: str, payload: CoursePatchRequest, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    course = get_course_access(course_id, user, write=True)

    fields: list[str] = []
    params: list[Any] = []

    if payload.title is not None:
        fields.append("title = %s")
        params.append(payload.title)
    if payload.description is not None:
        fields.append("description = %s")
        params.append(payload.description)
    if payload.goal is not None:
        fields.append("goal = %s")
        params.append(payload.goal)
    if payload.level is not None:
        fields.append("level = %s")
        params.append(payload.level)
    if payload.format is not None:
        fields.append("format = %s")
        params.append(payload.format)
    if payload.visibility is not None:
        fields.append("visibility = %s")
        params.append(payload.visibility)
    if payload.pace_minutes_per_day is not None:
        fields.append("pace_minutes_per_day = %s")
        params.append(payload.pace_minutes_per_day)

    if not fields:
        return serialize_course(course)

    fields.append("updated_at = NOW()")
    params.append(course_id)

    row = db_fetchone(
        f"""
        UPDATE courses
        SET {', '.join(fields)}
        WHERE id = %s
        RETURNING *
        """,
        tuple(params),
    )
    if not row:
        raise ApiError(code="NOT_FOUND", message="Course not found", status_code=404)
    return serialize_course(row)


@app.post("/api/courses/{course_id}/archive")
def archive_course(course_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    get_course_access(course_id, user, write=True)
    row = db_fetchone(
        """
        UPDATE courses
        SET status = 'archived',
            archived_at = NOW(),
            updated_at = NOW()
        WHERE id = %s
        RETURNING *
        """,
        (course_id,),
    )
    if not row:
        raise ApiError(code="NOT_FOUND", message="Course not found", status_code=404)
    return serialize_course(row)


@app.post("/api/courses/{course_id}/restore")
def restore_course(course_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    get_course_access(course_id, user, write=True)
    row = db_fetchone(
        """
        UPDATE courses
        SET status = CASE WHEN status = 'archived' THEN 'draft' ELSE status END,
            archived_at = NULL,
            updated_at = NOW()
        WHERE id = %s
        RETURNING *
        """,
        (course_id,),
    )
    if not row:
        raise ApiError(code="NOT_FOUND", message="Course not found", status_code=404)
    return serialize_course(row)


@app.delete("/api/courses/{course_id}")
def delete_course(course_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    course = get_course_access(course_id, user, write=True)
    if user.get("role") != "admin" and str(course.get("owner_user_id")) != str(user["id"]) and course.get("member_role") not in {"owner", "admin"}:
        raise ApiError(code="FORBIDDEN", message="Only owner/admin can delete course", status_code=403)

    db_execute(
        """
        UPDATE courses
        SET deleted_at = NOW(),
            updated_at = NOW()
        WHERE id = %s
        """,
        (course_id,),
    )
    return {"status": "deleted"}


@app.get("/api/courses/{course_id}/outline")
def get_course_outline(course_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    get_course_access(course_id, user)
    modules = db_fetchall(
        """
        SELECT id, title, sort_order
        FROM course_modules
        WHERE course_id = %s
        ORDER BY sort_order ASC
        """,
        (course_id,),
    )

    items: list[dict[str, Any]] = []
    for module in modules:
        lessons = db_fetchall(
            """
            SELECT id, title, sort_order
            FROM lessons
            WHERE course_id = %s
              AND module_id = %s
            ORDER BY sort_order ASC
            """,
            (course_id, module["id"]),
        )
        items.append(
            {
                "id": str(module["id"]),
                "title": module["title"],
                "order": module["sort_order"],
                "lessons": [
                    {
                        "id": str(lesson["id"]),
                        "title": lesson["title"],
                        "order": lesson["sort_order"],
                    }
                    for lesson in lessons
                ],
            }
        )

    if items:
        return {"modules": items}

    course = db_fetchone("SELECT outline_json FROM courses WHERE id = %s", (course_id,))
    return json_load((course or {}).get("outline_json"), {"modules": []})


@app.patch("/api/courses/{course_id}/outline")
def patch_course_outline(course_id: str, payload: OutlinePatchRequest, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    get_course_access(course_id, user, write=True)
    outline = {
        "modules": [
            {
                "title": module.title,
                "order": module.order,
                "lessons": [
                    {
                        "title": lesson.title,
                        "order": lesson.order,
                    }
                    for lesson in module.lessons
                ],
            }
            for module in payload.modules
        ]
    }
    return replace_outline(course_id, outline)


@app.post("/api/courses/{course_id}/build/plan")
def build_plan(
    course_id: str,
    payload: BuildPlanRequest,
    background_tasks: BackgroundTasks,
    request: Request,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    course = get_course_access(course_id, user, write=True)
    if course.get("workspace_id"):
        ensure_materials_belong_to_workspace(payload.material_ids, str(course["workspace_id"]), user)

    rate_key = f"{user['id']}:plan"
    enforce_rate_limit("build.plan", rate_key, limit=20, window_seconds=60)

    input_payload = {
        "material_ids": payload.material_ids,
        "goal": payload.goal,
        "level": payload.level,
        "format": payload.format,
        "pace_minutes_per_day": payload.pace_minutes_per_day,
        "options": payload.options.model_dump(),
        "title": course.get("title") or "Untitled course",
    }

    db_execute(
        """
        UPDATE courses
        SET goal = %s,
            level = %s,
            format = %s,
            pace_minutes_per_day = %s,
            updated_at = NOW()
        WHERE id = %s
        """,
        (payload.goal, payload.level, payload.format, payload.pace_minutes_per_day, course_id),
    )

    build_info = create_build(background_tasks, course_id, "plan", input_payload, user, idempotency_key)
    return build_info


@app.post("/api/courses/{course_id}/build/run")
def build_run(
    course_id: str,
    payload: BuildRunRequest,
    background_tasks: BackgroundTasks,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    course = get_course_access(course_id, user, write=True)
    if course.get("workspace_id"):
        ensure_materials_belong_to_workspace(payload.material_ids, str(course["workspace_id"]), user)

    enforce_rate_limit("build.run", f"{user['id']}:run", limit=30, window_seconds=60)

    input_payload = {
        "material_ids": payload.material_ids,
        "options": payload.options.model_dump(),
    }
    return create_build(background_tasks, course_id, "content", input_payload, user, idempotency_key)


@app.get("/api/builds/{build_id}")
def get_build(build_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    row = db_fetchone(
        """
        SELECT cb.*
        FROM course_builds cb
        JOIN courses c ON c.id = cb.course_id
        LEFT JOIN workspaces w ON w.id = c.workspace_id
        LEFT JOIN workspace_members wm ON wm.workspace_id = c.workspace_id AND wm.user_id = %s
        WHERE cb.id = %s
          AND (c.owner_user_id = %s OR wm.user_id IS NOT NULL OR %s = 'admin')
        """,
        (user["id"], build_id, user["id"], user.get("role", "user")),
    )
    if not row:
        raise ApiError(code="NOT_FOUND", message="Build not found", status_code=404)

    return serialize_build(row, include_debug=user.get("role") == "admin")


@app.get("/api/builds/{build_id}/events")
async def stream_build_events(build_id: str, user: dict[str, Any] = Depends(current_user)) -> StreamingResponse:
    _ = get_build(build_id, user)

    async def event_generator():
        last_state: str | None = None
        while True:
            row = db_fetchone(
                """
                SELECT id, course_id, status, step, progress_pct, error_message, user_message, result_json, updated_at
                FROM course_builds
                WHERE id = %s
                """,
                (build_id,),
            )
            if not row:
                yield "event: error\ndata: {\"message\": \"Build not found\"}\n\n"
                break

            payload = serialize_build(row, include_debug=False)
            serialized = json_dumps(payload)
            if serialized != last_state:
                yield f"event: progress\ndata: {serialized}\n\n"
                last_state = serialized

            if row.get("status") in {"done", "failed", "canceled"}:
                break

            await asyncio.sleep(1)

    return StreamingResponse(event_generator(), media_type="text/event-stream")


@app.post("/api/builds/{build_id}/cancel")
def cancel_build(build_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    build = get_build(build_id, user)
    if build["status"] in {"done", "failed", "canceled"}:
        return build

    db_execute(
        """
        UPDATE course_builds
        SET status = 'canceled',
            user_message = 'Build canceled',
            finished_at = NOW(),
            updated_at = NOW()
        WHERE id = %s
          AND status IN ('queued', 'running')
        """,
        (build_id,),
    )
    row = db_fetchone("SELECT * FROM course_builds WHERE id = %s", (build_id,))
    if not row:
        raise ApiError(code="NOT_FOUND", message="Build not found", status_code=404)
    return serialize_build(row, include_debug=user.get("role") == "admin")


@app.get("/api/courses/{course_id}/lessons/{lesson_id}")
def get_lesson(course_id: str, lesson_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    get_course_access(course_id, user)
    lesson = db_fetchone(
        """
        SELECT id, course_id, module_id, title, sort_order, status, estimated_minutes, content_blocks, created_at, updated_at
        FROM lessons
        WHERE id = %s
          AND course_id = %s
        """,
        (lesson_id, course_id),
    )
    if not lesson:
        raise ApiError(code="NOT_FOUND", message="Lesson not found", status_code=404)

    return {
        "id": str(lesson["id"]),
        "course_id": str(lesson["course_id"]),
        "module_id": str(lesson["module_id"]) if lesson.get("module_id") else None,
        "title": lesson["title"],
        "order": lesson["sort_order"],
        "status": lesson["status"],
        "estimated_minutes": lesson["estimated_minutes"],
        "content_blocks": json_load(lesson.get("content_blocks"), []),
        "created_at": lesson["created_at"],
        "updated_at": lesson["updated_at"],
    }


@app.post("/api/courses/{course_id}/lessons/{lesson_id}/regenerate")
def regenerate_lesson(
    course_id: str,
    lesson_id: str,
    payload: LessonRegenerateRequest,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    get_course_access(course_id, user, write=True)
    if user.get("role") != "admin" and user.get("plan") not in {"pro", "team", "business"}:
        raise ApiError(code="FORBIDDEN", message="Regenerate is available only for Pro/Admin", status_code=403)

    lesson = db_fetchone("SELECT id, title FROM lessons WHERE id = %s AND course_id = %s", (lesson_id, course_id))
    if not lesson:
        raise ApiError(code="NOT_FOUND", message="Lesson not found", status_code=404)

    course = db_fetchone("SELECT goal FROM courses WHERE id = %s", (course_id,))
    blocks = create_content_blocks(str(lesson["title"]), str((course or {}).get("goal") or "Learn"), payload.style, payload.focus)

    db_execute(
        """
        UPDATE lessons
        SET content_blocks = %s::jsonb,
            status = 'ready',
            updated_at = NOW()
        WHERE id = %s
        """,
        (json_dumps(blocks), lesson_id),
    )

    return get_lesson(course_id, lesson_id, user)


@app.get("/api/courses/{course_id}/lessons/{lesson_id}/practice")
def get_lesson_practice(course_id: str, lesson_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    get_course_access(course_id, user)
    lesson = db_fetchone("SELECT id, title FROM lessons WHERE id = %s AND course_id = %s", (lesson_id, course_id))
    if not lesson:
        raise ApiError(code="NOT_FOUND", message="Lesson not found", status_code=404)

    practice = db_fetchone("SELECT id, questions, created_at FROM practice_blocks WHERE lesson_id = %s", (lesson_id,))
    if not practice:
        questions = create_practice_questions(str(lesson["title"]), more_practice=False)
        practice = db_fetchone(
            """
            INSERT INTO practice_blocks (course_id, lesson_id, questions)
            VALUES (%s, %s, %s::jsonb)
            RETURNING id, questions, created_at
            """,
            (course_id, lesson_id, json_dumps(questions)),
        )
        if not practice:
            raise ApiError(code="PRACTICE_CREATE_FAILED", message="Could not create practice", status_code=500)

    return {
        "id": str(practice["id"]),
        "course_id": course_id,
        "lesson_id": lesson_id,
        "questions": json_load(practice.get("questions"), []),
        "created_at": practice.get("created_at"),
    }


@app.post("/api/courses/{course_id}/practice/{practice_id}/attempts")
def submit_practice_attempt(
    course_id: str,
    practice_id: str,
    payload: PracticeAttemptRequest,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    get_course_access(course_id, user)
    practice = db_fetchone(
        """
        SELECT id, lesson_id, questions
        FROM practice_blocks
        WHERE id = %s
          AND course_id = %s
        """,
        (practice_id, course_id),
    )
    if not practice:
        raise ApiError(code="NOT_FOUND", message="Practice not found", status_code=404)

    questions = json_load(practice.get("questions"), [])
    answers_by_question: dict[str, Any] = {}
    for answer in payload.answers:
        question_id = answer.get("question_id") or answer.get("id")
        if question_id:
            answers_by_question[str(question_id)] = answer.get("answer")

    total = max(1, len(questions))
    correct = 0
    explanations: list[dict[str, Any]] = []

    for question in questions:
        qid = str(question.get("id") or "")
        expected = question.get("correct")
        actual = answers_by_question.get(qid)
        is_correct = actual == expected
        if is_correct:
            correct += 1
        explanations.append(
            {
                "question_id": qid,
                "correct": is_correct,
                "explanation": question.get("explanation") or "",
            }
        )

    score = round((correct / total) * 100, 2)
    state = ensure_user_course_state(str(user["id"]), course_id)
    attempts = json_load(state.get("quiz_attempts"), [])
    attempts.append(
        {
            "practice_id": practice_id,
            "lesson_id": str(practice.get("lesson_id")) if practice.get("lesson_id") else None,
            "score": score,
            "created_at": now_utc().isoformat(),
            "client_time_ms": payload.client_time_ms,
        }
    )

    db_execute(
        """
        UPDATE user_course_states
        SET quiz_attempts = %s::jsonb,
            last_activity_at = NOW(),
            updated_at = NOW()
        WHERE id = %s
        """,
        (json_dumps(attempts), state["id"]),
    )

    recommendation = "Proceed to the next lesson." if score >= 70 else "Repeat key concepts and retry."
    return {
        "score": score,
        "explanations": explanations,
        "next_recommendation": recommendation,
    }


@app.get("/api/courses/{course_id}/progress")
def get_course_progress(course_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    get_course_access(course_id, user)
    state = ensure_user_course_state(str(user["id"]), course_id)

    completed_lessons = json_load(state.get("completed_lessons"), [])
    total_row = db_fetchone("SELECT COUNT(*)::int AS total FROM lessons WHERE course_id = %s", (course_id,))
    total = int((total_row or {}).get("total") or 0)
    percent = round((len(completed_lessons) / total) * 100, 2) if total > 0 else 0

    return {
        "current_lesson_id": str(state["current_lesson_id"]) if state.get("current_lesson_id") else None,
        "completed_lessons": completed_lessons,
        "quiz_attempts": json_load(state.get("quiz_attempts"), []),
        "streak_days": int(state.get("streak_days") or 0),
        "last_activity_at": state.get("last_activity_at"),
        "aggregate": {
            "percent": percent,
            "completed_lessons": len(completed_lessons),
            "total_lessons": total,
            "streak": int(state.get("streak_days") or 0),
        },
    }


@app.post("/api/courses/{course_id}/progress/complete-lesson")
def complete_lesson(course_id: str, payload: ProgressLessonRequest, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    get_course_access(course_id, user)
    lesson_id = parse_lesson_id(payload)

    lesson = db_fetchone("SELECT id FROM lessons WHERE id = %s AND course_id = %s", (lesson_id, course_id))
    if not lesson:
        raise ApiError(code="NOT_FOUND", message="Lesson not found", status_code=404)

    state = ensure_user_course_state(str(user["id"]), course_id)
    completed = json_load(state.get("completed_lessons"), [])
    if lesson_id not in completed:
        completed.append(lesson_id)

    current_last_activity = state.get("last_activity_at")
    today = now_utc().date()
    streak = int(state.get("streak_days") or 0)
    if current_last_activity:
        prev = current_last_activity.date()
        if prev == today:
            streak = max(streak, 1)
        elif prev == (today - timedelta(days=1)):
            streak = max(streak + 1, 1)
        else:
            streak = 1
    else:
        streak = 1

    db_execute(
        """
        UPDATE user_course_states
        SET completed_lessons = %s::jsonb,
            streak_days = %s,
            last_activity_at = NOW(),
            updated_at = NOW()
        WHERE id = %s
        """,
        (json_dumps(completed), streak, state["id"]),
    )

    total_row = db_fetchone("SELECT COUNT(*)::int AS total FROM lessons WHERE course_id = %s", (course_id,))
    total = int((total_row or {}).get("total") or 0)
    percent = round((len(completed) / total) * 100, 2) if total > 0 else 0

    db_execute(
        """
        UPDATE courses
        SET progress_json = %s::jsonb,
            updated_at = NOW()
        WHERE id = %s
        """,
        (
            json_dumps(
                {
                    "percent": percent,
                    "completed_lessons": len(completed),
                    "total_lessons": total,
                    "streak": streak,
                }
            ),
            course_id,
        ),
    )

    return get_course_progress(course_id, user)


@app.post("/api/courses/{course_id}/progress/set-current")
def set_current_lesson(course_id: str, payload: ProgressLessonRequest, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    get_course_access(course_id, user)
    lesson_id = parse_lesson_id(payload)

    lesson = db_fetchone("SELECT id FROM lessons WHERE id = %s AND course_id = %s", (lesson_id, course_id))
    if not lesson:
        raise ApiError(code="NOT_FOUND", message="Lesson not found", status_code=404)

    state = ensure_user_course_state(str(user["id"]), course_id)
    db_execute(
        """
        UPDATE user_course_states
        SET current_lesson_id = %s,
            last_activity_at = NOW(),
            updated_at = NOW()
        WHERE id = %s
        """,
        (lesson_id, state["id"]),
    )
    return get_course_progress(course_id, user)


@app.post("/api/courses/{course_id}/share-link")
def create_share_link(course_id: str, payload: ShareCreateRequest, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    get_course_access(course_id, user, write=True)
    share_id = str(uuid.uuid4())

    existing = db_fetchone("SELECT id FROM course_share_links WHERE course_id = %s", (course_id,))
    if existing:
        db_execute(
            """
            UPDATE course_share_links
            SET id = %s,
                expires_at = %s,
                revoked_at = NULL
            WHERE course_id = %s
            """,
            (share_id, payload.expires_at, course_id),
        )
    else:
        db_execute(
            """
            INSERT INTO course_share_links (id, course_id, expires_at)
            VALUES (%s, %s, %s)
            """,
            (share_id, course_id, payload.expires_at),
        )

    db_execute("UPDATE courses SET visibility = 'shared_link', updated_at = NOW() WHERE id = %s", (course_id,))

    base = os.getenv("PUBLIC_SHARE_BASE_URL", "http://localhost:8000/api/share")
    return {
        "share_id": share_id,
        "url": f"{base}/{share_id}",
        "expires_at": payload.expires_at,
    }


@app.delete("/api/courses/{course_id}/share-link")
def delete_share_link(course_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    get_course_access(course_id, user, write=True)
    db_execute(
        """
        UPDATE course_share_links
        SET revoked_at = NOW()
        WHERE course_id = %s
          AND revoked_at IS NULL
        """,
        (course_id,),
    )
    db_execute("UPDATE courses SET visibility = 'private', updated_at = NOW() WHERE id = %s", (course_id,))
    return {"status": "deleted"}


@app.get("/api/share/{share_id}")
def public_share(share_id: str) -> dict[str, Any]:
    row = db_fetchone(
        """
        SELECT c.id, c.title, c.description, c.goal, c.level, c.format, c.outline_json
        FROM course_share_links sl
        JOIN courses c ON c.id = sl.course_id
        WHERE sl.id::text = %s
          AND sl.revoked_at IS NULL
          AND (sl.expires_at IS NULL OR sl.expires_at > NOW())
          AND c.deleted_at IS NULL
        """,
        (share_id,),
    )
    if not row:
        raise ApiError(code="NOT_FOUND", message="Share link not found", status_code=404)

    return {
        "id": str(row["id"]),
        "title": row["title"],
        "description": row["description"],
        "goal": row["goal"],
        "level": row["level"],
        "format": row["format"],
        "outline": json_load(row.get("outline_json"), {"modules": []}),
    }


@app.post("/api/feedback", status_code=201)
def create_feedback(payload: FeedbackCreateRequest, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    row = db_fetchone(
        """
        INSERT INTO feedback_reports (user_id, course_id, lesson_id, type, message, meta)
        VALUES (%s, %s, %s, %s, %s, %s::jsonb)
        RETURNING id, status, created_at
        """,
        (user["id"], payload.course_id, payload.lesson_id, payload.type, payload.message, json_dumps(payload.meta)),
    )
    if not row:
        raise ApiError(code="FEEDBACK_CREATE_FAILED", message="Could not create feedback", status_code=500)

    return {
        "id": str(row["id"]),
        "status": row["status"],
        "created_at": row["created_at"],
    }


@app.get("/api/feedback")
def list_feedback_admin(user: dict[str, Any] = Depends(admin_user)) -> dict[str, Any]:
    rows = db_fetchall(
        """
        SELECT id, user_id, course_id, lesson_id, type, message, meta, status, created_at, updated_at
        FROM feedback_reports
        ORDER BY created_at DESC
        LIMIT 200
        """
    )
    return {
        "items": [
            {
                "id": str(row["id"]),
                "user_id": str(row["user_id"]) if row.get("user_id") else None,
                "course_id": str(row["course_id"]) if row.get("course_id") else None,
                "lesson_id": str(row["lesson_id"]) if row.get("lesson_id") else None,
                "type": row["type"],
                "message": row["message"],
                "meta": json_load(row.get("meta"), {}),
                "status": row["status"],
                "created_at": row["created_at"],
                "updated_at": row["updated_at"],
            }
            for row in rows
        ]
    }


@app.get("/api/billing/plans")
def billing_plans() -> dict[str, Any]:
    return public_pricing()


@app.post("/api/billing/checkout")
def billing_checkout(payload: BillingCheckoutRequest, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    validate_plan(payload.plan)

    workspace_id = payload.workspace_id
    if workspace_id:
        get_workspace_access(workspace_id, user, allowed_roles={"owner", "admin"})

    current_period_end = now_utc() + timedelta(days=30)
    row = db_fetchone(
        """
        INSERT INTO subscriptions (workspace_id, user_id, provider, plan, status, current_period_end, provider_payload)
        VALUES (%s, %s, 'mock_stripe', %s, 'active', %s, '{}'::jsonb)
        RETURNING id
        """,
        (workspace_id, user["id"], payload.plan, current_period_end),
    )
    if not row:
        raise ApiError(code="BILLING_FAILED", message="Could not create checkout session", status_code=500)

    db_execute("UPDATE users SET plan = %s, updated_at = NOW() WHERE id = %s", (payload.plan, user["id"]))
    return {
        "checkout_url": f"https://billing.example/checkout/{row['id']}",
        "subscription_id": str(row["id"]),
    }


@app.get("/api/billing/subscription")
def billing_subscription(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    row = db_fetchone(
        """
        SELECT id, workspace_id, user_id, provider, plan, status, current_period_end, provider_payload, created_at, updated_at
        FROM subscriptions
        WHERE user_id = %s
        ORDER BY created_at DESC
        LIMIT 1
        """,
        (user["id"],),
    )
    if not row:
        return {
            "plan": user.get("plan") or "free",
            "status": "none",
        }

    return {
        "id": str(row["id"]),
        "workspace_id": str(row["workspace_id"]) if row.get("workspace_id") else None,
        "user_id": str(row["user_id"]) if row.get("user_id") else None,
        "provider": row["provider"],
        "plan": row["plan"],
        "status": row["status"],
        "current_period_end": row["current_period_end"],
        "provider_payload": json_load(row.get("provider_payload"), {}),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


@app.post("/api/billing/portal")
def billing_portal(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return {"portal_url": f"https://billing.example/portal/{user['id']}"}


@app.post("/api/billing/webhook")
def billing_webhook(payload: dict[str, Any]) -> dict[str, Any]:
    event_type = payload.get("type")
    if event_type == "subscription.updated":
        sub_id = payload.get("subscription_id")
        status = payload.get("status")
        if sub_id and status:
            db_execute(
                """
                UPDATE subscriptions
                SET status = %s,
                    provider_payload = %s::jsonb,
                    updated_at = NOW()
                WHERE id::text = %s
                """,
                (status, json_dumps(payload), str(sub_id)),
            )

    if event_type == "payment.succeeded":
        sub_id = payload.get("subscription_id")
        amount = payload.get("amount") or 0
        currency = payload.get("currency") or "USD"
        status = payload.get("status") or "succeeded"
        db_execute(
            """
            INSERT INTO payments (subscription_id, amount, currency, status, provider_payload)
            VALUES (%s, %s, %s, %s, %s::jsonb)
            """,
            (sub_id, amount, currency, status, json_dumps(payload)),
        )

    return {"status": "ok"}


@app.get("/api/admin/users")
def admin_list_users(
    q: str | None = Query(default=None),
    status: str | None = Query(default=None),
    plan: str | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    user: dict[str, Any] = Depends(admin_user),
) -> dict[str, Any]:
    offset = (page - 1) * page_size
    conditions = ["deleted_at IS NULL"]
    params: list[Any] = []

    if q:
        conditions.append("(email ILIKE %s OR name ILIKE %s)")
        params.extend([f"%{q}%", f"%{q}%"])
    if status:
        conditions.append("status = %s")
        params.append(status)
    if plan:
        conditions.append("plan = %s")
        params.append(plan)

    params.extend([page_size, offset])

    rows = db_fetchall(
        f"""
        SELECT id, email, name, role, plan, status, created_at, last_login_at
        FROM users
        WHERE {' AND '.join(conditions)}
        ORDER BY created_at DESC
        LIMIT %s OFFSET %s
        """,
        tuple(params),
    )

    return {
        "items": [serialize_user(row) for row in rows],
        "page": page,
        "page_size": page_size,
    }


@app.get("/api/admin/users/{user_id}")
def admin_get_user(user_id: str, user: dict[str, Any] = Depends(admin_user)) -> dict[str, Any]:
    row = db_fetchone(
        """
        SELECT id, email, name, role, plan, status, created_at, last_login_at
        FROM users
        WHERE id = %s
          AND deleted_at IS NULL
        """,
        (user_id,),
    )
    if not row:
        raise ApiError(code="NOT_FOUND", message="User not found", status_code=404)
    return serialize_user(row)


@app.patch("/api/admin/users/{user_id}")
def admin_patch_user(user_id: str, payload: AdminUserPatchRequest, user: dict[str, Any] = Depends(admin_user)) -> dict[str, Any]:
    fields: list[str] = []
    params: list[Any] = []
    if payload.status is not None:
        fields.append("status = %s")
        params.append(payload.status)
    if payload.plan is not None:
        validate_plan(payload.plan)
        fields.append("plan = %s")
        params.append(payload.plan)

    if not fields:
        return admin_get_user(user_id, user)

    fields.append("updated_at = NOW()")
    params.append(user_id)

    row = db_fetchone(
        f"""
        UPDATE users
        SET {', '.join(fields)}
        WHERE id = %s
          AND deleted_at IS NULL
        RETURNING id, email, name, role, plan, status, created_at, last_login_at
        """,
        tuple(params),
    )
    if not row:
        raise ApiError(code="NOT_FOUND", message="User not found", status_code=404)
    return serialize_user(row)


@app.post("/api/admin/users/{user_id}/impersonate")
def admin_impersonate(user_id: str, user: dict[str, Any] = Depends(admin_user)) -> dict[str, Any]:
    target = db_fetchone(
        """
        SELECT id, email, role, plan, status
        FROM users
        WHERE id = %s
          AND deleted_at IS NULL
        """,
        (user_id,),
    )
    if not target:
        raise ApiError(code="NOT_FOUND", message="User not found", status_code=404)

    if target.get("status") != "active":
        raise ApiError(code="FORBIDDEN", message="Cannot impersonate non-active user", status_code=403)

    token = create_access_token(
        user_id=str(target["id"]),
        email=str(target["email"]),
        role=str(target.get("role") or "user"),
        plan=str(target.get("plan") or "free"),
    )
    return {
        "access_token": token,
        "token_type": "bearer",
        "impersonated_user_id": str(target["id"]),
    }


@app.get("/api/admin/courses")
def admin_list_courses(
    q: str | None = Query(default=None),
    status: str | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    user: dict[str, Any] = Depends(admin_user),
) -> dict[str, Any]:
    offset = (page - 1) * page_size
    conditions = ["c.deleted_at IS NULL"]
    params: list[Any] = []
    if q:
        conditions.append("(c.title ILIKE %s OR c.goal ILIKE %s)")
        params.extend([f"%{q}%", f"%{q}%"])
    if status:
        conditions.append("c.status = %s")
        params.append(status)
    params.extend([page_size, offset])

    rows = db_fetchall(
        f"""
        SELECT c.*
        FROM courses c
        WHERE {' AND '.join(conditions)}
        ORDER BY c.updated_at DESC
        LIMIT %s OFFSET %s
        """,
        tuple(params),
    )

    return {
        "items": [serialize_course(row) for row in rows],
        "page": page,
        "page_size": page_size,
    }


@app.get("/api/admin/courses/{course_id}")
def admin_get_course(course_id: str, user: dict[str, Any] = Depends(admin_user)) -> dict[str, Any]:
    row = db_fetchone("SELECT * FROM courses WHERE id = %s AND deleted_at IS NULL", (course_id,))
    if not row:
        raise ApiError(code="NOT_FOUND", message="Course not found", status_code=404)
    return serialize_course(row)


@app.post("/api/admin/courses/{course_id}/rebuild")
def admin_rebuild_course(
    course_id: str,
    payload: AdminCourseRebuildRequest,
    background_tasks: BackgroundTasks,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    user: dict[str, Any] = Depends(admin_user),
) -> dict[str, Any]:
    row = db_fetchone("SELECT id FROM courses WHERE id = %s AND deleted_at IS NULL", (course_id,))
    if not row:
        raise ApiError(code="NOT_FOUND", message="Course not found", status_code=404)

    step = payload.step or "content"
    return create_build(background_tasks, course_id, step, {"admin_rebuild": True}, user, idempotency_key)


@app.delete("/api/admin/courses/{course_id}")
def admin_delete_course(course_id: str, user: dict[str, Any] = Depends(admin_user)) -> dict[str, Any]:
    db_execute(
        """
        UPDATE courses
        SET deleted_at = NOW(),
            updated_at = NOW()
        WHERE id = %s
        """,
        (course_id,),
    )
    return {"status": "deleted"}


@app.get("/api/admin/templates")
def admin_list_templates(user: dict[str, Any] = Depends(admin_user)) -> dict[str, Any]:
    rows = db_fetchall(
        """
        SELECT id, name, description, schema, is_active, created_at, updated_at
        FROM templates
        ORDER BY created_at DESC
        """
    )
    return {
        "items": [
            {
                "id": str(row["id"]),
                "name": row["name"],
                "description": row["description"],
                "schema": json_load(row.get("schema"), {}),
                "is_active": row["is_active"],
                "created_at": row["created_at"],
                "updated_at": row["updated_at"],
            }
            for row in rows
        ]
    }


@app.post("/api/admin/templates", status_code=201)
def admin_create_template(payload: TemplateCreateRequest, user: dict[str, Any] = Depends(admin_user)) -> dict[str, Any]:
    row = db_fetchone(
        """
        INSERT INTO templates (name, description, schema)
        VALUES (%s, %s, %s::jsonb)
        RETURNING id, name, description, schema, is_active, created_at, updated_at
        """,
        (payload.name, payload.description or "", json_dumps(payload.template_schema)),
    )
    if not row:
        raise ApiError(code="TEMPLATE_CREATE_FAILED", message="Could not create template", status_code=500)

    return {
        "id": str(row["id"]),
        "name": row["name"],
        "description": row["description"],
        "schema": json_load(row.get("schema"), {}),
        "is_active": row["is_active"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


@app.patch("/api/admin/templates/{template_id}")
def admin_patch_template(
    template_id: str,
    payload: TemplatePatchRequest,
    user: dict[str, Any] = Depends(admin_user),
) -> dict[str, Any]:
    fields: list[str] = []
    params: list[Any] = []

    if payload.name is not None:
        fields.append("name = %s")
        params.append(payload.name)
    if payload.description is not None:
        fields.append("description = %s")
        params.append(payload.description)
    if payload.template_schema is not None:
        fields.append("schema = %s::jsonb")
        params.append(json_dumps(payload.template_schema))

    if not fields:
        template = db_fetchone("SELECT id, name, description, schema, is_active, created_at, updated_at FROM templates WHERE id = %s", (template_id,))
        if not template:
            raise ApiError(code="NOT_FOUND", message="Template not found", status_code=404)
        return {
            "id": str(template["id"]),
            "name": template["name"],
            "description": template["description"],
            "schema": json_load(template.get("schema"), {}),
            "is_active": template["is_active"],
            "created_at": template["created_at"],
            "updated_at": template["updated_at"],
        }

    fields.append("updated_at = NOW()")
    params.append(template_id)
    row = db_fetchone(
        f"""
        UPDATE templates
        SET {', '.join(fields)}
        WHERE id = %s
        RETURNING id, name, description, schema, is_active, created_at, updated_at
        """,
        tuple(params),
    )
    if not row:
        raise ApiError(code="NOT_FOUND", message="Template not found", status_code=404)
    return {
        "id": str(row["id"]),
        "name": row["name"],
        "description": row["description"],
        "schema": json_load(row.get("schema"), {}),
        "is_active": row["is_active"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


@app.post("/api/admin/templates/{template_id}/activate")
def admin_activate_template(template_id: str, user: dict[str, Any] = Depends(admin_user)) -> dict[str, Any]:
    row = db_fetchone(
        """
        UPDATE templates
        SET is_active = TRUE,
            updated_at = NOW()
        WHERE id = %s
        RETURNING id, is_active
        """,
        (template_id,),
    )
    if not row:
        raise ApiError(code="NOT_FOUND", message="Template not found", status_code=404)
    return {"id": str(row["id"]), "is_active": row["is_active"]}


@app.post("/api/admin/templates/{template_id}/deactivate")
def admin_deactivate_template(template_id: str, user: dict[str, Any] = Depends(admin_user)) -> dict[str, Any]:
    row = db_fetchone(
        """
        UPDATE templates
        SET is_active = FALSE,
            updated_at = NOW()
        WHERE id = %s
        RETURNING id, is_active
        """,
        (template_id,),
    )
    if not row:
        raise ApiError(code="NOT_FOUND", message="Template not found", status_code=404)
    return {"id": str(row["id"]), "is_active": row["is_active"]}


@app.get("/api/admin/billing/subscriptions")
def admin_billing_subscriptions(user: dict[str, Any] = Depends(admin_user)) -> dict[str, Any]:
    rows = db_fetchall(
        """
        SELECT id, workspace_id, user_id, provider, plan, status, current_period_end, provider_payload, created_at, updated_at
        FROM subscriptions
        ORDER BY created_at DESC
        LIMIT 500
        """
    )
    return {
        "items": [
            {
                "id": str(row["id"]),
                "workspace_id": str(row["workspace_id"]) if row.get("workspace_id") else None,
                "user_id": str(row["user_id"]) if row.get("user_id") else None,
                "provider": row["provider"],
                "plan": row["plan"],
                "status": row["status"],
                "current_period_end": row["current_period_end"],
                "provider_payload": json_load(row.get("provider_payload"), {}),
                "created_at": row["created_at"],
                "updated_at": row["updated_at"],
            }
            for row in rows
        ]
    }


@app.get("/api/admin/billing/payments")
def admin_billing_payments(user: dict[str, Any] = Depends(admin_user)) -> dict[str, Any]:
    rows = db_fetchall(
        """
        SELECT id, subscription_id, amount, currency, status, provider_payload, created_at
        FROM payments
        ORDER BY created_at DESC
        LIMIT 500
        """
    )
    return {
        "items": [
            {
                "id": str(row["id"]),
                "subscription_id": str(row["subscription_id"]) if row.get("subscription_id") else None,
                "amount": float(row["amount"]),
                "currency": row["currency"],
                "status": row["status"],
                "provider_payload": json_load(row.get("provider_payload"), {}),
                "created_at": row["created_at"],
            }
            for row in rows
        ]
    }


@app.get("/api/admin/feedback")
def admin_list_feedback(
    status: str | None = Query(default=None),
    type: str | None = Query(default=None),
    user: dict[str, Any] = Depends(admin_user),
) -> dict[str, Any]:
    conditions = ["1=1"]
    params: list[Any] = []
    if status:
        conditions.append("status = %s")
        params.append(status)
    if type:
        conditions.append("type = %s")
        params.append(type)

    rows = db_fetchall(
        f"""
        SELECT id, user_id, course_id, lesson_id, type, message, meta, status, created_at, updated_at
        FROM feedback_reports
        WHERE {' AND '.join(conditions)}
        ORDER BY created_at DESC
        """,
        tuple(params),
    )

    return {
        "items": [
            {
                "id": str(row["id"]),
                "user_id": str(row["user_id"]) if row.get("user_id") else None,
                "course_id": str(row["course_id"]) if row.get("course_id") else None,
                "lesson_id": str(row["lesson_id"]) if row.get("lesson_id") else None,
                "type": row["type"],
                "message": row["message"],
                "meta": json_load(row.get("meta"), {}),
                "status": row["status"],
                "created_at": row["created_at"],
                "updated_at": row["updated_at"],
            }
            for row in rows
        ]
    }


@app.patch("/api/admin/feedback/{feedback_id}")
def admin_patch_feedback(
    feedback_id: str,
    payload: AdminFeedbackPatchRequest,
    user: dict[str, Any] = Depends(admin_user),
) -> dict[str, Any]:
    row = db_fetchone(
        """
        UPDATE feedback_reports
        SET status = %s,
            updated_at = NOW()
        WHERE id = %s
        RETURNING id, status, updated_at
        """,
        (payload.status, feedback_id),
    )
    if not row:
        raise ApiError(code="NOT_FOUND", message="Feedback not found", status_code=404)
    return {
        "id": str(row["id"]),
        "status": row["status"],
        "updated_at": row["updated_at"],
    }


@app.get("/api/admin/health")
def admin_health(user: dict[str, Any] = Depends(admin_user)) -> dict[str, Any]:
    failed_builds = db_fetchone(
        """
        SELECT COUNT(*)::int AS total
        FROM course_builds
        WHERE status = 'failed'
          AND created_at >= NOW() - INTERVAL '24 hours'
        """
    )
    running_builds = db_fetchone(
        """
        SELECT COUNT(*)::int AS total
        FROM course_builds
        WHERE status IN ('queued', 'running')
        """
    )
    failed_jobs = db_fetchone(
        """
        SELECT COUNT(*)::int AS total
        FROM jobs
        WHERE status = 'failed'
          AND created_at >= NOW() - INTERVAL '24 hours'
        """
    )

    return {
        "uptime_seconds": int((now_utc() - started_at).total_seconds()),
        "builds_running": int((running_builds or {}).get("total") or 0),
        "builds_failed_24h": int((failed_builds or {}).get("total") or 0),
        "legacy_jobs_failed_24h": int((failed_jobs or {}).get("total") or 0),
        "status": "ok",
    }


@app.get("/api/admin/jobs")
def admin_jobs(user: dict[str, Any] = Depends(admin_user)) -> dict[str, Any]:
    builds = db_fetchall(
        """
        SELECT id, course_id, step, status, progress_pct, error_message, created_at, updated_at
        FROM course_builds
        ORDER BY created_at DESC
        LIMIT 100
        """
    )

    legacy_jobs = db_fetchall(
        """
        SELECT id, source_id, status, error, created_at, updated_at
        FROM jobs
        ORDER BY created_at DESC
        LIMIT 100
        """
    )

    return {
        "builds": [
            {
                "id": str(row["id"]),
                "course_id": str(row["course_id"]),
                "step": row["step"],
                "status": row["status"],
                "progress_pct": row["progress_pct"],
                "error_message": row.get("error_message"),
                "created_at": row["created_at"],
                "updated_at": row["updated_at"],
            }
            for row in builds
        ],
        "legacy_jobs": [
            {
                "id": str(row["id"]),
                "source_id": str(row["source_id"]),
                "status": row["status"],
                "error": row.get("error"),
                "created_at": row["created_at"],
                "updated_at": row["updated_at"],
            }
            for row in legacy_jobs
        ],
    }


# Backward compatibility (/api/v1)


@app.post("/api/v1/auth/register", status_code=201)
def register_v1(payload: RegisterRequest) -> dict[str, Any]:
    name = payload.email.split("@")[0]
    user = create_user_account(payload.email, payload.password, name)
    return {
        "id": str(user["id"]),
        "email": user["email"],
    }


@app.post("/api/v1/auth/login")
def login_v1(payload: LoginRequest) -> dict[str, Any]:
    user = db_fetchone(
        """
        SELECT id, email, role, plan, password_hash, deleted_at, status
        FROM users
        WHERE email = %s
        """,
        (payload.email,),
    )

    if not user or user.get("deleted_at") is not None or not password_context.verify(payload.password, user.get("password_hash") or ""):
        raise ApiError(code="INVALID_CREDENTIALS", message="Email or password is incorrect", status_code=401)

    if user.get("status") == "blocked":
        raise ApiError(code="FORBIDDEN", message="User is blocked", status_code=403)

    token = create_access_token(str(user["id"]), user["email"], str(user.get("role") or "user"), str(user.get("plan") or "free"))
    return {"access_token": token, "token_type": "bearer"}


@app.post("/api/v1/sources", status_code=202)
async def upload_source_v1(
    request: Request,
    user: dict[str, Any] = Depends(current_user),
    file: UploadFile = File(...),
    source_type: str = Form(default="document", alias="type"),
) -> dict[str, Any]:
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

    data = response.json()
    return {
        "source_id": str(data.get("sourceId", source_id)),
        "job_id": str(data.get("jobId", "")),
        "status": str(data.get("status", "queued")),
    }


@app.get("/api/v1/sources/{source_id}")
def source_details_v1(source_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    row = db_fetchone(
        """
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
        """,
        (source_id, user["id"]),
    )

    if not row:
        raise ApiError(code="SOURCE_NOT_FOUND", message="Source not found", status_code=404)

    job = None
    if row.get("job_id"):
        job = {
            "id": str(row["job_id"]),
            "status": row.get("job_status"),
            "error": row.get("error"),
        }

    return {
        "id": str(row["id"]),
        "type": row["type"],
        "name": row["name"],
        "status": row["status"],
        "job": job,
    }


@app.post("/api/v1/courses", status_code=201)
async def create_course_v1(
    payload: CourseCreateRequest,
    request: Request,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
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
    return {
        "course_id": str(data.get("course_id")),
        "structure": data.get("structure", {}),
    }


@app.get("/api/v1/courses/{course_id}")
def course_details_v1(course_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    row = db_fetchone(
        """
        SELECT id, title, goal, level, structure_json
        FROM courses
        WHERE id = %s
          AND (user_id = %s OR user_id IS NULL)
        """,
        (course_id, user["id"]),
    )

    if not row:
        raise ApiError(code="COURSE_NOT_FOUND", message="Course not found", status_code=404)

    return {
        "id": str(row["id"]),
        "title": row["title"],
        "goal": row["goal"],
        "level": row["level"],
        "structure": json_load(row.get("structure_json"), {}),
    }
