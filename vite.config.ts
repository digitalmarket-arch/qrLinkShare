import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig, type Plugin, type ResolvedConfig } from 'vite';

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss(), serviceWorker()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
  server: {
    port: 3000,
    host: '0.0.0.0',
    allowedHosts: true,
    hmr: process.env.DISABLE_HMR !== 'true',
  },
});

/**
 * Production builds only: once the bundle is on disk, writes <outDir>/sw.js from the template
 * sw/sw.js, filling in
 * - VERSION: a short hash of every file in outDir (public/ files such as the manifest and icons
 *   included) and of the template, so any change gives a new cache (older ones are deleted
 *   once no window that was open at the switch still needs them);
 * - PRECACHE: what the app needs offline ('./', assets/* without source maps, the manifest and
 *   the icons), saved when the service worker installs.
 */
function serviceWorker(): Plugin {
  let config: ResolvedConfig;
  return {
    name: 'qrls-service-worker',
    apply: 'build',
    configResolved(resolved) {
      config = resolved;
    },
    writeBundle: {
      order: 'post',
      sequential: true,
      async handler() {
        if (config.build.ssr) return;
        const outDir = path.resolve(config.root, config.build.outDir);
        const template = await readFile(path.resolve(__dirname, 'sw/sw.js'), 'utf8');
        const files = (await listFiles(outDir)).filter((f) => f !== 'sw.js').sort();

        const hash = createHash('sha256').update(template);
        for (const f of files) hash.update(`\0${f}\0`).update(await readFile(path.join(outDir, f)));
        const version = hash.digest('hex').slice(0, 12);

        const offline = files.filter((f) => (f.startsWith('assets/') ? !f.endsWith('.map') : /\.(webmanifest|png)$/.test(f)));
        const precache = ['./', ...offline.map((f) => f.split('/').map(encodeURIComponent).join('/'))];

        const code = fillIn(template, {
          __QRLS_VERSION__: JSON.stringify(version),
          __QRLS_PRECACHE__: JSON.stringify(precache, null, 2),
        });
        await writeFile(path.join(outDir, 'sw.js'), code);
        config.logger.info(`sw.js: version ${version}, ${precache.length} files kept for offline use`);
      },
    },
  };
}

/** Every file under dir, as relative paths with forward slashes. */
async function listFiles(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full, base)));
    else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

/** Replaces each placeholder, which must appear exactly once (a typo fails the build). */
function fillIn(template: string, values: Record<string, string>): string {
  let code = template;
  for (const [placeholder, value] of Object.entries(values)) {
    const parts = code.split(placeholder);
    if (parts.length !== 2) throw new Error(`sw/sw.js must contain ${placeholder} exactly once`);
    code = parts.join(value);
  }
  return code;
}
