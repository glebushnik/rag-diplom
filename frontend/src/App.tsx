import {
  type ButtonHTMLAttributes,
  type ChangeEvent,
  type FormEvent,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react'
import './App.css'
import { GatewayApiError, GatewayClient, resolveGatewayBaseUrl } from './lib/api'
import { clearStoredToken, readStoredToken, writeStoredToken } from './lib/tokenStore'
import type {
  CourseLevel,
  CourseModule,
  CourseResponse,
  CreateCourseRequest,
  JobStatus,
  SourceResponse,
} from './types'

type ThemeMode = 'dark' | 'light'
type UserRole = 'user' | 'admin'
type AuthMode = 'login' | 'signup'
type AdminSection =
  | 'overview'
  | 'users'
  | 'courses'
  | 'templates'
  | 'billing'
  | 'feedback'
  | 'health'

type WizardMaterialKind = 'file' | 'link' | 'text'
type WizardMaterialStatus = 'готово' | 'в работе' | 'нужна проверка'
type LearningLevel = 'с нуля' | 'базовый' | 'уверенный'
type LearningDepth = 'быстро' | 'стандарт' | 'глубоко'
type LearningPace = '15–30 мин' | '1 час' | 'свободно'

type CourseStatusFilter = 'all' | 'черновик' | 'в процессе' | 'завершен'

type Route =
  | { kind: 'landing' }
  | { kind: 'examples' }
  | { kind: 'pricing' }
  | { kind: 'about' }
  | { kind: 'help' }
  | { kind: 'login' }
  | { kind: 'signup' }
  | { kind: 'appLibrary' }
  | { kind: 'appNew' }
  | { kind: 'course'; courseId: string }
  | { kind: 'lesson'; courseId: string; lessonId: string }
  | { kind: 'practice'; courseId: string; blockId: string }
  | { kind: 'settings' }
  | { kind: 'billing' }
  | { kind: 'admin'; section: AdminSection }
  | { kind: 'notFound' }

interface WizardMaterial {
  id: string
  kind: WizardMaterialKind
  name: string
  detail: string
  status: WizardMaterialStatus
  sourceId?: string
}

interface PlanLesson {
  id: string
  title: string
}

interface PlanModule {
  id: string
  title: string
  lessons: PlanLesson[]
}

interface WizardState {
  step: 1 | 2 | 3 | 4
  materials: WizardMaterial[]
  selectedSourceId: string
  courseTitle: string
  goal: string
  level: LearningLevel
  depth: LearningDepth
  pace: LearningPace
  detailLevel: number
  practiceBoost: boolean
  modules: PlanModule[]
  createdCourseId: string | null
}

interface CourseLibraryItem {
  id: string
  title: string
  topic: string
  updatedAt: string
  totalLessons: number
}

interface CourseProgress {
  completedLessonIds: string[]
  dewStreak: number
  lastOpenedLessonId: string | null
}

interface TokenProfile {
  email: string | null
  role: UserRole
}

interface LessonNode {
  id: string
  moduleIndex: number
  lessonIndex: number
  moduleTitle: string
  title: string
  objective?: string
  details?: string
}

interface PracticeQuestion {
  id: string
  type: 'choice' | 'short'
  question: string
  options?: string[]
  answer: string
  reason: string
}

interface PanelProps {
  className?: string
  children: ReactNode
}

interface LiquidButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost'
  compact?: boolean
}

interface BadgeProps {
  label: string
  tone?: 'neutral' | 'success' | 'warning' | 'error'
}

interface BloomProgressProps {
  value: number
  label: string
  hint?: string
}

interface StepperProps {
  steps: string[]
  current: number
}

interface AuthFormProps {
  mode: AuthMode
  busy: boolean
  message: string | null
  errorMessage: string | null
  onSubmit: (email: string, password: string, mode: AuthMode) => Promise<void>
  onModeChange: (mode: AuthMode) => void
}

interface PracticeSessionProps {
  questions: PracticeQuestion[]
  onFinish: (correctCount: number) => void
}

const THEME_STORAGE_KEY = 'flowa.theme'
const LIBRARY_STORAGE_KEY = 'flowa.library'
const PROGRESS_STORAGE_KEY = 'flowa.progress'
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const POLL_INTERVAL_MS = 3000
const TERMINAL_STATUSES = new Set<JobStatus>(['indexed', 'failed'])

const LANDING_STEPS = ['Добавьте материалы', 'Выберите цель', 'Получите курс и учитесь']
const VALUE_CARDS = [
  'План по шагам',
  'Короткие уроки',
  'Практика',
  'Вопросы для самопроверки',
  'Прогресс и повторение',
]
const FOR_WHO = [
  'Экзамены и зачеты',
  'Новая тема для работы',
  'Обучение команды',
  'Курс для студентов и учеников',
]
const EXAMPLE_COURSES = [
  'Подготовка к экзамену',
  'Введение в тему',
  'План на 7 дней',
  'Курс по внутренним материалам',
  'Быстрый старт для новичка',
  'Повторение и закрепление',
]

const ADMIN_SECTIONS: Array<{ section: AdminSection; path: string; label: string }> = [
  { section: 'overview', path: '/admin', label: 'Overview' },
  { section: 'users', path: '/admin/users', label: 'Users' },
  { section: 'courses', path: '/admin/courses', label: 'Courses' },
  { section: 'templates', path: '/admin/templates', label: 'Templates' },
  { section: 'billing', path: '/admin/billing', label: 'Billing' },
  { section: 'feedback', path: '/admin/feedback', label: 'Feedback' },
  { section: 'health', path: '/admin/health', label: 'Health' },
]

const SOURCE_STATUS_TO_MATERIAL: Record<JobStatus, WizardMaterialStatus> = {
  queued: 'в работе',
  processing: 'в работе',
  embedded: 'в работе',
  indexed: 'готово',
  failed: 'нужна проверка',
}

const SOURCE_STATUS_LABEL: Record<JobStatus, string> = {
  queued: 'в очереди',
  processing: 'в работе',
  embedded: 'подготовка',
  indexed: 'готово',
  failed: 'нужна проверка',
}

const SOURCE_STATUS_HINT: Record<JobStatus, string> = {
  queued: 'Материал принят и скоро будет готов.',
  processing: 'Проверяем содержимое материала.',
  embedded: 'Собираем основу для вашего курса.',
  indexed: 'Материал можно использовать для курса.',
  failed: 'Не удалось завершить подготовку. Попробуйте снова.',
}

const LEVEL_TO_API: Record<LearningLevel, CourseLevel> = {
  'с нуля': 'beginner',
  базовый: 'intermediate',
  уверенный: 'advanced',
}

const LEVEL_OPTIONS: LearningLevel[] = ['с нуля', 'базовый', 'уверенный']
const DEPTH_OPTIONS: LearningDepth[] = ['быстро', 'стандарт', 'глубоко']
const PACE_OPTIONS: LearningPace[] = ['15–30 мин', '1 час', 'свободно']

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    window.setTimeout(resolve, milliseconds)
  })

const createId = (prefix: string): string =>
  `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`

const normalizePath = (pathname: string): string => {
  if (!pathname || pathname === '/') {
    return '/'
  }

  const compact = pathname.replace(/\/+$/, '')
  return compact.length > 0 ? compact : '/'
}

const resolveRoute = (pathname: string): Route => {
  const clean = normalizePath(pathname)

  if (clean === '/') {
    return { kind: 'landing' }
  }

  if (clean === '/examples') {
    return { kind: 'examples' }
  }

  if (clean === '/pricing') {
    return { kind: 'pricing' }
  }

  if (clean === '/about') {
    return { kind: 'about' }
  }

  if (clean === '/help') {
    return { kind: 'help' }
  }

  if (clean === '/login') {
    return { kind: 'login' }
  }

  if (clean === '/signup') {
    return { kind: 'signup' }
  }

  if (clean === '/app') {
    return { kind: 'appLibrary' }
  }

  if (clean === '/app/new') {
    return { kind: 'appNew' }
  }

  if (clean === '/settings') {
    return { kind: 'settings' }
  }

  if (clean === '/billing') {
    return { kind: 'billing' }
  }

  if (clean === '/admin') {
    return { kind: 'admin', section: 'overview' }
  }

  if (clean.startsWith('/admin/')) {
    const parts = clean.split('/').filter(Boolean)
    const section = parts[1] as AdminSection

    if (
      section === 'users' ||
      section === 'courses' ||
      section === 'templates' ||
      section === 'billing' ||
      section === 'feedback' ||
      section === 'health'
    ) {
      return { kind: 'admin', section }
    }

    return { kind: 'notFound' }
  }

  if (clean.startsWith('/app/course/')) {
    const parts = clean.split('/').filter(Boolean)

    if (parts.length === 3) {
      return { kind: 'course', courseId: parts[2] }
    }

    if (parts.length === 5 && parts[3] === 'lesson') {
      return { kind: 'lesson', courseId: parts[2], lessonId: parts[4] }
    }

    if (parts.length === 5 && parts[3] === 'practice') {
      return { kind: 'practice', courseId: parts[2], blockId: parts[4] }
    }
  }

  return { kind: 'notFound' }
}

const isProtectedRoute = (route: Route): boolean => {
  return (
    route.kind === 'appLibrary' ||
    route.kind === 'appNew' ||
    route.kind === 'course' ||
    route.kind === 'lesson' ||
    route.kind === 'practice' ||
    route.kind === 'settings' ||
    route.kind === 'billing' ||
    route.kind === 'admin'
  )
}

const safeJsonParse = <T,>(value: string | null, fallback: T): T => {
  if (!value) {
    return fallback
  }

  try {
    const parsed = JSON.parse(value)
    return parsed as T
  } catch {
    return fallback
  }
}

const decodeBase64Url = (value: string): string | null => {
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
    const padding = normalized.length % 4
    const suffix = padding === 0 ? '' : '='.repeat(4 - padding)
    return window.atob(`${normalized}${suffix}`)
  } catch {
    return null
  }
}

const decodeTokenPayload = (token: string): Record<string, unknown> | null => {
  const parts = token.split('.')

  if (parts.length < 2) {
    return null
  }

  const decoded = decodeBase64Url(parts[1])

  if (!decoded) {
    return null
  }

  return safeJsonParse<Record<string, unknown>>(decoded, {})
}

const resolveProfileFromToken = (token: string | null): TokenProfile => {
  if (!token) {
    return { email: null, role: 'user' }
  }

  const payload = decodeTokenPayload(token)

  if (!payload) {
    return { email: null, role: 'user' }
  }

  const roleRaw = payload.role
  const rolesRaw = payload.roles
  const isAdminFlag = payload.is_admin

  let role: UserRole = 'user'

  if (roleRaw === 'admin') {
    role = 'admin'
  }

  if (Array.isArray(rolesRaw) && rolesRaw.includes('admin')) {
    role = 'admin'
  }

  if (isAdminFlag === true) {
    role = 'admin'
  }

  const email =
    typeof payload.email === 'string'
      ? payload.email
      : typeof payload.sub === 'string'
        ? payload.sub
        : null

  return {
    email,
    role,
  }
}

const toErrorMessage = (error: unknown): string => {
  if (error instanceof GatewayApiError) {
    if (error.status === 401) {
      return 'Сессия завершилась. Войдите снова.'
    }

    if (error.status === 404) {
      return 'Не удалось найти данные. Проверьте введенные значения.'
    }

    if (error.status >= 500) {
      return 'Сервис временно недоступен. Попробуйте немного позже.'
    }

    return error.message || 'Не удалось выполнить действие.'
  }

  if (error instanceof Error) {
    return error.message
  }

  return 'Произошла ошибка. Попробуйте еще раз.'
}

const sourceReady = (status: JobStatus): boolean => status === 'indexed'

const upsertSource = (existing: SourceResponse[], incoming: SourceResponse): SourceResponse[] => {
  const index = existing.findIndex((item) => item.id === incoming.id)

  if (index < 0) {
    return [incoming, ...existing]
  }

  const next = [...existing]
  next[index] = incoming
  return next
}

