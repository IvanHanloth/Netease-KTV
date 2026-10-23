import { StrictMode, Suspense, lazy, useEffect, useRef, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
// Fonts are bundled (no Google Fonts): works offline / on networks where Google is blocked.
// Noto Sans SC is split by unicode-range, so browsers only download the subsets they need.
import '@fontsource/noto-sans-sc/400.css'
import '@fontsource/noto-sans-sc/500.css'
import '@fontsource/noto-sans-sc/600.css'
import '@fontsource/noto-sans-sc/700.css'
import '@fontsource/noto-sans-sc/900.css'
import '@fontsource/outfit/400.css'
import '@fontsource/outfit/500.css'
import '@fontsource/outfit/600.css'
import '@fontsource/outfit/700.css'
import './index.css'
import { Toasts } from './components/Toasts'
import { Spinner } from './components/ui'
import { isRetryable } from './lib/api'
import { useApp } from './store/app'

const Desk = lazy(() => import('./pages/Desk'))
const Tv = lazy(() => import('./pages/Tv'))
const Remote = lazy(() => import('./pages/Remote'))

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Phones drop Wi-Fi when the screen sleeps: retry network / server errors with backoff,
      // but not 4xx (those won't fix themselves).
      retry: (count, error) => isRetryable(error) && count < 4,
      retryDelay: (attempt) => Math.min(500 * 2 ** attempt, 4000),
      // Back from background / network restored: refresh anything stale or failed.
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      staleTime: 30_000,
    },
  },
})

/** When the WebSocket comes back after a drop, refetch queries that failed while it was down. */
function ConnectionWatcher() {
  const connected = useApp((s) => s.connected)
  const was = useRef(connected)
  useEffect(() => {
    if (connected && !was.current) {
      void queryClient.refetchQueries({ predicate: (q) => q.state.status === 'error' })
      void queryClient.invalidateQueries({ stale: true })
    }
    was.current = connected
  }, [connected])
  return null
}

const fallback = (
  <div className="flex h-full items-center justify-center text-muted">
    <Spinner size={28} />
  </div>
)

const page = (el: ReactElement) => <Suspense fallback={fallback}>{el}</Suspense>

const router = createBrowserRouter([
  { path: '/', element: page(<Desk />) },
  { path: '/tv', element: page(<Tv />) },
  { path: '/m', element: page(<Remote />) },
  { path: '*', element: page(<Desk />) },
])

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <ConnectionWatcher />
      <Toasts />
    </QueryClientProvider>
  </StrictMode>,
)
