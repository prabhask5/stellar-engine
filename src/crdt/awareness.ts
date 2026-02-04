/**
 * CRDT Awareness (Presence) Management
 *
 * Manages Yjs Awareness protocol for user presence indicators
 * (cursor positions, active users, etc.) via Supabase broadcast.
 */

import { Awareness } from 'y-protocols/awareness';
import * as awarenessProtocol from 'y-protocols/awareness';
import { debugLog, debugWarn, debugError } from '../debug';
import { getDeviceId } from '../deviceId';
import { getEngineConfig } from '../config';
import { supabase } from '../supabase/client';
import { getCrdtDoc } from './doc';
import type { AwarenessUser, RemoteUser } from './types';
import type { RealtimeChannel } from '@supabase/supabase-js';

/** Active awareness instances: docId → { awareness, channel, cleanup } */
const activeAwareness: Map<
  string,
  {
    awareness: Awareness;
    channel: RealtimeChannel;
    cleanup: (() => void)[];
  }
> = new Map();

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Initialize awareness (presence) for a CRDT document.
 *
 * Creates an Awareness instance and sets up a dedicated broadcast channel
 * for syncing presence state between clients.
 *
 * @param docId - Document/note ID
 * @param userInfo - Current user's display info
 * @returns The Awareness instance
 */
export function initAwareness(docId: string, userInfo: AwarenessUser): Awareness {
  const existing = activeAwareness.get(docId);
  if (existing) {
    // Update user info on existing awareness
    existing.awareness.setLocalStateField('user', userInfo);
    debugLog('[CRDT Awareness] Updated user info for:', docId);
    return existing.awareness;
  }

  const doc = getCrdtDoc(docId);
  if (!doc) {
    throw new Error(`Cannot init awareness - doc not initialized: ${docId}`);
  }

  debugLog('[CRDT Awareness] Initializing for:', docId);

  const awareness = new Awareness(doc);
  const deviceId = getDeviceId();
  const prefix = getEngineConfig().prefix;
  const channelName = `awareness_${prefix}_${docId}`;
  const cleanup: (() => void)[] = [];

  // Set local state
  awareness.setLocalStateField('user', userInfo);

  // Create a broadcast channel for awareness
  const channel = supabase.channel(channelName, {
    config: {
      broadcast: { self: false }
    }
  });

  // Listen for remote awareness updates
  channel.on(
    'broadcast',
    { event: 'awareness' },
    (payload: { payload: { data: string; deviceId: string } }) => {
      if (payload.payload.deviceId === deviceId) return;

      try {
        const update = base64ToUint8Array(payload.payload.data);
        awarenessProtocol.applyAwarenessUpdate(awareness, update, 'remote');
      } catch (e) {
        debugError('[CRDT Awareness] Error applying remote update:', e);
      }
    }
  );

  // Broadcast local awareness changes
  const onUpdate = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown
  ) => {
    if (origin === 'remote') return;

    const changedClients = added.concat(updated).concat(removed);
    try {
      const update = awarenessProtocol.encodeAwarenessUpdate(awareness, changedClients);
      channel.send({
        type: 'broadcast',
        event: 'awareness',
        payload: {
          data: uint8ArrayToBase64(update),
          deviceId
        }
      });
    } catch (e) {
      debugError('[CRDT Awareness] Error broadcasting update:', e);
    }
  };

  awareness.on('update', onUpdate);
  cleanup.push(() => awareness.off('update', onUpdate));

  // Subscribe to channel
  channel.subscribe((status) => {
    if (status === 'SUBSCRIBED') {
      debugLog('[CRDT Awareness] Channel connected for:', docId);

      // Send initial awareness state
      const update = awarenessProtocol.encodeAwarenessUpdate(awareness, [doc.clientID]);
      channel.send({
        type: 'broadcast',
        event: 'awareness',
        payload: {
          data: uint8ArrayToBase64(update),
          deviceId
        }
      });
    }
  });

  // Clean up awareness on window unload
  const beforeUnload = () => {
    awarenessProtocol.removeAwarenessStates(awareness, [doc.clientID], 'window-unload');
  };

  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', beforeUnload);
    cleanup.push(() => window.removeEventListener('beforeunload', beforeUnload));
  }

  activeAwareness.set(docId, { awareness, channel, cleanup });

  return awareness;
}

/**
 * Get the awareness instance for a document.
 *
 * @param docId - Document/note ID
 * @returns The Awareness instance if initialized, undefined otherwise
 */
export function getAwareness(docId: string): Awareness | undefined {
  return activeAwareness.get(docId)?.awareness;
}

/**
 * Destroy awareness for a document.
 *
 * Removes awareness state, closes the broadcast channel, and cleans up listeners.
 *
 * @param docId - Document/note ID
 */
export async function destroyAwareness(docId: string): Promise<void> {
  const entry = activeAwareness.get(docId);
  if (!entry) return;

  debugLog('[CRDT Awareness] Destroying for:', docId);

  // Run cleanup callbacks
  for (const fn of entry.cleanup) {
    try {
      fn();
    } catch (e) {
      debugWarn('[CRDT Awareness] Cleanup error:', e);
    }
  }

  // Remove awareness states
  const doc = getCrdtDoc(docId);
  if (doc) {
    awarenessProtocol.removeAwarenessStates(entry.awareness, [doc.clientID], 'destroy');
  }

  // Close channel
  try {
    await supabase.removeChannel(entry.channel);
  } catch (e) {
    debugWarn('[CRDT Awareness] Error removing channel:', e);
  }

  entry.awareness.destroy();
  activeAwareness.delete(docId);
}

/**
 * Update the local user's cursor position in awareness.
 *
 * @param docId - Document/note ID
 * @param cursor - Cursor position (blockId + offset), or null to clear
 */
export function updateAwarenessCursor(
  docId: string,
  cursor: { blockId: string; offset: number } | null
): void {
  const entry = activeAwareness.get(docId);
  if (!entry) return;

  const currentState = entry.awareness.getLocalState();
  if (!currentState) return;

  const currentUser = currentState.user as AwarenessUser | undefined;
  if (!currentUser) return;

  entry.awareness.setLocalStateField('user', { ...currentUser, cursor });
}

/**
 * Get all remote users currently present on a document.
 *
 * Returns awareness state from all clients except the local one.
 *
 * @param docId - Document/note ID
 * @returns Array of remote user presence states
 */
export function getRemoteAwarenessUsers(docId: string): RemoteUser[] {
  const entry = activeAwareness.get(docId);
  if (!entry) return [];

  const doc = getCrdtDoc(docId);
  if (!doc) return [];

  const localClientId = doc.clientID;
  const states = entry.awareness.getStates();
  const remoteUsers: RemoteUser[] = [];

  states.forEach((state, clientId) => {
    if (clientId === localClientId) return;
    const user = state.user as AwarenessUser | undefined;
    if (user) {
      remoteUsers.push({ clientId, user });
    }
  });

  return remoteUsers;
}
