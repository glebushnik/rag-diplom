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

const STATUS_LABELS: Record<JobStatus, string> = {
  queued: 'Queued',
  processing: 'Processing',
  embedded: 'Embedded',
  indexed: 'Indexed',
  failed: 'Failed',
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
  }

  const handleUpload = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setErrorMessage(null)

    if (!selectedFile) {
      setErrorMessage('Select a file before uploading.')
      return
    }

    try {
      await onUpload(selectedFile, sourceType)
      setSelectedFile(null)

      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Upload failed.')
    }
  }

  return (
    <section className="glass-panel content-panel fade-in">
      <header className="section-header">
        <h2>Sources</h2>
        <p className="muted-text">Upload документ и дождитесь статуса job = indexed.</p>
      </header>

      <form className="form" onSubmit={handleUpload}>
        <div className="field-grid">
          <label className="field">
            <span>Document</span>
            <input
              ref={fileInputRef}
              className="control"
              type="file"
              onChange={handleFileChange}
              accept=".pdf,.doc,.docx,.txt,.md"
            />
          </label>

          <label className="field">
            <span>Type</span>
            <select
              className="control"
              value={sourceType}
              onChange={(event) => setSourceType(event.target.value)}
            >
              <option value="document">document</option>
              <option value="url">url</option>
              <option value="notes">notes</option>
            </select>
          </label>
        </div>

        {errorMessage ? <p className="inline-error">{errorMessage}</p> : null}

        <button className="btn btn-primary" type="submit" disabled={isUploading}>
          {isUploading ? 'Uploading...' : 'Upload Source'}
        </button>
      </form>

      {message ? <p className="inline-info">{message}</p> : null}

      <div className="source-list">
        {sources.length === 0 ? (
          <p className="muted-text">Sources not uploaded yet.</p>
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
                  <p className="source-meta">{source.id}</p>
                  <div className="row source-status-row">
                    <span className={statusClassName}>{STATUS_LABELS[jobStatus]}</span>
                    <span className="muted-text">job: {jobStatus}</span>
                  </div>
                  {source.job?.error ? (
                    <p className="inline-error">Job error: {source.job.error}</p>
                  ) : null}
                </div>

                <div className="row source-actions">
                  <button
                    className="btn btn-secondary"
                    type="button"
                    onClick={() => onSelectSource(source.id)}
                  >
                    Use Source
                  </button>
                  <button
                    className="btn btn-ghost"
                    type="button"
                    onClick={() => onRefresh(source.id)}
                  >
                    Refresh
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
