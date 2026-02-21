import { type FormEvent, useState } from 'react'
import { GatewayApiError, type GatewayClient } from '../lib/api'

type AuthMode = 'login' | 'register'

interface AuthPanelProps {
  api: GatewayClient
  onAuthenticated: (token: string) => Promise<void>
}

const toErrorMessage = (error: unknown): string => {
  if (error instanceof GatewayApiError) {
    return error.message
  }

  if (error instanceof Error) {
    return error.message
  }

  return 'Unexpected authentication error.'
}

export const AuthPanel = ({ api, onAuthenticated }: AuthPanelProps) => {
  const [mode, setMode] = useState<AuthMode>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    setIsSubmitting(true)
    setErrorMessage(null)

    try {
      if (mode === 'register') {
        await api.register({ email, password })
      }

      const loginResponse = await api.login({ email, password })
      await onAuthenticated(loginResponse.access_token)
      setPassword('')
    } catch (error) {
      setErrorMessage(toErrorMessage(error))
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <section className="glass-panel auth-panel fade-in">
      <h2>{mode === 'login' ? 'Sign In' : 'Create Account'}</h2>
      <p className="muted-text">
        JWT хранится в памяти и в secure storage через Electron main process.
      </p>

      <form className="form" onSubmit={handleSubmit}>
        <label className="field">
          <span>Email</span>
          <input
            required
            className="control"
            autoComplete="email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>

        <label className="field">
          <span>Password</span>
          <input
            required
            className="control"
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            type="password"
            minLength={6}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>

        {errorMessage ? <p className="inline-error">{errorMessage}</p> : null}

        <div className="row actions-row">
          <button className="btn btn-primary" type="submit" disabled={isSubmitting}>
            {isSubmitting ? 'Submitting...' : mode === 'login' ? 'Login' : 'Register'}
          </button>

          <button
            className="btn btn-secondary"
            type="button"
            onClick={() => setMode(mode === 'login' ? 'register' : 'login')}
            disabled={isSubmitting}
          >
            {mode === 'login' ? 'Need account?' : 'Have account?'}
          </button>
        </div>
      </form>
    </section>
  )
}
