/**
 * Forbid-UI loader entry for headless tests.
 *
 * Registers the genuine deny resolver (in forbid-ui-loader-hooks.mjs) that fails
 * any module resolution of a pi-tui specifier or an absolute path containing
 * `/src/tui/`. It is a strict deny — it does not accept a warm cache,
 * `hasUI=false`, or a skip. Tests that register this loader must prove the
 * headless runtime resolves with zero UI modules loaded.
 *
 * Usage:
 *   node --experimental-strip-types --import ./test/support/forbid-ui-loader.mjs --test ...
 */

import { register } from "node:module";
import { fileURLToPath } from "node:url";

register(new URL("./forbid-ui-loader-hooks.mjs", import.meta.url));
