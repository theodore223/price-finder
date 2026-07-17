// Backend URL'i — Vercel'e deploy ettikten sonra kendi URL'inle değiştir.
// Yerel test için: bilgisayarının LAN IP'si, örn. "http://192.168.1.20:3000/api/analyze"
export const API_URL = "https://pazar-app-delta.vercel.app/api/analyze";
// Tek istek için zaman aşımı (web search + backend'in 429 backoff'lu retry'ı
// dahil analiz 10-60 sn sürebilir)
export const REQUEST_TIMEOUT_MS = 75_000;
