import { MongoClient } from 'mongodb';
import { BaseAdapter } from '../core/base-adapter.js';

export class MongoAdapter extends BaseAdapter {
  constructor(clientClass = MongoClient) {
    super();
    this.ClientClass = clientClass;
  }

  async connect(uri) {
    this.client = new this.ClientClass(uri);
    await this.client.connect();
    this.db = this.client.db;
  }

  async execute(query, options) {
    if (!options.collection) throw new Error("Collection name is required for MongoDB");

    // ИИ присылает JSON-строку, превращаем её в объект
    const filter = JSON.parse(query);
    const limit = options.limit ? parseInt(options.limit) : 50;
    return await this.db.collection(options.collection).find(filter).limit(limit).toArray();
  }

  async close() {
    if (this.client) await this.client.close();
  }
}