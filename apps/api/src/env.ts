/**
 * Reads a required env var without ever putting its value in the message —
 * a missing `GOOGLE_CLIENT_SECRET` must name the var and nothing else.
 *
 * Treats blank as missing: a var set to whitespace is a misconfiguration, not
 * a value.
 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`Missing required env var: ${name}`);
  }

  return value;
}
