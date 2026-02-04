/**
 * CRDT Realtime Sync via Supabase Broadcast
 *
 * Manages Supabase Realtime broadcast channels for syncing Yjs document updates.
 * Handles:
 * - Broadcasting local Yjs updates to other clients
 * - Receiving and applying remote Yjs updates
 * - Echo suppression via device_id
 * - Checkpoint persistence (full state → note_content table)
 * - Reconnection with state vector diff sync
 * - Debounced checkpoint saves
 */

import * as Y from 'yjs';
import { debugLog, debugWarn, debugError } from '../debug';
import { getEngineConfig } from '../config';
import { getDeviceId } from '../deviceId';
import { supabase } from '../supabase/client';
import { getCrdtDoc, _getDocEntry } from './doc';
import type { CrdtBroadcastPayload, CrdtSyncState } from './types';
import type { RealtimeChannel } from '@supabase/supabase-js';

/** Active sync channels: docId → channel state */
const activeChannels: Map<
  string,
  {
    channel: RealtimeChannel;
    syncState: CrdtSyncState;
    updateHandler: (update: Uint8Array, origin: unknown) => void;
    checkpointTimer: ReturnType<typeof setTimeout> | null;
    visibilityHandler: (() => void) | null;
  }
> = new Map();

/** Debounce delay for checkpoint saves (ms) */
const CHECKPOINT_DEBOUNCE_MS = 5000;

// ─── Helpers ───────────────────────────────────────────────────────────────

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

function getChannelName(docId: string): string {
  const prefix = getEngineConfig().prefix;
  return `crdt_${prefix}_${docId}`;
}

// ─── Checkpoint Persistence ────────────────────────────────────────────────

/**
 * Save a checkpoint of the full Yjs state to the note_content table.
 * Uses direct Supabase client calls (bypasses normal engine data path since yjs_state is binary).
 *
 * @param docId - Document/note ID
 */
export async function saveCrdtCheckpoint(docId: string): Promise<void> {
  const doc = getCrdtDoc(docId);
  if (!doc) {
    debugWarn('[CRDT Sync] Cannot save checkpoint - doc not initialized:', docId);
    return;
  }

  const channelEntry = activeChannels.get(docId);
  if (channelEntry?.syncState.checkpointInProgress) {
    debugLog('[CRDT Sync] Checkpoint already in progress for:', docId);
    return;
  }

  if (channelEntry) {
    channelEntry.syncState.checkpointInProgress = true;
  }

  try {
    debugLog('[CRDT Sync] Saving checkpoint for:', docId);
    const state = Y.encodeStateAsUpdate(doc);
    const base64State = uint8ArrayToBase64(state);

    const { error } = await supabase.from('note_content').upsert(
      {
        note_id: docId,
        yjs_state: base64State,
        updated_at: new Date().toISOString(),
        device_id: getDeviceId()
      },
      {
        onConflict: 'note_id'
      }
    );

    if (error) {
      debugError('[CRDT Sync] Checkpoint save failed:', error);
    } else {
      debugLog('[CRDT Sync] Checkpoint saved for:', docId);
      if (channelEntry) {
        channelEntry.syncState.lastCheckpoint = Date.now();
      }
    }
  } catch (e) {
    debugError('[CRDT Sync] Checkpoint save error:', e);
  } finally {
    if (channelEntry) {
      channelEntry.syncState.checkpointInProgress = false;
    }
  }
}

/**
 * Load initial CRDT state from the remote note_content table.
 * Fetches yjs_state and applies it to the local Y.Doc.
 *
 * @param docId - Document/note ID
 */
export async function loadCrdtFromRemote(docId: string): Promise<void> {
  const doc = getCrdtDoc(docId);
  if (!doc) {
    debugWarn('[CRDT Sync] Cannot load from remote - doc not initialized:', docId);
    return;
  }

  try {
    debugLog('[CRDT Sync] Loading from remote for:', docId);

    const { data, error } = await supabase
      .from('note_content')
      .select('yjs_state')
      .eq('note_id', docId)
      .eq('deleted', false)
      .maybeSingle();

    if (error) {
      debugError('[CRDT Sync] Remote load failed:', error);
      return;
    }

    if (data?.yjs_state) {
      const state = base64ToUint8Array(data.yjs_state as string);
      Y.applyUpdate(doc, state, 'remote-load');
      debugLog('[CRDT Sync] Remote state applied for:', docId, `(${state.length} bytes)`);
    } else {
      debugLog('[CRDT Sync] No remote state found for:', docId);
    }
  } catch (e) {
    debugError('[CRDT Sync] Remote load error:', e);
  }
}

