/** The one helper every example app shares. */

import { CacheStatus, type Representation } from "../src/mod.ts";

/**
 * The cache verdict as the header/page token the Python examples use:
 * `HIT` / `MISS` / `UNCACHEABLE` (`NONE` before any server stamped one).
 */
export function cacheStatusName(rep: Representation): string {
  return rep.cacheStatus === null
    ? "NONE"
    : CacheStatus[rep.cacheStatus].toUpperCase();
}
