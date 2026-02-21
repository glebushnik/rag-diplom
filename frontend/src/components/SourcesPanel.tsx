import { type ChangeEvent, type FormEvent, useRef, useState } from 'react'
import type { JobStatus, SourceResponse } from '../types'

interface SourcesPanelProps {
  sources: SourceResponse[]
  selectedSourceId: string | null
  onSelectSource: (sourceId: string) => void
  onUpload: (file: File, sourceType?: string) => Promise<void>
  onRefresh: (sourceId: string) => Promise<void>
  isUploading: boolean
  message: string | null
}

const MAX_FILE_SIZE_MB = 30
const MAX_FILE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024

const STATUS_LABELS: Record<JobStatus, string> = {
  queued: 'В очереди',
  processing: 'В обработке',
  embedded: 'Векторизация',
  indexed: 'Готово',
  failed: 'Ошибка',
}

const STATUS_HINTS: Record<JobStatus, string> = {
  queued: 'Файл добавлен в очередь и скоро начнет обрабатываться.',
  processing: 'Система анализирует содержимое документа.',
  embedded: 'Материал разбит на части и подготовлен для поиска.',
  indexed: 'Источник готов. Можно собирать курс.',
  failed: 'Обработка завершилась с ошибкой. Проверьте файл и попробуйте снова.',
}

const formatSize = (value: number): string => {
  if (value < 1024 * 1024) {
    return `${Math.ceil(value / 1024)} КБ`
  }

  return `${(value / (1024 * 1024)).toFixed(1)} МБ`
}

export const SourcesPanel = ({
  sources,
  selectedSourceId,
  onSelectSource,
  onUpload,
  onRefresh,
  isUploading,
  message,
}: SourcesPanelProps) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [sourceType, setSourceType] = useState('document')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    setSelectedFile(event.target.files?.[0] ?? null)
    setErrorMessage(null)
  }

  const handleUpload = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setErrorMessage(null)

    if (!selectedFile) {
      setErrorMessage('Сначала выберите файл для загрузки.')
      return
    }

    if (selectedFile.size > MAX_FILE_BYTES) {
      setErrorMessage(`Размер файла не должен превышать ${MAX_FILE_SIZE_MB} МБ.`)
      return
    }

    try {
      await onUpload(selectedFile, sourceType)
      setSelectedFile(null)

      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : 'Не удалось загрузить источник. Попробуйте снова.',
      )
    }
  }

  return (
    <section className="glass-panel content-panel fade-in">
      <header className="section-header">
        <h2>Шаг 1. Добавьте учебный материал</h2>
        <p className="muted-text">
          Загрузите документ. Когда статус станет «Готово», можно переходить к сборке курса.
        </p>
      </header>

      <form className="form" onSubmit={handleUpload}>
        <div className="field-grid">
          <label className="field">
            <span>Файл</span>
            <input
              ref={fileInputRef}
              className="control"
              type="file"
              onChange={handleFileChange}
              accept=".pdf,.doc,.docx,.txt,.md"
            />
          </label>

          <label className="field">
            <span>Тип материала</span>
            <select
              className="control"
              value={sourceType}
              onChange={(event) => setSourceType(event.target.value)}
            >
              <option value="document">Документ</option>
              <option value="url">Веб-страница</option>
              <option value="notes">Заметки</option>
            </select>
          </label>
        </div>

        {selectedFile ? (
          <p className="muted-text">
            Выбран файл: {selectedFile.name} ({formatSize(selectedFile.size)})
          </p>
        ) : null}

        {errorMessage ? (
          <p className="form-message form-message-error validation-pop" role="alert">
            {errorMessage}
          </p>
        ) : null}

        <button className="btn btn-primary" type="submit" disabled={isUploading}>
          {isUploading ? 'Загружаем материал...' : 'Загрузить материал'}
        </button>
      </form>

      {message ? (
        <p className="form-message form-message-success" role="status">
          {message}
        </p>
      ) : null}

      <div className="source-list">
        {sources.length === 0 ? (
          <p className="muted-text">
            Пока нет загруженных материалов. Добавьте первый документ, чтобы начать.
          </p>
        ) : (
          sources.map((source) => {
            const jobStatus = source.job?.status ?? source.status
            const statusClassName = `status-badge status-${jobStatus}`

            return (
              <article
                key={source.id}
                className={`source-item ${selectedSourceId === source.id ? 'is-active' : ''}`}
              >
                <div className="source-item-main">
                  <p className="source-name">{source.name}</p>
                  <p className="source-meta">Тип: {source.type}</p>
                  <div className="row source-status-row">
                    <span className={statusClassName}>{STATUS_LABELS[jobStatus]}</span>
                    <span className="muted-text">{STATUS_HINTS[jobStatus]}</span>
                  </div>
                  {source.job?.error ? (
                    <p className="form-message form-message-error validation-pop">
                      Подробности ошибки: {source.job.error}
                    </p>
                  ) : null}
                </div>

                <div className="row source-actions">
                  <button
                    className="btn btn-secondary"
                    type="button"
                    onClick={() => onSelectSource(source.id)}
                  >
                    {selectedSourceId === source.id ? 'Выбрано' : 'Выбрать для курса'}
                  </button>
                  <button
                    className="btn btn-ghost"
                    type="button"
                    onClick={() => void onRefresh(source.id)}
                  >
                    Проверить статус
                  </button>
                </div>
              </article>
            )
          })
        )}
      </div>
    </section>
  )
}
