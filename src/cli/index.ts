import { startServer, DEFAULT_PORT } from '../server/index.js'

const port = Number(process.env.PORT ?? process.env.THREADMAP_PORT ?? DEFAULT_PORT)
await startServer(port)
