let debugEnabled = null;
let debugPrefix = 'stellar';
export function _setDebugPrefix(prefix) {
    debugPrefix = prefix;
}
export function isDebugMode() {
    if (debugEnabled !== null)
        return debugEnabled;
    debugEnabled =
        typeof localStorage !== 'undefined' &&
            localStorage.getItem(`${debugPrefix}_debug_mode`) === 'true';
    return debugEnabled;
}
export function setDebugMode(enabled) {
    debugEnabled = enabled;
    localStorage.setItem(`${debugPrefix}_debug_mode`, enabled ? 'true' : 'false');
}
export function debugLog(...args) {
    if (isDebugMode())
        console.log(...args);
}
export function debugWarn(...args) {
    if (isDebugMode())
        console.warn(...args);
}
export function debugError(...args) {
    if (isDebugMode())
        console.error(...args);
}
//# sourceMappingURL=debug.js.map