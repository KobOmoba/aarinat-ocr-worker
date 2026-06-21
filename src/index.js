// AariNAT OCR — Cloudflare Worker v2.1
// Fixed: Groq model, 25s timeout, better error handling

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
  'Access-Control-Allow-Methods': 'POST, OPTIONS, GET',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function resp(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function extractJSON(raw) {
  raw = raw.trim().replace(/^```json?\s*/i, '').replace(/\s*```$/, '').trim();
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

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (request.method === 'GET') {
      return resp({
        name: 'AariNAT OCR API', version: '2.1', status: 'live',
        provider: 'Groq Vision', model: env.GROQ_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct',
        usage: 'POST with { base64: "...", mime: "image/jpeg" }',
      });
    }

    if (request.method !== 'POST') return resp({ error: 'POST only' }, 405);

    let body;
    try { body = await request.json(); }
    catch (e) { return resp({ error: 'Invalid JSON body' }, 400); }

    const { base64, mime = 'image/jpeg' } = body;
    if (!base64) return resp({ error: 'base64 required' }, 400);

    const apiKey = env.GROQ_API_KEY;
    if (!apiKey) return resp({ error: 'GROQ_API_KEY not configured' }, 500);

    const model = env.GROQ_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct';

    // 25-second timeout — just under Cloudflare Workers 30s wall limit
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);

    try {
      const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method:  'POST',
        signal:  controller.signal,
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
              { type: 'text', text: PROMPT },
            ],
          }],
          max_tokens:  2048,
          temperature: 0.1,
        }),
      });
      clearTimeout(timer);

      if (!groqRes.ok) {
        const err = await groqRes.text();
        return resp({ error: `Groq ${groqRes.status}: ${err.slice(0, 200)}`, students: [] }, 502);
      }

      const data     = await groqRes.json();
      const raw      = data.choices?.[0]?.message?.content || '';
      const parsed   = extractJSON(raw);
      const students = cleanStudents(parsed.students);

      return resp({ students, provider: 'AariNAT-OCR-Groq', model });

    } catch (err) {
      clearTimeout(timer);
      const isTimeout = err.name === 'AbortError';
      return resp({
        error: isTimeout ? 'Groq timeout after 25s' : err.message,
        students: []
      }, 502);
    }
  },
};
