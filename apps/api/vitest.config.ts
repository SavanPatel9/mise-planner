import { randomBytes } from "node:crypto";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    env: {
      // `crypto/tokenCrypto.ts` reads this at module load and throws without
      // it, and the sign-in path now imports it, so a suite that merely loads
      // `auth/passport.ts` needs a key. Generated per run rather than written
      // down: nothing committed here is a key, and no test may depend on its
      // value. `tokenCrypto.test.ts` still installs its own.
      TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    },
  },
});
