import { API_URL, REQUEST_TIMEOUT_MS } from "./config";
import type { AnalyzeResult, IdentifyResult } from "./types";

// Backend'in 429/RATE_LIMIT yanıtı — UI bunu sert hata yerine "biraz bekle"
// mesajıyla gösterir.
export class RateLimitError extends Error {}

export function analyzeImage(base64Jpeg: string): Promise<AnalyzeResult> {
  return requestAnalysis({ image: base64Jpeg });
}

export function analyzeQuery(query: string): Promise<AnalyzeResult> {
  return requestAnalysis({ query });
}

// Grounding'siz ucuz çağrı: sadece ürünü tanı, fiyat araştırma yok.
export async function identifyImage(base64Jpeg: string): Promise<IdentifyResult> {
  const data = await postJson({ image: base64Jpeg, mode: "identify" });

  if (!data || typeof data.name !== "string" || typeof data.category !== "string") {
    throw new Error("Sunucudan beklenmeyen yanıt geldi");
  }

  return {
    name: data.name,
    brand: typeof data.brand === "string" && data.brand ? data.brand : null,
    category: data.category,
    condition_guess:
      typeof data.condition_guess === "string" && data.condition_guess
        ? data.condition_guess
        : null,
    confidence:
      data.confidence === "high" || data.confidence === "medium"
        ? data.confidence
        : "low",
  };
}

async function requestAnalysis(body: {
  image?: string;
  query?: string;
}): Promise<AnalyzeResult> {
  const data = await postJson(body);

  if (
    !data ||
    typeof data.name !== "string" ||
    typeof data.used_price_min_eur !== "number" ||
    typeof data.used_price_max_eur !== "number"
  ) {
    throw new Error("Sunucudan beklenmeyen yanıt geldi");
  }

  // Model kaynak dizisini atlarsa kart yine de çalışsın
  if (!Array.isArray(data.sources)) {
    data.sources = [];
  }
  data.sources = data.sources.filter(
    (s: unknown) => s && typeof (s as { site?: unknown }).site === "string",
  );

  // listings'i normalize et: URL'siz/bozuk girdileri ele, eksik alanları doldur
  for (const source of data.sources) {
    const raw: unknown[] = Array.isArray(source.listings) ? source.listings : [];
    source.listings = raw
      .filter(
        (l): l is { url: string; title?: unknown; price_eur?: unknown } =>
          !!l &&
          typeof (l as { url?: unknown }).url === "string" &&
          (l as { url: string }).url.startsWith("http"),
      )
      .map((l) => ({
        title: typeof l.title === "string" && l.title ? l.title : "İlan",
        price_eur: typeof l.price_eur === "number" ? l.price_eur : null,
        url: l.url,
      }));
  }

  // Yeni alanları eski backend yanıtlarına karşı tolere et
  if (typeof data.market_price_eur !== "number") data.market_price_eur = null;
  if (typeof data.max_buy_price_eur !== "number") data.max_buy_price_eur = null;

  return data as AnalyzeResult;
}

async function postJson(body: object): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const data = await res.json().catch(() => null);

    if (res.status === 429 || (data && data.error_type === "RATE_LIMIT")) {
      throw new RateLimitError(
        (data && typeof data.error === "string" && data.error) ||
          "Çok istek oldu, birkaç saniye sonra tekrar dene",
      );
    }

    if (!res.ok) {
      throw new Error(
        (data && typeof data.error === "string" && data.error) ||
          `Sunucu hatası (${res.status})`,
      );
    }

    return data;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("İstek zaman aşımına uğradı — bağlantını kontrol edip tekrar dene");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
