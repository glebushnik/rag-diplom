import type {
  ApiErrorPayload,
  CourseResponse,
  CreateCourseRequest,
  CreateCourseResponse,
  LoginRequest,
  LoginResponse,
  RegisterRequest,
  RegisterResponse,
  SourceResponse,
  SourceUploadResponse,
} from '../types'

type RequestOptions = Omit<RequestInit, 'headers'> & {
  headers?: HeadersInit
  auth?: boolean
}

const API_PREFIX = '/api/v1'

const isApiErrorPayload = (value: unknown): value is ApiErrorPayload => {
  if (!value || typeof value !== 'object') {
    return false
  }

  const candidate = value as Partial<ApiErrorPayload>
  return (
    Boolean(candidate.error) &&
    typeof candidate.error?.code === 'string' &&
    typeof candidate.error?.message === 'string'
  )
}

const parseJsonSafely = (payload: string): unknown => {
  if (!payload.trim()) {
    return null
  }

  try {
    return JSON.parse(payload)
  } catch {
    return null
  }
}

const normalizeGatewayUrl = (input: string): string => {
  const trimmed = input.trim().replace(/\/+$/, '')

  if (trimmed.endsWith(API_PREFIX)) {
    return trimmed
  }

  return `${trimmed}${API_PREFIX}`
}

export const resolveGatewayBaseUrl = (input?: string): string => {
  if (input && input.trim().length > 0) {
    return normalizeGatewayUrl(input)
  }

  return normalizeGatewayUrl('http://localhost:8000')
}

export class GatewayApiError extends Error {
  status: number
  code: string
  details: Record<string, unknown> | undefined

  constructor(
    message: string,
    status: number,
    code: string,
    details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'GatewayApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

export class GatewayClient {
  private readonly baseUrl: string

  private readonly getToken: () => string | null

  constructor(baseUrl: string, getToken: () => string | null) {
    this.baseUrl = baseUrl
    this.getToken = getToken
  }

  private async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const { auth = true, headers, body, ...rest } = options
    const requestHeaders = new Headers(headers ?? {})

    if (!(body instanceof FormData) && !requestHeaders.has('Content-Type')) {
      requestHeaders.set('Content-Type', 'application/json')
    }

    if (auth) {
      const token = this.getToken()

      if (!token) {
        throw new GatewayApiError('JWT token is missing. Please log in again.', 401, 'UNAUTHORIZED')
      }

      requestHeaders.set('Authorization', `Bearer ${token}`)
    }

    const response = await fetch(`${this.baseUrl}${path}`, {
      ...rest,
      body,
      headers: requestHeaders,
    })

    const responseText = await response.text()
    const payload = parseJsonSafely(responseText)

    if (!response.ok) {
      if (isApiErrorPayload(payload)) {
        throw new GatewayApiError(
          payload.error.message,
          response.status,
          payload.error.code,
          payload.error.details,
        )
      }

      throw new GatewayApiError(
        `Request failed with status ${response.status}`,
        response.status,
        'HTTP_ERROR',
      )
    }

    return payload as T
  }

  register(data: RegisterRequest): Promise<RegisterResponse> {
    return this.request<RegisterResponse>('/auth/register', {
      method: 'POST',
      body: JSON.stringify(data),
      auth: false,
    })
  }

  login(data: LoginRequest): Promise<LoginResponse> {
    return this.request<LoginResponse>('/auth/login', {
      method: 'POST',
      body: JSON.stringify(data),
      auth: false,
    })
  }

  uploadSource(file: File, type?: string): Promise<SourceUploadResponse> {
    const formData = new FormData()
    formData.append('file', file)

    if (type && type.trim().length > 0) {
      formData.append('type', type)
    }

    return this.request<SourceUploadResponse>('/sources', {
      method: 'POST',
      body: formData,
    })
  }

  getSource(sourceId: string): Promise<SourceResponse> {
    return this.request<SourceResponse>(`/sources/${sourceId}`, {
      method: 'GET',
    })
  }

  createCourse(payload: CreateCourseRequest): Promise<CreateCourseResponse> {
    return this.request<CreateCourseResponse>('/courses', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  }

  getCourse(courseId: string): Promise<CourseResponse> {
    return this.request<CourseResponse>(`/courses/${courseId}`, {
      method: 'GET',
    })
  }
}
