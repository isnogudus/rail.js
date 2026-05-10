/**
 * Runs every example in the examples/ directory and reports
 * pass/fail. Useful as a smoke test that all examples still
 * execute against the current library version.
 */

import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

const files = (await readdir(here))
  .filter((f) => /^\d+-.+\.js$/.test(f))
  .sort();

let failures = 0;

for (const file of files) {
  process.stdout.write(`\n\x1b[1m=== ${file} ===\x1b[0m\n`);
  await new Promise((resolve) => {
    const p = spawn(process.execPath, [join(here, file)], {
      stdio: 'inherit',
    });
    p.on('exit', (code) => {
      if (code !== 0) {
        failures++;
        process.stdout.write(`\x1b[31m! ${file} exited with code ${code}\x1b[0m\n`);
      }
      resolve();
    });
  });
}

if (failures > 0) {
  console.error(`\n\x1b[31m${failures} example(s) failed.\x1b[0m`);
  process.exit(1);
}
console.log(`\n\x1b[32mAll ${files.length} examples ran successfully.\x1b[0m`);
