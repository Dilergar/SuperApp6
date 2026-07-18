'use client';

import React, { Component, type ErrorInfo } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState, useRef } from 'react';
import { useAuthStore } from '@/lib/stores/auth';
import { CallsWatcher } from '@/components/calls/CallsWatcher';

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 1000 * 60,
            // Живость данных дают socket-события и точечные инвалидации; дефолтный
            // refetch-on-focus с 30+ смонтированными запросами устраивал шторм из
            // 8–30 запросов на каждый Alt-Tab. Точечно включается там, где надо.
            refetchOnWindowFocus: false,
            // Ретраим только сеть/5xx: клиентские ошибки (403 отозванный доступ,
            // 404) повторным запросом не лечатся — лишь задерживают ошибку в UI.
            retry: (failureCount, error) => {
              if (failureCount >= 2) return false;
              const status = (error as { response?: { status?: number } } | null)?.response
                ?.status;
              return status === undefined || status >= 500;
            },
          },
        },
      }),
  );

  const hydrate = useAuthStore((s) => s.hydrate);
  const hydrated = useRef(false);
  useEffect(() => {
    if (!hydrated.current) {
      hydrated.current = true;
      hydrate();
    }
  }, [hydrate]);

  return (
    <QueryClientProvider client={queryClient}>
      <ErrorBoundary>
        {children}
        {/* Входящие звонки ловятся на любой странице (модалка + рингтон) */}
        <CallsWatcher />
      </ErrorBoundary>
    </QueryClientProvider>
  );
}

// ============================================================
// Error Boundary — catches render errors, shows fallback
// ============================================================

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends Component<{ children: React.ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('ErrorBoundary caught:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexDirection: 'column', gap: '1rem', padding: '2rem', textAlign: 'center',
          fontFamily: 'Plus Jakarta Sans, sans-serif', color: '#38392d',
        }}>
          <h2 style={{ fontFamily: 'Epilogue, sans-serif', fontSize: '1.5rem' }}>Что-то пошло не так</h2>
          <p style={{ fontSize: '0.9rem', color: '#5e5e52' }}>{this.state.error?.message}</p>
          <button
            onClick={() => { this.setState({ hasError: false, error: null }); window.location.reload(); }}
            style={{
              padding: '0.5rem 1.5rem', background: '#c61a1e', color: '#fff',
              border: 'none', borderRadius: '0.5rem', cursor: 'pointer', fontWeight: 600,
            }}
          >
            Перезагрузить
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
