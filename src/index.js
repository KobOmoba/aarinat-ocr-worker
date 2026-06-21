// AariNAT OCR — Cloudflare Worker
// Powered by Groq Vision (Llama 4 Scout)
// Free tier: 100,000 requests/day. No credit card needed.
// Deploy at: workers.cloudflare.com

const PROMPT = `You are AariNAT OCR reading a Nigerian primary or secondary school register.
The image may be handwritten in ALL CAPS, typed, or printed. It may be rotated.

Common Nigerian register formats:
  - Table: SERIAL NO | SURNAME | FIRST NAME | CLASS | BALANCE
  - Numbered list: "1. SURNAME FIRSTNAME"
  - Plain list, one name per line

Nigerian name examples:
  Surnames:   OGUNLADE, KASALI, ALAWODE, ADEBAYO, OLIYIDE, OBASA, AKINWANDE,
              LAWAL, ODEREYE, ADEGUNLE, GBELEKALE, FAFIOLU, AYANRINDE
  Firstnames: GODWIN, MICHEAL, BLESSING, AMINAT, DEBORAH, GABRIEL, RASAQ,
              ENOCH, KOREDE, ISREAL, MARYAM, CYNTHIA, WASILAT, DORCAS

Rules:
  1. Each row = ONE student. Read ALL rows — do NOT skip any.
  2. Ignore: header rows, serial numbers, naira amounts, dates, totals.
  3. If a class column is visible extract it per student.
     Classes look like: BASIC ONE-SIX, NURSERY 1-2, JSS 1-3, SSS 1-3, UNKNOWN
  4. Do NOT split one student into two entries.
  5. If handwriting is unclear make your BEST guess at the Nigerian name.
  6. Return surname and firstname SEPARATELY.

Return ONLY valid JSON — no markdown, no explanation, nothing else:
{"students":[{"surname":"OLIYIDE","firstname":"GODWIN","class":"UNKNOWN"},
             {"surname":"OBASA","firstname":"MICHEAL","class":"BASIC FOUR"}]}`;

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function extractJSON(raw) {
  raw = raw.trim()
    .replace(/^```json?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  try { return JSON.parse(raw); } catch (e) {}
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) try { return JSON.parse(m[0]); } catch (e) {}
  return { students: [] };
}

function cleanStudents(list) {
  const seen = new Set();
  return (list || []).reduce((out, s) => {
    const surname   = String(s.surname   || '').trim().toUpperCase();
    const firstname = String(s.firstname || '').trim().toUpperCase();
    const cls       = String(s.class     || '').trim().toUpperCase();
    const full      = [surname, firstname].filter(Boolean).join(' ');
    const key       = full.replace(/[^A-Z]/g, '');
    if (key.length < 3 || seen.has(key)) return out;
    seen.add(key);
    out.push({ surname, firstname, class: cls, fullName: full });
    return out;
  }, []);
}

export default {
  async fetch(request, env) {

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    // Health check — GET /
    if (request.method === 'GET') {
      return json({
        name:     'AariNAT OCR API',
        version:  '2.0',
        status:   'live',
        provider: 'Groq Vision — Llama 4 Scout',
        usage:    'POST with { base64: "...", mime: "image/jpeg" }',
      });
    }

    if (request.method !== 'POST') {
      return json({ error: 'POST only' }, 405);
    }

    // Parse body
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    const { base64, mime = 'image/jpeg' } = body;
    if (!base64) {
      return json({ error: 'body must include base64 (image data) and mime' }, 400);
    }

    // Check Groq key
    const apiKey = env.GROQ_API_KEY;
    if (!apiKey) {
      return json({ error: 'GROQ_API_KEY not set — add it in Workers Settings → Variables' }, 500);
    }

    const model = env.GROQ_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct';

    // Call Groq Vision API
    let groqRes;
    try {
      groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method:  'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [{
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } },
              { type: 'text',      text: PROMPT },
            ],
          }],
          max_tokens:  2048,
          temperature: 0.1,
        }),
      });
    } catch (e) {
      return json({ error: `Could not reach Groq: ${e.message}`, students: [] }, 502);
    }

    if (!groqRes.ok) {
      const err = await groqRes.text();
      return json({ error: `Groq ${groqRes.status}: ${err.slice(0, 300)}`, students: [] }, 502);
    }

    const data     = await groqRes.json();
    const raw      = data.choices?.[0]?.message?.content || '';
    const parsed   = extractJSON(raw);
    const students = cleanStudents(parsed.students);

    return json({ students, provider: 'AariNAT-OCR-Groq', model });
  },
};
