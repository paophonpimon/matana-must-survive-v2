import type { IncomingMessage, ServerResponse } from 'node:http'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const DEMO_STATE_PATH = '/__matana_demo_state'

const sharedDemoState = (): Plugin => {
  let state: unknown = null
  const handler = (request: IncomingMessage, response: ServerResponse, next: () => void): void => {
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('Content-Type', 'application/json; charset=utf-8')
    if (request.method === 'GET') {
      response.end(JSON.stringify({ state }))
      return
    }
    if (request.method !== 'PUT') {
      next()
      return
    }
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      try {
        state = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
        response.end(JSON.stringify({ ok: true }))
      } catch {
        response.statusCode = 400
        response.end(JSON.stringify({ ok: false }))
      }
    })
  }

  return {
    name: 'matana-shared-demo-state',
    configureServer(server) {
      server.middlewares.use(DEMO_STATE_PATH, handler)
    },
    configurePreviewServer(server) {
      server.middlewares.use(DEMO_STATE_PATH, handler)
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), sharedDemoState()],
  build: { target: 'es2022' },
})
