/**
 * Remote Changes Store
 *
 * Manages incoming realtime changes and active editing state to enable:
 * - Graceful UI animations when remote changes arrive
 * - Protection of user edits from being overwritten
 * - Deferred change application for entities being edited
 *
 * Two types of entities:
 * 1. Auto-save entities (toggles, quick actions) - changes apply immediately with animation
 * 2. Form entities (modals with Save button) - changes are deferred until form closes
 *
 * Action type detection:
 * Since Supabase Realtime only sends INSERT/UPDATE/DELETE events, we detect
 * the specific action type by analyzing which fields changed:
 * - INSERT → 'create' action
 * - DELETE → 'delete' action
 * - UPDATE with 'completed' changed → 'toggle' action
 * - UPDATE with 'current_value' changed → 'increment' or 'decrement' action
 * - UPDATE with 'order' changed → 'reorder' action
 * - UPDATE with 'name' changed → 'rename' action
 * - UPDATE with 'is_enabled' changed → 'toggle' action (for block lists)
 * - UPDATE with other fields → 'update' action
 */

import { writable, derived } from 'svelte/store';

// ============================================================
// TYPES
// ============================================================

/**
 * Action types that can be detected from realtime events.
 * Used to apply appropriate animations.
 */
export type RemoteActionType =
  | 'create' // New entity inserted
  | 'delete' // Entity deleted
  | 'toggle' // Boolean field toggled (completed, is_enabled)
  | 'increment' // Numeric value increased
  | 'decrement' // Numeric value decreased
  | 'reorder' // Order changed
  | 'rename' // Name changed
  | 'update'; // Other field updates

interface RemoteChange {
  entityId: string;
  entityType: string; // Table name
  fields: string[]; // Which fields changed
  actionType: RemoteActionType; // Detected action type
  timestamp: number;
  applied: boolean; // Whether the change was applied to local DB
  // For increment/decrement, store the delta for animation direction
  valueDelta?: number;
}

interface ActiveEdit {
  entityId: string;
  entityType: string;
  formType: 'auto-save' | 'manual-save';
  startedAt: number;
  fields?: string[]; // Which fields are being edited (for field-level tracking)
}

interface RemoteChangesState {
  // Recent remote changes (for animation)
  recentChanges: Map<string, RemoteChange>;
  // Entities currently being edited
  activeEdits: Map<string, ActiveEdit>;
  // Deferred changes waiting for edit to complete
  deferredChanges: Map<string, RemoteChange[]>;
  // Entities pending deletion (for delete animation)
  // Key: entityType:entityId, Value: timestamp when delete was recorded
  pendingDeletes: Map<string, number>;
}

// ============================================================
// STORE
// ============================================================

const ANIMATION_DURATION = 2000; // How long to keep change in "recent" for animation
const CLEANUP_INTERVAL = 5000; // How often to clean up old changes

// How long to keep items in pending delete state for animation
const DELETE_ANIMATION_DURATION = 500;

