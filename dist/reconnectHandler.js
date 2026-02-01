/**
 * Reconnect Handler Registry
 * Allows layout components to register callbacks for reconnection events
 */
let reconnectHandler = null;
/**
 * Set the reconnect handler (called from layout.svelte)
 */
export function setReconnectHandler(handler) {
    reconnectHandler = handler;
}
/**
 * Call the reconnect handler if one is registered
 * Called from the network store on reconnection
 */
export async function callReconnectHandler() {
    if (reconnectHandler) {
        await reconnectHandler();
    }
}
//# sourceMappingURL=reconnectHandler.js.map