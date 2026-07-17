import { ApiError, GoogleGenAI, type GenerateContentResponse } from "@google/genai";
import { NextRequest, NextResponse } from "next/server";

// Google Search grounding + olası 429 backoff'u dahil istek uzayabilir — Vercel'de süre tanı.
export const maxDuration = 60;

// Rate limit (429) yememek için lite model: free tier'da RPM/RPD limitleri daha yüksek.
// 2.5-flash-lite Temmuz 2026'da yeni kullanıcılara kapatıldı (404 dönüyor) — 3.1'e geçildi.
const MODEL = "gemini-3.1-flash-lite";

const INSTRUCTIONS = `Sen ikinci el alım-satım (reselling) fiyat uzmanısın. Sana bir ürün
fotoğrafı YA DA ürün adı (metin) veriliyor. Amaç: kullanıcı bu ürünü pazardan alıp
internette yeniden satacak.

1. Ürünü tanı: marka, model, kategori. Fotoğraf verildiyse fotoğraftan tanı; metin
   verildiyse metni esas al (metinde fotoğraf olmadığı için condition_guess null olsun).
   Emin değilsen en olası tahmini yaz ve confidence'ı düşür.
2. Google Search'ü TUTUMLU kullan — arama kotası sınırlı, TOPLAM EN FAZLA 2 arama yap:
   - İkinci el fiyatlar için TEK birleşik arama:
     "<ürün adı> gebraucht preis ebay.de kleinanzeigen.de vinted.de"
   - Sıfır/perakende fiyat ilk aramanın sonuçlarından çıkmadıysa BİR arama daha:
     "<ürün adı> neu kaufen preis"
   Site başına ayrı arama YAPMA, model adını netleştirmek için ek arama YAPMA.
3. eBay için GERÇEKLEŞEN satış fiyatları (verkaufte Artikel / sold) istenen (asking)
   fiyattan daha değerli sinyaldir; sonuçlarda satılmış fiyat görürsen ona ağırlık ver.
   Göremezsen aktif ilan fiyatlarını kullan ve note'a "aktif ilan fiyatı" yaz.
4. Arama sonuçlarından her site (eBay, Kleinanzeigen, Vinted) için ayrı bir fiyat aralığı
   çıkarmaya çalış (price_min_eur / price_max_eur). Fiyat UYDURMA; ama arama sonucu
   özetlerinde o siteye ait fiyat GÖRDÜYSEN aralığı MUTLAKA doldur — ilanın URL'ini
   görememen aralığı null bırakma sebebi DEĞİLDİR. "listings" bundan bağımsızdır: arama
   sonuçlarında TAM ve GERÇEK URL'ini gördüğün en fazla 3 ilanı koy (kısa başlık, fiyat,
   URL). URL görmediysen listings boş dizi kalsın — asla URL uydurma veya tahmin etme.
   Bir site için sonuçlarda HİÇ fiyat verisi yoksa o kaynağın price_min_eur/price_max_eur
   alanlarını null, listings'i boş yap ve note'a "veri bulunamadı" yaz — o site için EK
   ARAMA YAPMA. Uç değerleri (defolu, toplu satış, yanlış ürün) aralığa katma.
5. Üç kaynağı KARŞILAŞTIR ve bu ürünün internette NORMALDE SATILDIĞI fiyatı tek sayı
   olarak çıkar (market_price_eur). En güvenilir sinyal eBay'in satılmış fiyatları —
   ağırlığı onlara ver. İlanlarda istenen fiyatlar genelde gerçekleşen satıştan yüksektir,
   bunu hesaba kat. Ayrıca kaynaklardaki ilan fiyatlarından genel bir aralık da ver
   (used_price_min_eur / used_price_max_eur). Hiçbir sitede veri yoksa en iyi tahminle
   doldur, confidence'ı "low" yap ve notes'ta belirt.
6. Yeniden satıcı için iyi bir ALIŞ hedefi hesapla (max_buy_price_eur): satış komisyonu,
   kargo ve emek düşüldükten sonra anlamlı kâr kalmalı — kabaca market_price_eur'un
   %50-60'ı. Talebi yüksek, hızlı satılan üründe biraz üstü; niş/yavaş satılan üründe
   altı olabilir. negotiation_tip'te bu alış hedefini ve beklenen kâr mantığını kısaca
   Türkçe açıkla.
7. SADECE aşağıdaki JSON'u döndür, başka hiçbir şey yazma (markdown, \`\`\` yok):

{
  "name": "ürünün okunabilir adı",
  "brand": "marka ya da null",
  "category": "kategori",
  "condition_guess": "fotoğraftan tahmini durum, ya da null",
  "new_price_eur": <sayı ya da null>,
  "sources": [
    { "site": "eBay (satılan)", "price_min_eur": <sayı ya da null>, "price_max_eur": <sayı ya da null>, "listings": [ { "title": "kısa ilan başlığı", "price_eur": <sayı ya da null>, "url": "TAM URL" } ], "note": "kısa Türkçe not ya da null" },
    { "site": "Kleinanzeigen", "price_min_eur": <sayı ya da null>, "price_max_eur": <sayı ya da null>, "listings": [], "note": "kısa Türkçe not ya da null" },
    { "site": "Vinted", "price_min_eur": <sayı ya da null>, "price_max_eur": <sayı ya da null>, "listings": [], "note": "kısa Türkçe not ya da null" }
  ],
  "market_price_eur": <sayı>,
  "max_buy_price_eur": <sayı>,
  "used_price_min_eur": <sayı>,
  "used_price_max_eur": <sayı>,
  "confidence": "high" | "medium" | "low",
  "negotiation_tip": "alış hedefi ve kâr mantığını açıklayan kısa Türkçe öneri",
  "notes": "kısa Türkçe açıklama, kaynak/belirsizlik notu"
}

"sources" dizisinde her zaman bu üç site bu sırayla bulunsun.`;

