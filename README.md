# FlohFiyat — İkinci El Pazar Fiyat Tarayıcı

Telefonun kamerasını ürüne tut, foto çek → Gemini ürünü tanır, Google Search ile
Almanya'daki güncel sıfır fiyatını ve tipik ikinci el aralığını bulur.

## Klasörler

- `backend/` — Next.js API proxy (`POST /api/analyze`). Gemini API key sadece burada.
- `flohfiyat/` — Expo (React Native, TypeScript) mobil uygulama.

## Backend'i çalıştır / deploy et

```bash
cd backend

# Yerel geliştirme — anahtar: https://aistudio.google.com/apikey
echo "GEMINI_API_KEY=AIza..." > .env.local
npm run dev          # http://localhost:3000/api/analyze

# Vercel'e deploy
npx vercel           # ilk kurulumda projeyi bağla
npx vercel env add GEMINI_API_KEY   # production için key ekle
npx vercel --prod
```

Not: `/api/analyze` route'unda `maxDuration = 60` ayarlı — Google Search dahil
analiz 10-40 saniye sürebilir. Daha önce ANTHROPIC_API_KEY eklediysen Vercel'den
kaldırabilirsin, artık kullanılmıyor.

## Uygulamayı çalıştır

1. `flohfiyat/config.ts` içindeki `API_URL`'i kendi Vercel URL'inle değiştir.
   (Yerel test için bilgisayarının LAN IP'si: `http://192.168.x.x:3000/api/analyze` —
   telefon ve bilgisayar aynı Wi-Fi'da olmalı.)
2. Başlat:

```bash
cd flohfiyat
npx expo start
```

3. Telefonda **Expo Go** ile QR kodu okut.

## API sözleşmesi

`POST /api/analyze` — gövde: `{ "image": "<base64 jpeg, data URI prefix'siz>" }`

Başarılı yanıt:

```json
{
  "name": "...", "brand": "... | null", "category": "...",
  "condition_guess": "... | null",
  "new_price_eur": 120, "used_price_min_eur": 40, "used_price_max_eur": 60,
  "confidence": "high | medium | low",
  "negotiation_tip": "...", "notes": "..."
}
```

Hata yanıtı: `{ "error": "okunabilir Türkçe mesaj" }` (400/429/500/502).

## Notlar

- Model: `gemini-2.5-flash`, `googleSearch` tool'u açık, tek Gemini çağrısında
  tanıma + fiyat araştırma. Konum hedefi (Almanya/EUR) prompt'ta belirtiliyor.
- `googleSearch` açıkken zorunlu JSON modu (`responseMimeType`/`responseSchema`)
  KULLANILMIYOR — gemini-2.5'te çakışıyor; JSON prompt'la zorlanıp parse ediliyor.
- Fotoğraf app tarafında 1024px genişliğe küçültülüp jpeg (0.6) olarak yollanır.
- Fiyatlar yaklaşıktır; kart üstündeki güven rozetine bak.
- Backend'de TypeScript 5'e sabit kal (`typescript@^5`) — TS 7, Next.js 16
  build'ini kırıyor.
