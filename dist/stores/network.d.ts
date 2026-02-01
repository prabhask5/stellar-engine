import { type Readable } from 'svelte/store';
type NetworkCallback = () => void | Promise<void>;
export declare const isOnline: Readable<boolean> & {
    init: () => void;
    onReconnect: (callback: NetworkCallback) => () => void;
    onDisconnect: (callback: NetworkCallback) => () => void;
};
export {};
//# sourceMappingURL=network.d.ts.map