// Google Search grounding 2026'dan beri free tier'da yok (429 RESOURCE_EXHAUSTED dönüyor).
// Kota hatasında aramasız yedek mod: model kendi bilgisiyle tahmin eder, bunu belli eder.
const NO_SEARCH_SUFFIX = `

ÖNEMLİ EK TALİMAT: Google Search şu an KULLANILAMIYOR. Arama yapmaya çalışma.
- Fiyatları kendi bilginle tahmin et (Almanya pazarı, EUR).
- sources içindeki üç site için price_min_eur/price_max_eur null, listings boş dizi,
  note "güncel arama yapılamadı" olsun.
- market_price_eur, max_buy_price_eur, used_price_min_eur, used_price_max_eur alanlarını
  en iyi tahminle yine de doldur.
- confidence en fazla "medium" olabilir.
- notes'ta fiyatların güncel arama olmadan tahmin edildiğini mutlaka belirt.`;

// Grounding'siz, ucuz "sadece tanı" modu — app önce bunu çağırıp bedava arama
// linklerini gösterir; pahalı fiyat analizi ayrı butonla gelir.
const IDENTIFY_INSTRUCTIONS = `Sana bir ürün fotoğrafı veriliyor. Fotoğraftaki ürünü tanı:
marka, model, kategori. Emin değilsen en olası tahmini yaz ve confidence'ı düşür.
SADECE aşağıdaki JSON'u döndür, başka hiçbir şey yazma (markdown, \`\`\` yok):

{
  "name": "ürünün okunabilir adı (marka + model)",
  "brand": "marka ya da null",
  "category": "kategori",
  "condition_guess": "fotoğraftan tahmini durum, ya da null",
  "confidence": "high" | "medium" | "low"
}`;

function extractJson(text: string): unknown {
  // Olası ```json ... ``` fence'lerini temizle, ilk { ile son } arasını al.
  const cleaned = text.replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Yanıtta JSON bulunamadı");
  }
  return JSON.parse(cleaned.slice(start, end + 1));
}

interface Listing {
  title: string;
  price_eur: number | null;
  url: string;
}

interface ParsedSource {
  site?: unknown;
  price_min_eur?: unknown;
  price_max_eur?: unknown;
  listings?: unknown;
}

