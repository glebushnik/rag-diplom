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
      setErrorMessage('Enter course id to fetch structure.')
      return
    }

    try {
      await onLoadCourse(courseId.trim())
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Unable to load course.')
    }
  }

  return (
    <section className="glass-panel content-panel fade-in">
      <header className="section-header">
        <h2>Course Viewer</h2>
        <p className="muted-text">Просмотр структуры курса из `GET /courses/{'{id}'}`.</p>
      </header>

      <form className="form" onSubmit={handleLoadCourse}>
        <label className="field">
          <span>Course ID</span>
          <input
            className="control"
            placeholder="Paste course uuid"
            value={courseId}
            onChange={(event) => setCourseId(event.target.value)}
          />
        </label>

        {errorMessage ? <p className="inline-error">{errorMessage}</p> : null}

        <button className="btn btn-secondary" type="submit" disabled={isLoading}>
          {isLoading ? 'Loading...' : 'Load Course'}
        </button>
      </form>

      {!course ? (
        <p className="muted-text">Course is not loaded yet.</p>
      ) : (
        <div className="course-view">
          <div className="course-meta">
            <h3>{course.title}</h3>
            <p>
              <strong>Id:</strong> {course.id}
            </p>
            <p>
              <strong>Level:</strong> {course.level}
            </p>
            <p>
              <strong>Goal:</strong> {course.goal}
            </p>
          </div>

          <div className="module-list">
            <h4>Modules ({modules.length})</h4>
            {modules.length === 0 ? (
              <p className="muted-text">No modules in structure.</p>
            ) : (
              modules.map((module, index) => (
                <article className="module-item" key={`${module.title ?? 'module'}-${index}`}>
                  <p className="module-title">{module.title ?? `Module ${index + 1}`}</p>
                  {module.description ? <p>{module.description}</p> : null}
                  {Array.isArray(module.lessons) && module.lessons.length > 0 ? (
                    <p className="muted-text">Lessons: {module.lessons.length}</p>
                  ) : null}
                </article>
              ))
            )}
          </div>

          <div className="json-container">
            <h4>Raw Structure</h4>
            <pre>{JSON.stringify(course.structure, null, 2)}</pre>
          </div>
        </div>
      )}
    </section>
  )
}
