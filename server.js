require('dotenv').config();

const http = require('node:http');
const nodemailer = require('nodemailer');

const required = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'ALERT_TO', 'ALLOWED_ORIGINS'];
const missing = required.filter(name => !process.env[name]);
if (missing.length) {
  throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
}

const allowedOrigins = new Set(process.env.ALLOWED_ORIGINS.split(',').map(origin => origin.trim()).filter(Boolean));
if (!allowedOrigins.size) {
  throw new Error('ALLOWED_ORIGINS must contain at least one dashboard origin.');
}

const mailFrom = process.env.MAIL_FROM || process.env.SMTP_USER;
const port = Number(process.env.PORT || 3000);
const rateLimits = new Map();
const rateWindowMs = 60_000;
const maxRequestsPerWindow = 10;
const sensorModels = {
  Temperature: 'DS18B20',
  Current: 'ACS172',
  Vibration: 'SW-420',
};
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

function respond(res, status, body, origin) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...(origin ? {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin',
    } : {}),
  });
  res.end(JSON.stringify(body));
}

function isRateLimited(ip) {
  const now = Date.now();
  const entry = rateLimits.get(ip);
  if (!entry || now - entry.startedAt >= rateWindowMs) {
    rateLimits.set(ip, { startedAt: now, count: 1 });
    return false;
  }
  entry.count += 1;
  return entry.count > maxRequestsPerWindow;
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8_192) {
      const error = new Error('Request body is too large.');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('Request body must be valid JSON.');
    error.status = 400;
    throw error;
  }
}

function validateAlarm(alarm) {
  const validSensors = ['Temperature', 'Current', 'Vibration'];
  if (!alarm || typeof alarm !== 'object' || Array.isArray(alarm)) return false;
  if (!validSensors.includes(alarm.sensor)) return false;
  if (!['WARNING', 'CRITICAL'].includes(alarm.severity)) return false;
  if (alarm.model !== undefined && alarm.model !== sensorModels[alarm.sensor]) return false;
  if (!(typeof alarm.value === 'number' && Number.isFinite(alarm.value)) && !(alarm.sensor === 'Vibration' && alarm.value === 'DETECTED')) return false;
  if (!(typeof alarm.threshold === 'number' && Number.isFinite(alarm.threshold)) && !(alarm.sensor === 'Vibration' && alarm.threshold === 'Detection')) return false;
  return typeof alarm.timestamp === 'string' && Number.isFinite(Date.parse(alarm.timestamp));
}

async function handle(req, res, mailTransport) {
  const origin = req.headers.origin;
  const url = new URL(req.url, 'http://localhost');
  const isHealthCheck = req.method === 'GET' && ['/', '/api/health'].includes(url.pathname);

  if (isHealthCheck) {
    if (origin && !allowedOrigins.has(origin)) {
      respond(res, 403, { error: 'Origin is not allowed.' });
      return;
    }
    respond(res, 200, { status: 'ok' }, origin);
    return;
  }

  if (!origin || !allowedOrigins.has(origin)) {
    respond(res, 403, { error: 'Origin is not allowed.' });
    return;
  }

  if (req.method === 'OPTIONS') {
    respond(res, 204, {}, origin);
    return;
  }

  if (req.method !== 'POST' || url.pathname !== '/api/alarms/email') {
    respond(res, 404, { error: 'Not found.' }, origin);
    return;
  }

  if (isRateLimited(req.socket.remoteAddress || 'unknown')) {
    respond(res, 429, { error: 'Too many alert requests. Try again later.' }, origin);
    return;
  }

  try {
    const alarm = await readJson(req);
    if (!validateAlarm(alarm)) {
      respond(res, 400, { error: 'Invalid alarm payload.' }, origin);
      return;
    }

    const value = typeof alarm.value === 'number' ? alarm.value.toFixed(2) : alarm.value;
    const threshold = typeof alarm.threshold === 'number' ? alarm.threshold.toFixed(2) : alarm.threshold;
    const model = sensorModels[alarm.sensor];
    const subject = `[${alarm.severity}] Industrial machine ${alarm.sensor} (${model}) alarm`;
    const text = [
      `Sensor: ${alarm.sensor}`,
      `Model: ${model}`,
      `Severity: ${alarm.severity}`,
      `Value: ${value}`,
      `Threshold: ${threshold}`,
      `Time: ${new Date(alarm.timestamp).toLocaleString()}`,
    ].join('\n');

    await mailTransport.sendMail({
      from: mailFrom,
      to: process.env.ALERT_TO,
      subject,
      text,
    });
    respond(res, 202, { sent: true }, origin);
  } catch (error) {
    if (error.status) {
      respond(res, error.status, { error: error.message }, origin);
      return;
    }
    console.error('Alarm email delivery failed:', error.message);
    respond(res, 502, { error: 'Could not deliver the alarm email.' }, origin);
  }
}

function createServer(mailTransport = transporter) {
  return http.createServer((req, res) => {
    handle(req, res, mailTransport).catch(error => {
      console.error('Request handling failed:', error);
      if (!res.headersSent) respond(res, 500, { error: 'Internal server error.' });
      else res.destroy();
    });
  });
}

if (require.main === module) {
  createServer().listen(port, () => {
    console.log(`Alarm email API listening on port ${port}`);
  });
}

module.exports = { createServer };
