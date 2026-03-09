require('dotenv/config');
const { login } = require('./bot');
const api = require('./api');

async function main() {
  console.log('Starting NicBot...');

  // Start API server
  api.start();

  // Start Discord bot
  await login();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
