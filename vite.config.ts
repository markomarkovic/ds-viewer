import preact from '@preact/preset-vite'
import { execSync } from 'node:child_process'
import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'
import pkg from './package.json'

const git = (cmd: string, fallback: string) => {
  try {
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  } catch {
    return fallback
  }
}

const commit = git('git rev-parse --short HEAD', 'unknown')
const dirty = git('git status --porcelain', '') === '' ? '' : '-dirty'

export default defineConfig({
  base: './',
  plugins: [preact(), viteSingleFile()],
  worker: { format: 'es' },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __GIT_COMMIT__: JSON.stringify(commit + dirty),
  },
})
