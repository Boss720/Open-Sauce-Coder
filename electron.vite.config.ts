import { builtinModules } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

/** Resolve a path relative to this config file (ESM has no __dirname). */
const r = (p: string): string => fileURLToPath(new URL(p, import.meta.url))

/**
 * Electron itself plus every Node built-in, in both bare and `node:`-prefixed
 * form. electron-vite already externalizes these for main/preload, but we list
 * them explicitly so the intent survives any future config merging.
 */
const nodeExternals: string[] = [
  'electron',
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`)
]

/**
 * `@opencode-ai/sdk` is a *runtime* dependency of the MAIN process only. It must
 * never be bundled: electron-builder ships it from node_modules, and bundling it
 * breaks its dynamic requires. `build.externalizeDeps` (default true) already
 * externalizes everything under `dependencies`; the explicit entry documents it.
 */
const mainExternals: string[] = [...nodeExternals, '@opencode-ai/sdk']

/**
 * The renderer's index.html ships a dev-friendly CSP (loopback script/connect-src
 * for Vite HMR) so `vite dev` works. That policy would be needlessly permissive in
 * a packaged build, so on `build` only, swap it for a locked-down production CSP.
 * `style-src 'unsafe-inline'` stays — react-markdown / highlight.js emit inline
 * styles — but there is no `'unsafe-eval'` and no remote origins anywhere.
 */
const prodCspPlugin = {
  name: 'prod-csp',
  apply: 'build' as const,
  transformIndexHtml(html: string): string {
    const prodCsp =
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'"
    return html.replace(
      /<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]*>/i,
      `<meta http-equiv="Content-Security-Policy" content="${prodCsp}">`
    )
  }
}

export default defineConfig({
  main: {
    build: {
      externalizeDeps: true,
      lib: {
        entry: r('./src/main/index.ts')
      },
      rollupOptions: {
        external: mainExternals
      }
    }
  },

  preload: {
    build: {
      externalizeDeps: true,
      lib: {
        entry: r('./src/preload/index.ts'),
        // Sandboxed Electron renderers load preload scripts as CommonJS.
        // Emitting ESM here produces index.mjs, which Electron's sandbox
        // rejects before contextBridge can expose window.api.
        formats: ['cjs']
      },
      rollupOptions: {
        external: nodeExternals
      }
    }
  },

  renderer: {
    root: r('./src/renderer'),
    // Keep Vite's optimizer cache rooted at the invocation cwd. The repo may be
    // opened through a Windows junction, while this config resolves through the
    // physical path; mixing those paths makes Vite fail to match esbuild outputs.
    cacheDir: join(process.cwd(), 'node_modules', '.vite'),
    plugins: [react(), prodCspPlugin],
    resolve: {
      alias: {
        '@renderer': r('./src/renderer/src')
      }
    },
    build: {
      rollupOptions: {
        input: r('./src/renderer/index.html')
      }
    },
    optimizeDeps: {
      // monaco-editor@0.56 builds each of its workers (editorWorkerService, plus the
      // json/css/html/typescript language workers) via
      // `new Worker(new URL('<worker>.js', import.meta.url))` inside its own package
      // source — no MonacoEnvironment config or CDN needed, Vite's asset pipeline
      // bundles these as same-origin worker chunks (satisfies the CSP's
      // `worker-src 'self' blob:`). esbuild's dev-mode dep pre-bundling does not
      // apply that same-origin asset-URL rewrite, so excluding the package here is
      // required for the worker URLs to resolve correctly against the dev server.
      exclude: ['monaco-editor']
    },
    server: {
      // Electron loads this URL in dev; keep it loopback-only.
      // Port may shift if 5173 is busy — electron-vite passes the real URL
      // through ELECTRON_RENDERER_URL, and the CSP allows any loopback port.
      host: '127.0.0.1',
      port: 5173
    }
  }
})
