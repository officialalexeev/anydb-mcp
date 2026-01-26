import { createClient } from 'redis';
import { BaseAdapter } from '../core/base-adapter.js';

export class RedisAdapter extends BaseAdapter {
  constructor(clientClass = createClient) {
    super();
    this.ClientClass = clientClass;
  }

  async connect(uri) {
    // Если URI не содержит префикса redis://, добавим его
    if (!uri.startsWith('redis://') && !uri.startsWith('rediss://')) {
      uri = 'redis://' + uri;
    }
    
    this.client = this.ClientClass({ url: uri });
    await this.client.connect();
  }

  async execute(commandStr, options = {}) {
    try {
      // Парсим строку команды, учитывая кавычки
      const parts = this.parseCommand(commandStr);
      if (parts.length === 0) return [];

      const command = parts[0].toUpperCase();
      const args = parts.slice(1);

      // Выполняем команду Redis
      let result;
      switch (command) {
        case 'GET':
          result = await this.client.get(args[0]);
          // Если результат - строка, попробуем распарсить как JSON
          if (typeof result === 'string') {
            try {
              result = JSON.parse(result);
            } catch (e) {
              // Если не JSON, возвращаем как есть
            }
          }
          result = [result]; // Оборачиваем в массив для согласованности
          break;
          
        case 'SET':
          result = await this.client.set(args[0], args[1]);
          result = [{ status: result }]; // Оборачиваем в массив
          break;
          
        case 'HGETALL':
          result = await this.client.hGetAll(args[0]);
          result = [result]; // Оборачиваем в массив
          break;
          
        case 'HMGET':
          result = await this.client.hmGet(args[0], args.slice(1));
          result = [result]; // Оборачиваем в массив
          break;
          
        case 'LRANGE':
          result = await this.client.lRange(args[0], parseInt(args[1]), parseInt(args[2]));
          // LRANGE возвращает массив, оборачивать не нужно
          break;
          
        case 'KEYS':
          result = await this.client.KEYS(args[0]);
          result = result.map(key => ({ key })); // Форматируем как массив объектов
          break;
          
        case 'EXISTS':
          result = await this.client.exists(args[0]);
          result = [{ exists: result }]; // Оборачиваем в массив
          break;
          
        case 'DEL':
          result = await this.client.del(args[0]);
          result = [{ deleted: result }]; // Оборачиваем в массив
          break;
          
        case 'FLUSHDB':
          result = await this.client.flushDb();
          result = [{ flushed: result }]; // Оборачиваем в массив
          break;
          
        default:
          // Для других команд пробуем выполнить напрямую
          result = await this.client.sendCommand([command, ...args]);
          if (Array.isArray(result)) {
            // Если результат - массив, оставляем как есть
          } else {
            // Иначе оборачиваем в массив
            result = [result];
          }
          break;
      }

      // Если результат не массив, оборачиваем в массив
      if (!Array.isArray(result)) {
        result = [result];
      }

      return result;
    } catch (err) {
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
      await this.client.quit();
    }
  }
}