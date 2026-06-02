const path = require('path');
require('dotenv').config();

module.exports = {
  port: Number(process.env.PORT || 8787),
  databaseFile: process.env.DATABASE_FILE || path.join(process.cwd(), 'data', 'jimk.sqlite'),
  adminApiKey: process.env.ADMIN_API_KEY || 'change-this-admin-key',
  siteBaseUrl: process.env.SITE_BASE_URL || 'https://www.jesusismykingmovement.com'
};
