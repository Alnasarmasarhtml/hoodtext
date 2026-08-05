/**
 * The messenger surface (SPEC §7.3).
 *
 * `AppShell` is the only piece a route mounts: it runs the identity ceremony
 * and the receive engine once, then hands the resolved session to the rail and
 * the pane through `AppSessionProvider`.
 */

export { AppShell } from './AppShell';
export type { AppShellProps } from './AppShell';

export { AppNotice } from './AppNotice';
export type { AppNoticeProps, AppNoticeTone } from './AppNotice';

export { IdentityGate } from './IdentityGate';
export type { IdentityGateProps } from './IdentityGate';

export { ConversationList } from './ConversationList';
export type { ConversationListProps } from './ConversationList';

export { ThreadRoute } from './Thread';
export type { ThreadRouteProps } from './Thread';

export { ThreadPlaceholder } from './ThreadPlaceholder';

export { Composer } from './Composer';
export type { ComposerProps } from './Composer';

export { MessageRow, REACTION_EMOJI } from './MessageRow';
export type { MessageRowProps, ReactionSummary } from './MessageRow';

export { MediaAttachment } from './MediaAttachment';
export type { MediaAttachmentProps } from './MediaAttachment';

export { LockedNotice } from './LockedNotice';
export type { LockedNoticeProps } from './LockedNotice';

export { AccountBadge } from './AccountBadge';
export type { AccountBadgeProps } from './AccountBadge';

export { PerkChip } from './PerkChip';
export type { PerkChipProps } from './PerkChip';

export { RoomCreate } from './RoomCreate';

export { RoomMembers } from './RoomMembers';
export type { RoomMembersProps } from './RoomMembers';

export { DemoBanner } from './DemoBanner';
export type { DemoBannerProps } from './DemoBanner';

export { RelayStatus } from './RelayStatus';
export type { RelayStatusProps } from './RelayStatus';

export { TamperBanner } from './TamperBanner';
export type { TamperBannerProps } from './TamperBanner';

export { AppSessionProvider, useAppSession } from './session';
export type { AppSession } from './session';
