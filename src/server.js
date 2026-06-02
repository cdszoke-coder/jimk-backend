const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const env = require('./config/env');
const { initDatabase } = require('./db/client');
const publicRoutes = require('./routes/public');
const adminRoutes = require('./routes/admin');

initDatabase();

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

app.get('/healthz', (req, res) => {
  res.status(200).json({ ok: true, service: 'jimk-2qr-backend' });
});

app.use('/api/public', publicRoutes);
app.use('/api/admin', adminRoutes);

const publicDir = path.join(__dirname, '..', 'public');
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
}

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((error, req, res, next) => {
  console.error(error);
  res.status(error.statusCode || 500).json({ error: error.message || 'Internal server error' });
});

app.listen(env.port, () => {
  console.log(`JIMK 2-QR backend listening on http://localhost:${env.port}`);
});