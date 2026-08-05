import { create } from 'zustand';

/**
 * Global UI state that is not tied to a route.
 *
 * The wallet sheet lives here rather than in a provider so any surface can open
 * it — the header control, the `/app` locked state, the `/access` approve step —
 * without prop-drilling or a third-party modal.
 */
interface ConnectSheetState {
  readonly isOpen: boolean;
  /** Why the sheet was opened; lets the sheet explain itself in context. */
  readonly reason: string | null;
  open: (reason?: string) => void;
  close: () => void;
  toggle: () => void;
}

export const useConnectSheet = create<ConnectSheetState>()((set, get) => ({
  isOpen: false,
  reason: null,
  open: (reason) => set({ isOpen: true, reason: reason ?? null }),
  close: () => set({ isOpen: false, reason: null }),
  toggle: () => (get().isOpen ? set({ isOpen: false, reason: null }) : set({ isOpen: true })),
}));

/**
 * How outgoing drops reach the chain.
 *
 * The default is the gasless path: the relay verifies the drop signature and
 * posts the anchor itself. `selfPost` switches to `Anchors.post` from the
 * user's own wallet — one transaction per message, gas only — which is the
 * fallback when the relay is down or refusing sends. Session-scoped on
 * purpose: a deliberate escape hatch, not a sticky setting.
 */
interface SendPrefsState {
  /** True → anchor via the user's wallet instead of the relay. */
  readonly selfPost: boolean;
  setSelfPost: (on: boolean) => void;
  toggleSelfPost: () => void;
}

export const useSendPrefs = create<SendPrefsState>()((set, get) => ({
  selfPost: false,
  setSelfPost: (on) => set({ selfPost: on }),
  toggleSelfPost: () => set({ selfPost: !get().selfPost }),
}));
