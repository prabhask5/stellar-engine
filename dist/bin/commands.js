#!/usr/bin/env node
/**
 * @fileoverview Central CLI entry point for stellar-drive.
 *
 * Routes CLI arguments to the appropriate command handler. Each command
 * lives in its own file and is lazily imported only when matched.
 *
 * Available commands:
 *   - `stellar-drive install pwa` — Scaffold a complete offline-first SvelteKit PWA project
 *
 * @see {@link install-pwa.ts} for the `install pwa` command
 */
import * as p from '@clack/prompts';
import color from 'picocolors';
// =============================================================================
//                           COMMAND REGISTRY
// =============================================================================
/**
 * Available CLI commands. Add new entries here to register additional commands.
 */
const COMMANDS = [
    {
        name: 'install pwa',
        usage: 'stellar-drive install pwa',
        description: 'Scaffold a complete offline-first SvelteKit PWA project'
    }
];
// =============================================================================
//                              HELP
// =============================================================================
/**
 * Print the help screen listing all available commands.
 */
function printHelp() {
    p.intro(color.bold('\u2726 stellar-drive CLI'));
    const commandList = COMMANDS.map((cmd) => `${color.cyan(cmd.usage)}\n${color.dim(cmd.description)}`).join('\n\n');
    p.note(commandList, 'Available commands');
    p.outro('Run a command to get started.');
}
// =============================================================================
//                           COMMAND ROUTING
// =============================================================================
/**
 * Route CLI arguments to the appropriate command handler.
 * Prints help and exits if the command is not recognised.
 */
function routeCommand() {
    const args = process.argv.slice(2);
    const command = args.slice(0, 2).join(' ');
    /* `install pwa` is a two-word command. */
    if (command === 'install pwa') {
        import('./install-pwa.js')
            .then((m) => m.run())
            .catch((err) => {
            console.error('Error:', err);
            process.exit(1);
        });
        return;
    }
    /* Unrecognised command or no args — show help */
    printHelp();
    process.exit(args.length === 0 ? 0 : 1);
}
// =============================================================================
//                                 RUN
// =============================================================================
routeCommand();
//# sourceMappingURL=commands.js.map