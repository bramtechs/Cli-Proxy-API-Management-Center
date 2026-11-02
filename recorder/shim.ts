/**
 * Headless browser globals for the panel's quota modules.
 *
 * The recorder reuses the panel's API client and provider data layers; they
 * dispatch window events and persist small bits of state to web storage. In the
 * recorder those side effects have no consumer, so in-memory stand-ins suffice.
 */

class MemoryStorage {
  private items = new Map<string, string>();
  get length() {
    return this.items.size;
  }
  key(index: number) {
    return [...this.items.keys()][index] ?? null;
  }
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.items.set(key, String(value));
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
  clear() {
    this.items.clear();
  }
}

const g = globalThis as Record<string, unknown>;
if (typeof g.localStorage === 'undefined') g.localStorage = new MemoryStorage();
if (typeof g.sessionStorage === 'undefined') g.sessionStorage = new MemoryStorage();
if (typeof g.window === 'undefined') {
  g.window = Object.assign(new EventTarget(), {
    location: { href: 'http://localhost/', origin: 'http://localhost', protocol: 'http:' },
    localStorage: g.localStorage,
    sessionStorage: g.sessionStorage,
  });
}
