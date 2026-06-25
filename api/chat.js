// AURA — Secure Vercel Serverless Function
// API key is ONLY here, read from environment variables
// Never exposed to the browser

const RATE_MAP = new Map();
const RATE_LIMIT  = 20;
const RATE_WINDOW = 60000;

function isRateLimited(ip) {
  var now = Date.now();
  var entry = RATE_MAP.get(ip);
  if (!entry || now > entry.resetAt) {
    RATE_MAP.set(ip, { count: 1, resetAt: now + RATE_WINDOW });
    return false;
  }
  if (entry.count >= RATE_LIMIT) return true;
  entry.count++;
  return false;
}

var MAX_MSG_LEN   = 4000;
var MAX_TURNS     = 20;
var ALLOWED_ROLES = { user: true, assistant: true };

function sanitize(messages) {
  if (!Array.isArray(messages)) throw new Error('messages must be an array');
  if (messages.length === 0)    throw new Error('no messages provided');
  if (messages.length > MAX_TURNS) throw new Error('too many messages');

  return messages.map(function(m, i) {
    if (!m || typeof m !== 'object')        throw new Error('message[' + i + '] invalid');
    if (!ALLOWED_ROLES[m.role])             throw new Error('message[' + i + '] invalid role: ' + m.role);
    if (typeof m.content !== 'string')      throw new Error('message[' + i + '] content must be string');
    if (m.content.length > MAX_MSG_LEN)    throw new Error('message[' + i + '] too long');
    return {
      role:    m.role,
      content: m.content.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim()
    };
  });
}

module.exports = async function handler(req, res) {
  // Security headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cache-Control', 'no-store');

  // CORS — allow same origin + localhost dev
  var origin = req.headers['origin'] || '';
  var host   = req.headers['host']   || '';
  var allowed =
    origin === '' ||
    origin.includes(host) ||
    /^https?:\/\/localhost(:\d+)?$/.test(origin) ||
    /^https?:\/\/127\.0\.0\.1(:\d+)?$/.test(origin) ||
    /\.vercel\.app$/.test(origin);

  res.setHeader('Access-Control-Allow-Origin',  allowed ? (origin || '*') : 'null');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST')    { res.status(405).json({ error: 'Method not allowed' }); return; }

  // Rate limit
  var ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
        || (req.socket && req.socket.remoteAddress)
        || 'unknown';
  if (isRateLimited(ip)) {
    res.status(429).json({ error: 'Too many requests. Please wait a moment.' });
    return;
  }

  // Parse & validate body
  var msgs;
  try {
    var body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch(e) { throw new Error('Invalid JSON'); }
    }
    if (!body || typeof body !== 'object') throw new Error('Invalid request body');
    msgs = sanitize(body.messages);
    if (msgs[msgs.length - 1].role !== 'user') throw new Error('Last message must be from user');
  } catch(err) {
    res.status(400).json({ error: 'Bad request: ' + err.message });
    return;
  }

  // Check API key
  var GROQ_API_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_API_KEY) {
    console.error('GROQ_API_KEY not set');
    res.status(500).json({ error: 'Server configuration error. Contact the administrator.' });
    return;
  }

  // Call Groq
  try {
    var upstream = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': 'Bearer ' + GROQ_API_KEY
      },
      body: JSON.stringify({
        model:       'llama-3.3-70b-versatile',
        max_tokens:  1024,
        temperature: 0.7,
        messages: [
          {
            role:    'system',
            content: 'You are AURA, a helpful and brilliant AI assistant. Be concise, smart, and conversational. Use markdown for code blocks and formatting when helpful.'
          }
        ].concat(msgs)
      })
    });

    if (!upstream.ok) {
      var errText = await upstream.text().catch(function(){ return ''; });
      console.error('Groq upstream error', upstream.status, errText);
      res.status(502).json({ error: 'AI service error (' + upstream.status + '). Please try again.' });
      return;
    }

    var data  = await upstream.json();
    var reply = data &&
                data.choices &&
                data.choices[0] &&
                data.choices[0].message &&
                data.choices[0].message.content;

    if (!reply) {
      console.error('Empty Groq response:', JSON.stringify(data));
      res.status(502).json({ error: 'Empty response from AI. Please try again.' });
      return;
    }

    res.status(200).json({ reply: reply });

  } catch(err) {
    console.error('Handler error:', err.message, err.stack);
    res.status(500).json({ error: 'Internal server error. Please try again.' });
  }
};