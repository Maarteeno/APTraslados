/**
 * Persistencia del token.
 *
 * Se inyecta en vez de importar AsyncStorage directo, por dos razones: el
 * paquete no debe depender de React Native (así se puede testear en Node), y
 * cada app puede elegir dónde guardar. En producción esto debería ser
 * almacenamiento seguro (expo-secure-store), no AsyncStorage: un token en
 * AsyncStorage queda en texto plano en el sandbox de la app.
 */

export interface TokenStorage {
  get(): Promise<string | null>;
  set(token: string): Promise<void>;
  clear(): Promise<void>;
}

/** Para tests y para arrancar. No persiste entre reinicios de la app. */
export class MemoryTokenStorage implements TokenStorage {
  private token: string | null = null;

  async get(): Promise<string | null> {
    return this.token;
  }
  async set(token: string): Promise<void> {
    this.token = token;
  }
  async clear(): Promise<void> {
    this.token = null;
  }
}

/**
 * Adaptador sobre cualquier cosa con la forma de AsyncStorage.
 *
 *   new AsyncTokenStorage(AsyncStorage)
 */
export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export class AsyncTokenStorage implements TokenStorage {
  constructor(
    private readonly store: KeyValueStore,
    private readonly key = 'orbit.token',
  ) {}

  async get(): Promise<string | null> {
    return this.store.getItem(this.key);
  }
  async set(token: string): Promise<void> {
    await this.store.setItem(this.key, token);
  }
  async clear(): Promise<void> {
    await this.store.removeItem(this.key);
  }
}