const createInitialWizardState = (): WizardState => ({
  step: 1,
  materials: [],
  selectedSourceId: '',
  courseTitle: '',
  goal: '',
  level: 'с нуля',
  depth: 'стандарт',
  pace: '15–30 мин',
  detailLevel: 50,
  practiceBoost: true,
  modules: [],
  createdCourseId: null,
})

const buildInitialPlan = (title: string, goal: string): PlanModule[] => {
  const baseTopic = (title || goal || 'Новая тема').trim()

  return [
    {
      id: createId('module'),
      title: `Старт: ${baseTopic}`,
      lessons: [
        { id: createId('lesson'), title: 'Главные идеи' },
        { id: createId('lesson'), title: 'Что важно запомнить' },
      ],
    },
    {
      id: createId('module'),
      title: 'Применение в задачах',
      lessons: [
        { id: createId('lesson'), title: 'Шаги в работе' },
        { id: createId('lesson'), title: 'Разбор примера' },
      ],
    },
    {
      id: createId('module'),
      title: 'Закрепление',
      lessons: [
        { id: createId('lesson'), title: 'Проверка понимания' },
        { id: createId('lesson'), title: 'План повторения' },
      ],
    },
  ]
}

const countLessonsFromCourse = (course: CourseResponse | null): number => {
  if (!course || !course.structure || !Array.isArray(course.structure.modules)) {
    return 0
  }

  let total = 0

  for (const module of course.structure.modules) {
    if (Array.isArray(module.lessons)) {
      total += module.lessons.length
    }
  }

  return total
}

const upsertLibraryItem = (
  existing: CourseLibraryItem[],
  incoming: CourseLibraryItem,
): CourseLibraryItem[] => {
  const index = existing.findIndex((item) => item.id === incoming.id)

  if (index < 0) {
    return [incoming, ...existing]
  }

  const next = [...existing]
  next[index] = incoming

  return next.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
}

const getCourseModules = (course: CourseResponse | null): CourseModule[] => {
  if (!course || !course.structure || !Array.isArray(course.structure.modules)) {
    return []
  }

  return course.structure.modules
}

const getModuleTitle = (module: CourseModule, index: number): string => {
  if (typeof module.title === 'string' && module.title.trim()) {
    return module.title.trim()
  }

  return `Модуль ${index + 1}`
}

const getLessonTitle = (lesson: Record<string, unknown>, index: number): string => {
  if (typeof lesson.title === 'string' && lesson.title.trim()) {
    return lesson.title.trim()
  }

  return `Урок ${index + 1}`
}

const toLessonId = (moduleIndex: number, lessonIndex: number): string =>
  `m${moduleIndex + 1}-l${lessonIndex + 1}`

const flattenLessons = (course: CourseResponse | null): LessonNode[] => {
  const modules = getCourseModules(course)
  const lessons: LessonNode[] = []

  modules.forEach((module, moduleIndex) => {
    const moduleTitle = getModuleTitle(module, moduleIndex)
    const moduleLessons = Array.isArray(module.lessons) ? module.lessons : []

    moduleLessons.forEach((lesson, lessonIndex) => {
      const lessonRecord = lesson as Record<string, unknown>

      lessons.push({
        id: toLessonId(moduleIndex, lessonIndex),
        moduleIndex,
        lessonIndex,
        moduleTitle,
        title: getLessonTitle(lessonRecord, lessonIndex),
        objective:
          typeof lessonRecord.objective === 'string' ? lessonRecord.objective : undefined,
        details:
          typeof lessonRecord.description === 'string'
            ? lessonRecord.description
            : typeof module.description === 'string'
              ? module.description
              : undefined,
      })
    })
  })

  return lessons
}

const resolveNextLesson = (
  lessons: LessonNode[],
  progress: CourseProgress | undefined,
): LessonNode | null => {
  if (lessons.length === 0) {
    return null
  }

  const completed = new Set(progress?.completedLessonIds ?? [])
  const next = lessons.find((lesson) => !completed.has(lesson.id))

  if (next) {
    return next
  }

  return lessons[lessons.length - 1]
}

const toneByStatus = (
  status: CourseStatusFilter | WizardMaterialStatus,
): 'neutral' | 'success' | 'warning' | 'error' => {
  if (status === 'завершен' || status === 'готово') {
    return 'success'
  }

  if (status === 'в процессе' || status === 'в работе') {
    return 'warning'
  }

  if (status === 'нужна проверка') {
    return 'error'
  }

  return 'neutral'
}

const courseStatusByProgress = (completed: number, total: number): Exclude<CourseStatusFilter, 'all'> => {
  if (total > 0 && completed >= total) {
    return 'завершен'
  }

  if (completed > 0) {
    return 'в процессе'
  }

  return 'черновик'
}

const humanDate = (value: string): string => {
  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    return value
  }

  return date.toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })
}

const buildPracticeQuestions = (lesson: LessonNode | null): PracticeQuestion[] => {
  const lessonTitle = lesson?.title ?? 'теме'
  const moduleTitle = lesson?.moduleTitle ?? 'модулю'

  return [
    {
      id: createId('q'),
      type: 'choice',
      question: `С чего лучше начать изучение раздела «${lessonTitle}»?`,
      options: ['С главной идеи и цели', 'Случайно с любого места', 'Только с примеров'],
      answer: 'С главной идеи и цели',
      reason: 'Так легче увидеть общий путь и не потерять фокус.',
    },
    {
      id: createId('q'),
      type: 'short',
      question: `Какая ключевая цель у блока «${moduleTitle}»?`,
      answer: 'цель',
      reason: 'Достаточно назвать цель блока своими словами.',
    },
    {
      id: createId('q'),
      type: 'choice',
      question: 'Что помогает закрепить материал быстрее?',
      options: ['Небольшие повторы по ходу', 'Пропускать сложные моменты', 'Читать только заголовки'],
      answer: 'Небольшие повторы по ходу',
      reason: 'Короткие повторы лучше удерживают внимание и память.',
    },
    {
      id: createId('q'),
      type: 'choice',
      question: 'Какой формат шага самый удобный для ежедневного темпа?',
      options: ['15–30 минут', '4 часа без перерыва', 'Один раз в месяц'],
      answer: '15–30 минут',
      reason: 'Короткие сессии проще встроить в расписание.',
    },
    {
      id: createId('q'),
      type: 'short',
      question: 'Напишите одно действие, которое сделаете после этого урока.',
      answer: 'действие',
      reason: 'Даже короткий план действия помогает перейти к практике.',
    },
  ]
}

const classNames = (...tokens: Array<string | false | null | undefined>): string =>
  tokens.filter(Boolean).join(' ')

const PetalBackground = ({ disabled = false, dense = false }: { disabled?: boolean; dense?: boolean }) => {
  if (disabled) {
    return null
  }

  return (
    <div className={classNames('petal-background', dense && 'is-dense')} aria-hidden>
      <span className="petal-shape petal-a" />
      <span className="petal-shape petal-b" />
      <span className="petal-shape petal-c" />
      <span className="petal-shape petal-d" />
      <span className="petal-shape petal-e" />
    </div>
  )
}

const GlassPanel = ({ className, children }: PanelProps) => (
  <section className={classNames('glass-panel', className)}>{children}</section>
)

const GlassCard = ({ className, children }: PanelProps) => (
  <article className={classNames('glass-card', className)}>{children}</article>
)

const LiquidButton = ({
  variant = 'primary',
  compact = false,
  className,
  children,
  ...props
}: LiquidButtonProps) => (
  <button
    className={classNames('liquid-button', `is-${variant}`, compact && 'is-compact', className)}
    {...props}
  >
    {children}
  </button>
)

const ThemeLatchButton = ({ theme, onToggle }: { theme: ThemeMode; onToggle: () => void }) => {
  const isLight = theme === 'light'
  const nextLabel = isLight ? 'Включить темную тему' : 'Включить светлую тему'

  return (
    <button
      className={classNames('theme-latch', isLight && 'is-light')}
      type="button"
      onClick={onToggle}
      aria-label={nextLabel}
      title={nextLabel}
    >
      <span className="theme-latch-track">
        <span className={classNames('theme-latch-thumb', isLight && 'is-light')}>
          <svg viewBox="0 0 24 24" aria-hidden>
            <rect x="6.5" y="10" width="11" height="8" rx="2.2" />
            {isLight ? (
              <path d="M9.2 10V7.8a3.3 3.3 0 0 1 5.4-2.6" />
            ) : (
              <path d="M8.8 10V7.7a3.2 3.2 0 1 1 6.4 0V10" />
            )}
            <circle cx="12" cy="14" r="1.1" />
          </svg>
        </span>
      </span>
    </button>
  )
}

const BloomBadge = ({ label, tone = 'neutral' }: BadgeProps) => (
  <span className={classNames('bloom-badge', `is-${tone}`)}>{label}</span>
)

const BloomProgress = ({ value, label, hint }: BloomProgressProps) => {
  const normalized = Math.max(0, Math.min(100, Math.round(value)))
  const radius = 42
  const circumference = 2 * Math.PI * radius
  const offset = circumference - (normalized / 100) * circumference

  return (
    <div className="bloom-progress">
      <svg viewBox="0 0 120 120" className="bloom-progress-ring" aria-hidden>
        <circle cx="60" cy="60" r={radius} className="bloom-progress-track" />
        <circle
          cx="60"
          cy="60"
          r={radius}
          className="bloom-progress-value"
          style={{ strokeDasharray: circumference, strokeDashoffset: offset }}
        />
      </svg>
      <div className="bloom-progress-content">
        <p className="progress-value">{normalized}%</p>
        <p className="progress-label">{label}</p>
        {hint ? <p className="progress-hint">{hint}</p> : null}
      </div>
    </div>
  )
}

