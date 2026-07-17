# Price Finder — Flea Market Price Scanner

Point your phone's camera at an item and take a photo → Gemini identifies the
product and uses Google Search to find its current retail price in Germany plus
a typical second-hand price range.

## Folders

- `backend/` — Next.js API proxy (`POST /api/analyze`). The Gemini API key lives only here.
- `flohfiyat/` — Expo (React Native, TypeScript) mobile app.

## Run / deploy the backend

```bash
cd backend

# Local development — get a key at https://aistudio.google.com/apikey
echo "GEMINI_API_KEY=AIza..." > .env.local
npm run dev          # http://localhost:3000/api/analyze

# Deploy to Vercel
npx vercel           # link the project on first run
npx vercel env add GEMINI_API_KEY   # add the key for production
npx vercel --prod
```

Note: the `/api/analyze` route sets `maxDuration = 60` — analysis including
Google Search can take 10–40 seconds. If you previously added an
ANTHROPIC_API_KEY on Vercel, you can remove it; it's no longer used.

## Run the app

1. Replace `API_URL` in `flohfiyat/config.ts` with your own Vercel URL.
   (For local testing use your computer's LAN IP:
   `http://192.168.x.x:3000/api/analyze` — phone and computer must be on the
   same Wi-Fi.)
2. Start:

```bash
cd flohfiyat
npx expo start
```

3. Scan the QR code with **Expo Go** on your phone.

## API contract

`POST /api/analyze` — body: `{ "image": "<base64 jpeg, without data URI prefix>" }`

Successful response:

```json
{
  "name": "...", "brand": "... | null", "category": "...",
  "condition_guess": "... | null",
  "new_price_eur": 120, "used_price_min_eur": 40, "used_price_max_eur": 60,
  "confidence": "high | medium | low",
  "negotiation_tip": "...", "notes": "..."
}
```

Error response: `{ "error": "human-readable message (in Turkish)" }` (400/429/500/502).

## Notes

- Model: `gemini-2.5-flash` with the `googleSearch` tool enabled — recognition
  and price research happen in a single Gemini call. The location target
  (Germany/EUR) is specified in the prompt.
- Forced JSON mode (`responseMimeType`/`responseSchema`) is NOT used while
  `googleSearch` is enabled — they conflict on gemini-2.5; JSON is enforced via
  the prompt and then parsed.
- The photo is resized to 1024px width on the app side and sent as jpeg (0.6 quality).
- Prices are approximate; check the confidence badge on the result card.
- Pin the backend to TypeScript 5 (`typescript@^5`) — TS 7 breaks the
  Next.js 16 build.
