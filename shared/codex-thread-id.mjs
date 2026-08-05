const CODEX_THREAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function normalizeCodexThreadId(value) {
  if (typeof value !== "string") return null;
  let normalized = value.trim();
  if (!normalized) return null;
  try {
    normalized = decodeURIComponent(normalized);
  } catch {
    return null;
  }
  normalized = normalized
    .replace(/^(?:local|cloud):/i, "")
    .replace(/^urn:uuid:/i, "")
    .toLowerCase();
  return CODEX_THREAD_ID_PATTERN.test(normalized) ? normalized : null;
}

export function isCodexThreadId(value) {
  return normalizeCodexThreadId(value) !== null;
}
