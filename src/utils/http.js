function badRequest(res, message, details = null) {
  return res.status(400).json({ error: message, details });
}

function notFound(res, message) {
  return res.status(404).json({ error: message });
}

function ok(res, data) {
  return res.status(200).json(data);
}

module.exports = { badRequest, notFound, ok };
