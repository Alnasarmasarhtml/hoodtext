/**
 * Messenger hooks (SPEC §7.3).
 *
 * `useIdentity` and `useDrops` are mounted once, by the app shell; everything
 * else reads the shared engine state and is safe to use anywhere below it.
 */

export { useIdentity } from './useIdentity';
export type { IdentityStatus, UseIdentityResult } from './useIdentity';

export { useActivation } from './useActivation';
export type { UseActivationResult } from './useActivation';

export { useDrops } from './useDrops';
export type { UseDropsParams, UseDropsResult } from './useDrops';

export {
  useConversation,
  useConversationMessages,
  useConversations,
  useStartConversation,
} from './useConversations';
export type {
  StartStatus,
  UseConversationsResult,
  UseStartConversationParams,
  UseStartConversationResult,
} from './useConversations';

export {
  MAX_ATTACHMENT_BYTES,
  MAX_BODY_BYTES,
  previewEnvelope,
  useSendMessage,
} from './useSendMessage';
export type {
  EnvelopePreview,
  SendInput,
  SendMediaInput,
  SendReactionInput,
  SendStage,
  UseSendMessageParams,
  UseSendMessageResult,
} from './useSendMessage';

export {
  HANDLE_RE,
  resolveRecipient,
  useDisplayName,
  useHandle,
  usePerkTier,
} from './useHandles';
export type {
  RecipientFailure,
  RecipientResult,
  ResolvedRecipient,
} from './useHandles';

export {
  useAdminRentAlert,
  useCreateRoom,
  usePayRent,
  useRentQuote,
  useRoom,
  useRoomChain,
  useRoomRoster,
  useRooms,
} from './useRooms';
export type {
  AdminRentAlert,
  CreateRoomPhase,
  PayRentPhase,
  RoomChainState,
  RosterPhase,
  UseCreateRoomResult,
  UsePayRentResult,
  UseRoomRosterParams,
  UseRoomRosterResult,
} from './useRooms';

export { useRelayStatus } from './useRelayStatus';
export type { UseRelayStatusResult } from './useRelayStatus';

export { describeChainError } from './errors';

export {
  STEALTH_CONVO_ID,
  UNATTRIBUTED_CONVO_ID,
  compareMessages,
  parseMediaPayload,
  parseReactionPayload,
  parseRoomKeyPayload,
} from './types';
export type {
  ChatMessage,
  Conversation,
  MediaPayload,
  MessageDirection,
  MessageIntegrity,
  MessageKind,
  MessageStatus,
  PeerRecord,
  ReactionPayload,
  RoomKeyPayload,
  RoomRecord,
  TamperEvent,
} from './types';
