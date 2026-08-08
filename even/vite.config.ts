import { defineConfig } from 'vite'
import { readFileSync } from 'fs'

const appJson = JSON.parse(readFileSync('./app.json', 'utf-8'))

export default defineConfig(({ command }) => ({
  define: {
    __APP_VERSION__: JSON.stringify(appJson.version),
  },
  base: command === 'build' ? './' : '/',
  // 配信物には検証用の資材を一切入れない。
  // publicDir の中身はビルドでそのまま dist へコピーされ .ehpk に固められるため、
  // E2E 用のページ (設定を上書きする) を置くと出荷ビルドに紛れ込む。
  // dev server の時だけ tools/e2e-public を publicDir にする。
  publicDir: command === 'serve' ? 'tools/e2e-public' : false,
  server: {
    host: true,
    port: 5177,
    allowedHosts: true,
  },
}))