// ─── Debounced Checkpoint ──────────────────────────────────────────────────

function scheduleCheckpoint(docId: string): void {
  const entry = activeChannels.get(docId);
  if (!entry) return;

  // Clear existing timer
  if (entry.checkpointTimer) {
    clearTimeout(entry.checkpointTimer);
  }

  // Schedule new checkpoint
  entry.checkpointTimer = setTimeout(() => {
    entry.checkpointTimer = null;
    saveCrdtCheckpoint(docId);
  }, CHECKPOINT_DEBOUNCE_MS);
}

// ─── Realtime Channel Management ──────────────────────────────────────────

/**
 * Connect a CRDT document to Supabase Realtime for live sync.
 *
 * Opens a broadcast channel, attaches update listeners, and handles
 * incoming remote updates with echo suppression.
 *
 * @param docId - Document/note ID
 */
export function connectCrdtRealtime(docId: string): void {
  if (activeChannels.has(docId)) {
    debugLog('[CRDT Sync] Already connected for:', docId);
    return;
  }

  const doc = getCrdtDoc(docId);
  if (!doc) {
    debugWarn('[CRDT Sync] Cannot connect - doc not initialized:', docId);
    return;
  }

  const deviceId = getDeviceId();
  const channelName = getChannelName(docId);

  debugLog('[CRDT Sync] Connecting realtime for:', docId);

  const channel = supabase.channel(channelName, {
    config: {
      broadcast: {
        self: false // Don't receive own broadcasts
      }
    }
  });

  const syncState: CrdtSyncState = {
    connected: false,
    pendingUpdates: 0,
    lastCheckpoint: null,
    checkpointInProgress: false
  };

  // Handle incoming broadcast messages
  channel.on('broadcast', { event: 'crdt' }, (payload: { payload: CrdtBroadcastPayload }) => {
    const msg = payload.payload;

    // Echo suppression (backup - self:false should handle this)
    if (msg.deviceId === deviceId) return;
    if (msg.docId !== docId) return;

    switch (msg.type) {
      case 'update': {
        try {
          const update = base64ToUint8Array(msg.data);
          Y.applyUpdate(doc, update, 'remote-broadcast');
          debugLog('[CRDT Sync] Applied remote update for:', docId, `(${update.length} bytes)`);
        } catch (e) {
          debugError('[CRDT Sync] Error applying remote update:', e);
        }
        break;
      }
      case 'state-vector-request': {
        // Remote peer is requesting our state vector for diff sync
        try {
          const sv = Y.encodeStateVector(doc);
          const fullUpdate = Y.encodeStateAsUpdate(doc);
          channel.send({
            type: 'broadcast',
            event: 'crdt',
            payload: {
              type: 'state-vector-response',
              data: uint8ArrayToBase64(fullUpdate),
              deviceId,
              docId
            } satisfies CrdtBroadcastPayload
          });
          debugLog(
            '[CRDT Sync] Sent state vector response for:',
            docId,
            `(sv: ${sv.length} bytes)`
          );
        } catch (e) {
          debugError('[CRDT Sync] Error sending state vector response:', e);
        }
        break;
      }
      case 'state-vector-response': {
        // Received full state from a peer after reconnect
        try {
          const update = base64ToUint8Array(msg.data);
          Y.applyUpdate(doc, update, 'remote-state-sync');
          debugLog('[CRDT Sync] Applied state sync for:', docId, `(${update.length} bytes)`);
        } catch (e) {
          debugError('[CRDT Sync] Error applying state sync:', e);
        }
        break;
      }
    }
  });

  // Listen for local doc updates and broadcast them
  const updateHandler = (update: Uint8Array, origin: unknown) => {
    // Don't re-broadcast updates that came from remote
    if (
      origin === 'remote-broadcast' ||
      origin === 'remote-load' ||
      origin === 'remote-state-sync'
    ) {
      return;
    }

    if (!syncState.connected) {
      syncState.pendingUpdates++;
      return;
    }

    try {
      channel.send({
        type: 'broadcast',
        event: 'crdt',
        payload: {
          type: 'update',
          data: uint8ArrayToBase64(update),
          deviceId,
          docId
        } satisfies CrdtBroadcastPayload
      });
      debugLog('[CRDT Sync] Broadcast update for:', docId, `(${update.length} bytes)`);
    } catch (e) {
      debugError('[CRDT Sync] Error broadcasting update:', e);
      syncState.pendingUpdates++;
    }

    // Schedule a checkpoint save after edits
    scheduleCheckpoint(docId);
  };

  doc.on('update', updateHandler);

  // Save checkpoint on visibility hidden (user leaving page)
  const visibilityHandler = () => {
    if (document.visibilityState === 'hidden') {
      debugLog('[CRDT Sync] Page hidden - saving checkpoint for:', docId);
      saveCrdtCheckpoint(docId);
    }
  };

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', visibilityHandler);
  }

  // Subscribe to the channel
  channel.subscribe((status) => {
    switch (status) {
      case 'SUBSCRIBED':
        debugLog('[CRDT Sync] Channel connected for:', docId);
        syncState.connected = true;

        // If there were pending updates while disconnected, send full state
        if (syncState.pendingUpdates > 0) {
          debugLog('[CRDT Sync] Sending accumulated updates for:', docId);
          try {
            const fullUpdate = Y.encodeStateAsUpdate(doc);
            channel.send({
              type: 'broadcast',
              event: 'crdt',
              payload: {
                type: 'update',
                data: uint8ArrayToBase64(fullUpdate),
                deviceId,
                docId
              } satisfies CrdtBroadcastPayload
            });
            syncState.pendingUpdates = 0;
          } catch (e) {
            debugError('[CRDT Sync] Error sending accumulated updates:', e);
          }
        }

        // Request state from any connected peers (for reconnect sync)
        channel.send({
          type: 'broadcast',
          event: 'crdt',
          payload: {
            type: 'state-vector-request',
            data: uint8ArrayToBase64(Y.encodeStateVector(doc)),
            deviceId,
            docId
          } satisfies CrdtBroadcastPayload
        });
        break;

      case 'CHANNEL_ERROR':
        debugError('[CRDT Sync] Channel error for:', docId);
        syncState.connected = false;
        break;

      case 'CLOSED':
        debugLog('[CRDT Sync] Channel closed for:', docId);
        syncState.connected = false;
        break;

      case 'TIMED_OUT':
        debugWarn('[CRDT Sync] Channel timed out for:', docId);
        syncState.connected = false;
        break;
    }
  });

  activeChannels.set(docId, {
    channel,
    syncState,
    updateHandler,
    checkpointTimer: null,
    visibilityHandler
  });
}

