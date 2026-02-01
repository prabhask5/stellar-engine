let debugEnabled: boolean | null = null;
let debugPrefix = 'stellar';

export function _setDebugPrefix(prefix: string) {
	debugPrefix = prefix;
}

export function isDebugMode(): boolean {
	if (debugEnabled !== null) return debugEnabled;
	debugEnabled =
		typeof localStorage !== 'undefined' &&
		localStorage.getItem(`${debugPrefix}_debug_mode`) === 'true';
	return debugEnabled;
}

export function setDebugMode(enabled: boolean) {
	debugEnabled = enabled;
	localStorage.setItem(`${debugPrefix}_debug_mode`, enabled ? 'true' : 'false');
}

export function debugLog(...args: unknown[]) {
	if (isDebugMode()) console.log(...args);
}
export function debugWarn(...args: unknown[]) {
	if (isDebugMode()) console.warn(...args);
}
export function debugError(...args: unknown[]) {
	if (isDebugMode()) console.error(...args);
}
