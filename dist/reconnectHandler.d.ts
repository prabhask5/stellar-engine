/**
 * Reconnect Handler Registry
 * Allows layout components to register callbacks for reconnection events
 */
type ReconnectHandler = () => Promise<void>;
/**
 * Set the reconnect handler (called from layout.svelte)
 */
export declare function setReconnectHandler(handler: ReconnectHandler | null): void;
/**
 * Call the reconnect handler if one is registered
 * Called from the network store on reconnection
 */
export declare function callReconnectHandler(): Promise<void>;
export {};
//# sourceMappingURL=reconnectHandler.d.ts.map