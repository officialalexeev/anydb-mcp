export default {
  testEnvironment: 'node',
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  testMatch: ['**/__tests__/**/*.[jt]s', '**/?(*.)+(spec|test).[jt]s'],
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/index.js', // Пропускаем главный файл, так как он содержит только запуск сервера
  ],
};