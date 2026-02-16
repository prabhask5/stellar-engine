/**
 * @fileoverview CLI command that scaffolds a PWA SvelteKit project using stellar-drive.
 *
 * Generates a complete project structure including:
 *   - Build configuration (Vite, TypeScript, SvelteKit, ESLint, Prettier, Knip)
 *   - PWA assets (manifest, offline page, placeholder icons)
 *   - SvelteKit routes (home, login, setup wizard, profile, error, confirm)
 *   - API endpoints (config, deploy, validate)
 *   - Shared schema definition (single source of truth for Dexie + SQL + types)
 *   - Git hooks via Husky
 *
 * Files are written non-destructively: existing files are skipped, not overwritten.
 *
 * Invoked via `stellar-drive install pwa` (routed by {@link commands.ts}).
 *
 * @example
 * ```bash
 * stellar-drive install pwa
 * ```
 *
 * @see {@link run} for the entry point
 * @see {@link runInteractiveSetup} for the interactive walkthrough
 * @see {@link writeIfMissing} for the non-destructive file write strategy
 */
/**
 * Main entry point for the CLI scaffolding tool.
 *
 * **Execution flow:**
 *   1. Run interactive walkthrough to collect {@link InstallOptions}.
 *   2. Write `package.json` (if missing).
 *   3. Run `npm install` to fetch dependencies.
 *   4. Write all template files by category with animated progress.
 *   5. Initialise Husky and write the pre-commit hook.
 *   6. Print a styled summary of created/skipped files and next steps.
 *
 * @returns A promise that resolves when scaffolding is complete.
 *
 * @throws {Error} If `npm install` or `npx husky init` fails.
 */
export declare function run(): Promise<void>;
//# sourceMappingURL=install-pwa.d.ts.map