function createRemoteChangesStore() {
  const { subscribe, update } = writable<RemoteChangesState>({
    recentChanges: new Map(),
    activeEdits: new Map(),
    deferredChanges: new Map(),
    pendingDeletes: new Map()
  });

  // Cleanup old changes periodically
  let cleanupInterval: ReturnType<typeof setInterval> | null = null;

  function startCleanup() {
    if (cleanupInterval) return;
    if (typeof window === 'undefined') return;

    cleanupInterval = setInterval(() => {
      const now = Date.now();
      update((state) => {
        const newRecentChanges = new Map(state.recentChanges);
        // Remove old recent changes
        for (const [key, change] of newRecentChanges) {
          if (now - change.timestamp > ANIMATION_DURATION) {
            newRecentChanges.delete(key);
          }
        }
        return { ...state, recentChanges: newRecentChanges };
      });
    }, CLEANUP_INTERVAL);
  }

  function stopCleanup() {
    if (cleanupInterval) {
      clearInterval(cleanupInterval);
      cleanupInterval = null;
    }
  }

  return {
    subscribe,

    /**
     * Detect action type from event type and changed fields.
     * This is how we know what animation to play even though Supabase
     * doesn't store the "action" - we infer it from what changed.
     */
    detectActionType(
      eventType: 'INSERT' | 'UPDATE' | 'DELETE',
      fields: string[],
      valueDelta?: number
    ): RemoteActionType {
      if (eventType === 'INSERT') return 'create';
      if (eventType === 'DELETE') return 'delete';

      // For UPDATE, determine action from which fields changed
      // Priority order matters - more specific actions first

      // Toggle actions (completed, is_enabled)
      if (fields.includes('completed') || fields.includes('is_enabled')) {
        return 'toggle';
      }

      // Increment/decrement (current_value changed)
      if (fields.includes('current_value')) {
        if (valueDelta !== undefined) {
          return valueDelta > 0 ? 'increment' : 'decrement';
        }
        return 'increment'; // Default to increment if delta unknown
      }

      // Reorder (order changed)
      if (fields.includes('order') && fields.length === 1) {
        return 'reorder';
      }

      // Rename or visual property change (name, color)
      if ((fields.includes('name') || fields.includes('color')) && fields.length <= 2) {
        return 'rename';
      }

      // Generic update for other changes
      return 'update';
    },

    /**
     * Record a remote change that just arrived.
     * If the entity is being edited with a manual-save form, defer the change.
     * Otherwise, mark it as a recent change for animation.
     *
     * @param eventType - Supabase event type (INSERT/UPDATE/DELETE)
     * @param valueDelta - For increment/decrement, the change in value
     */
    recordRemoteChange(
      entityId: string,
      entityType: string,
      fields: string[],
      applied: boolean,
      eventType: 'INSERT' | 'UPDATE' | 'DELETE' = 'UPDATE',
      valueDelta?: number
    ): { deferred: boolean; actionType: RemoteActionType } {
      startCleanup();

      const actionType = this.detectActionType(eventType, fields, valueDelta);

      const change: RemoteChange = {
        entityId,
        entityType,
        fields,
        actionType,
        timestamp: Date.now(),
        applied,
        valueDelta
      };

      let deferred = false;

      update((state) => {
        const key = `${entityType}:${entityId}`;
        const activeEdit = state.activeEdits.get(key);

        if (activeEdit && activeEdit.formType === 'manual-save') {
          // Entity is being edited in a form with Save button - defer the change
          const newDeferredChanges = new Map(state.deferredChanges);
          const existing = [...(newDeferredChanges.get(key) || [])];
          existing.push(change);
          newDeferredChanges.set(key, existing);
          deferred = true;
          return { ...state, deferredChanges: newDeferredChanges };
        } else {
          // Apply immediately (or already applied) - record for animation
          const newRecentChanges = new Map(state.recentChanges);
          newRecentChanges.set(key, change);
          return { ...state, recentChanges: newRecentChanges };
        }
      });

      return { deferred, actionType };
    },

    /**
     * Record a local change for animation purposes.
     * Call this BEFORE the component mounts (e.g., right before adding to database)
     * so that when the component mounts with remoteChangeAnimation, the create animation triggers.
     *
     * This is useful for local creates to animate the same way as remote creates.
     */
    recordLocalChange(
      entityId: string,
      entityType: string,
      actionType: RemoteActionType,
      fields: string[] = ['*']
    ): void {
      startCleanup();

      const change: RemoteChange = {
        entityId,
        entityType,
        fields,
        actionType,
        timestamp: Date.now(),
        applied: true
      };

      update((state) => {
        const key = `${entityType}:${entityId}`;
        const newRecentChanges = new Map(state.recentChanges);
        newRecentChanges.set(key, change);
        return { ...state, recentChanges: newRecentChanges };
      });
    },

    /**
     * Mark an entity as being actively edited.
     * @param formType 'auto-save' for inline edits, 'manual-save' for modals with Save button
     */
    startEditing(
      entityId: string,
      entityType: string,
      formType: 'auto-save' | 'manual-save',
      fields?: string[]
    ): void {
      update((state) => {
        const key = `${entityType}:${entityId}`;
        const newActiveEdits = new Map(state.activeEdits);
        newActiveEdits.set(key, {
          entityId,
          entityType,
          formType,
          startedAt: Date.now(),
          fields
        });
        return { ...state, activeEdits: newActiveEdits };
      });
    },

    /**
     * Mark editing as complete. Returns any deferred changes that need to be processed.
     */
    stopEditing(entityId: string, entityType: string): RemoteChange[] {
      let deferredChanges: RemoteChange[] = [];

      update((state) => {
        const key = `${entityType}:${entityId}`;
        const newActiveEdits = new Map(state.activeEdits);
        newActiveEdits.delete(key);

        const newDeferredChanges = new Map(state.deferredChanges);
        // Return deferred changes for processing
        if (newDeferredChanges.has(key)) {
          deferredChanges = newDeferredChanges.get(key) || [];
          newDeferredChanges.delete(key);
        }

        return { ...state, activeEdits: newActiveEdits, deferredChanges: newDeferredChanges };
      });

      return deferredChanges;
    },

    /**
     * Check if an entity is currently being edited.
     */
    isEditing(entityId: string, entityType: string): boolean {
      let editing = false;
      const unsubscribe = subscribe((state) => {
        editing = state.activeEdits.has(`${entityType}:${entityId}`);
      });
      unsubscribe();
      return editing;
    },

    /**
     * Clear deferred changes for an entity without stopping editing.
     * Used when user dismisses or loads remote changes in the banner.
     */
    clearDeferredChanges(entityId: string, entityType: string): void {
      update((state) => {
        const key = `${entityType}:${entityId}`;
        const newDeferredChanges = new Map(state.deferredChanges);
        newDeferredChanges.delete(key);
        return { ...state, deferredChanges: newDeferredChanges };
      });
    },

    /**
     * Check if an entity has deferred changes waiting.
     */
    hasDeferredChanges(entityId: string, entityType: string): boolean {
      let hasChanges = false;
      const unsubscribe = subscribe((state) => {
        const key = `${entityType}:${entityId}`;
        const changes = state.deferredChanges.get(key);
        hasChanges = !!changes && changes.length > 0;
      });
      unsubscribe();
      return hasChanges;
    },

    /**
     * Check if an entity was recently changed (for animation).
     */
    wasRecentlyChanged(entityId: string, entityType: string): boolean {
      let recent = false;
      const unsubscribe = subscribe((state) => {
        const key = `${entityType}:${entityId}`;
        const change = state.recentChanges.get(key);
        if (change && Date.now() - change.timestamp < ANIMATION_DURATION) {
          recent = true;
        }
      });
      unsubscribe();
      return recent;
    },

    /**
     * Get recent change details for an entity (for field-level animation).
     */
    getRecentChange(entityId: string, entityType: string): RemoteChange | null {
      let change: RemoteChange | null = null;
      const unsubscribe = subscribe((state) => {
        const key = `${entityType}:${entityId}`;
        const c = state.recentChanges.get(key);
        if (c && Date.now() - c.timestamp < ANIMATION_DURATION) {
          change = c;
        }
      });
      unsubscribe();
      return change;
    },

    /**
     * Mark an entity as pending delete (for delete animation).
     * Returns a promise that resolves after the animation duration.
     * The pending delete is cleared AFTER resolve so the caller can
     * delete from DB first — this prevents a reactive flash where the
     * item reappears between animation end and DOM removal.
     */
    markPendingDelete(entityId: string, entityType: string): Promise<void> {
      update((state) => {
        const key = `${entityType}:${entityId}`;
        const newPendingDeletes = new Map(state.pendingDeletes);
        newPendingDeletes.set(key, Date.now());
        return { ...state, pendingDeletes: newPendingDeletes };
      });

      // Return promise that resolves after animation duration
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve();
          // Clean up after a short delay — the caller deletes from DB on
          // resolve which triggers DOM removal, so this is just housekeeping
          setTimeout(() => {
            update((state) => {
              const key = `${entityType}:${entityId}`;
              const newPendingDeletes = new Map(state.pendingDeletes);
              newPendingDeletes.delete(key);
              return { ...state, pendingDeletes: newPendingDeletes };
            });
          }, 100);
        }, DELETE_ANIMATION_DURATION);
      });
    },

    /**
     * Check if an entity is pending deletion (for animation).
     */
    isPendingDelete(entityId: string, entityType: string): boolean {
      let pending = false;
      const unsubscribe = subscribe((state) => {
        const key = `${entityType}:${entityId}`;
        pending = state.pendingDeletes.has(key);
      });
      unsubscribe();
      return pending;
    },

    /**
     * Clear all tracking (for logout).
     */
    clear(): void {
      stopCleanup();
      update(() => ({
        recentChanges: new Map(),
        activeEdits: new Map(),
        deferredChanges: new Map(),
        pendingDeletes: new Map()
      }));
    },

    /**
     * Stop the cleanup interval (for cleanup on unmount).
     */
    destroy(): void {
      stopCleanup();
    }
  };
}

export const remoteChangesStore = createRemoteChangesStore();

// ============================================================
// DERIVED STORES FOR UI
// ============================================================

/**
 * Derived store for components to check if a specific entity was recently updated remotely.
 * Use this to trigger animations.
 */
export function createRecentChangeIndicator(entityId: string, entityType: string) {
  return derived(remoteChangesStore, ($state) => {
    const key = `${entityType}:${entityId}`;
    const change = $state.recentChanges.get(key);
    if (!change) return null;
    if (Date.now() - change.timestamp > ANIMATION_DURATION) return null;
    return change;
  });
}

/**
 * Derived store for components to check if a specific entity is pending deletion.
 * Use this to apply delete animation before removing from DOM.
 */
export function createPendingDeleteIndicator(entityId: string, entityType: string) {
  return derived(remoteChangesStore, ($state) => {
    const key = `${entityType}:${entityId}`;
    return $state.pendingDeletes.has(key);
  });
}
