import { type FormEvent, useState } from 'react'
import { GatewayApiError, type GatewayClient } from '../lib/api'

type AuthMode = 'login' | 'register'

interface AuthPanelProps {
  api: GatewayClient
  onAuthenticated: (token: string) => Promise<void>
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const toErrorMessage = (error: unknown): string => {
  if (error instanceof GatewayApiError) {
    if (error.status === 401) {
      return 'Неверный email или пароль. Проверьте данные и попробуйте снова.'
    }

    if (error.status === 409) {
      return 'Пользователь с таким email уже существует.'
    }

    return 'Не удалось выполнить запрос. Попробуйте еще раз через минуту.'
  }

  if (error instanceof Error) {
    return error.message
  }

  return 'Не удалось выполнить действие. Попробуйте еще раз.'
}

export const AuthPanel = ({ api, onAuthenticated }: AuthPanelProps) => {
  const [mode, setMode] = useState<AuthMode>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)

  const validate = (): string | null => {
    const normalizedEmail = email.trim()

    if (!normalizedEmail) {
      return 'Введите email, чтобы продолжить.'
    }

    if (!EMAIL_PATTERN.test(normalizedEmail)) {
      return 'Укажите корректный email в формате электронной почты, например primer@pochta.ru.'
    }

    if (password.length < 8) {
      return 'Пароль должен содержать минимум 8 символов.'
    }

    if (mode === 'register' && password !== confirmPassword) {
      return 'Пароли не совпадают. Проверьте ввод.'
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

    setIsSubmitting(true)

    try {
      if (mode === 'register') {
        await api.register({ email: email.trim(), password })
        setSuccessMessage('Аккаунт создан. Выполняем вход...')
      }

      const loginResponse = await api.login({ email: email.trim(), password })
      await onAuthenticated(loginResponse.access_token)
      setPassword('')
      setConfirmPassword('')
    } catch (error) {
      setErrorMessage(toErrorMessage(error))
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <section className="glass-panel auth-panel fade-in">
      <div className="auth-mode-toggle" role="tablist" aria-label="Режим авторизации">
        <button
          className={`mode-pill ${mode === 'login' ? 'is-active' : ''}`}
          type="button"
          onClick={() => {
            setMode('login')
            setErrorMessage(null)
            setSuccessMessage(null)
          }}
        >
          Вход
        </button>
        <button
          className={`mode-pill ${mode === 'register' ? 'is-active' : ''}`}
          type="button"
          onClick={() => {
            setMode('register')
            setErrorMessage(null)
            setSuccessMessage(null)
          }}
        >
          Регистрация
        </button>
      </div>

      <h2>{mode === 'login' ? 'Вход в личный кабинет' : 'Создание нового аккаунта'}</h2>
      <p className="muted-text">
        {mode === 'login'
          ? 'Введите свои данные, чтобы продолжить работу с платформой.'
          : 'Создайте аккаунт, чтобы сохранить прогресс и начать сборку учебных курсов.'}
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
            placeholder="primer@pochta.ru"
          />
        </label>

        <label className="field">
          <span>Пароль</span>
          <input
            required
            className="control"
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            type="password"
            minLength={8}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Минимум 8 символов"
          />
        </label>

        {mode === 'register' ? (
          <label className="field">
            <span>Повторите пароль</span>
            <input
              required
              className="control"
              autoComplete="new-password"
              type="password"
              minLength={8}
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              placeholder="Повторите пароль"
            />
          </label>
        ) : null}

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

        <button className="btn btn-primary" type="submit" disabled={isSubmitting}>
          {isSubmitting
            ? 'Проверяем данные...'
            : mode === 'login'
              ? 'Войти в кабинет'
              : 'Создать аккаунт'}
        </button>
      </form>
    </section>
  )
}
