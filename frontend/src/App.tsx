import { useCallback, useEffect, useMemo, useState } from 'react'
import './App.css'
import { AuthPanel } from './components/AuthPanel'
import { CourseBuilderPanel } from './components/CourseBuilderPanel'
import { CourseViewerPanel } from './components/CourseViewerPanel'
import { SourcesPanel } from './components/SourcesPanel'
import { GatewayApiError, GatewayClient, resolveGatewayBaseUrl } from './lib/api'
import { clearStoredToken, readStoredToken, writeStoredToken } from './lib/tokenStore'
import type {
  CourseResponse,
  CreateCourseRequest,
  JobStatus,
  SourceResponse,
} from './types'

type AppTab = 'sources' | 'builder' | 'viewer'

const TABS: Array<{ key: AppTab; label: string; description: string }> = [
  { key: 'sources', label: 'Sources', description: 'Upload + status polling' },
  { key: 'builder', label: 'Course Builder', description: 'Goal / level / generate course' },
  { key: 'viewer', label: 'Course Viewer', description: 'Inspect structure from API' },
]

const POLL_INTERVAL_MS = 3000
const TERMINAL_STATUSES = new Set<JobStatus>(['indexed', 'failed'])

const upsertSource = (existing: SourceResponse[], incoming: SourceResponse): SourceResponse[] => {
  const index = existing.findIndex((item) => item.id === incoming.id)

  if (index < 0) {
    return [incoming, ...existing]
  }

  const next = [...existing]
  next[index] = incoming
  return next
}

const toErrorMessage = (error: unknown): string => {
  if (error instanceof GatewayApiError) {
    return error.message
  }

  if (error instanceof Error) {
    return error.message
  }

  return 'Unexpected error.'
}

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    window.setTimeout(resolve, milliseconds)
  })

