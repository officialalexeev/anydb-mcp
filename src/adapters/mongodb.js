import { MongoClient } from 'mongodb';
import { BaseAdapter } from '../core/base-adapter.js';

export class MongoAdapter extends BaseAdapter {
  constructor(clientClass = MongoClient, timeout = 30000) {
    super(5000, timeout);
    this.ClientClass = clientClass;
  }

  async connect(uri) {
    this.client = new this.ClientClass(uri, {
      serverSelectionTimeoutMS: this.connectTimeout,
      connectTimeoutMS: this.connectTimeout,
    });
    await this.client.connect();
    this.db = this.client.db;
  }

  async execute(query, options) {
    if (!options.collection) throw new Error("Collection name is required for MongoDB");

    // AI sends JSON string, convert it to object
    const filter = JSON.parse(query);
    const limit = options.limit ? parseInt(options.limit) : 50;
    
    try {
      return await this.db.collection(options.collection)
        .find(filter)
        .limit(limit)
        .maxTimeMS(this.queryTimeout)
        .toArray();
    } catch (err) {
      // MongoDB timeout error
      if (err.name === 'MongoServerError' && (err.code === 50 || err.message.includes('timed out'))) {
        throw new Error(`Query exceeded ${this.queryTimeout}ms timeout (maxTimeMS)`);
      }
      throw err;
    }
  }

  async close() {
    if (this.client) await this.client.close();
  }
}