import { useMemo, useState } from 'react'
import type { CourseResponse, JobStatus, SourceResponse } from '../types'

export type AdminActivityLevel = 'info' | 'error'

export interface AdminActivityEntry {
  id: string
  timestamp: string
  level: AdminActivityLevel
  message: string
}

interface AdminPanelProps {
  sources: SourceResponse[]
  course: CourseResponse | null
  selectedSourceId: string | null
  gatewayBaseUrl: string
  activityLog: AdminActivityEntry[]
  onRefreshSource: (sourceId: string) => Promise<void>
}

const STATUS_ORDER: JobStatus[] = ['queued', 'processing', 'embedded', 'indexed', 'failed']

const STATUS_LABELS: Record<JobStatus, string> = {
  queued: 'В очереди',
  processing: 'В обработке',
  embedded: 'Векторизация',
  indexed: 'Готово',
  failed: 'Ошибка',
}

const formatDate = (value: string): string => {
  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    return value
  }

  return date.toLocaleString('ru-RU')
}

export const AdminPanel = ({
  sources,
  course,
  selectedSourceId,
  gatewayBaseUrl,
  activityLog,
  onRefreshSource,
}: AdminPanelProps) => {
  const [isRefreshingSelected, setIsRefreshingSelected] = useState(false)

  const statusCounts = useMemo(() => {
    const counts: Record<JobStatus, number> = {
      queued: 0,
      processing: 0,
      embedded: 0,
      indexed: 0,
      failed: 0,
    }

    for (const source of sources) {
      counts[source.status] += 1
    }

    return counts
  }, [sources])

  const canRefreshSelected = Boolean(selectedSourceId)

  const handleRefreshSelected = async () => {
    if (!selectedSourceId) {
      return
    }

    setIsRefreshingSelected(true)

    try {
      await onRefreshSource(selectedSourceId)
    } finally {
      setIsRefreshingSelected(false)
    }
  }

  return (
    <section className="glass-panel content-panel admin-panel fade-in">
      <header className="section-header">
        <h2>Админ-панель</h2>
        <p className="muted-text">
          Техническая зона для мониторинга процессов, статусов и сырых данных платформы.
        </p>
      </header>

      <div className="admin-metrics-grid">
        <article className="admin-metric-card">
          <p className="admin-metric-label">Всего источников</p>
          <p className="admin-metric-value">{sources.length}</p>
        </article>

        <article className="admin-metric-card">
          <p className="admin-metric-label">Источник в фокусе</p>
          <p className="admin-metric-value admin-metric-code">{selectedSourceId ?? 'не выбран'}</p>
        </article>

        <article className="admin-metric-card">
          <p className="admin-metric-label">Текущий курс</p>
          <p className="admin-metric-value admin-metric-code">{course?.id ?? 'не загружен'}</p>
        </article>
      </div>

      <div className="admin-status-grid">
        {STATUS_ORDER.map((status) => (
          <article key={status} className="admin-status-card">
            <p className="admin-status-title">{STATUS_LABELS[status]}</p>
            <p className="admin-status-value">{statusCounts[status]}</p>
          </article>
        ))}
      </div>

      <div className="admin-actions-row">
        <button
          className="btn btn-secondary"
          type="button"
          onClick={() => void handleRefreshSelected()}
          disabled={!canRefreshSelected || isRefreshingSelected}
        >
          {isRefreshingSelected ? 'Обновляем...' : 'Обновить выбранный источник'}
        </button>
      </div>

      <section className="admin-block">
        <h3>Технические параметры</h3>
        <div className="admin-technical-grid">
          <div>
            <p className="admin-metric-label">Адрес API</p>
            <p className="admin-metric-code">{gatewayBaseUrl}</p>
          </div>
          <div>
            <p className="admin-metric-label">Выбранный источник</p>
            <p className="admin-metric-code">{selectedSourceId ?? 'не выбран'}</p>
          </div>
          <div>
            <p className="admin-metric-label">Курс для анализа</p>
            <p className="admin-metric-code">{course?.id ?? 'не выбран'}</p>
          </div>
        </div>
      </section>

      <section className="admin-block">
        <h3>Сырые данные источников</h3>
        <pre>{JSON.stringify(sources, null, 2)}</pre>
      </section>

      <section className="admin-block">
        <h3>Сырые данные курса</h3>
        <pre>{course ? JSON.stringify(course, null, 2) : 'Курс пока не загружен.'}</pre>
      </section>

      <section className="admin-block">
        <h3>Лента событий</h3>
        <div className="admin-log-list">
          {activityLog.length === 0 ? (
            <p className="muted-text">События появятся после действий в системе.</p>
          ) : (
            activityLog.map((entry) => (
              <article
                className={`admin-log-item ${entry.level === 'error' ? 'is-error' : 'is-info'}`}
                key={entry.id}
              >
                <p>{entry.message}</p>
                <p className="admin-log-time">{formatDate(entry.timestamp)}</p>
              </article>
            ))
          )}
        </div>
      </section>
    </section>
  )
}
