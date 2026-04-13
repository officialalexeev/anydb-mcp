import { createClient } from 'redis';
import { BaseAdapter } from '../core/base-adapter.js';

export class RedisAdapter extends BaseAdapter {
  constructor(clientClass = createClient, timeout = 30000) {
    super(5000, timeout);
    this.ClientClass = clientClass;
  }

  async connect(uri) {
    // If URI doesn't have redis:// prefix, add it
    if (!uri.startsWith('redis://') && !uri.startsWith('rediss://')) {
      uri = 'redis://' + uri;
    }

    this.client = this.ClientClass({
      url: uri,
      socket: {
        connectTimeout: this.connectTimeout,
        timeout: this.queryTimeout,
      }
    });
    await this.client.connect();
  }

  async execute(commandStr, options = {}) {
    try {
      // Parse command string, handling quotes
      const parts = this.parseCommand(commandStr);
      if (parts.length === 0) return [];

      const command = parts[0].toUpperCase();
      const args = parts.slice(1);

      // Execute Redis command
      let result;
      switch (command) {
        case 'GET':
          result = await this.client.get(args[0]);
          // If result is string, try to parse as JSON
          if (typeof result === 'string') {
            try {
              result = JSON.parse(result);
            } catch (e) {
              // If not JSON, return as-is
            }
          }
          result = [result]; // Wrap in array for consistency
          break;

        case 'SET':
          result = await this.client.set(args[0], args[1]);
          result = [{ status: result }]; // Wrap in array
          break;

        case 'HGETALL':
          result = await this.client.hGetAll(args[0]);
          result = [result]; // Wrap in array
          break;

        case 'HMGET':
          result = await this.client.hmGet(args[0], args.slice(1));
          result = [result]; // Wrap in array
          break;

        case 'LRANGE':
          result = await this.client.lRange(args[0], parseInt(args[1]), parseInt(args[2]));
          // LRANGE returns array, no wrapping needed
          break;

        case 'KEYS':
          result = await this.client.KEYS(args[0]);
          result = result.map(key => ({ key })); // Format as array of objects
          break;

        case 'EXISTS':
          result = await this.client.exists(args[0]);
          result = [{ exists: result }]; // Wrap in array
          break;

        case 'DEL':
          result = await this.client.del(args[0]);
          result = [{ deleted: result }]; // Wrap in array
          break;

        case 'FLUSHDB':
          result = await this.client.flushDb();
          result = [{ flushed: result }]; // Wrap in array
          break;

        default:
          // For other commands, try to execute directly
          result = await this.client.sendCommand([command, ...args]);
          if (Array.isArray(result)) {
            // If result is array, keep as-is
          } else {
            // Otherwise wrap in array
            result = [result];
          }
          break;
      }

      // If result is not array, wrap it
      if (!Array.isArray(result)) {
        result = [result];
      }

      return result;
    } catch (err) {
      // Timeout and connection errors
      if (err.message.includes('timed out') || 
          err.message.includes('Socket closed') ||
          err.name === 'SocketClosedUnexpectedlyError') {
        throw new Error(`Redis command timed out after ${this.queryTimeout}ms`);
      }
      throw new Error(`Redis Command Error: ${err.message}`);
    }
  }

  parseCommand(commandStr) {
    const args = [];
    let current = '';
    let inQuote = false;
    let quoteChar = '';

    for (let i = 0; i < commandStr.length; i++) {
      const char = commandStr[i];

      if (inQuote) {
        if (char === quoteChar) {
          inQuote = false;
          args.push(current);
          current = '';
        } else {
          current += char;
        }
      } else {
        if (char === '"' || char === "'") {
          inQuote = true;
          quoteChar = char;
        } else if (char === ' ') {
          if (current.length > 0) {
            args.push(current);
            current = '';
          }
        } else {
          current += char;
        }
      }
    }

    if (current.length > 0 || inQuote) {
      args.push(current);
    }

    return args;
  }

  async close() {
    if (this.client) {
      try {
        await this.client.quit();
      } catch (err) {
        // Ignore errors on close
        console.error('Warning: Redis close() failed:', err.message);
      }
    }
  }
}