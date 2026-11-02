import { app } from "./app.js";

function resolvePort(raw: string | undefined): number {
  if (raw === undefined) {
    return 3000;
  }

  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `Invalid PORT env var: ${JSON.stringify(raw)} (expected an integer in 1-65535)`,
    );
  }

  return port;
}

const port = resolvePort(process.env.PORT);

app.listen(port, () => {
  console.log(`[api] listening on port ${port}`);
});
