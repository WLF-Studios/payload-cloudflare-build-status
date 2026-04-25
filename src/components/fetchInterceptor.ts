let isInterceptorInstalled = false

export function installFetchInterceptor(endpointPath: string): void {
  if (isInterceptorInstalled || typeof window === 'undefined') {
    return
  }

  const originalFetch = window.fetch

  const interceptedFetch = new Proxy(originalFetch, {
    apply(target, _thisArg, argArray: Parameters<typeof fetch>) {
      return Reflect.apply(target, window, argArray).then((response: Response) => {
        const [url, options] = argArray
        const method = options?.method?.toUpperCase()

        if (method && ['PATCH', 'POST', 'PUT'].includes(method)) {
          const urlString =
            typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url

          const isContentEndpoint =
            urlString.includes('/api/') &&
            !urlString.includes(endpointPath) &&
            !urlString.includes('/api/auth') &&
            !urlString.includes('/api/preferences') &&
            !urlString.includes('/api/users')

          if (isContentEndpoint && response.ok) {
            window.setTimeout(() => {
              window.dispatchEvent(new CustomEvent('payload-save-complete'))
            }, 1500)
          }
        }

        return response
      })
    },
  }) as typeof fetch

  window.fetch = interceptedFetch
  isInterceptorInstalled = true
}
