# AariNAT OCR Worker

Cloudflare Worker powered by Groq Vision (Llama 4 Scout).
Self-hosted OCR for Nigerian school registers.

## Endpoint
`https://aarinat-ocr.aarinat-company-limited.workers.dev`

## Usage
POST with `{ "base64": "...", "mime": "image/jpeg" }`
Returns `{ "students": [...], "provider": "AariNAT-OCR-Groq" }`

## Cascade (EduBloom apps)
1. AariNAT OCR (this Worker) — primary
2. Base44 — secondary fallback
3. Gemini — if key configured
4. OCR.space — last resort

*AariNAT Company Limited*
