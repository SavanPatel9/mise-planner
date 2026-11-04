// Vercel Function entry for the whole API. The Express app is built once at
// module scope (apps/api/src/app.ts) and reused across invocations; Vercel
// rewrites every /api/* path here, so the app still sees the original path and
// its "/api"-mounted routers match.
import { createApp } from "../apps/api/src/app.js";

export default createApp();
