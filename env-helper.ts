export function getEnv(name: string, required = true): string {
  const realKey = Object.keys(process.env).find((k) =>
    k.trim().replace(/^\uFEFF/, "") === name
  );
  const value = realKey ? process.env[realKey] : undefined;
  if (required && (!value || value.trim() === "")) {
    throw new Error(`[GasGuardian] Missing required env var → ${name}`);
  }
  return value ? value.trim() : "";
}
