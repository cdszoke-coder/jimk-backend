const path = require('path');
require('dotenv').config();

const databaseFile = process.env.DATABASE_FILE || path.join(process.cwd(), 'data', 'jimk.sqlite');
const dataDir = path.dirname(databaseFile);
const uploadsDir = process.env.UPLOADS_DIR || path.join(dataDir, 'uploads');

module.exports = {
  port: Number(process.env.PORT || 8787),
  databaseFile,
  dataDir,
  uploadsDir,
  adminApiKey: process.env.ADMIN_API_KEY || 'change-this-admin-key',
  siteBaseUrl: process.env.SITE_BASE_URL || 'https://www.jesusismykingmovement.com'
};