const InputGlass = ({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) => (
  <input className={classNames('input-glass', className)} {...props} />
)

const SelectGlass = ({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) => (
  <select className={classNames('select-glass', className)} {...props}>
    {children}
  </select>
)

const TextareaGlass = ({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) => (
  <textarea className={classNames('textarea-glass', className)} {...props} />
)

const StepperGlass = ({ steps, current }: StepperProps) => (
  <div className="stepper-glass" aria-label="Шаги">
    {steps.map((step, index) => {
      const stepNumber = index + 1
      const status = stepNumber < current ? 'done' : stepNumber === current ? 'current' : 'next'

      return (
        <div key={step} className={classNames('stepper-item', `is-${status}`)}>
          <span className="stepper-dot">{stepNumber}</span>
          <span className="stepper-label">{step}</span>
        </div>
      )
    })}
  </div>
)

const LoadingState = ({ title = 'Загрузка', text = 'Подождите немного...' }: { title?: string; text?: string }) => (
  <GlassPanel className="state-panel loading-state">
    <div className="shimmer-line" />
    <h3>{title}</h3>
    <p>{text}</p>
  </GlassPanel>
)

const EmptyState = ({ title, text, cta, onCta }: { title: string; text: string; cta: string; onCta: () => void }) => (
  <GlassPanel className="state-panel empty-state">
    <div className="petal-icon" aria-hidden>
      ✿
    </div>
    <h3>{title}</h3>
    <p>{text}</p>
    <LiquidButton variant="secondary" type="button" onClick={onCta}>
      {cta}
    </LiquidButton>
  </GlassPanel>
)

const ErrorState = ({ text, onRetry }: { text: string; onRetry: () => void }) => (
  <GlassPanel className="state-panel error-state">
    <h3>Нужно повторить действие</h3>
    <p>{text}</p>
    <LiquidButton variant="secondary" type="button" onClick={onRetry}>
      Попробовать снова
    </LiquidButton>
  </GlassPanel>
)

const AuthForm = ({
  mode,
  busy,
  message,
  errorMessage,
  onSubmit,
  onModeChange,
}: AuthFormProps) => {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setLocalError(null)

    const normalized = email.trim()

    if (!normalized || !EMAIL_PATTERN.test(normalized)) {
      setLocalError('Введите корректный email, например hello@example.com.')
      return
    }

    if (password.length < 8) {
      setLocalError('Пароль должен содержать минимум 8 символов.')
      return
    }

    if (mode === 'signup' && confirm !== password) {
      setLocalError('Пароли не совпадают.')
      return
    }

    await onSubmit(normalized, password, mode)
  }

  return (
    <GlassPanel className="auth-panel">
      <div className="auth-switch" role="tablist" aria-label="Режим входа">
        <button
          type="button"
          className={classNames('auth-pill', mode === 'login' && 'is-active')}
          onClick={() => {
            setLocalError(null)
            onModeChange('login')
          }}
        >
          Вход
        </button>
        <button
          type="button"
          className={classNames('auth-pill', mode === 'signup' && 'is-active')}
          onClick={() => {
            setLocalError(null)
            onModeChange('signup')
          }}
        >
          Регистрация
        </button>
      </div>

      <form className="flow-form" onSubmit={handleSubmit}>
        <label className="field-stack">
          <span>Email</span>
          <InputGlass type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
        </label>

        <label className="field-stack">
          <span>Пароль</span>
          <InputGlass
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            minLength={8}
          />
        </label>

        {mode === 'signup' ? (
          <label className="field-stack">
            <span>Повторите пароль</span>
            <InputGlass
              type="password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              minLength={8}
            />
          </label>
        ) : null}

        {localError ? <p className="message message-error">{localError}</p> : null}
        {errorMessage ? <p className="message message-error">{errorMessage}</p> : null}
        {message ? <p className="message message-success">{message}</p> : null}

        <LiquidButton variant="primary" type="submit" disabled={busy}>
          {busy ? 'Проверяем...' : mode === 'login' ? 'Войти' : 'Создать аккаунт'}
        </LiquidButton>
      </form>
    </GlassPanel>
  )
}

const PracticeSession = ({ questions, onFinish }: PracticeSessionProps) => {
  const [index, setIndex] = useState(0)
  const [choice, setChoice] = useState('')
  const [textAnswer, setTextAnswer] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [correctCount, setCorrectCount] = useState(0)

  const current = questions[index]

  const evaluateCurrentAnswer = useMemo(() => {
    if (!current) {
      return false
    }

    if (current.type === 'choice') {
      return choice === current.answer
    }

    const normalized = textAnswer.trim().toLowerCase()

    if (!normalized) {
      return false
    }

    if (current.answer === 'цель') {
      return normalized.includes('цель') || normalized.includes('результат')
    }

    if (current.answer === 'действие') {
      return normalized.length >= 4
    }

    return normalized.includes(current.answer.toLowerCase())
  }, [choice, current, textAnswer])

  const isCorrect = submitted && evaluateCurrentAnswer

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (!current || submitted) {
      return
    }

    if (current.type === 'choice' && !choice) {
      return
    }

    if (current.type === 'short' && !textAnswer.trim()) {
      return
    }

    if (evaluateCurrentAnswer) {
      setCorrectCount((prev) => prev + 1)
    }

    setSubmitted(true)
  }

  const handleNext = () => {
    const next = index + 1

    if (next >= questions.length) {
      onFinish(correctCount)
      return
    }

    setIndex(next)
    setSubmitted(false)
    setChoice('')
    setTextAnswer('')
  }

  if (!current) {
    return null
  }

  const progress = Math.round(((index + (submitted ? 1 : 0)) / questions.length) * 100)

  return (
    <GlassPanel className="practice-session">
      <div className="practice-head">
        <BloomBadge label={`Вопрос ${index + 1} из ${questions.length}`} tone="neutral" />
        <div className="practice-track">
          <div className="practice-track-value" style={{ width: `${progress}%` }} />
        </div>
      </div>

      <form className="flow-form" onSubmit={handleSubmit}>
        <h3>{current.question}</h3>

        {current.type === 'choice' ? (
          <div className="option-list">
            {(current.options ?? []).map((option) => (
              <label className="option-item" key={option}>
                <input
                  type="radio"
                  name={`question-${current.id}`}
                  checked={choice === option}
                  onChange={() => setChoice(option)}
                />
                <span>{option}</span>
              </label>
            ))}
          </div>
        ) : (
          <label className="field-stack">
            <span>Ваш ответ</span>
            <TextareaGlass
              rows={4}
              value={textAnswer}
              onChange={(event) => setTextAnswer(event.target.value)}
              placeholder="Напишите коротко и по делу"
            />
          </label>
        )}

        {submitted ? (
          <p className={classNames('message', isCorrect ? 'message-success' : 'message-warning')}>
            {isCorrect ? 'Верно.' : 'Есть неточность.'} {current.reason}
          </p>
        ) : null}

        {!submitted ? (
          <LiquidButton variant="primary" type="submit">
            Ответить
          </LiquidButton>
        ) : (
          <LiquidButton variant="secondary" type="button" onClick={handleNext}>
            {index + 1 >= questions.length ? 'Завершить' : 'Следующий вопрос'}
          </LiquidButton>
        )}
      </form>
    </GlassPanel>
  )
}

function App() {
  const gatewayBaseUrl = useMemo(() => {
    const desktopConfigValue = window.desktopConfig?.gatewayUrl
    return resolveGatewayBaseUrl(desktopConfigValue || import.meta.env.VITE_GATEWAY_URL)
  }, [])

  const [route, setRoute] = useState<Route>(() => resolveRoute(window.location.pathname))
  const [theme, setTheme] = useState<ThemeMode>(() => {
    const storedTheme = window.localStorage.getItem(THEME_STORAGE_KEY)

    if (storedTheme === 'light' || storedTheme === 'dark') {
      return storedTheme
    }

    return 'dark'
  })

  const [token, setToken] = useState<string | null>(null)
  const [profile, setProfile] = useState<TokenProfile>({ email: null, role: 'user' })
  const [bootstrapping, setBootstrapping] = useState(true)

  const [sources, setSources] = useState<SourceResponse[]>([])
  const [wizard, setWizard] = useState<WizardState>(() => createInitialWizardState())
  const [library, setLibrary] = useState<CourseLibraryItem[]>(() =>
    safeJsonParse<CourseLibraryItem[]>(window.localStorage.getItem(LIBRARY_STORAGE_KEY), []),
  )
  const [progressMap, setProgressMap] = useState<Record<string, CourseProgress>>(() =>
    safeJsonParse<Record<string, CourseProgress>>(
      window.localStorage.getItem(PROGRESS_STORAGE_KEY),
      {},
    ),
  )
  const [coursesById, setCoursesById] = useState<Record<string, CourseResponse>>({})

  const [isUploading, setIsUploading] = useState(false)
  const [isCreatingCourse, setIsCreatingCourse] = useState(false)
  const [loadingCourseId, setLoadingCourseId] = useState<string | null>(null)

  const [authBusy, setAuthBusy] = useState(false)
  const [authError, setAuthError] = useState<string | null>(null)
  const [authMessage, setAuthMessage] = useState<string | null>(null)

  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [librarySearch, setLibrarySearch] = useState('')
  const [libraryFilter, setLibraryFilter] = useState<CourseStatusFilter>('all')

  const api = useMemo(() => new GatewayClient(gatewayBaseUrl, () => token), [gatewayBaseUrl, token])

  const navigate = useCallback((path: string, replace = false) => {
    if (window.location.pathname !== path) {
      if (replace) {
        window.history.replaceState({}, '', path)
      } else {
        window.history.pushState({}, '', path)
      }
    }

    setRoute(resolveRoute(path))
  }, [])

  const toggleTheme = useCallback(() => {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'))
  }, [])

  const rememberCourse = useCallback((course: CourseResponse) => {
    const totalLessons = countLessonsFromCourse(course)

    setCoursesById((existing) => ({ ...existing, [course.id]: course }))
    setLibrary((existing) =>
      upsertLibraryItem(existing, {
        id: course.id,
        title: course.title,
        topic: course.goal,
        updatedAt: new Date().toISOString(),
        totalLessons,
      }),
    )
  }, [])

  const syncWizardStatusBySource = useCallback((source: SourceResponse) => {
    const nextStatus = SOURCE_STATUS_TO_MATERIAL[source.status]

    setWizard((existing) => ({
      ...existing,
      materials: existing.materials.map((material) =>
        material.sourceId === source.id
          ? {
              ...material,
              status: nextStatus,
            }
          : material,
      ),
    }))
  }, [])

  const pollSourceUntilDone = useCallback(
    async (sourceId: string) => {
      let shouldContinue = true

      while (shouldContinue) {
        try {
          const current = await api.getSource(sourceId)
          setSources((existing) => upsertSource(existing, current))
          syncWizardStatusBySource(current)

          if (TERMINAL_STATUSES.has(current.status)) {
            shouldContinue = false

            if (current.status === 'indexed') {
              setNotice(`Материал «${current.name}» готов.`)
            } else {
              setError(`Материал «${current.name}» требует повторной загрузки.`)
            }

            break
          }
        } catch (pollError) {
          setError(toErrorMessage(pollError))
          shouldContinue = false
          break
        }

        await sleep(POLL_INTERVAL_MS)
      }
    },
    [api, syncWizardStatusBySource],
  )

  const refreshSource = useCallback(
    async (sourceId: string) => {
      try {
        const source = await api.getSource(sourceId)
        setSources((existing) => upsertSource(existing, source))
        syncWizardStatusBySource(source)

        if (!TERMINAL_STATUSES.has(source.status)) {
          void pollSourceUntilDone(source.id)
        }
      } catch (refreshError) {
        setError(toErrorMessage(refreshError))
      }
    },
    [api, pollSourceUntilDone, syncWizardStatusBySource],
  )

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    window.localStorage.setItem(THEME_STORAGE_KEY, theme)
  }, [theme])

  useEffect(() => {
    window.localStorage.setItem(LIBRARY_STORAGE_KEY, JSON.stringify(library))
  }, [library])

  useEffect(() => {
    window.localStorage.setItem(PROGRESS_STORAGE_KEY, JSON.stringify(progressMap))
  }, [progressMap])

  useEffect(() => {
    const handlePopState = () => {
      setRoute(resolveRoute(window.location.pathname))
    }

    window.addEventListener('popstate', handlePopState)

    return () => {
      window.removeEventListener('popstate', handlePopState)
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    const bootstrap = async () => {
      try {
        const storedToken = await readStoredToken()

        if (cancelled) {
          return
        }

        setToken(storedToken)
        setProfile(resolveProfileFromToken(storedToken))
      } catch (bootstrapError) {
        if (!cancelled) {
          setError(toErrorMessage(bootstrapError))
        }
      } finally {
        if (!cancelled) {
          setBootstrapping(false)
        }
      }
    }

    void bootstrap()

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!notice) {
      return
    }

    const timer = window.setTimeout(() => {
      setNotice(null)
    }, 3800)

    return () => {
      window.clearTimeout(timer)
    }
  }, [notice])

  useEffect(() => {
    if (!error) {
      return
    }

    const timer = window.setTimeout(() => {
      setError(null)
    }, 5200)

    return () => {
      window.clearTimeout(timer)
    }
  }, [error])

  useEffect(() => {
    if (bootstrapping) {
      return
    }

    if (route.kind === 'notFound') {
      navigate('/', true)
      return
    }

    if (!token && isProtectedRoute(route)) {
      setNotice('Сначала войдите в аккаунт, чтобы продолжить.')
      navigate('/login', true)
      return
    }

    if (token && (route.kind === 'login' || route.kind === 'signup')) {
      navigate('/app', true)
      return
    }

    if (route.kind === 'admin' && profile.role !== 'admin') {
      setError('Раздел Admin доступен только по роли.')
      navigate('/app', true)
    }
  }, [bootstrapping, navigate, profile.role, route, token])

  const activeCourseId =
    route.kind === 'course' || route.kind === 'lesson' || route.kind === 'practice'
      ? route.courseId
      : null

  useEffect(() => {
    if (!token || !activeCourseId) {
      return
    }

    if (coursesById[activeCourseId]) {
      return
    }

    let cancelled = false

    const fetchCourse = async () => {
      setLoadingCourseId(activeCourseId)

      try {
        const course = await api.getCourse(activeCourseId)

        if (!cancelled) {
          rememberCourse(course)
        }
      } catch (courseError) {
        if (!cancelled) {
          setError(toErrorMessage(courseError))
        }
      } finally {
        if (!cancelled) {
          setLoadingCourseId(null)
        }
      }
    }

    void fetchCourse()

    return () => {
      cancelled = true
    }
  }, [activeCourseId, api, coursesById, rememberCourse, token])

  useEffect(() => {
    if (route.kind !== 'lesson') {
      return
    }

    const { courseId, lessonId } = route

    setProgressMap((existing) => {
      const current = existing[courseId] ?? {
        completedLessonIds: [],
        dewStreak: 0,
        lastOpenedLessonId: null,
      }

      return {
        ...existing,
        [courseId]: {
          ...current,
          lastOpenedLessonId: lessonId,
        },
      }
    })
  }, [route])

  const handleLogout = useCallback(async () => {
    await clearStoredToken()
    setToken(null)
    setProfile({ email: null, role: 'user' })
    setSources([])
    setWizard(createInitialWizardState())
    setNotice('Вы вышли из аккаунта.')
    navigate('/', true)
  }, [navigate])

  const handleAuthSubmit = useCallback(
    async (email: string, password: string, mode: AuthMode) => {
      setAuthBusy(true)
      setAuthError(null)
      setAuthMessage(null)

      try {
        if (mode === 'signup') {
          await api.register({ email, password })
          setAuthMessage('Аккаунт создан. Выполняем вход...')
        }

        const login = await api.login({ email, password })
        await writeStoredToken(login.access_token)
        setToken(login.access_token)
        setProfile(resolveProfileFromToken(login.access_token))
        setAuthMessage(null)
        setNotice(mode === 'signup' ? 'Добро пожаловать в Flowa.' : 'Вы успешно вошли.')

        navigate(mode === 'signup' ? '/app/new' : '/app', true)
      } catch (submitError) {
        setAuthError(toErrorMessage(submitError))
      } finally {
        setAuthBusy(false)
      }
    },
    [api, navigate],
  )

  const handleFileUpload = useCallback(
    async (file: File) => {
      setError(null)
      setIsUploading(true)

      try {
        const uploaded = await api.uploadSource(file, 'document')

        const optimisticSource: SourceResponse = {
          id: uploaded.source_id,
          type: 'document',
          name: file.name,
          status: uploaded.status,
          job: {
            id: uploaded.job_id,
            status: uploaded.status,
            error: null,
          },
        }

        setSources((existing) => upsertSource(existing, optimisticSource))
        setWizard((existing) => ({
          ...existing,
          selectedSourceId: uploaded.source_id,
          materials: [
            {
              id: createId('material'),
              kind: 'file',
              name: file.name,
              detail: 'Файл',
              status: SOURCE_STATUS_TO_MATERIAL[uploaded.status],
              sourceId: uploaded.source_id,
            },
            ...existing.materials,
          ],
        }))

        setNotice('Материал добавлен. Проверяем готовность.')
        void pollSourceUntilDone(uploaded.source_id)
      } catch (uploadError) {
        setError(toErrorMessage(uploadError))
      } finally {
        setIsUploading(false)
      }
    },
    [api, pollSourceUntilDone],
  )

  const handleAddLinkMaterial = useCallback((urlValue: string) => {
    setWizard((existing) => ({
      ...existing,
      materials: [
        {
          id: createId('material'),
          kind: 'link',
          name: urlValue,
          detail: 'Ссылка',
          status: 'готово',
        },
        ...existing.materials,
      ],
    }))
    setNotice('Ссылка добавлена в материалы.')
  }, [])

  const handleAddTextMaterial = useCallback((textValue: string) => {
    const cleanText = textValue.trim().slice(0, 68)

    setWizard((existing) => ({
      ...existing,
      materials: [
        {
          id: createId('material'),
          kind: 'text',
          name: cleanText.length > 0 ? `${cleanText}${textValue.length > 68 ? '...' : ''}` : 'Текст',
          detail: 'Текст',
          status: 'готово',
        },
        ...existing.materials,
      ],
    }))
    setNotice('Текст добавлен в материалы.')
  }, [])

  const handleBuildPlan = useCallback(() => {
    setError(null)

    const hasReadySource = sources.some((source) => sourceReady(source.status))

    if (!hasReadySource) {
      setError('Для сборки курса нужен хотя бы один файл со статусом «готово».')
      return
    }

    if (!wizard.goal.trim()) {
      setError('Опишите цель обучения, чтобы собрать план.')
      return
    }

    if (!wizard.courseTitle.trim()) {
      setError('Добавьте название курса.')
      return
    }

    setWizard((existing) => ({
      ...existing,
      step: 3,
      modules: existing.modules.length > 0 ? existing.modules : buildInitialPlan(existing.courseTitle, existing.goal),
      selectedSourceId:
        existing.selectedSourceId ||
        sources.find((source) => sourceReady(source.status))?.id ||
        existing.selectedSourceId,
    }))
  }, [sources, wizard.courseTitle, wizard.goal])

  const handleCreateCourse = useCallback(async () => {
    setError(null)

    if (!wizard.selectedSourceId) {
      setError('Выберите готовый файл перед созданием курса.')
      return
    }

    const payload: CreateCourseRequest = {
      source_id: wizard.selectedSourceId,
      title: wizard.courseTitle.trim(),
      goal: wizard.goal.trim(),
      level: LEVEL_TO_API[wizard.level],
    }

    setIsCreatingCourse(true)

    try {
      const created = await api.createCourse(payload)

      let resolvedCourse: CourseResponse

      try {
        resolvedCourse = await api.getCourse(created.course_id)
      } catch {
        resolvedCourse = {
          id: created.course_id,
          title: wizard.courseTitle.trim(),
          goal: wizard.goal.trim(),
          level: LEVEL_TO_API[wizard.level],
          structure: {
            title: wizard.courseTitle.trim(),
            modules:
              created.structure.modules && created.structure.modules.length > 0
                ? created.structure.modules
                : wizard.modules.map((module) => ({
                    title: module.title,
                    lessons: module.lessons.map((lesson) => ({ title: lesson.title })),
                  })),
          },
        }
      }

      rememberCourse(resolvedCourse)

      setWizard((existing) => ({
        ...existing,
        step: 4,
        createdCourseId: created.course_id,
      }))
      setNotice('Курс готов.')
    } catch (createError) {
      setError(toErrorMessage(createError))
    } finally {
      setIsCreatingCourse(false)
    }
  }, [api, rememberCourse, wizard])

  const handleMarkLessonDone = useCallback((courseId: string, lessonId: string) => {
    setProgressMap((existing) => {
      const current = existing[courseId] ?? {
        completedLessonIds: [],
        dewStreak: 0,
        lastOpenedLessonId: null,
      }

      const nextCompleted = current.completedLessonIds.includes(lessonId)
        ? current.completedLessonIds
        : [...current.completedLessonIds, lessonId]

      return {
        ...existing,
        [courseId]: {
          ...current,
          completedLessonIds: nextCompleted,
          lastOpenedLessonId: lessonId,
        },
      }
    })
  }, [])

  const handlePracticeComplete = useCallback((courseId: string, correctCount: number, total: number) => {
    setProgressMap((existing) => {
      const current = existing[courseId] ?? {
        completedLessonIds: [],
        dewStreak: 0,
        lastOpenedLessonId: null,
      }

      const ratio = total > 0 ? correctCount / total : 0
      const nextStreak = ratio >= 0.8 ? current.dewStreak + 1 : 0

      return {
        ...existing,
        [courseId]: {
          ...current,
          dewStreak: nextStreak,
        },
      }
    })

    setNotice('Отлично. Дальше — следующий шаг курса.')
  }, [])

  const shareCourse = useCallback(async (courseId: string) => {
    const link = `${window.location.origin}/app/course/${courseId}`

    try {
      await navigator.clipboard.writeText(link)
      setNotice('Ссылка скопирована.')
    } catch {
      setNotice(`Ссылка: ${link}`)
    }
  }, [])

  const resetWizard = useCallback(() => {
    setWizard(createInitialWizardState())
  }, [])

  const currentCourse = activeCourseId ? coursesById[activeCourseId] ?? null : null
  const lessonList = useMemo(() => flattenLessons(currentCourse), [currentCourse])

  const currentProgress =
    activeCourseId && progressMap[activeCourseId]
      ? progressMap[activeCourseId]
      : {
          completedLessonIds: [],
          dewStreak: 0,
          lastOpenedLessonId: null,
        }

  const nextLesson = useMemo(
    () => resolveNextLesson(lessonList, activeCourseId ? progressMap[activeCourseId] : undefined),
    [activeCourseId, lessonList, progressMap],
  )

  const selectedLesson =
    route.kind === 'lesson'
      ? lessonList.find((lesson) => lesson.id === route.lessonId) ?? null
      : null

  const filteredLibrary = useMemo(() => {
    const normalized = librarySearch.trim().toLowerCase()

    return library.filter((item) => {
      const completed = progressMap[item.id]?.completedLessonIds.length ?? 0
      const status = courseStatusByProgress(completed, item.totalLessons)

      if (libraryFilter !== 'all' && status !== libraryFilter) {
        return false
      }

      if (!normalized) {
        return true
      }

      return (
        item.title.toLowerCase().includes(normalized) ||
        item.topic.toLowerCase().includes(normalized) ||
        item.id.toLowerCase().includes(normalized)
      )
    })
  }, [library, libraryFilter, librarySearch, progressMap])

  if (bootstrapping) {
    return (
      <div className="page-shell centered-shell">
        <PetalBackground dense />
        <LoadingState title="Flowa готовится" text="Проверяем сессию и открываем рабочее пространство..." />
      </div>
    )
  }

  const isAdminRoute = route.kind === 'admin'

  const renderMarketingLanding = () => (
    <div className="page-stack">
      <GlassPanel className="hero-panel">
        <div className="hero-copy">
          <p className="eyebrow">Flowa</p>
          <h1>Соберите курс из своих материалов.</h1>
          <p className="hero-subtitle">
            Документы, ссылки, заметки — Flowa превращает их в понятный путь обучения.
          </p>
          <p className="hero-one-liner">
            Flowa превращает ваши документы и ссылки в понятный курс с уроками, практикой и прогрессом.
          </p>
          <div className="hero-actions">
            <LiquidButton
              variant="primary"
              type="button"
              onClick={() => navigate(token ? '/app/new' : '/signup')}
            >
              Создать курс
            </LiquidButton>
            <LiquidButton variant="secondary" type="button" onClick={() => navigate('/examples')}>
              Посмотреть пример
            </LiquidButton>
          </div>
        </div>

        <GlassCard className="hero-preview">
          <div className="preview-grid">
            <div>
              <p className="preview-title">Модули</p>
              <ul className="preview-list">
                <li>1. Вход в тему</li>
                <li>2. Практика на шагах</li>
                <li>3. Закрепление</li>
              </ul>
            </div>
            <div>
              <p className="preview-title">Урок</p>
              <p className="preview-lesson">Главное за 20 минут</p>
              <p className="preview-note">Понятные акценты и короткий пример.</p>
            </div>
          </div>
          <GlassCard className="mini-practice">Проверим понимание: 5 вопросов</GlassCard>
        </GlassCard>
      </GlassPanel>

      <GlassPanel className="section-panel">
        <h2>Как это работает</h2>
        <div className="grid-three">
          {LANDING_STEPS.map((step) => (
            <GlassCard key={step} className="feature-card">
              <p>{step}</p>
            </GlassCard>
          ))}
        </div>
      </GlassPanel>

      <GlassPanel className="section-panel">
        <h2>Что вы получите</h2>
        <div className="grid-three">
          {VALUE_CARDS.map((card) => (
            <GlassCard key={card} className="feature-card">
              <p>{card}</p>
            </GlassCard>
          ))}
        </div>
      </GlassPanel>

      <GlassPanel className="section-panel">
        <h2>Для кого</h2>
        <div className="grid-two">
          {FOR_WHO.map((item) => (
            <GlassCard key={item} className="feature-card">
              <p>{item}</p>
            </GlassCard>
          ))}
        </div>
      </GlassPanel>

      <GlassPanel className="section-panel">
        <h2>Примеры</h2>
        <div className="grid-three">
          {EXAMPLE_COURSES.map((item) => (
            <GlassCard key={item} className="feature-card">
              <p>{item}</p>
            </GlassCard>
          ))}
        </div>
      </GlassPanel>

      <GlassPanel className="section-panel">
        <h2>Тарифы</h2>
        <div className="pricing-grid">
          <GlassCard className="pricing-card">
            <h3>Free</h3>
            <p>До 2 курсов в месяц, базовый объем материалов.</p>
            <p>Для личного старта.</p>
          </GlassCard>
          <GlassCard className="pricing-card is-highlighted">
            <h3>Pro</h3>
            <p>Больше курсов, больше материалов, экспорт и шаринг.</p>
            <p>Для регулярного обучения.</p>
          </GlassCard>
          <GlassCard className="pricing-card">
            <h3>Team</h3>
            <p>Совместная работа, роли, общий доступ к курсам.</p>
            <p>Для команд и учебных групп.</p>
          </GlassCard>
        </div>
      </GlassPanel>

      <GlassPanel className="section-panel">
        <h2>FAQ</h2>
        <div className="grid-two">
          <GlassCard className="feature-card">
            <h3>Можно ли начать с одного файла?</h3>
            <p>Да, этого достаточно для старта.</p>
          </GlassCard>
          <GlassCard className="feature-card">
            <h3>Можно ли изменить план?</h3>
            <p>Да, шаги и уроки можно редактировать.</p>
          </GlassCard>
          <GlassCard className="feature-card">
            <h3>Можно ли обновить курс, если материалы изменились?</h3>
            <p>Да, добавьте новые материалы и обновите курс.</p>
          </GlassCard>
          <GlassCard className="feature-card">
            <h3>Подходит ли для команды?</h3>
            <p>Да, для этого есть Team-подход и отдельный Admin.</p>
          </GlassCard>
        </div>
        <div className="final-cta">
          <h3>Соберите курс. Учитесь по шагам.</h3>
          <LiquidButton
            variant="primary"
            type="button"
            onClick={() => navigate(token ? '/app/new' : '/signup')}
          >
            Создать курс
          </LiquidButton>
        </div>
      </GlassPanel>
    </div>
  )

  const renderExamples = () => (
    <div className="page-stack">
      <GlassPanel className="section-panel">
        <h1>Примеры курсов</h1>
        <p className="muted-text">Готовые форматы, которые легко адаптировать под вашу тему.</p>
      </GlassPanel>
      <div className="grid-three">
        {EXAMPLE_COURSES.map((item) => (
          <GlassCard className="feature-card" key={item}>
            <h3>{item}</h3>
            <p>Короткие уроки, практика и видимый прогресс.</p>
          </GlassCard>
        ))}
      </div>
      <GlassPanel className="section-panel">
        <LiquidButton
          variant="primary"
          type="button"
          onClick={() => navigate(token ? '/app/new' : '/signup')}
        >
          Создать свой курс
        </LiquidButton>
      </GlassPanel>
    </div>
  )

  const renderPricing = () => (
    <div className="page-stack">
      <GlassPanel className="section-panel">
        <h1>Тарифы Flowa</h1>
        <p className="muted-text">Выберите темп и объем, которые подходят вашему формату обучения.</p>
      </GlassPanel>
      <div className="pricing-grid">
        <GlassCard className="pricing-card">
          <h3>Free</h3>
          <ul className="plain-list">
            <li>2 курса в месяц</li>
            <li>Стартовый объем материалов</li>
            <li>Базовый прогресс</li>
          </ul>
        </GlassCard>
        <GlassCard className="pricing-card is-highlighted">
          <h3>Pro</h3>
          <ul className="plain-list">
            <li>До 20 курсов в месяц</li>
            <li>Расширенный объем материалов</li>
            <li>Экспорт и шаринг</li>
          </ul>
        </GlassCard>
        <GlassCard className="pricing-card">
          <h3>Team</h3>
          <ul className="plain-list">
            <li>Командный доступ</li>
            <li>Совместная работа</li>
            <li>Расширенная отчетность</li>
          </ul>
        </GlassCard>
      </div>
    </div>
  )

  const renderAbout = () => (
    <div className="page-stack">
      <GlassPanel className="section-panel">
        <h1>О Flowa</h1>
        <p>Flowa = Flow + Flower.</p>
        <p className="muted-text">Знания распускаются из ваших материалов.</p>
      </GlassPanel>
      <GlassPanel className="section-panel">
        <h2>Ценности</h2>
        <div className="grid-three">
          <GlassCard className="feature-card">
            <h3>Ясность</h3>
            <p>Каждый шаг понятен с первого экрана.</p>
          </GlassCard>
          <GlassCard className="feature-card">
            <h3>Темп</h3>
            <p>Короткие сессии и плавный рост навыка.</p>
          </GlassCard>
          <GlassCard className="feature-card">
            <h3>Практика</h3>
            <p>Проверка понимания внутри учебного пути.</p>
          </GlassCard>
        </div>
      </GlassPanel>
    </div>
  )

  const renderHelp = () => (
    <div className="page-stack">
      <GlassPanel className="section-panel">
        <h1>Помощь</h1>
        <p className="muted-text">Короткие ответы на частые вопросы.</p>
      </GlassPanel>
      <div className="grid-two">
        <GlassCard className="feature-card">
          <h3>Как быстро начать?</h3>
          <p>Зарегистрируйтесь, добавьте файл и перейдите в мастер курса.</p>
        </GlassCard>
        <GlassCard className="feature-card">
          <h3>Как продолжить с того же места?</h3>
          <p>Войдите в аккаунт и откройте библиотеку курсов.</p>
        </GlassCard>
        <GlassCard className="feature-card">
          <h3>Можно ли менять план после создания?</h3>
          <p>Да, шаги и уроки можно уточнять под задачу.</p>
        </GlassCard>
        <GlassCard className="feature-card">
          <h3>Что делать при ошибке?</h3>
          <p>Нажмите «Попробовать снова» или загрузите материал повторно.</p>
        </GlassCard>
      </div>
    </div>
  )

  const renderAuthPage = (mode: AuthMode) => (
    <div className="auth-layout">
      <GlassPanel className="auth-copy">
        <p className="eyebrow">Flowa Account</p>
        <h1>{mode === 'login' ? 'Войдите в аккаунт' : 'Создайте аккаунт'}</h1>
        <p>
          {mode === 'login'
            ? 'После входа откроется библиотека курсов и ваш текущий прогресс.'
            : 'После регистрации сразу откроется мастер создания курса.'}
        </p>
        <ul className="plain-list">
          <li>Понятный путь без лишних шагов</li>
          <li>Короткие уроки и проверка понимания</li>
          <li>Прогресс, который видно сразу</li>
        </ul>
      </GlassPanel>

      <AuthForm
        mode={mode}
        busy={authBusy}
        message={authMessage}
        errorMessage={authError}
        onSubmit={handleAuthSubmit}
        onModeChange={(nextMode) => navigate(nextMode === 'login' ? '/login' : '/signup', true)}
      />
    </div>
  )

  const renderLibrary = () => (
    <div className="page-stack">
      <GlassPanel className="section-panel app-head">
        <div>
          <p className="eyebrow">/app</p>
          <h1>Библиотека курсов</h1>
          <p className="muted-text">Продолжайте обучение с нужного шага.</p>
        </div>
        <LiquidButton variant="primary" type="button" onClick={() => navigate('/app/new')}>
          Создать курс
        </LiquidButton>
      </GlassPanel>

      <GlassPanel className="section-panel filter-panel">
        <label className="field-stack">
          <span>Поиск</span>
          <InputGlass
            value={librarySearch}
            onChange={(event) => setLibrarySearch(event.target.value)}
            placeholder="Тема, название или ID"
          />
        </label>

        <label className="field-stack">
          <span>Статус</span>
          <SelectGlass
            value={libraryFilter}
            onChange={(event) => setLibraryFilter(event.target.value as CourseStatusFilter)}
          >
            <option value="all">Все</option>
            <option value="черновик">Черновик</option>
            <option value="в процессе">В процессе</option>
            <option value="завершен">Завершен</option>
          </SelectGlass>
        </label>
      </GlassPanel>

      {filteredLibrary.length === 0 ? (
        <EmptyState
          title="Добавьте материалы — и Flowa соберет курс."
          text="В библиотеке пока пусто. Начните с мастера создания курса."
          cta="Создать курс"
          onCta={() => navigate('/app/new')}
        />
      ) : (
        <div className="course-grid">
          {filteredLibrary.map((item) => {
            const completed = progressMap[item.id]?.completedLessonIds.length ?? 0
            const status = courseStatusByProgress(completed, item.totalLessons)

            return (
              <GlassCard key={item.id} className="course-card">
                <div className="course-card-head">
                  <h3>{item.title}</h3>
                  <BloomBadge label={status} tone={toneByStatus(status)} />
                </div>
                <p className="muted-text">{item.topic}</p>
                <p className="muted-text">Обновлен: {humanDate(item.updatedAt)}</p>
                <BloomProgress
                  value={item.totalLessons > 0 ? (completed / item.totalLessons) * 100 : 0}
                  label="Прогресс"
                  hint={`${completed} из ${item.totalLessons} уроков`}
                />
                <div className="row-wrap">
                  <LiquidButton
                    variant="secondary"
                    type="button"
                    onClick={() => navigate(`/app/course/${item.id}`)}
                  >
                    Открыть курс
                  </LiquidButton>
                  <LiquidButton variant="ghost" type="button" onClick={() => shareCourse(item.id)}>
                    Поделиться
                  </LiquidButton>
                </div>
              </GlassCard>
            )
          })}
        </div>
      )}
    </div>
  )

  const renderWizard = () => {
    const readySourceIds = new Set(sources.filter((source) => sourceReady(source.status)).map((source) => source.id))

    return (
      <div className="page-stack">
        <GlassPanel className="section-panel app-head">
          <div>
            <p className="eyebrow">/app/new</p>
            <h1>Мастер создания курса</h1>
            <p className="muted-text">4 шага: материалы, цель, план, готово.</p>
          </div>
        </GlassPanel>

        <StepperGlass
          steps={['Материалы', 'Цель', 'План', 'Готово']}
          current={wizard.step}
        />

        {wizard.step === 1 ? (
          <WizardStepMaterials
            isUploading={isUploading}
            materials={wizard.materials}
            sources={sources}
            selectedSourceId={wizard.selectedSourceId}
            onSourceSelect={(sourceId) =>
              setWizard((existing) => ({
                ...existing,
                selectedSourceId: sourceId,
              }))
            }
            onUploadFile={handleFileUpload}
            onAddLink={handleAddLinkMaterial}
            onAddText={handleAddTextMaterial}
            onRefreshSource={refreshSource}
            onNext={() => {
              if (wizard.materials.length === 0) {
                setError('Добавьте хотя бы один материал.')
                return
              }

              setWizard((existing) => ({ ...existing, step: 2 }))
            }}
          />
        ) : null}

        {wizard.step === 2 ? (
          <GlassPanel className="section-panel wizard-step">
            <h2>Шаг 2. Цель</h2>
            <p className="muted-text">Опишите результат и формат, который вам подходит.</p>

            <div className="form-grid-two">
              <label className="field-stack">
                <span>Название курса</span>
                <InputGlass
                  value={wizard.courseTitle}
                  placeholder="Например: Быстрый старт"
                  onChange={(event) =>
                    setWizard((existing) => ({
                      ...existing,
                      courseTitle: event.target.value,
                    }))
                  }
                />
              </label>

              <label className="field-stack">
                <span>Уровень</span>
                <SelectGlass
                  value={wizard.level}
                  onChange={(event) =>
                    setWizard((existing) => ({
                      ...existing,
                      level: event.target.value as LearningLevel,
                    }))
                  }
                >
                  {LEVEL_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </SelectGlass>
              </label>
            </div>

            <label className="field-stack">
              <span>Что вы хотите в итоге?</span>
              <TextareaGlass
                rows={4}
                value={wizard.goal}
                placeholder="Например: быстро разобраться в теме и уверенно применять на практике"
                onChange={(event) =>
                  setWizard((existing) => ({
                    ...existing,
                    goal: event.target.value,
                  }))
                }
              />
            </label>

            <div className="form-grid-two">
              <label className="field-stack">
                <span>Сколько времени?</span>
                <SelectGlass
                  value={wizard.depth}
                  onChange={(event) =>
                    setWizard((existing) => ({
                      ...existing,
                      depth: event.target.value as LearningDepth,
                    }))
                  }
                >
                  {DEPTH_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </SelectGlass>
              </label>

              <label className="field-stack">
                <span>Темп</span>
                <SelectGlass
                  value={wizard.pace}
                  onChange={(event) =>
                    setWizard((existing) => ({
                      ...existing,
                      pace: event.target.value as LearningPace,
                    }))
                  }
                >
                  {PACE_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </SelectGlass>
              </label>
            </div>

            <div className="row-wrap">
              <LiquidButton
                variant="ghost"
                type="button"
                onClick={() => setWizard((existing) => ({ ...existing, step: 1 }))}
              >
                Назад
              </LiquidButton>
              <LiquidButton variant="primary" type="button" onClick={handleBuildPlan}>
                Собрать план
              </LiquidButton>
            </div>

            {readySourceIds.size === 0 ? (
              <p className="message message-warning">
                Для следующего шага нужен хотя бы один файл со статусом «готово».
              </p>
            ) : null}
          </GlassPanel>
        ) : null}

        {wizard.step === 3 ? (
          <GlassPanel className="section-panel wizard-step">
            <h2>Шаг 3. План</h2>
            <p className="muted-text">Проверьте модули и уроки перед созданием курса.</p>

            <label className="field-stack">
              <span>Источник для сборки</span>
              <SelectGlass
                value={wizard.selectedSourceId}
                onChange={(event) =>
                  setWizard((existing) => ({
                    ...existing,
                    selectedSourceId: event.target.value,
                  }))
                }
              >
                <option value="">Выберите готовый файл</option>
                {sources
                  .filter((source) => sourceReady(source.status))
                  .map((source) => (
                    <option key={source.id} value={source.id}>
                      {source.name}
                    </option>
                  ))}
              </SelectGlass>
            </label>

            <div className="range-block">
              <label htmlFor="detail-range">Коротко ↔ подробно</label>
              <input
                id="detail-range"
                type="range"
                min={0}
                max={100}
                value={wizard.detailLevel}
                onChange={(event) =>
                  setWizard((existing) => ({
                    ...existing,
                    detailLevel: Number(event.target.value),
                  }))
                }
              />
            </div>

            <label className="toggle-row">
              <input
                type="checkbox"
                checked={wizard.practiceBoost}
                onChange={(event) =>
                  setWizard((existing) => ({
                    ...existing,
                    practiceBoost: event.target.checked,
                  }))
                }
              />
              <span>Больше практики</span>
            </label>

            <div className="plan-list">
              {wizard.modules.map((module, moduleIndex) => (
                <GlassCard key={module.id} className="plan-module">
                  <div className="plan-module-head">
                    <InputGlass
                      value={module.title}
                      onChange={(event) => {
                        const value = event.target.value
                        setWizard((existing) => ({
                          ...existing,
                          modules: existing.modules.map((item) =>
                            item.id === module.id
                              ? {
                                  ...item,
                                  title: value,
                                }
                              : item,
                          ),
                        }))
                      }}
                    />
                    <div className="row-wrap">
                      <LiquidButton
                        variant="ghost"
                        compact
                        type="button"
                        onClick={() => {
                          if (moduleIndex === 0) {
                            return
                          }

                          setWizard((existing) => {
                            const nextModules = [...existing.modules]
                            const current = nextModules[moduleIndex]
                            nextModules[moduleIndex] = nextModules[moduleIndex - 1]
                            nextModules[moduleIndex - 1] = current
                            return { ...existing, modules: nextModules }
                          })
                        }}
                      >
                        ↑
                      </LiquidButton>
                      <LiquidButton
                        variant="ghost"
                        compact
                        type="button"
                        onClick={() => {
                          setWizard((existing) => ({
                            ...existing,
                            modules: existing.modules.filter((item) => item.id !== module.id),
                          }))
                        }}
                      >
                        Убрать
                      </LiquidButton>
                    </div>
                  </div>

                  <div className="lesson-edit-list">
                    {module.lessons.map((lesson, lessonIndex) => (
                      <div className="lesson-edit-item" key={lesson.id}>
                        <InputGlass
                          value={lesson.title}
                          onChange={(event) => {
                            const value = event.target.value
                            setWizard((existing) => ({
                              ...existing,
                              modules: existing.modules.map((item) =>
                                item.id === module.id
                                  ? {
                                      ...item,
                                      lessons: item.lessons.map((lessonItem) =>
                                        lessonItem.id === lesson.id
                                          ? {
                                              ...lessonItem,
                                              title: value,
                                            }
                                          : lessonItem,
                                      ),
                                    }
                                  : item,
                              ),
                            }))
                          }}
                        />
                        <div className="row-wrap">
                          <LiquidButton
                            variant="ghost"
                            compact
                            type="button"
                            onClick={() => {
                              if (lessonIndex === 0) {
                                return
                              }

                              setWizard((existing) => ({
                                ...existing,
                                modules: existing.modules.map((item) => {
                                  if (item.id !== module.id) {
                                    return item
                                  }

                                  const nextLessons = [...item.lessons]
                                  const currentLesson = nextLessons[lessonIndex]
                                  nextLessons[lessonIndex] = nextLessons[lessonIndex - 1]
                                  nextLessons[lessonIndex - 1] = currentLesson
                                  return {
                                    ...item,
                                    lessons: nextLessons,
                                  }
                                }),
                              }))
                            }}
                          >
                            ↑
                          </LiquidButton>
                          <LiquidButton
                            variant="ghost"
                            compact
                            type="button"
                            onClick={() => {
                              setWizard((existing) => ({
                                ...existing,
                                modules: existing.modules.map((item) =>
                                  item.id === module.id
                                    ? {
                                        ...item,
                                        lessons: item.lessons.filter((lessonItem) => lessonItem.id !== lesson.id),
                                      }
                                    : item,
                                ),
                              }))
                            }}
                          >
                            Убрать
                          </LiquidButton>
                        </div>
                      </div>
                    ))}
                  </div>

                  <LiquidButton
                    variant="secondary"
                    compact
                    type="button"
                    onClick={() => {
                      setWizard((existing) => ({
                        ...existing,
                        modules: existing.modules.map((item) =>
                          item.id === module.id
                            ? {
                                ...item,
                                lessons: [
                                  ...item.lessons,
                                  {
                                    id: createId('lesson'),
                                    title: `Урок ${item.lessons.length + 1}`,
                                  },
                                ],
                              }
                            : item,
                        ),
                      }))
                    }}
                  >
                    Добавить урок
                  </LiquidButton>
                </GlassCard>
              ))}
            </div>

            <LiquidButton
              variant="secondary"
              type="button"
              onClick={() => {
                setWizard((existing) => ({
                  ...existing,
                  modules: [
                    ...existing.modules,
                    {
                      id: createId('module'),
                      title: `Модуль ${existing.modules.length + 1}`,
                      lessons: [
                        {
                          id: createId('lesson'),
                          title: 'Новый урок',
                        },
                      ],
                    },
                  ],
                }))
              }}
            >
              Добавить модуль
            </LiquidButton>

            <div className="row-wrap">
              <LiquidButton
                variant="ghost"
                type="button"
                onClick={() => setWizard((existing) => ({ ...existing, step: 2 }))}
              >
                Назад
              </LiquidButton>
              <LiquidButton variant="primary" type="button" onClick={() => void handleCreateCourse()} disabled={isCreatingCourse}>
                {isCreatingCourse ? 'Создаем курс...' : 'Создать курс'}
              </LiquidButton>
            </div>
          </GlassPanel>
        ) : null}

        {wizard.step === 4 ? (
          <GlassPanel className="section-panel wizard-success">
            <div className="bloom-animate" aria-hidden>
              ✿
            </div>
            <h2>Курс готов</h2>
            <p>Все получилось. Можно начать обучение прямо сейчас.</p>

            <div className="row-wrap">
              <LiquidButton
                variant="primary"
                type="button"
                onClick={() => {
                  if (!wizard.createdCourseId) {
                    return
                  }

                  const course = coursesById[wizard.createdCourseId]
                  const lessons = flattenLessons(course)
                  if (lessons.length > 0) {
                    navigate(`/app/course/${wizard.createdCourseId}/lesson/${lessons[0].id}`)
                    return
                  }

                  navigate(`/app/course/${wizard.createdCourseId}`)
                }}
              >
                Начать учиться
              </LiquidButton>
              <LiquidButton
                variant="secondary"
                type="button"
                onClick={() => {
                  if (wizard.createdCourseId) {
                    navigate(`/app/course/${wizard.createdCourseId}`)
                  }
                }}
              >
                Посмотреть план
              </LiquidButton>
              <LiquidButton
                variant="ghost"
                type="button"
                onClick={() => {
                  if (wizard.createdCourseId) {
                    void shareCourse(wizard.createdCourseId)
                  }
                }}
              >
                Поделиться
              </LiquidButton>
            </div>

            <LiquidButton variant="secondary" type="button" onClick={resetWizard}>
              Собрать еще один курс
            </LiquidButton>
          </GlassPanel>
        ) : null}
      </div>
    )
  }

  const renderCourse = () => {
    if (loadingCourseId === activeCourseId) {
      return <LoadingState title="Открываем курс" text="Собираем план и прогресс..." />
    }

    if (!currentCourse) {
      return (
        <ErrorState
          text="Не удалось открыть курс."
          onRetry={() => {
            if (activeCourseId) {
              setCoursesById((existing) => {
                const next = { ...existing }
                delete next[activeCourseId]
                return next
              })
              navigate(`/app/course/${activeCourseId}`, true)
            }
          }}
        />
      )
    }

    const progressPercent =
      lessonList.length > 0
        ? (currentProgress.completedLessonIds.length / lessonList.length) * 100
        : 0

    return (
      <div className="course-layout">
        <GlassPanel className="course-sidebar">
          <h3>План</h3>
          {getCourseModules(currentCourse).map((module, moduleIndex) => {
            const moduleTitle = getModuleTitle(module, moduleIndex)
            const lessons = Array.isArray(module.lessons) ? module.lessons : []

            return (
              <div className="stem-module" key={`${moduleTitle}-${moduleIndex}`}>
                <p className="stem-title">{moduleTitle}</p>
                <ul className="stem-lessons">
                  {lessons.map((lesson, lessonIndex) => {
                    const id = toLessonId(moduleIndex, lessonIndex)
                    const done = currentProgress.completedLessonIds.includes(id)

                    return (
                      <li key={id}>
                        <button
                          className={classNames('lesson-link', done && 'is-done')}
                          type="button"
                          onClick={() => navigate(`/app/course/${currentCourse.id}/lesson/${id}`)}
                        >
                          <span className="stem-dot" />
                          {getLessonTitle(lesson as Record<string, unknown>, lessonIndex)}
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </div>
            )
          })}
        </GlassPanel>

        <div className="course-main-stack">
          <GlassPanel className="next-lesson-panel">
            <p className="eyebrow">Следующий шаг</p>
            {nextLesson ? (
              <>
                <h2>{nextLesson.title}</h2>
                <p className="muted-text">Вы на шаг ближе.</p>
                <div className="row-wrap">
                  <LiquidButton
                    variant="primary"
                    type="button"
                    onClick={() => navigate(`/app/course/${currentCourse.id}/lesson/${nextLesson.id}`)}
                  >
                    Продолжить
                  </LiquidButton>
                  <LiquidButton
                    variant="secondary"
                    type="button"
                    onClick={() => navigate(`/app/course/${currentCourse.id}/practice/${nextLesson.id}`)}
                  >
                    Закрепим: 5 вопросов
                  </LiquidButton>
                </div>
              </>
            ) : (
              <p className="muted-text">Добавьте уроки в план, чтобы продолжить.</p>
            )}
          </GlassPanel>

          <GlassPanel className="milestones-panel">
            <h3>Petal Milestones</h3>
            <div className="milestones-line">
              {getCourseModules(currentCourse).map((module, index) => {
                const completed = lessonList.filter(
                  (lesson) =>
                    lesson.moduleIndex === index &&
                    currentProgress.completedLessonIds.includes(lesson.id),
                ).length

                const total = lessonList.filter((lesson) => lesson.moduleIndex === index).length

                return (
                  <div className="milestone-item" key={`${index}-${module.title ?? 'module'}`}>
                    <span className={classNames('milestone-petal', completed >= total && total > 0 && 'is-complete')} />
                    <div>
                      <p>{getModuleTitle(module, index)}</p>
                      <p className="muted-text">
                        {completed}/{total}
                      </p>
                    </div>
                  </div>
                )
              })}
            </div>
          </GlassPanel>
        </div>

        <GlassPanel className="course-side-info">
          <BloomProgress
            value={progressPercent}
            label="Прогресс"
            hint={`${currentProgress.completedLessonIds.length} из ${lessonList.length} уроков`}
          />
          <GlassCard className="dew-card">
            <p>Dew Drop</p>
            <p className="dew-value">{currentProgress.dewStreak}</p>
            <p className="muted-text">Серия точных ответов</p>
          </GlassCard>
        </GlassPanel>
      </div>
    )
  }

  const renderLesson = () => {
    if (!currentCourse || !selectedLesson) {
      return (
        <ErrorState
          text="Урок пока недоступен."
          onRetry={() => {
            if (activeCourseId) {
              navigate(`/app/course/${activeCourseId}`)
            }
          }}
        />
      )
    }

    const currentIndex = lessonList.findIndex((lesson) => lesson.id === selectedLesson.id)
    const previous = currentIndex > 0 ? lessonList[currentIndex - 1] : null
    const next = currentIndex >= 0 && currentIndex + 1 < lessonList.length ? lessonList[currentIndex + 1] : null

    return (
      <div className="page-stack">
        <GlassPanel className="section-panel lesson-panel">
          <p className="eyebrow">Урок</p>
          <h1>{selectedLesson.title}</h1>
          <p className="muted-text">{selectedLesson.moduleTitle}</p>

          <GlassCard className="lesson-block">
            <h3>Главное</h3>
            <ul className="plain-list">
              <li>Сначала выделите главный смысл урока.</li>
              <li>Сведите материал к 3-4 коротким пунктам.</li>
              <li>Сразу проверьте, как это применить в задаче.</li>
            </ul>
          </GlassCard>

          <GlassCard className="lesson-block">
            <h3>Подробнее</h3>
            <details>
              <summary>Шаг 1. Понимание темы</summary>
              <p>{selectedLesson.details ?? 'Сфокусируйтесь на смысле и результате этого шага.'}</p>
            </details>
            <details>
              <summary>Шаг 2. Применение</summary>
              <p>Выберите один рабочий пример и пройдите его по шагам.</p>
            </details>
            <details>
              <summary>Шаг 3. Повторение</summary>
              <p>Коротко перескажите ключевые идеи своими словами.</p>
            </details>
          </GlassCard>

          <GlassCard className="lesson-block">
            <h3>Пример</h3>
            <p>
              Представьте, что нужно объяснить тему коллеге за 5 минут. Какие 2 пункта вы назовете
              первыми?
            </p>
          </GlassCard>

          <GlassCard className="lesson-block">
            <h3>Проверь себя</h3>
            <p>Назовите одну идею, одно действие и один результат этого урока.</p>
          </GlassCard>

          <div className="row-wrap">
            <LiquidButton
              variant="ghost"
              type="button"
              onClick={() => {
                if (previous) {
                  navigate(`/app/course/${currentCourse.id}/lesson/${previous.id}`)
                } else {
                  navigate(`/app/course/${currentCourse.id}`)
                }
              }}
            >
              Назад
            </LiquidButton>

            <LiquidButton
              variant="secondary"
              type="button"
              onClick={() => {
                handleMarkLessonDone(currentCourse.id, selectedLesson.id)
                navigate(`/app/course/${currentCourse.id}/practice/${selectedLesson.id}`)
              }}
            >
              Проверка понимания
            </LiquidButton>

            <LiquidButton
              variant="primary"
              type="button"
              onClick={() => {
                handleMarkLessonDone(currentCourse.id, selectedLesson.id)

                if (next) {
                  navigate(`/app/course/${currentCourse.id}/lesson/${next.id}`)
                  return
                }

                navigate(`/app/course/${currentCourse.id}`)
              }}
            >
              {next ? 'Следующий урок' : 'К курсу'}
            </LiquidButton>
          </div>
        </GlassPanel>
      </div>
    )
  }

  const renderPractice = () => {
    if (!currentCourse) {
      return (
        <ErrorState
          text="Практика пока недоступна."
          onRetry={() => {
            if (activeCourseId) {
              navigate(`/app/course/${activeCourseId}`)
            }
          }}
        />
      )
    }

    const routeBlockId = route.kind === 'practice' ? route.blockId : ''
    const resolvedLesson = lessonList.find((item) => item.id === routeBlockId) ?? lessonList[0] ?? null
    const questions = buildPracticeQuestions(resolvedLesson)

    return (
      <div className="page-stack">
        <GlassPanel className="section-panel">
          <div className="practice-headline">
            <div>
              <p className="eyebrow">Практика</p>
              <h1>{resolvedLesson ? `Проверка по уроку «${resolvedLesson.title}»` : 'Проверка понимания'}</h1>
              <p className="muted-text">Ответьте на вопросы и закрепите тему.</p>
            </div>
            <GlassCard className="dew-chip">
              <p>Dew Drop</p>
              <p className="dew-value">{currentProgress.dewStreak}</p>
            </GlassCard>
          </div>

          <PracticeSession
            questions={questions}
            onFinish={(correctCount) => {
              handlePracticeComplete(currentCourse.id, correctCount, questions.length)
              navigate(`/app/course/${currentCourse.id}`)
            }}
          />
        </GlassPanel>
      </div>
    )
  }

  const renderSettings = () => (
    <div className="page-stack">
      <GlassPanel className="section-panel">
        <h1>Настройки</h1>
        <p className="muted-text">Профиль и внешний вид.</p>
      </GlassPanel>

      <GlassPanel className="section-panel">
        <div className="form-grid-two">
          <GlassCard>
            <h3>Профиль</h3>
            <p>Email: {profile.email ?? 'не указан'}</p>
          </GlassCard>
          <GlassCard>
            <h3>Тема</h3>
            <p>Текущая тема: {theme === 'dark' ? 'Темная' : 'Светлая'}</p>
            <LiquidButton variant="secondary" type="button" onClick={toggleTheme}>
              Переключить тему
            </LiquidButton>
          </GlassCard>
        </div>
      </GlassPanel>
    </div>
  )

  const renderBilling = () => (
    <div className="page-stack">
      <GlassPanel className="section-panel">
        <h1>Подписка и оплата</h1>
        <p className="muted-text">Выберите подходящий план.</p>
      </GlassPanel>

      <div className="pricing-grid">
        <GlassCard className="pricing-card">
          <h3>Free</h3>
          <p>Для первых шагов.</p>
          <LiquidButton variant="ghost" type="button">
            Текущий план
          </LiquidButton>
        </GlassCard>
        <GlassCard className="pricing-card is-highlighted">
          <h3>Pro</h3>
          <p>Для регулярного обучения.</p>
          <LiquidButton variant="primary" type="button">
            Перейти на Pro
          </LiquidButton>
        </GlassCard>
        <GlassCard className="pricing-card">
          <h3>Team</h3>
          <p>Для команд.</p>
          <LiquidButton variant="secondary" type="button">
            Подключить Team
          </LiquidButton>
        </GlassCard>
      </div>
    </div>
  )

  const renderAdmin = () => {
    if (profile.role !== 'admin') {
      return <LoadingState title="Проверяем доступ" text="Подождите немного..." />
    }

    const section = route.kind === 'admin' ? route.section : 'overview'
    const totalReadySources = sources.filter((source) => source.status === 'indexed').length
    const totalCourses = library.length

    const adminContent = () => {
      if (section === 'overview') {
        return (
          <div className="admin-grid">
            <GlassCard>
              <p className="eyebrow">Users</p>
              <h3>{Math.max(1, library.length + 1)}</h3>
              <p className="muted-text">Активные аккаунты за период</p>
            </GlassCard>
            <GlassCard>
              <p className="eyebrow">Courses</p>
              <h3>{totalCourses}</h3>
              <p className="muted-text">Курсы в системе</p>
            </GlassCard>
            <GlassCard>
              <p className="eyebrow">Health</p>
              <h3>{totalReadySources}</h3>
              <p className="muted-text">Готовые материалы</p>
            </GlassCard>
          </div>
        )
      }

      if (section === 'users') {
        return (
          <GlassPanel className="admin-table-wrap">
            <h2>Users</h2>
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Email</th>
                  <th>План</th>
                  <th>Статус</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>{profile.email ?? 'owner@flowa.app'}</td>
                  <td>Pro</td>
                  <td>Активен</td>
                </tr>
                <tr>
                  <td>team@flowa.app</td>
                  <td>Team</td>
                  <td>Активен</td>
                </tr>
                <tr>
                  <td>trial@flowa.app</td>
                  <td>Free</td>
                  <td>Пробный</td>
                </tr>
              </tbody>
            </table>
          </GlassPanel>
        )
      }

      if (section === 'courses') {
        return (
          <GlassPanel className="admin-table-wrap">
            <h2>Courses</h2>
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Название</th>
                  <th>ID</th>
                  <th>Структура</th>
                </tr>
              </thead>
              <tbody>
                {library.length === 0 ? (
                  <tr>
                    <td colSpan={3}>Курсы появятся после создания.</td>
                  </tr>
                ) : (
                  library.map((item) => (
                    <tr key={item.id}>
                      <td>{item.title}</td>
                      <td>{item.id}</td>
                      <td>{item.totalLessons} уроков</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </GlassPanel>
        )
      }

      if (section === 'templates') {
        return (
          <div className="admin-grid">
            <GlassCard>
              <h3>Быстрый старт</h3>
              <p>3 модуля, короткие уроки, практика в конце.</p>
            </GlassCard>
            <GlassCard>
              <h3>Глубокий разбор</h3>
              <p>5 модулей, акцент на повторение.</p>
            </GlassCard>
            <GlassCard>
              <h3>Командный формат</h3>
              <p>Короткие уроки + контрольные вопросы.</p>
            </GlassCard>
          </div>
        )
      }

      if (section === 'billing') {
        return (
          <GlassPanel className="admin-table-wrap">
            <h2>Billing</h2>
            <table className="admin-table">
              <thead>
                <tr>
                  <th>План</th>
                  <th>Пользователи</th>
                  <th>Статус</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Free</td>
                  <td>18</td>
                  <td>Активен</td>
                </tr>
                <tr>
                  <td>Pro</td>
                  <td>9</td>
                  <td>Активен</td>
                </tr>
                <tr>
                  <td>Team</td>
                  <td>3</td>
                  <td>Активен</td>
                </tr>
              </tbody>
            </table>
          </GlassPanel>
        )
      }

      if (section === 'feedback') {
        return (
          <div className="admin-grid">
            <GlassCard>
              <h3>Обращения</h3>
              <p>"Хочу больше примеров в уроках"</p>
            </GlassCard>
            <GlassCard>
              <h3>Причины отмен</h3>
              <p>"Редко пользуюсь"</p>
            </GlassCard>
            <GlassCard>
              <h3>Запросы</h3>
              <p>"Нужен отдельный шаблон для команд"</p>
            </GlassCard>
          </div>
        )
      }

      return (
        <div className="admin-grid">
          <GlassCard>
            <h3>Health</h3>
            <p>Сервис доступен</p>
          </GlassCard>
          <GlassCard>
            <h3>Загрузка материалов</h3>
            <p>{sources.length} в работе</p>
          </GlassCard>
          <GlassCard>
            <h3>Gateway</h3>
            <p className="admin-code">{gatewayBaseUrl}</p>
          </GlassCard>
        </div>
      )
    }

    return (
      <div className="admin-layout">
        <aside className="admin-sidebar">
          <button className="admin-brand" type="button" onClick={() => navigate('/admin')}>
            Flowa Admin
          </button>
          <nav className="admin-nav">
            {ADMIN_SECTIONS.map((item) => (
              <button
                key={item.section}
                className={classNames('admin-nav-item', section === item.section && 'is-active')}
                type="button"
                onClick={() => navigate(item.path)}
              >
                {item.label}
              </button>
            ))}
          </nav>
        </aside>

        <main className="admin-main">
          <GlassPanel className="admin-head">
            <h1>Admin / {section}</h1>
            <p className="muted-text">Закрытый контур для ролей с доступом.</p>
          </GlassPanel>
          {adminContent()}
        </main>
      </div>
    )
  }

  const renderMain = () => {
    if (route.kind === 'landing') {
      return renderMarketingLanding()
    }

    if (route.kind === 'examples') {
      return renderExamples()
    }

    if (route.kind === 'pricing') {
      return renderPricing()
    }

    if (route.kind === 'about') {
      return renderAbout()
    }

    if (route.kind === 'help') {
      return renderHelp()
    }

    if (route.kind === 'login') {
      return renderAuthPage('login')
    }

    if (route.kind === 'signup') {
      return renderAuthPage('signup')
    }

    if (route.kind === 'appLibrary') {
      return renderLibrary()
    }

    if (route.kind === 'appNew') {
      return renderWizard()
    }

    if (route.kind === 'course') {
      return renderCourse()
    }

    if (route.kind === 'lesson') {
      return renderLesson()
    }

    if (route.kind === 'practice') {
      return renderPractice()
    }

    if (route.kind === 'settings') {
      return renderSettings()
    }

    if (route.kind === 'billing') {
      return renderBilling()
    }

    if (route.kind === 'admin') {
      return renderAdmin()
    }

    return (
      <EmptyState
        title="Страница не найдена"
        text="Вернитесь на главную и продолжите путь в Flowa."
        cta="На главную"
        onCta={() => navigate('/')}
      />
    )
  }

  const isMarketingRoute =
    route.kind === 'landing' ||
    route.kind === 'examples' ||
    route.kind === 'pricing' ||
    route.kind === 'about' ||
    route.kind === 'help' ||
    route.kind === 'login' ||
    route.kind === 'signup'

  const isAppRoute =
    route.kind === 'appLibrary' ||
    route.kind === 'appNew' ||
    route.kind === 'course' ||
    route.kind === 'lesson' ||
    route.kind === 'practice' ||
    route.kind === 'settings' ||
    route.kind === 'billing'

  const isCourseFlowRoute =
    route.kind === 'course' || route.kind === 'lesson' || route.kind === 'practice'

  return (
    <div className={classNames('page-shell', isAdminRoute && 'is-admin-shell')}>
      <PetalBackground disabled={isAdminRoute} dense />

      {isMarketingRoute ? (
        <GlassPanel className="topbar marketing-topbar">
          <button className="brand" type="button" onClick={() => navigate('/')}>
            Flowa
          </button>

          <nav className="topbar-nav">
            <button
              className={classNames('nav-link', route.kind === 'landing' && 'is-active')}
              type="button"
              onClick={() => navigate('/')}
            >
              Главная
            </button>
            <button
              className={classNames('nav-link', route.kind === 'examples' && 'is-active')}
              type="button"
              onClick={() => navigate('/examples')}
            >
              Примеры
            </button>
            <button
              className={classNames('nav-link', route.kind === 'pricing' && 'is-active')}
              type="button"
              onClick={() => navigate('/pricing')}
            >
              Тарифы
            </button>
            <button
              className={classNames('nav-link', route.kind === 'help' && 'is-active')}
              type="button"
              onClick={() => navigate('/help')}
            >
              Помощь
            </button>
          </nav>

          <div className="topbar-actions">
            <ThemeLatchButton theme={theme} onToggle={toggleTheme} />

            {!token ? (
              <>
                <LiquidButton variant="ghost" compact type="button" onClick={() => navigate('/login')}>
                  Войти
                </LiquidButton>
                <LiquidButton variant="primary" compact type="button" onClick={() => navigate('/signup')}>
                  Регистрация
                </LiquidButton>
              </>
            ) : (
              <>
                <LiquidButton variant="secondary" compact type="button" onClick={() => navigate('/app')}>
                  В кабинет
                </LiquidButton>
                <LiquidButton variant="ghost" compact type="button" onClick={() => void handleLogout()}>
                  Выйти
                </LiquidButton>
              </>
            )}
          </div>
        </GlassPanel>
      ) : null}

      {isAppRoute ? (
        <GlassPanel className="topbar app-topbar">
          <button className="brand" type="button" onClick={() => navigate('/app')}>
            Flowa Workspace
          </button>

          <nav className="topbar-nav">
            <button
              className={classNames('nav-link', route.kind === 'appLibrary' && 'is-active')}
              type="button"
              onClick={() => navigate('/app')}
            >
              Библиотека
            </button>
            <button
              className={classNames('nav-link', route.kind === 'appNew' && 'is-active')}
              type="button"
              onClick={() => navigate('/app/new')}
            >
              Новый курс
            </button>
            {activeCourseId ? (
              <button
                className={classNames('nav-link', isCourseFlowRoute && 'is-active')}
                type="button"
                onClick={() => navigate(`/app/course/${activeCourseId}`)}
              >
                Текущий курс
              </button>
            ) : null}
            <button
              className={classNames('nav-link', route.kind === 'settings' && 'is-active')}
              type="button"
              onClick={() => navigate('/settings')}
            >
              Настройки
            </button>
            <button
              className={classNames('nav-link', route.kind === 'billing' && 'is-active')}
              type="button"
              onClick={() => navigate('/billing')}
            >
              Подписка
            </button>
            {profile.role === 'admin' ? (
              <button className="nav-link" type="button" onClick={() => navigate('/admin')}>
                Admin
              </button>
            ) : null}
          </nav>

          <div className="topbar-actions">
            <ThemeLatchButton theme={theme} onToggle={toggleTheme} />
            <LiquidButton variant="ghost" compact type="button" onClick={() => navigate('/')}>
              Лендинг
            </LiquidButton>
            <LiquidButton variant="secondary" compact type="button" onClick={() => void handleLogout()}>
              Выйти
            </LiquidButton>
          </div>
        </GlassPanel>
      ) : null}

      {notice ? <p className="banner banner-success">{notice}</p> : null}
      {error ? <p className="banner banner-error">{error}</p> : null}

      {renderMain()}
    </div>
  )
}

interface WizardStepMaterialsProps {
  isUploading: boolean
  materials: WizardMaterial[]
  sources: SourceResponse[]
  selectedSourceId: string
  onSourceSelect: (sourceId: string) => void
  onUploadFile: (file: File) => Promise<void>
  onAddLink: (urlValue: string) => void
  onAddText: (textValue: string) => void
  onRefreshSource: (sourceId: string) => Promise<void>
  onNext: () => void
}

const MAX_FILE_SIZE_MB = 30

const WizardStepMaterials = ({
  isUploading,
  materials,
  sources,
  selectedSourceId,
  onSourceSelect,
  onUploadFile,
  onAddLink,
  onAddText,
  onRefreshSource,
  onNext,
}: WizardStepMaterialsProps) => {
  const [file, setFile] = useState<File | null>(null)
  const [link, setLink] = useState('')
  const [text, setText] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)

  const readySources = sources.filter((source) => sourceReady(source.status))

  const handleFileSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setLocalError(null)

    if (!file) {
      setLocalError('Сначала выберите файл.')
      return
    }

    if (file.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
      setLocalError(`Файл должен быть не больше ${MAX_FILE_SIZE_MB} МБ.`)
      return
    }

    await onUploadFile(file)
    setFile(null)
  }

  const handleAddLink = () => {
    const normalized = link.trim()

    if (!normalized) {
      setLocalError('Вставьте ссылку.')
      return
    }

    if (!/^https?:\/\//.test(normalized)) {
      setLocalError('Ссылка должна начинаться с http:// или https://')
      return
    }

    onAddLink(normalized)
    setLink('')
  }

  const handleAddText = () => {
    const normalized = text.trim()

    if (normalized.length < 10) {
      setLocalError('Добавьте чуть больше текста, минимум 10 символов.')
      return
    }

    onAddText(normalized)
    setText('')
  }

  return (
    <GlassPanel className="section-panel wizard-step">
      <h2>Шаг 1. Добавьте материалы</h2>
      <p className="muted-text">Файлы, ссылки или текст. Все материалы отображаются в общем списке.</p>

      <div className="form-grid-two">
        <GlassCard>
          <h3>Загрузить файл</h3>
          <form className="flow-form" onSubmit={(event) => void handleFileSubmit(event)}>
            <InputGlass
              type="file"
              accept=".pdf,.doc,.docx,.txt,.md"
              onChange={(event: ChangeEvent<HTMLInputElement>) => setFile(event.target.files?.[0] ?? null)}
            />
            {file ? <p className="muted-text">{file.name}</p> : null}
            <LiquidButton variant="primary" type="submit" disabled={isUploading}>
              {isUploading ? 'Добавляем...' : 'Добавить файл'}
            </LiquidButton>
          </form>
        </GlassCard>

        <GlassCard>
          <h3>Вставить ссылку</h3>
          <div className="flow-form">
            <InputGlass
              value={link}
              placeholder="https://"
              onChange={(event) => setLink(event.target.value)}
            />
            <LiquidButton variant="secondary" type="button" onClick={handleAddLink}>
              Добавить ссылку
            </LiquidButton>
          </div>
        </GlassCard>
      </div>

      <GlassCard>
        <h3>Вставить текст</h3>
        <div className="flow-form">
          <TextareaGlass
            rows={4}
            value={text}
            placeholder="Вставьте заметки или фрагмент материала"
            onChange={(event) => setText(event.target.value)}
          />
          <LiquidButton variant="secondary" type="button" onClick={handleAddText}>
            Добавить текст
          </LiquidButton>
        </div>
      </GlassCard>

      {localError ? <p className="message message-error">{localError}</p> : null}

      <GlassCard>
        <h3>Добавленные материалы</h3>

        {materials.length === 0 ? (
          <p className="muted-text">Пока пусто. Добавьте первый материал.</p>
        ) : (
          <div className="materials-list">
            {materials.map((material) => (
              <div className="material-item" key={material.id}>
                <div>
                  <p>{material.name}</p>
                  <p className="muted-text">{material.detail}</p>
                </div>
                <BloomBadge label={material.status} tone={toneByStatus(material.status)} />
              </div>
            ))}
          </div>
        )}
      </GlassCard>

      <GlassCard>
        <h3>Файлы со статусом</h3>
        {sources.length === 0 ? (
          <p className="muted-text">Файлы появятся здесь после загрузки.</p>
        ) : (
          <div className="materials-list">
            {sources.map((source) => (
              <div className="material-item" key={source.id}>
                <div>
                  <p>{source.name}</p>
                  <p className="muted-text">{SOURCE_STATUS_HINT[source.status]}</p>
                </div>
                <div className="row-wrap">
                  <BloomBadge
                    label={SOURCE_STATUS_LABEL[source.status]}
                    tone={toneByStatus(SOURCE_STATUS_TO_MATERIAL[source.status])}
                  />
                  <LiquidButton
                    variant="ghost"
                    compact
                    type="button"
                    onClick={() => void onRefreshSource(source.id)}
                  >
                    Обновить
                  </LiquidButton>
                </div>
              </div>
            ))}
          </div>
        )}

        {readySources.length > 0 ? (
          <label className="field-stack">
            <span>Файл для сборки курса</span>
            <SelectGlass value={selectedSourceId} onChange={(event) => onSourceSelect(event.target.value)}>
              <option value="">Выберите файл</option>
              {readySources.map((source) => (
                <option value={source.id} key={source.id}>
                  {source.name}
                </option>
              ))}
            </SelectGlass>
          </label>
        ) : null}
      </GlassCard>

      <div className="row-wrap">
        <LiquidButton variant="primary" type="button" onClick={onNext}>
          Дальше
        </LiquidButton>
      </div>
    </GlassPanel>
  )
}

export default App
