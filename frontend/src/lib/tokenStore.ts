const FALLBACK_TOKEN_KEY = 'diplom.gateway.jwt'

export const readStoredToken = async (): Promise<string | null> => {
  if (window.desktopAuth) {
    return window.desktopAuth.getToken()
  }

  return window.localStorage.getItem(FALLBACK_TOKEN_KEY)
}

export const writeStoredToken = async (token: string): Promise<void> => {
  if (window.desktopAuth) {
    await window.desktopAuth.setToken(token)
    return
  }

  window.localStorage.setItem(FALLBACK_TOKEN_KEY, token)
}

export const clearStoredToken = async (): Promise<void> => {
  if (window.desktopAuth) {
    await window.desktopAuth.clearToken()
    return
  }

  window.localStorage.removeItem(FALLBACK_TOKEN_KEY)
}
