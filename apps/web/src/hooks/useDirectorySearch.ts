/**
 * Live directory search for the conversation rail.
 *
 * Two lanes, deliberately different speeds:
 *  - LOCAL: instant substring filter over the conversations this device holds
 *    (room names, peer addresses, cached @handles), re-run on every keystroke.
 *  - GLOBAL: a debounced on-chain lookup when the input could name someone new
 *    (a full 0x address, or a plausible @handle), producing one "start a chat"
 *    row with clear resolving / found / unclaimed / no-keys / error states.
 *
 * Enter-to-submit stays byte-for-byte what it was: the form's own onSubmit
 * still resolves independently, so pasting an address and hitting Enter never
 * waits on the debounce.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { isAddress, type Address } from 'viem';
import { useConfig } from 'wagmi';
import { readContract } from 'wagmi/actions';

import { keyRegistryAbi } from '@/lib/abi';
import { ACTIVE_CHAIN_ID, tryGetContracts } from '@/lib/chain';
import { isDemoActive } from '@/lib/demo';
import { useDebounced } from '@/lib/use-debounced';
import type { Conversation } from './types';
import { HANDLE_RE, peekHandle, resolveRecipient, subscribeHandles } from './useHandles';

const ZERO_KEY = `0x${'00'.repeat(32)}`;

export type GlobalLookupPhase =
  | 'idle'
  | 'resolving'
  | 'found'
  | 'unclaimed'
  | 'no-keys'
  | 'error';

export interface GlobalLookup {
  readonly phase: GlobalLookupPhase;
  readonly identity: { readonly address: Address; readonly handle: string | null } | null;
  /** Human-readable copy for the unclaimed / no-keys / error states. */
  readonly message: string | null;
}

export interface DirectorySearchResult {
  /** Conversations on this device matching the query, in rail order. */
  readonly localMatches: readonly Conversation[];
  readonly global: GlobalLookup;
}

const IDLE: GlobalLookup = { phase: 'idle', identity: null, message: null };

function matchesLocal(conversation: Conversation, needle: string): boolean {
  if (conversation.room !== null) {
    return conversation.room.name.toLowerCase().includes(needle);
  }
  if (conversation.unattributed) {
    return 'unattributed'.includes(needle);
  }
  const address = conversation.peerAddress?.toLowerCase() ?? '';
  if (address !== '') {
    if (address.includes(needle) || address.slice(2).includes(needle)) return true;
    const handle = peekHandle(address);
    if (handle !== null && `@${handle}`.includes(needle)) return true;
  }
  return false;
}

export function useDirectorySearch(
  query: string,
  conversations: readonly Conversation[],
): DirectorySearchResult {
  const config = useConfig();
  const [global, setGlobal] = useState<GlobalLookup>(IDLE);
  const seqRef = useRef(0);

  /* Handle-cache version counter, so local matches refresh when a name lands. */
  const [handleVersion, setHandleVersion] = useState(0);
  useEffect(() => subscribeHandles(() => setHandleVersion((v) => v + 1)), []);

  const needle = query.trim().toLowerCase().replace(/^@/, '');

  const localMatches = useMemo(() => {
    void handleVersion;
    if (needle === '') return [];
    return conversations.filter((conversation) => matchesLocal(conversation, needle));
  }, [conversations, needle, handleVersion]);

  const settled = useDebounced(query.trim(), 300);

  useEffect(() => {
    const token = ++seqRef.current;
    const candidate = settled;
    if (candidate === '') {
      setGlobal(IDLE);
      return;
    }
    const bare = candidate.replace(/^@/, '').toLowerCase();
    const isAddressCandidate = isAddress(candidate, { strict: false });
    if (!isAddressCandidate && !HANDLE_RE.test(bare)) {
      setGlobal(IDLE); // short garbage just filters locally, never an error
      return;
    }

    setGlobal({ phase: 'resolving', identity: null, message: null });

    void (async (): Promise<void> => {
      const resolved = await resolveRecipient(config, candidate);
      if (seqRef.current !== token) return; // a newer query superseded us
      if (!resolved.ok) {
        const phase: GlobalLookupPhase =
          resolved.failure.reason === 'unclaimed'
            ? 'unclaimed'
            : resolved.failure.reason === 'chain'
              ? 'error'
              : 'idle';
        setGlobal(
          phase === 'idle'
            ? IDLE
            : { phase, identity: null, message: resolved.failure.message },
        );
        return;
      }

      const identity = {
        address: resolved.recipient.address,
        handle: resolved.recipient.handle,
      };

      if (isDemoActive()) {
        setGlobal({ phase: 'found', identity, message: null });
        return;
      }

      const contracts = tryGetContracts(ACTIVE_CHAIN_ID);
      if (contracts === null) {
        setGlobal({
          phase: 'error',
          identity,
          message: 'HoodGram is not configured for this chain, so the key registry cannot be read.',
        });
        return;
      }
      try {
        const keysOf = await readContract(config, {
          address: contracts.keyRegistry,
          abi: keyRegistryAbi,
          functionName: 'keysOf',
          args: [identity.address],
          chainId: ACTIVE_CHAIN_ID,
        });
        if (seqRef.current !== token) return;
        if (keysOf[0].toLowerCase() === ZERO_KEY) {
          setGlobal({
            phase: 'no-keys',
            identity,
            message:
              'That account has not registered messaging keys yet. Registering is free. Ask them to open HoodGram once.',
          });
          return;
        }
        setGlobal({ phase: 'found', identity, message: null });
      } catch {
        if (seqRef.current !== token) return;
        setGlobal({
          phase: 'error',
          identity,
          message: 'The key registry could not be read. Check the connection and try again.',
        });
      }
    })();
  }, [config, settled]);

  return { localMatches, global };
}
