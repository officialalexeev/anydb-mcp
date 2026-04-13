const { BaseAdapter } = require('../src/core/base-adapter.js');

// Mock-класс для тестирования абстрактного класса
class ConcreteAdapter extends BaseAdapter {}

describe('BaseAdapter', () => {
  let adapter;

  beforeEach(() => {
    adapter = new ConcreteAdapter();
  });

  test('connect should throw error when called', async () => {
    await expect(adapter.connect('mock-uri')).rejects.toThrow('connect() is not implemented');
  });

  test('execute should throw error when called', async () => {
    await expect(adapter.execute('SELECT * FROM table')).rejects.toThrow('execute() is not implemented');
  });

  test('close should throw error when called', async () => {
    await expect(adapter.close()).rejects.toThrow('close() is not implemented');
  });
});