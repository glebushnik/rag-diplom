export type JobStatus = 'queued' | 'processing' | 'embedded' | 'indexed' | 'failed'

export interface RegisterRequest {
  email: string
  password: string
}

export interface RegisterResponse {
  id: string
  email: string
}

export interface LoginRequest {
  email: string
  password: string
}

export interface LoginResponse {
  access_token: string
  token_type: string
}

export interface ApiErrorPayload {
  error: {
    code: string
    message: string
    details?: Record<string, unknown>
  }
}

export interface SourceUploadResponse {
  source_id: string
  job_id: string
  status: JobStatus
}

export interface SourceJob {
  id: string
  status: JobStatus
  error: string | null
}

export interface SourceResponse {
  id: string
  type: string
  name: string
  status: JobStatus
  job: SourceJob | null
}

export type CourseLevel = 'beginner' | 'intermediate' | 'advanced'

export interface CreateCourseRequest {
  source_id: string
  title: string
  goal: string
  level: CourseLevel
  provider_override?: 'local' | 'api'
}

export interface CourseLesson {
  title?: string
  objective?: string
  [key: string]: unknown
}

export interface CourseModule {
  title?: string
  description?: string
  lessons?: CourseLesson[]
  [key: string]: unknown
}

export interface CourseStructure {
  title?: string
  modules?: CourseModule[]
  [key: string]: unknown
}

export interface CreateCourseResponse {
  course_id: string
  structure: CourseStructure
}

export interface CourseResponse {
  id: string
  title: string
  goal: string
  level: string
  structure: CourseStructure
}
