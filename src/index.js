// AariNAT OCR — Cloudflare Worker v2.6
// Key fix: reasoning_format:"hidden" (NOT reasoning_effort) suppresses Qwen3 thinking tokens
// Without this, Qwen emits thousands of <think> tokens that cause timeout before JSON arrives

const PROMPT = `You are a relentless data extraction bot. You have been given an image of a Nigerian school register. Your ONLY job is to find and return every single student row — no exceptions.

STEP 1 — COUNT THE ROWS
Before writing any JSON, mentally count every horizontal line of text that contains a name. That count is your target. You MUST return exactly that many objects.

STEP 2 — SCAN EXHAUSTIVELY
Scan left to right, top to bottom. For EVERY row you see:
- Assign it an index (1, 2, 3... in order)
- Extract the SURNAME (left name column)
- Extract the FIRSTNAME (right name column)
- Extract the CLASS if visible (BASIC ONE-SIX, NURSERY 1-2, JSS 1-3, SSS 1-3, UNKNOWN)

STEP 3 — NEVER SKIP
Do NOT skip any row. Do NOT stop early. Do NOT summarise.
If handwriting is unclear, GUESS the Nigerian name spelling — but include the row.
If you only see one name on a row, put it in surname and leave firstname empty.

SKIP ONLY: the single header row (SERIAL NO / NAMES / S.N), naira amounts, dates.

Nigerian name reference (use to help guess unclear handwriting):
Surnames:   OGUNLADE, KASALI, ALAWODE, ADEBAYO, OLIYIDE, OBASA, AKINWANDE, LAWAL,
            ODEREYE, ADEGUNLE, GBELEKALE, FAFIOLU, AYANRINDE, MOSES, SHONIPE,
            OJO, OYEBOLA, ADERIBIGBE, OLAYIWOLA, ADENIYI, AYOMIDE, OLOOTU, JOHN,
            DADA, IDOWU, ATAJA, OGUNSOLA, AWOLOWO, KASALI, ALAO, AKINDELE
Firstnames: GODWIN, MICHEAL, BLESSING, AMINAT, DEBORAH, GABRIEL, RASAQ, ENOCH,
            KOREDE, ISREAL, MARYAM, CYNTHIA, WASILAT, DORCAS, CHRISTIANA, AFEEZ,
            DOMINION, SAMUEL, MALEEK, FATHIA, INIOLUWA, QUARIBAT, AWAL, BIGGOLD,
            TOHEEB, SALAM, WAJUD, IBRAHIM, RAHMON, SUCCESS, EZEKIEL, EMMANUEL

STEP 4 — OUTPUT
Return ONLY a valid JSON object. No markdown. No explanation. Nothing else.
The array MUST have one object per student row — every single one.

{"students":[
  {"index":1,"surname":"OLIYIDE","firstname":"GODWIN","class":"UNKNOWN"},
  {"index":2,"surname":"OBASA","firstname":"MICHEAL","class":"BASIC FOUR"}
]}`;

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
  // Defensive: strip any <think>...</think> blocks in case they slip through
  raw = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  raw = raw.replace(/^```json?\s*/i, '').replace(/\s*```$/, '').trim();

  try { return JSON.parse(raw); } catch (e) {}

  const m = raw.match(/\{[\s\S]*\}/);
  if (m) try { return JSON.parse(m[0]); } catch (e) {}

  // Truncated JSON repair — salvage complete student objects even if array is cut off
  const students = [];
  for (const match of raw.matchAll(/\{[^{}]*"surname"\s*:\s*"([^"]+)"[^{}]*"firstname"\s*:\s*"([^"]+)"[^{}]*\}/g)) {
    try {
      const obj = JSON.parse(match[0]);
      if (obj.surname && obj.firstname) students.push(obj);
    } catch(e) {}
  }
  if (students.length > 0) return { students };
  return { students: [] };
}

function cleanStudents(list) {
  const seen = new Set();
  return (list || []).reduce((out, s) => {
    const surname   = String(s.surname   || '').trim().toUpperCase();
    const firstname = String(s.firstname || '').trim().toUpperCase();
    const cls       = String(s.class     || '').trim().toUpperCase() || 'UNKNOWN';
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
        name: 'AariNAT OCR API', version: '2.6', status: 'live',
        provider: 'Groq Vision — qwen/qwen3.6-27b',
        fix: 'reasoning_format:hidden suppresses think tokens (was reasoning_effort which Groq ignored)',
      });
    }

    if (request.method !== 'POST') return resp({ error: 'POST only' }, 405);

    let body;
    try { body = await request.json(); }
    catch (e) { return resp({ error: 'Invalid JSON body' }, 400); }

    const { base64, mime = 'image/jpeg' } = body;
    if (!base64) return resp({ error: 'base64 required' }, 400);

    // Check image size — Groq 4MB base64 limit
    const estimatedBytes = base64.length * 0.75;
    if (estimatedBytes > 4 * 1024 * 1024) {
      return resp({
        error: `Image ~${Math.round(estimatedBytes/1024/1024)}MB exceeds Groq 4MB limit. Resize before sending.`,
        students: [], hint: 'resize'
      }, 413);
    }

    const apiKey = env.GROQ_API_KEY;
    if (!apiKey) return resp({ error: 'GROQ_API_KEY not configured' }, 500);

    const model = env.GROQ_MODEL || 'qwen/qwen3.6-27b';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);

    let groqRes;
    try {
      groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST', signal: controller.signal,
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
          max_tokens:       8192,
          temperature:      0.7,    // Qwen3.6 non-thinking mode recommendation
          top_p:            0.8,
          top_k:            20,
          presence_penalty: 1.5,
          reasoning_format: 'hidden', // ← THE FIX: suppresses <think> tokens in output
        }),
      });
      clearTimeout(timer);
    } catch (e) {
      clearTimeout(timer);
      return resp({
        error: e.name === 'AbortError' ? 'Groq timeout after 25s' : e.message,
        students: []
      }, 502);
    }

    if (!groqRes.ok) {
      const err = await groqRes.text();
      return resp({ error: `Groq ${groqRes.status}: ${err.slice(0, 400)}`, students: [] }, 502);
    }

    const data     = await groqRes.json();
    const raw      = data.choices?.[0]?.message?.content || '';
    const parsed   = extractJSON(raw);
    const students = cleanStudents(parsed.students);

    return resp({
      students, model, count: students.length,
      provider: 'AariNAT-OCR-Groq',
      rawLength: raw.length,
    });
  },
};
