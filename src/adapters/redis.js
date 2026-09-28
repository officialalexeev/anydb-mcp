import { createClient } from 'redis';
import { BaseAdapter } from '../core/base-adapter.js';
import { RedisSchemaAdapter } from '../core/schema.js';

// Reply values that are worth decoding as JSON before handing them to an agent.
const JSON_REPLY_COMMANDS = new Set(['GET', 'HGET', 'MGET', 'HMGET', 'HGETALL']);

export class RedisAdapter extends BaseAdapter {
  constructor(clientClass = createClient, timeout = 30000) {
    super(5000, timeout);
    this.ClientClass = clientClass;
  }

  async connect(uri) {
    // Tolerate bare `host:port` and `user:pass@host:port` forms.
    if (!/^rediss?:\/\//i.test(uri)) {
      uri = `redis://${uri}`;
    }

    this.client = this.ClientClass({
      url: uri,
      socket: {
        connectTimeout: this.connectTimeout,
        timeout: this.queryTimeout,
      }
    });

    try {
      await this.client.connect();
    } catch (err) {
      throw describeError(err, this.connectTimeout);
    }
  }

  async execute(commandStr) {
    const parts = this.parseCommand(commandStr);
    if (parts.length === 0) return [];

    const command = parts[0].toUpperCase();
    const args = parts.slice(1);

    let reply;
    try {
      reply = await this.client.sendCommand([command, ...args]);
    } catch (err) {
      throw describeError(err, this.queryTimeout);
    }

    if (JSON_REPLY_COMMANDS.has(command) && typeof reply === 'string') {
      try {
        reply = JSON.parse(reply);
      } catch {
        // Not JSON; hand the raw string back.
      }
    }

    return Array.isArray(reply) ? reply : [reply];
  }

  describe(options = {}) {
    const schema = new RedisSchemaAdapter(this.connectTimeout, this.queryTimeout);
    schema.client = this.client;
    return schema.describe(options);
  }

  /**
   * Split a command line on whitespace, honouring single and double quotes so
   * values containing spaces survive.
   *
   * @param {string} commandStr - Raw command line
   * @returns {string[]} Command name followed by its arguments
   */
  parseCommand(commandStr) {
    const args = [];
    let current = '';
    let inQuote = false;
    let quoteChar = '';

    for (let i = 0; i < commandStr.length; i++) {
      const char = commandStr[i];

      if (inQuote) {
        if (char === '\\' && i + 1 < commandStr.length) {
          current += commandStr[++i];
        } else if (char === quoteChar) {
          inQuote = false;
          args.push(current);
          current = '';
        } else {
          current += char;
        }
        continue;
      }

      if (char === '"' || char === "'") {
        inQuote = true;
        quoteChar = char;
      } else if (/\s/.test(char)) {
        if (current.length > 0) {
          args.push(current);
          current = '';
        }
      } else {
        current += char;
      }
    }

    if (inQuote) {
      throw new Error(`Unbalanced quote in Redis command: ${commandStr}`);
    }
    if (current.length > 0) {
      args.push(current);
    }

    return args;
  }

  /** node-redis tracks its own socket state, so this needs no round trip. */
  isHealthy() {
    return !!this.client && this.client.isReady === true;
  }

  /** Drop the socket, so Redis stops working on an abandoned command. */
  abort() {
    if (!this.client) return;
    const client = this.client;
    this.client = null;
    this.aborted = true;
    try {
      client.destroy();
    } catch {
      // already destroyed
    }
  }

  async close() {
    if (!this.client) return;
    const client = this.client;
    this.client = null;

    try {
      await client.quit();
    } catch (err) {
      // A client that never opened, or a socket that already dropped, has
      // nothing left to report.
      if (!this.aborted && !/closed|not connected/i.test(err.message || '')) {
        console.error('Warning: Redis close() failed:', err.message);
      }
    }
  }
}

function describeError(err, timeoutMs) {
  const message = (err && err.message) || String(err);
  const name = err && err.name;

  if (/timed out|ETIMEDOUT|ClientClosedError|SocketClosedUnexpectedlyError|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ENOTFOUND/i.test(`${name} ${message}`)) {
    return new Error(`[Redis error] ${message} (client timeout was ${timeoutMs}ms)`);
  }

  return new Error(`[Redis ${name || 'error'}] ${message}`);
}
