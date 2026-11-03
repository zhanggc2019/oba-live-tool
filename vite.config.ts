import { rmSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import electron from 'vite-plugin-electron/simple'
import pkg from './package.json'

// https://vitejs.dev/config/
export default defineConfig(({ command }) => {
  rmSync('dist-electron', { recursive: true, force: true })

  const isServe = command === 'serve'
  const isBuild = command === 'build'
  const sourcemap = isServe || !!process.env.VSCODE_DEBUG

  return {
    resolve: {
      alias: {
        '@': path.join(__dirname, 'src'),
        shared: path.join(__dirname, 'shared'),
      },
    },
    plugins: [
      react(),
      tailwindcss(),
      electron({
        main: {
          // Shortcut of `build.lib.entry`
          entry: 'electron/main/index.ts',
          onstart(args) {
            if (process.env.VSCODE_DEBUG) {
              console.log(/* For `.vscode/.debug.script.mjs` */ '[startup] Electron App')
            } else {
              args.startup()
            }
          },
          vite: {
            build: {
              sourcemap: true,
              minify: false, // 开启前后差距大概 100kb
              outDir: 'dist-electron/main',
              rollupOptions: {
                external: [
                  // 将 ws 移入 devDependencies 后启动报错，需要排除下面两个包
                  // (ws 移回 dependencies 虽然正常不报错，但是安装后启动也会报错)
                  'bufferutil',
                  'utf-8-validate',
                  ...Object.keys('dependencies' in pkg ? pkg.dependencies : {}),
                ],
              },
            },
            resolve: {
              alias: {
                '#': path.join(__dirname, 'electron/main'),
                shared: path.join(__dirname, 'shared'),
              },
            },
          },
        },
        preload: {
          // Shortcut of `build.rollupOptions.input`.
          // Preload scripts may contain Web assets, so use the `build.rollupOptions.input` instead `build.lib.entry`.
          input: 'electron/preload/index.ts',
          vite: {
            build: {
              sourcemap: sourcemap ? 'inline' : undefined, // #332
              minify: isBuild,
              outDir: 'dist-electron/preload',
              rollupOptions: {
                external: [...Object.keys('dependencies' in pkg ? pkg.dependencies : {})],
              },
            },
            resolve: {
              alias: {
                shared: path.join(__dirname, 'shared'),
              },
            },
          },
        },
        // Ployfill the Electron and Node.js API for Renderer process.
        // If you want use Node.js in Renderer process, the `nodeIntegration` needs to be enabled in the Main process.
        // See 👉 https://github.com/electron-vite/vite-plugin-electron-renderer
        renderer: {},
      }),
    ],
    // 固定开发来源，端口被占用时明确报错，避免换端口后看不到原 localStorage。
    server: process.env.VSCODE_DEBUG
      ? {
          host: new URL(pkg.debug.env.VITE_DEV_SERVER_URL).hostname,
          port: Number(new URL(pkg.debug.env.VITE_DEV_SERVER_URL).port),
          strictPort: true,
        }
      : { host: 'localhost', port: 5173, strictPort: true },
    clearScreen: false,
  }
})
