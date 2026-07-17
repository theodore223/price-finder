export type Confidence = "high" | "medium" | "low";

// Sitede bulunan tek bir gerçek ilan — karttan tıklanıp tarayıcıda açılır.
export interface SourceListing {
  title: string;
  price_eur: number | null;
  url: string;
}

// Tek bir sitedeki (eBay/Kleinanzeigen/Vinted) gerçek ilan fiyat aralığı.
// Sitede veri bulunamazsa fiyatlar null gelir, note açıklar.
export interface PriceSource {
  site: string;
  price_min_eur: number | null;
  price_max_eur: number | null;
  listings: SourceListing[];
  note: string | null;
}

// Fotoğraftan sadece ürün tanıma sonucu (grounding'siz ucuz çağrı) —
// fiyat analizi ayrı butonla istenir.
export interface IdentifyResult {
  name: string;
  brand: string | null;
  category: string;
  condition_guess: string | null;
  confidence: Confidence;
}

export interface AnalyzeResult {
  name: string;
  brand: string | null;
  category: string;
  condition_guess: string | null;
  new_price_eur: number | null;
  sources: PriceSource[];
  // İnternette normalde gerçekleşen satış fiyatı (eBay satılmış ilan ağırlıklı)
  market_price_eur: number | null;
  // Kârlı yeniden satış için önerilen en yüksek alış fiyatı
  max_buy_price_eur: number | null;
  used_price_min_eur: number;
  used_price_max_eur: number;
  confidence: Confidence;
  negotiation_tip: string;
  notes: string;
}
