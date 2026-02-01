/**
 * Reconnect Handler Registry
 * Allows layout components to register callbacks for reconnection events
 */

type ReconnectHandler = () => Promise<void>;

let reconnectHandler: ReconnectHandler | null = null;

/**
 * Set the reconnect handler (called from layout.svelte)
 */
export function setReconnectHandler(handler: ReconnectHandler | null): void {
  reconnectHandler = handler;
}

/**
 * Call the reconnect handler if one is registered
 * Called from the network store on reconnection
 */
export async function callReconnectHandler(): Promise<void> {
  if (reconnectHandler) {
    await reconnectHandler();
  }
}