/**
 * Disconnect a CRDT document from Supabase Realtime.
 *
 * Saves a final checkpoint, removes listeners, and closes the channel.
 *
 * @param docId - Document/note ID
 */
export async function disconnectCrdtRealtime(docId: string): Promise<void> {
  const entry = activeChannels.get(docId);
  if (!entry) {
    debugLog('[CRDT Sync] Not connected for:', docId);
    return;
  }

  debugLog('[CRDT Sync] Disconnecting realtime for:', docId);

  // Clear checkpoint timer
  if (entry.checkpointTimer) {
    clearTimeout(entry.checkpointTimer);
    entry.checkpointTimer = null;
  }

  // Remove visibility listener
  if (entry.visibilityHandler && typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', entry.visibilityHandler);
  }

  // Remove doc update listener
  const doc = getCrdtDoc(docId);
  if (doc) {
    doc.off('update', entry.updateHandler);
  }

  // Save final checkpoint before disconnecting
  await saveCrdtCheckpoint(docId);

  // Remove the channel
  try {
    await supabase.removeChannel(entry.channel);
  } catch (e) {
    debugWarn('[CRDT Sync] Error removing channel:', e);
  }

  activeChannels.delete(docId);
  debugLog('[CRDT Sync] Disconnected for:', docId);
}

/**
 * Get the sync state for a connected document.
 *
 * @param docId - Document/note ID
 * @returns The sync state if connected, undefined otherwise
 */
export function getCrdtSyncState(docId: string): CrdtSyncState | undefined {
  return activeChannels.get(docId)?.syncState;
}

/**
 * Check if a document is connected to realtime.
 *
 * @param docId - Document/note ID
 */
export function isCrdtRealtimeConnected(docId: string): boolean {
  return activeChannels.get(docId)?.syncState.connected ?? false;
}
