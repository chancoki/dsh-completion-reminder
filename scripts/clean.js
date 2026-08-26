#!/usr/bin/env node

/**
 * Cross-platform clean script for the DSH Completion Reminder plugin.
 * Removes the lib/ and dist/ build output directories.
 *
 * Usage: node scripts/clean.js
 */

import { rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

for (const dir of ['lib', 'dist']) {
  const target = resolve(ROOT, dir);
  try {
    rmSync(target, { recursive: true, force: true });
    console.log('[clean] removed', target);
  } catch {
    // ignore — directory may not exist
  }
}
