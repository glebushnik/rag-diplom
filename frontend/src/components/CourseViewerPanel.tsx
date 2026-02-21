import { type FormEvent, useMemo, useState } from 'react'
import type { CourseModule, CourseResponse } from '../types'

interface CourseViewerPanelProps {
  course: CourseResponse | null
  onLoadCourse: (courseId: string) => Promise<void>
  isLoading: boolean
}

const getModules = (course: CourseResponse | null): CourseModule[] => {
  if (!course) {
    return []
  }

  const modules = course.structure.modules

  if (!Array.isArray(modules)) {
    return []
  }

  return modules
}

const getModuleTitle = (module: CourseModule, index: number): string => {
  if (module.title && module.title.trim()) {
    return module.title
  }

  return `Модуль ${index + 1}`
}

const LEVEL_LABELS: Record<string, string> = {
  beginner: 'Начальный',
  intermediate: 'Средний',
  advanced: 'Продвинутый',
}

export const CourseViewerPanel = ({
  course,
  onLoadCourse,
  isLoading,
}: CourseViewerPanelProps) => {
  const [courseId, setCourseId] = useState('')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const modules = useMemo(() => getModules(course), [course])

  const handleLoadCourse = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setErrorMessage(null)

    if (!courseId.trim()) {
      setErrorMessage('Введите код курса, чтобы загрузить его.')
      return
    }

    try {
      await onLoadCourse(courseId.trim())
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Не удалось загрузить курс.')
    }
  }

  return (
    <section className="glass-panel content-panel fade-in">
      <header className="section-header">
        <h2>Шаг 3. Готовый курс</h2>
        <p className="muted-text">
          Здесь вы увидите итоговую структуру и план обучения, который можно использовать в работе.
        </p>
      </header>

      <form className="form" onSubmit={handleLoadCourse}>
        <label className="field">
          <span>Код курса (если хотите открыть уже созданный)</span>
          <input
            className="control"
            placeholder="Вставьте код курса"
            value={courseId}
            onChange={(event) => setCourseId(event.target.value)}
          />
        </label>

        {errorMessage ? (
          <p className="form-message form-message-error validation-pop" role="alert">
            {errorMessage}
          </p>
        ) : null}

        <button className="btn btn-secondary" type="submit" disabled={isLoading}>
          {isLoading ? 'Загружаем курс...' : 'Открыть курс'}
        </button>
      </form>

      {!course ? (
        <p className="muted-text">
          Курс пока не открыт. Сначала создайте его в предыдущем шаге или загрузите по коду.
        </p>
      ) : (
        <div className="course-view">
          <div className="course-meta">
            <h3>{course.title}</h3>
            <p>
              <strong>Уровень:</strong> {LEVEL_LABELS[course.level] ?? course.level}
            </p>
            <p>
              <strong>Цель:</strong> {course.goal}
            </p>
            <p className="muted-text">
              Это готовый каркас курса, который можно использовать как основу программы обучения.
            </p>
          </div>

          <div className="module-list">
            <h4>Модули курса ({modules.length})</h4>
            {modules.length === 0 ? (
              <p className="muted-text">В структуре пока нет модулей.</p>
            ) : (
              modules.map((module, index) => (
                <article className="module-item" key={`${module.title ?? 'module'}-${index}`}>
                  <p className="module-title">{getModuleTitle(module, index)}</p>
                  {module.description ? <p>{module.description}</p> : null}
                  {Array.isArray(module.lessons) && module.lessons.length > 0 ? (
                    <ul className="lesson-list">
                      {module.lessons.map((lesson, lessonIndex) => (
                        <li key={`${lesson.title ?? 'lesson'}-${lessonIndex}`}>
                          {lesson.title?.trim() || `Урок ${lessonIndex + 1}`}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="muted-text">Уроки появятся после дополнительной детализации.</p>
                  )}
                </article>
              ))
            )}
          </div>
        </div>
      )}
    </section>
  )
}
