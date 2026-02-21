import { type FormEvent, useMemo, useState } from 'react'
import type { CourseLevel, CreateCourseRequest, SourceResponse } from '../types'

interface CourseBuilderPanelProps {
  availableSources: SourceResponse[]
  preferredSourceId: string | null
  onCreateCourse: (payload: CreateCourseRequest) => Promise<void>
  isSubmitting: boolean
}

const LEVEL_OPTIONS: CourseLevel[] = ['beginner', 'intermediate', 'advanced']

type ProviderOption = 'default' | 'local' | 'api'

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
  const [providerOverride, setProviderOverride] = useState<ProviderOption>('default')
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

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setErrorMessage(null)
    setSuccessMessage(null)

    if (!resolvedSourceId) {
      setErrorMessage('Choose an indexed source before creating a course.')
      return
    }

    if (goal.trim().length < 8) {
      setErrorMessage('Goal must be at least 8 characters long.')
      return
    }

    const payload: CreateCourseRequest = {
      source_id: resolvedSourceId,
      title: title.trim(),
      goal: goal.trim(),
      level,
    }

    if (providerOverride !== 'default') {
      payload.provider_override = providerOverride
    }

    try {
      await onCreateCourse(payload)
      setSuccessMessage('Course has been created. Open Course Viewer tab.')
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Course creation failed.')
    }
  }

  return (
    <section className="glass-panel content-panel fade-in">
      <header className="section-header">
        <h2>Course Builder</h2>
        <p className="muted-text">Цель, уровень и источник для генерации структуры курса.</p>
      </header>

      {indexedSources.length === 0 ? (
        <p className="inline-error">No indexed sources available yet.</p>
      ) : null}

      <form className="form" onSubmit={handleSubmit}>
        <div className="field-grid">
          <label className="field">
            <span>Indexed Source</span>
            <select
              className="control"
              value={resolvedSourceId}
              onChange={(event) => setSourceId(event.target.value)}
              disabled={indexedSources.length === 0}
            >
              <option value="">Select source</option>
              {indexedSources.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.name} ({source.id.slice(0, 8)})
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Level</span>
            <select
              className="control"
              value={level}
              onChange={(event) => setLevel(event.target.value as CourseLevel)}
            >
              {LEVEL_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Provider Override</span>
            <select
              className="control"
              value={providerOverride}
              onChange={(event) => setProviderOverride(event.target.value as ProviderOption)}
            >
              <option value="default">default</option>
              <option value="local">local</option>
              <option value="api">api</option>
            </select>
          </label>
        </div>

        <label className="field">
          <span>Course Title</span>
          <input
            required
            className="control"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Курс по ML"
          />
        </label>

        <label className="field">
          <span>Goal</span>
          <textarea
            required
            className="control control-textarea"
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            placeholder="Освоить основы машинного обучения и уметь строить MVP-модели"
          />
        </label>

        {errorMessage ? <p className="inline-error">{errorMessage}</p> : null}
        {successMessage ? <p className="inline-info">{successMessage}</p> : null}

        <button
          className="btn btn-primary"
          type="submit"
          disabled={isSubmitting || indexedSources.length === 0}
        >
          {isSubmitting ? 'Creating...' : 'Create Course'}
        </button>
      </form>
    </section>
  )
}
