export class UpstashConfigStore {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly namespace: string;

  constructor() {
    const restUrl = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;

    if (restUrl && token) {
      this.baseUrl = restUrl.replace(/\/+$/, '');
      this.headers = {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      };
    } else {
      this.baseUrl = '';
      this.headers = {};
    }
    this.namespace = 'st_miniapp_config';
  }

  private isEnabled(): boolean {
    return this.baseUrl !== '';
  }

  private encode(value: string): string {
    return encodeURIComponent(value);
  }

  private async cmd(...args: string[]): Promise<any> {
    if (!this.isEnabled()) {
      throw new Error('Redis is not configured');
    }

    if (args.length === 0) {
      throw new Error('Upstash cmd requires at least one argument');
    }

    const command = args[0].toLowerCase();
    let url = '';
    let response: Response;

    try {
      if (command === 'get') {
        const key = this.encode(String(args[1]));
        url = `${this.baseUrl}/get/${key}`;
        response = await fetch(url, { headers: this.headers });
      } else if (command === 'setex') {
        const key = this.encode(String(args[1]));
        const seconds = this.encode(String(args[2]));
        url = `${this.baseUrl}/setex/${key}/${seconds}`;
        response = await fetch(url, {
          method: 'POST',
          headers: this.headers,
          body: JSON.stringify({ value: args[3] }),
        });
      } else {
        const encodedArgs = args.slice(1).map((value) => this.encode(String(value)));
        url = `${this.baseUrl}/${command}`;
        if (encodedArgs.length > 0) {
          url = `${url}/${encodedArgs.join('/')}`;
        }
        response = await fetch(url, { method: 'POST', headers: this.headers });
      }

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Upstash error ${response.status}: ${text}`);
      }

      const data = await response.json();
      if (data && typeof data === 'object' && data.error) {
        throw new Error(String(data.error));
      }

      return data;
    } catch (error) {
      console.warn(`[UpstashConfigStore] cmd '${command}' failed:`, error);
      throw error;
    }
  }

  private decodeGetResult(result: any): unknown {
    let raw: unknown = null;
    if (result && typeof result === 'object') {
      raw = result.result ?? result.value;
    }

    if (raw === null || raw === undefined || raw === '' || raw === 'null') {
      return null;
    }

    // Attempt to parse string values
    let current: unknown = raw;
    let previous: unknown = null;
    while (current !== previous) {
      previous = current;
      if (typeof current === 'string') {
        try {
          current = JSON.parse(current);
        } catch {
          // If it fails to parse, just keep the string
        }
      }

      // Unwrap if it has result or value nested
      if (current && typeof current === 'object' && !Array.isArray(current)) {
        const obj = current as Record<string, unknown>;
        if ('result' in obj || 'value' in obj) {
          current = obj.result ?? obj.value;
        }
      }
    }

    return current;
  }

  async getConfig(key: string): Promise<any | null> {
    if (!this.isEnabled()) return null;

    try {
      const result = await this.cmd('get', `${this.namespace}:${key}`);
      const value = this.decodeGetResult(result);
      if (typeof value === 'string') {
        try {
          return JSON.parse(value);
        } catch {
          return value; // if not parsable, return as string
        }
      }
      return value;
    } catch {
      return null; // Fallback to memory / DB if Redis fails
    }
  }

  async setConfig(key: string, value: any, ttlSeconds: number = 60): Promise<void> {
    if (!this.isEnabled()) return;

    try {
      const valStr = typeof value === 'string' ? value : JSON.stringify(value);
      await this.cmd('setex', `${this.namespace}:${key}`, String(ttlSeconds), valStr);
    } catch (error) {
      // Best-effort cache write, ignore if it fails
      console.error(`[UpstashConfigStore] Failed to set config for key ${key}:`, error);
    }
  }
}

export const configStore = new UpstashConfigStore();
