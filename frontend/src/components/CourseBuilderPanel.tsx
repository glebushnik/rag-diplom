import { type FormEvent, useMemo, useState } from 'react'
import type { CourseLevel, CreateCourseRequest, SourceResponse } from '../types'

interface CourseBuilderPanelProps {
  availableSources: SourceResponse[]
  preferredSourceId: string | null
  onCreateCourse: (payload: CreateCourseRequest) => Promise<void>
  isSubmitting: boolean
}

const LEVEL_OPTIONS: Array<{ value: CourseLevel; label: string; description: string }> = [
  {
    value: 'beginner',
    label: 'Начальный',
    description: 'Для тех, кто только знакомится с темой.',
  },
  {
    value: 'intermediate',
    label: 'Средний',
    description: 'Для слушателей с базовой подготовкой.',
  },
  {
    value: 'advanced',
    label: 'Продвинутый',
    description: 'Для глубокой практики и сложных кейсов.',
  },
]

export const CourseBuilderPanel = ({
  availableSources,
  preferredSourceId,
  onCreateCourse,
  isSubmitting,
}: CourseBuilderPanelProps) => {
  const indexedSources = useMemo(
    () => availableSources.filter((source) => source.status === 'indexed'),
    [availableSources],
  )

  const [sourceId, setSourceId] = useState('')
  const [title, setTitle] = useState('')
  const [goal, setGoal] = useState('')
  const [level, setLevel] = useState<CourseLevel>('beginner')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)

  const resolvedSourceId = useMemo(() => {
    if (sourceId && indexedSources.some((source) => source.id === sourceId)) {
      return sourceId
    }

    if (preferredSourceId && indexedSources.some((source) => source.id === preferredSourceId)) {
      return preferredSourceId
    }

    return indexedSources[0]?.id ?? ''
  }, [indexedSources, preferredSourceId, sourceId])

  const validate = (): string | null => {
    if (!resolvedSourceId) {
      return 'Сначала подготовьте хотя бы один источник со статусом «Готово».'
    }

    if (title.trim().length < 4) {
      return 'Название курса должно быть не короче 4 символов.'
    }

    if (goal.trim().length < 12) {
      return 'Опишите цель подробнее (минимум 12 символов).'
    }

    return null
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setErrorMessage(null)
    setSuccessMessage(null)

    const validationError = validate()

    if (validationError) {
      setErrorMessage(validationError)
      return
    }

    const payload: CreateCourseRequest = {
      source_id: resolvedSourceId,
      title: title.trim(),
      goal: goal.trim(),
      level,
    }

    try {
      await onCreateCourse(payload)
      setSuccessMessage('Курс успешно создан. Перейдите во вкладку «Готовый курс».')
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Не удалось создать курс.')
    }
  }

  return (
    <section className="glass-panel content-panel fade-in">
      <header className="section-header">
        <h2>Шаг 2. Сформируйте курс</h2>
        <p className="muted-text">
          Опишите, чему должен научиться слушатель. Платформа соберет структуру автоматически.
        </p>
      </header>

      {indexedSources.length === 0 ? (
        <p className="form-message form-message-error validation-pop" role="alert">
          Пока нет готовых источников. Вернитесь на первый шаг и дождитесь завершения обработки.
        </p>
      ) : null}

      <form className="form" onSubmit={handleSubmit}>
        <div className="field-grid">
          <label className="field">
            <span>Источник для курса</span>
            <select
              className="control"
              value={resolvedSourceId}
              onChange={(event) => setSourceId(event.target.value)}
              disabled={indexedSources.length === 0}
            >
              <option value="">Выберите источник</option>
              {indexedSources.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.name}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Уровень сложности</span>
            <select
              className="control"
              value={level}
              onChange={(event) => setLevel(event.target.value as CourseLevel)}
            >
              {LEVEL_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <small className="muted-text">
              {LEVEL_OPTIONS.find((option) => option.value === level)?.description}
            </small>
          </label>
        </div>

        <label className="field">
          <span>Название курса</span>
          <input
            required
            className="control"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Например: Основы машинного обучения"
          />
        </label>

        <label className="field">
          <span>Цель курса</span>
          <textarea
            required
            className="control control-textarea"
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            placeholder="Например: Освоить базовые подходы и научиться строить рабочие модели для практических задач."
          />
        </label>

        {errorMessage ? (
          <p className="form-message form-message-error validation-pop" role="alert">
            {errorMessage}
          </p>
        ) : null}
        {successMessage ? (
          <p className="form-message form-message-success" role="status">
            {successMessage}
          </p>
        ) : null}

        <button
          className="btn btn-primary"
          type="submit"
          disabled={isSubmitting || indexedSources.length === 0}
        >
          {isSubmitting ? 'Собираем структуру курса...' : 'Сгенерировать курс'}
        </button>
      </form>
    </section>
  )
}