function App() {
  const gatewayBaseUrl = useMemo(() => {
    const desktopConfigValue = window.desktopConfig?.gatewayUrl
    return resolveGatewayBaseUrl(desktopConfigValue || import.meta.env.VITE_GATEWAY_URL)
  }, [])

  const [token, setToken] = useState<string | null>(null)
  const [isTokenBootstrapping, setIsTokenBootstrapping] = useState(true)
  const [activeTab, setActiveTab] = useState<AppTab>('sources')
  const [sources, setSources] = useState<SourceResponse[]>([])
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null)
  const [isUploading, setIsUploading] = useState(false)
  const [isCreatingCourse, setIsCreatingCourse] = useState(false)
  const [isLoadingCourse, setIsLoadingCourse] = useState(false)
  const [course, setCourse] = useState<CourseResponse | null>(null)
  const [noticeMessage, setNoticeMessage] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const api = useMemo(() => new GatewayClient(gatewayBaseUrl, () => token), [gatewayBaseUrl, token])

  useEffect(() => {
    let cancelled = false

    const bootstrapToken = async () => {
      try {
        const storedToken = await readStoredToken()

        if (!cancelled) {
          setToken(storedToken)
        }
      } catch (error) {
        if (!cancelled) {
          setErrorMessage(toErrorMessage(error))
        }
      } finally {
        if (!cancelled) {
          setIsTokenBootstrapping(false)
        }
      }
    }

    void bootstrapToken()

    return () => {
      cancelled = true
    }
  }, [])

  const pollSourceUntilDone = useCallback(
    async (sourceId: string) => {
      let polling = true

      while (polling) {
        try {
          const currentSource = await api.getSource(sourceId)
          setSources((existing) => upsertSource(existing, currentSource))

          if (TERMINAL_STATUSES.has(currentSource.status)) {
            const finalMessage =
              currentSource.status === 'indexed'
                ? `Source ${currentSource.name} reached status indexed.`
                : `Source ${currentSource.name} failed during processing.`

            setNoticeMessage(finalMessage)
            polling = false
            break
          }
        } catch (error) {
          setErrorMessage(toErrorMessage(error))
          polling = false
          break
        }

        await sleep(POLL_INTERVAL_MS)
      }
    },
    [api],
  )

  const handleAuthenticated = useCallback(async (nextToken: string) => {
    setErrorMessage(null)
    setNoticeMessage('Authorization completed.')
    setToken(nextToken)
    await writeStoredToken(nextToken)
  }, [])

  const handleLogout = useCallback(async () => {
    await clearStoredToken()
    setToken(null)
    setSources([])
    setSelectedSourceId(null)
    setCourse(null)
    setNoticeMessage('Session ended.')
    setErrorMessage(null)
    setActiveTab('sources')
  }, [])

  const handleSourceUpload = useCallback(
    async (file: File, sourceType?: string) => {
      setErrorMessage(null)
      setNoticeMessage('Uploading source...')
      setIsUploading(true)

      try {
        const uploadResult = await api.uploadSource(file, sourceType)

        const optimisticSource: SourceResponse = {
          id: uploadResult.source_id,
          type: sourceType || 'document',
          name: file.name,
          status: uploadResult.status,
          job: {
            id: uploadResult.job_id,
            status: uploadResult.status,
            error: null,
          },
        }

        setSources((existing) => upsertSource(existing, optimisticSource))
        setSelectedSourceId(uploadResult.source_id)
        setNoticeMessage(`Source ${file.name} uploaded. Polling status...`)
        void pollSourceUntilDone(uploadResult.source_id)
      } catch (error) {
        const message = toErrorMessage(error)
        setErrorMessage(message)
        throw error instanceof Error ? error : new Error(message)
      } finally {
        setIsUploading(false)
      }
    },
    [api, pollSourceUntilDone],
  )

  const handleRefreshSource = useCallback(
    async (sourceId: string) => {
      setErrorMessage(null)

      try {
        const source = await api.getSource(sourceId)
        setSources((existing) => upsertSource(existing, source))
        setSelectedSourceId(source.id)

        if (!TERMINAL_STATUSES.has(source.status)) {
          void pollSourceUntilDone(source.id)
        }
      } catch (error) {
        const message = toErrorMessage(error)
        setErrorMessage(message)
        throw error instanceof Error ? error : new Error(message)
      }
    },
    [api, pollSourceUntilDone],
  )

  const handleCreateCourse = useCallback(
    async (payload: CreateCourseRequest) => {
      setErrorMessage(null)
      setIsCreatingCourse(true)

      try {
        const created = await api.createCourse(payload)

        setCourse({
          id: created.course_id,
          title: payload.title,
          goal: payload.goal,
          level: payload.level,
          structure: created.structure,
        })

        setNoticeMessage(`Course ${payload.title} created with id ${created.course_id}.`)
        setActiveTab('viewer')

        try {
          const resolvedCourse = await api.getCourse(created.course_id)
          setCourse(resolvedCourse)
        } catch {
          setNoticeMessage(
            `Course ${payload.title} created. Full structure will load after manual refresh.`,
          )
        }
      } catch (error) {
        const message = toErrorMessage(error)
        setErrorMessage(message)
        throw error instanceof Error ? error : new Error(message)
      } finally {
        setIsCreatingCourse(false)
      }
    },
    [api],
  )

  const handleLoadCourse = useCallback(
    async (courseId: string) => {
      setErrorMessage(null)
      setIsLoadingCourse(true)

      try {
        const nextCourse = await api.getCourse(courseId)
        setCourse(nextCourse)
        setActiveTab('viewer')
      } catch (error) {
        const message = toErrorMessage(error)
        setErrorMessage(message)
        throw error instanceof Error ? error : new Error(message)
      } finally {
        setIsLoadingCourse(false)
      }
    },
    [api],
  )

  if (isTokenBootstrapping) {
    return (
      <div className="shell shell-centered">
        <div className="glass-panel loading-panel">Loading secure session...</div>
      </div>
    )
  }

  if (!token) {
    return (
      <div className="shell shell-auth">
        <section className="glass-panel hero-panel fade-in">
          <p className="eyebrow">Desktop MVP</p>
          <h1>Liquid Glass Course Studio</h1>
          <p>
            Login/register, upload source, track indexing and generate structured courses via
            Gateway API.
          </p>
          <p className="muted-text">Gateway base URL: {gatewayBaseUrl}</p>
        </section>

        <AuthPanel api={api} onAuthenticated={handleAuthenticated} />
      </div>
    )
  }

  return (
    <div className="shell">
      <header className="glass-panel topbar fade-in">
        <div>
          <p className="eyebrow">Liquid Glass</p>
          <h1>Desktop Course Builder</h1>
          <p className="muted-text">Gateway: {gatewayBaseUrl}</p>
        </div>

        <button className="btn btn-secondary" type="button" onClick={() => void handleLogout()}>
          Logout
        </button>
      </header>

      {noticeMessage ? <p className="banner banner-info">{noticeMessage}</p> : null}
      {errorMessage ? <p className="banner banner-error">{errorMessage}</p> : null}

      <main className="workspace">
        <aside className="glass-panel nav-panel fade-in">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              className={`tab-button ${activeTab === tab.key ? 'is-active' : ''}`}
              type="button"
              onClick={() => setActiveTab(tab.key)}
            >
              <span>{tab.label}</span>
              <small>{tab.description}</small>
            </button>
          ))}
        </aside>

        <section>
          {activeTab === 'sources' ? (
            <SourcesPanel
              sources={sources}
              selectedSourceId={selectedSourceId}
              onSelectSource={setSelectedSourceId}
              onUpload={handleSourceUpload}
              onRefresh={handleRefreshSource}
              isUploading={isUploading}
              message={noticeMessage}
            />
          ) : null}

          {activeTab === 'builder' ? (
            <CourseBuilderPanel
              availableSources={sources}
              preferredSourceId={selectedSourceId}
              onCreateCourse={handleCreateCourse}
              isSubmitting={isCreatingCourse}
            />
          ) : null}

          {activeTab === 'viewer' ? (
            <CourseViewerPanel
              course={course}
              onLoadCourse={handleLoadCourse}
              isLoading={isLoadingCourse}
            />
          ) : null}
        </section>
      </main>
    </div>
  )
}

export default App