// Grounding çoğu zaman modele ilanların gerçek URL'ini göstermez; model de talimat
// gereği URL uyduramaz. Boş kalan kaynaklara Gemini'nin groundingMetadata'sındaki
// gerçek arama sonucu linklerini yedek olarak ekle. Bunlar Google'ın redirect
// URL'leri — tarayıcıda açılınca gerçek sayfaya gider.
function attachGroundingLinks(parsed: unknown, response: GenerateContentResponse): void {
  const sources = (parsed as { sources?: unknown } | null)?.sources;
  if (!Array.isArray(sources)) return;
  for (const source of sources as ParsedSource[]) {
    if (!Array.isArray(source.listings)) source.listings = [];
  }

  const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
  for (const chunk of chunks) {
    const web = chunk.web as
      | { uri?: string; title?: string; domain?: string }
      | undefined;
    if (!web?.uri) continue;

    const hint = `${web.title ?? ""} ${web.domain ?? ""}`.toLowerCase();
    // picclick: eBay satılmış fiyatlarını listeleyen toplayıcı — eBay kaynağına say
    const match = [
      { siteKeyword: "ebay", hints: ["ebay", "picclick"] },
      { siteKeyword: "kleinanzeigen", hints: ["kleinanzeigen"] },
      { siteKeyword: "vinted", hints: ["vinted"] },
    ].find((m) => m.hints.some((h) => hint.includes(h)));
    if (!match) continue;

    const source = (sources as ParsedSource[]).find(
      (s) => typeof s.site === "string" && s.site.toLowerCase().includes(match.siteKeyword),
    );
    if (!source) continue;

    // Fiyat verisi olmayan kaynağa alakasız arama sayfası linki koyma
    const hasData = source.price_min_eur != null || source.price_max_eur != null;
    if (!hasData) continue;

    const listings = source.listings as Listing[];
    if (listings.length >= 3) continue;
    if (listings.some((l) => l.url === web.uri)) continue;
    listings.push({
      title: web.title || "Arama sonucu",
      price_eur: null,
      url: web.uri,
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type LimitKind = "RPM" | "RPD" | "unknown";

// Gemini'nin 429 gövdesinden RetryInfo.retryDelay'i ve hangi kotanın dolduğunu
// (dakikalık RPM mi, günlük RPD mi) çıkar. ApiError.message ham JSON'u içerir.
function parseRateLimit(err: ApiError): { retryDelayMs: number | null; limit: LimitKind } {
  const msg = err.message ?? "";
  const delayMatch = msg.match(/retryDelay["\s:]+(\d+(?:\.\d+)?)s/i);
  const retryDelayMs = delayMatch ? Math.round(parseFloat(delayMatch[1]) * 1000) : null;
  let limit: LimitKind = "unknown";
  if (/perday/i.test(msg)) limit = "RPD";
  else if (/perminute/i.test(msg)) limit = "RPM";
  return { retryDelayMs, limit };
}

function rateLimitResponse(limit: LimitKind) {
  return NextResponse.json(
    {
      error:
        limit === "RPD"
          ? "Günlük ücretsiz kota doldu — yarın tekrar dene"
          : "Çok istek oldu, birkaç saniye sonra tekrar dene",
      error_type: "RATE_LIMIT",
      limit,
    },
    { status: 429 },
  );
}

export async function POST(req: NextRequest) {
  let image: unknown;
  let query: unknown;
  let mode: unknown;
  try {
    ({ image, query, mode } = await req.json());
  } catch {
    return NextResponse.json({ error: "Geçersiz istek gövdesi" }, { status: 400 });
  }

  const hasImage = typeof image === "string" && image.length > 0;
  const trimmedQuery = typeof query === "string" ? query.trim() : "";
  const identifyOnly = mode === "identify";

  if (identifyOnly && !hasImage) {
    return NextResponse.json(
      { error: "identify modu için image (base64 jpeg) alanı gerekli" },
      { status: 400 },
    );
  }

  if (!hasImage && trimmedQuery.length === 0) {
    return NextResponse.json(
      {
        error:
          "image (base64 jpeg, data URI prefix'siz) ya da query (ürün adı) alanı gerekli",
      },
      { status: 400 },
    );
  }

  if (!process.env.GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY tanımlı değil — Vercel env ayarlarını kontrol et");
    return NextResponse.json(
      { error: "Sunucu yapılandırması eksik (API anahtarı)" },
      { status: 500 },
    );
  }

  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const instructions = identifyOnly ? IDENTIFY_INSTRUCTIONS : INSTRUCTIONS;

  // googleSearch açıkken responseMimeType/responseSchema KULLANMA —
  // gemini-2.5'te çakışıyor. JSON'u prompt zorluyor, aşağıda parse ediyoruz.
  const generate = (withSearch: boolean) =>
    ai.models.generateContent({
      model: MODEL,
      contents: [
        {
          role: "user",
          parts: hasImage
            ? [
                { inlineData: { mimeType: "image/jpeg", data: image as string } },
                { text: withSearch ? instructions : instructions + NO_SEARCH_SUFFIX },
              ]
            : [
                {
                  text: `Aranan ürün: ${trimmedQuery}\n\n${
                    withSearch ? instructions : instructions + NO_SEARCH_SUFFIX
                  }`,
                },
              ],
        },
      ],
      config: withSearch ? { tools: [{ googleSearch: {} }] } : {},
    });

  try {
    let response: GenerateContentResponse;
    try {
      response = await generate(!identifyOnly);
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 429) throw err;

      const { retryDelayMs, limit } = parseRateLimit(err);
      console.error(
        `Gemini 429 (limit: ${limit}, retryDelay: ${retryDelayMs ?? "?"}ms):`,
        err.message?.slice(0, 1000),
      );

      // identify zaten aramasız — burada 429 gerçek model kotasıdır, fallback yok.
      if (identifyOnly) {
        if (limit === "RPD" || (retryDelayMs !== null && retryDelayMs > 15_000)) {
          return rateLimitResponse(limit);
        }
        await sleep(retryDelayMs ?? 4_000);
        try {
          response = await generate(false);
        } catch (retryErr) {
          if (retryErr instanceof ApiError && retryErr.status === 429) {
            const retryInfo = parseRateLimit(retryErr);
            console.error(`Gemini 429 (retry de başarısız, limit: ${retryInfo.limit})`);
            return rateLimitResponse(retryInfo.limit);
          }
          throw retryErr;
        }
      } else {
        // Analiz modunda 429 çoğunlukla grounding kotası (free tier'da search yok,
        // detaysız RESOURCE_EXHAUSTED döner). Aramasız fallback'i dene; o da 429
        // yerse gerçekten model kotası dolmuştur.
        console.error("Grounding kotası dolu görünüyor — aramasız fallback deneniyor");
        try {
          response = await generate(false);
        } catch (fallbackErr) {
          if (fallbackErr instanceof ApiError && fallbackErr.status === 429) {
            const info = parseRateLimit(fallbackErr);
            console.error(`Gemini 429 (fallback de başarısız, limit: ${info.limit})`);
            return rateLimitResponse(info.limit);
          }
          throw fallbackErr;
        }
      }
    }

    const text = response.text;
    if (!text) {
      console.error(
        "Gemini yanıtında metin yok:",
        JSON.stringify(response).slice(0, 500),
      );
      return NextResponse.json(
        { error: "Modelden yanıt alınamadı, tekrar deneyin" },
        { status: 502 },
      );
    }

    try {
      const parsed = extractJson(text);
      if (!identifyOnly) attachGroundingLinks(parsed, response);
      return NextResponse.json(parsed);
    } catch {
      console.error("JSON çözümlenemedi, ham yanıt:", text.slice(0, 500));
      return NextResponse.json(
        { error: "Model yanıtı çözümlenemedi, tekrar deneyin" },
        { status: 502 },
      );
    }
  } catch (err) {
    if (err instanceof ApiError) {
      console.error("Gemini API hatası:", err.status, err.message);
      return NextResponse.json(
        { error: "Fiyat analizi başarısız oldu, tekrar deneyin" },
        { status: 502 },
      );
    }
    console.error("Beklenmeyen hata:", err);
    return NextResponse.json({ error: "Sunucu hatası" }, { status: 500 });
  }
}
