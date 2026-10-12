const memoryStorage = new Map<string, string>();

function browserLocalStorage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

export const safeLocalStorage = {
  getItem(key: string): string | null {
    const storage = browserLocalStorage();
    if (storage) {
      try {
        return storage.getItem(key);
      } catch {
        return memoryStorage.get(key) ?? null;
      }
    }
    return memoryStorage.get(key) ?? null;
  },

  setItem(key: string, value: string): void {
    const storage = browserLocalStorage();
    if (storage) {
      try {
        storage.setItem(key, value);
        return;
      } catch {
        // Codex's native MCP App iframe can deny localStorage access.
      }
    }
    memoryStorage.set(key, value);
  },

  removeItem(key: string): void {
    const storage = browserLocalStorage();
    if (storage) {
      try {
        storage.removeItem(key);
      } catch {
        // Keep the in-memory fallback consistent below.
      }
    }
    memoryStorage.delete(key);
  },
};
