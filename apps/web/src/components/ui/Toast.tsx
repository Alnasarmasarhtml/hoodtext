'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

import { cx } from '@/lib/cx';
import s from './Toast.module.css';

export type ToastKind = 'info' | 'success' | 'error';

export interface ToastAction {
  readonly label: string;
  readonly onClick: () => void;
}

export interface ToastInput {
  readonly title: string;
  readonly body?: string;
  /** `success` is reserved for confirmed-on-chain results. */
  readonly kind?: ToastKind;
  /** ms before auto-dismiss; `0` keeps it until dismissed. Default 6000. */
  readonly duration?: number;
  readonly action?: ToastAction;
}

interface ToastRecord {
  readonly id: string;
  readonly title: string;
  readonly body: string | undefined;
  readonly kind: ToastKind;
  readonly duration: number;
  readonly action: ToastAction | undefined;
  readonly closing: boolean;
}

export interface ToastApi {
  /** Queue a toast; returns its id. */
  push: (toast: ToastInput) => string;
  dismiss: (id: string) => void;
  clear: () => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const KIND_LABEL: Readonly<Record<ToastKind, string>> = {
  info: 'Notice',
  success: 'Confirmed',
  error: 'Failed',
};

const EXIT_MS = 200;

let counter = 0;
function nextId(): string {
  counter += 1;
  return `t${counter.toString(36)}`;
}

export function ToastProvider({ children }: { children: ReactNode }): ReactNode {
  const [toasts, setToasts] = useState<readonly ToastRecord[]>([]);
  const [mounted, setMounted] = useState(false);
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => setMounted(true), []);

  const clearTimer = useCallback((id: string): void => {
    const timer = timersRef.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }, []);

  const remove = useCallback(
    (id: string): void => {
      clearTimer(id);
      clearTimer(`${id}:exit`);
      setToasts((current) => current.filter((t) => t.id !== id));
    },
    [clearTimer],
  );

  const dismiss = useCallback(
    (id: string): void => {
      clearTimer(id);
      setToasts((current) =>
        current.map((t) => (t.id === id ? { ...t, closing: true } : t)),
      );
      const exit = setTimeout(() => remove(id), EXIT_MS);
      timersRef.current.set(`${id}:exit`, exit);
    },
    [clearTimer, remove],
  );

  const schedule = useCallback(
    (id: string, duration: number): void => {
      if (duration <= 0) return;
      clearTimer(id);
      timersRef.current.set(
        id,
        setTimeout(() => dismiss(id), duration),
      );
    },
    [clearTimer, dismiss],
  );

  const push = useCallback(
    (input: ToastInput): string => {
      const id = nextId();
      const record: ToastRecord = {
        id,
        title: input.title,
        body: input.body,
        kind: input.kind ?? 'info',
        duration: input.duration ?? 6000,
        action: input.action,
        closing: false,
      };
      setToasts((current) => [...current.slice(-3), record]);
      schedule(id, record.duration);
      return id;
    },
    [schedule],
  );

  const clear = useCallback((): void => {
    for (const timer of timersRef.current.values()) clearTimeout(timer);
    timersRef.current.clear();
    setToasts([]);
  }, []);

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  const api = useMemo<ToastApi>(() => ({ push, dismiss, clear }), [clear, dismiss, push]);

  const viewport = (
    <div className={s.viewport} role="region" aria-label="Notifications">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={cx(s.toast, s[toast.kind], toast.closing && s.closing)}
          role={toast.kind === 'error' ? 'alert' : 'status'}
          onPointerEnter={() => clearTimer(toast.id)}
          onPointerLeave={() => schedule(toast.id, Math.min(toast.duration, 2500))}
        >
          <div className={s.body}>
            <span className={s.kind}>
              <span className={s.mark} aria-hidden="true" />
              {KIND_LABEL[toast.kind]}
            </span>
            <span className={s.title}>{toast.title}</span>
            {toast.body !== undefined && <span className={s.text}>{toast.body}</span>}
            {toast.action !== undefined && (
              <button type="button" className={s.action} onClick={toast.action.onClick}>
                {toast.action.label}
              </button>
            )}
          </div>

          <button
            type="button"
            className={s.close}
            onClick={() => dismiss(toast.id)}
            aria-label="Dismiss notification"
          >
            <svg className={s.closeIcon} viewBox="0 0 10 10" aria-hidden="true">
              <path d="M1 1l8 8M9 1l-8 8" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      {mounted && toasts.length > 0 ? createPortal(viewport, document.body) : null}
    </ToastContext.Provider>
  );
}

/**
 * Queue notifications from anywhere under `<Providers>`.
 *
 * @example toast.push({ kind: 'success', title: 'Anchored', body: `Block ${n}` })
 */
export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (ctx === null) {
    throw new Error('useToast must be used inside <Providers> (ToastProvider is missing).');
  }
  return ctx;
}
