/**
 * The HoodGram primitive kit — "Signals Desk".
 *
 * Every component here is bespoke: notched via `clip-path`, hairlined at 1px,
 * mono-labelled, tabular. Green only appears on primary CTAs, the active
 * nav/tab state, confirmed-on-chain status, the live subscription badge and the
 * $GRAM wordmark.
 */

export { Button, SignalBars, buttonClassName } from './Button';
export type {
  ButtonProps,
  ButtonSize,
  ButtonStyleOptions,
  ButtonVariant,
} from './Button';

export { Panel, PanelHeader } from './Panel';
export type {
  PanelPadding,
  PanelProps,
  PanelHeaderProps,
  PanelTag,
  PanelTone,
} from './Panel';

export { Eyebrow, Label } from './Label';
export type { EyebrowProps, EyebrowSize, LabelProps, LabelTone } from './Label';

export { Stat } from './Stat';
export type { StatProps, StatSize, StatTone } from './Stat';

export { Field } from './Field';
export type { FieldProps } from './Field';


export { MonthStepper } from './MonthStepper';
export type { MonthStepperProps } from './MonthStepper';

export { Countdown } from './Countdown';
export type { CountdownProps, CountdownSize } from './Countdown';

export { Hex } from './Hex';
export type { HexProps, HexTone } from './Hex';

export { ToastProvider, useToast } from './Toast';
export type { ToastAction, ToastApi, ToastInput, ToastKind } from './Toast';

export { ConnectSheet } from './ConnectSheet';

export { SiteHeader } from './SiteHeader';

/* Shared hooks and shape helpers the kit is built on. */
export { useCountUp } from '@/lib/use-count-up';
export type { CountUpOptions } from '@/lib/use-count-up';
export { usePrefersReducedMotion } from '@/lib/use-prefers-reduced-motion';
export { shapeClass } from '@/lib/notch';
export type { Notch } from '@/lib/notch';
export { useConnectSheet } from '@/lib/ui-store';
