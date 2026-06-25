// AURA — Secure Vercel Serverless Function with Supabase Memory
// API key is ONLY here, read from environment variables

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
var MAX_TURNS     = 40;
var ALLOWED_ROLES = { user: true, assistant: true };

function sanitize(messages) {
  if (!Array.isArray(messages)) throw new Error('messages must be an array');
  if (messages.length === 0)    throw new Error('no messages provided');
  if (messages.length > MAX_TURNS) messages = messages.slice(-MAX_TURNS);

  return messages.map(function(m, i) {
    if (!m || typeof m !== 'object')     throw new Error('message[' + i + '] invalid');
    if (!ALLOWED_ROLES[m.role])          throw new Error('message[' + i + '] invalid role');
    if (typeof m.content !== 'string')   throw new Error('message[' + i + '] content must be string');
    if (m.content.length > MAX_MSG_LEN) throw new Error('message[' + i + '] too long');
    return {
      role:    m.role,
      content: m.content.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim()
    };
  });
}

// Supabase REST helper (no SDK needed)
async function supabaseRequest(path, method, body, supabaseUrl, supabaseKey) {
  var res = await fetch(supabaseUrl + '/rest/v1' + path, {
    method: method || 'GET',
    headers: {
      'Content-Type':  'application/json',
      'apikey':        supabaseKey,
      'Authorization': 'Bearer ' + supabaseKey,
      'Prefer':        method === 'POST' ? 'return=minimal' : ''
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    var err = await res.text().catch(function(){ return ''; });
    throw new Error('Supabase error ' + res.status + ': ' + err);
  }
  if (res.status === 204 || res.headers.get('content-length') === '0') return null;
  return res.json();
}

module.exports = async function handler(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cache-Control', 'no-store');

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

  var ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
        || (req.socket && req.socket.remoteAddress)
        || 'unknown';
  if (isRateLimited(ip)) {
    res.status(429).json({ error: 'Too many requests. Please wait a moment.' });
    return;
  }

  var body;
  try {
    body = req.body;
    if (typeof body === 'string') body = JSON.parse(body);
    if (!body || typeof body !== 'object') throw new Error('Invalid request body');
  } catch(err) {
    res.status(400).json({ error: 'Bad request: ' + err.message });
    return;
  }

  var sessionId  = typeof body.sessionId === 'string' ? body.sessionId.slice(0, 64) : null;
  var newMessage = typeof body.message   === 'string' ? body.message.slice(0, MAX_MSG_LEN).trim() : null;

  if (!newMessage) {
    res.status(400).json({ error: 'No message provided' });
    return;
  }

  var GROQ_API_KEY    = process.env.GROQ_API_KEY;
  var SUPABASE_URL    = process.env.SUPABASE_URL;
  var SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

  if (!GROQ_API_KEY) {
    res.status(500).json({ error: 'Server configuration error (GROQ)' });
    return;
  }

  // Load history from Supabase if sessionId provided
  var dbMessages = [];
  if (sessionId && SUPABASE_URL && SUPABASE_ANON_KEY) {
    try {
      var rows = await supabaseRequest(
        '/conversations?session_id=eq.' + encodeURIComponent(sessionId) +
        '&order=created_at.asc&limit=40',
        'GET', null, SUPABASE_URL, SUPABASE_ANON_KEY
      );
      if (Array.isArray(rows)) {
        dbMessages = rows.map(function(r){ return { role: r.role, content: r.content }; });
      }
    } catch(err) {
      console.error('Supabase load error:', err.message);
      // Non-fatal — continue without history
    }
  }

  // Build messages for Groq
  dbMessages.push({ role: 'user', content: newMessage });
  var msgs = sanitize(dbMessages);

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
          content: 'You are AURA, a sleek and brilliant AI assistant created by Soumya Karmakar, with memory of past conversations. Be concise, smart, and conversational. Use markdown for code and formatting when helpful. If asked who created you, who your creator is, or who made you, respond with personality and confidence — something like "I was built by Soumya Karmakar — designed to think deeper and reply faster." Vary the phrasing naturally instead of repeating the same sentence every time. Never mention Meta, Llama, or Groq as your creator.'
          }
        ].concat(msgs)
      })
    });

    if (!upstream.ok) {
      console.error('Groq error:', upstream.status);
      res.status(502).json({ error: 'AI service error. Please try again.' });
      return;
    }

    var data  = await upstream.json();
    var reply = data && data.choices && data.choices[0] &&
                data.choices[0].message && data.choices[0].message.content;

    if (!reply) {
      res.status(502).json({ error: 'Empty response from AI.' });
      return;
    }

    // Save both messages to Supabase
    if (sessionId && SUPABASE_URL && SUPABASE_ANON_KEY) {
      try {
        await supabaseRequest('/conversations', 'POST', [
          { session_id: sessionId, role: 'user',      content: newMessage },
          { session_id: sessionId, role: 'assistant', content: reply }
        ], SUPABASE_URL, SUPABASE_ANON_KEY);
      } catch(err) {
        console.error('Supabase save error:', err.message);
        // Non-fatal
      }
    }

    res.status(200).json({ reply: reply, sessionId: sessionId });

  } catch(err) {
    console.error('Handler error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
};