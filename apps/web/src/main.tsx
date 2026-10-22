import { StrictMode, Suspense, lazy, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import './index.css'
import { Toasts } from './components/Toasts'
import { Spinner } from './components/ui'

const Desk = lazy(() => import('./pages/Desk'))
const Tv = lazy(() => import('./pages/Tv'))
const Remote = lazy(() => import('./pages/Remote'))

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 30_000 },
  },
})

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
      <Toasts />
    </QueryClientProvider>
  </StrictMode>,
)
