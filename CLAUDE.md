# FlohFiyat — İkinci El Pazar Fiyat Tarayıcı

## Proje Nedir

Almanya'daki ikinci el pazarında (Flohmarkt) telefonun kamerasını bir ürüne tutunca,
uygulama ürünü tanıyıp o ürünün **güncel normal fiyatını** (sıfır perakende fiyatı) ve
**tipik ikinci el fiyat aralığını** söylesin. Amaç: pazarda pazarlık yaparken elimde
gerçek bir referans olsun, kazık yememek.

Kullanım senaryosu: Standın önünde duruyorum, telefonu ürüne tutuyorum, foto çekiyorum,
2-3 saniye sonra "Bu bir X marka Y ürünü, sıfırı ~120€, ikinci el makul aralık 40-60€"
diye kart çıkıyor.

## Nasıl Çalışıyor (Akış)

```
[Telefon Kamerası]
      │  foto çek (base64)
      ▼
[Expo App]  ──POST /api/analyze──►  [Vercel Serverless Proxy]
      ▲                                      │
      │                                      │  Anthropic API çağrısı
      │                                      │  (vision + web_search, tek istek)
      │                                      ▼
      │                             [Claude Sonnet]
      │                              1. Fotoğraftaki ürünü tanı (marka/model/kategori)
      │                              2. web_search ile Almanya'da güncel fiyatı bul
      │                              3. JSON döndür
      │                                      │
      └────────── sonuç kartı ◄──────────────┘
```

Kritik nokta: Ürün tanıma + fiyat bulma **tek Anthropic çağrısında** oluyor. Vision ile
görseli okur, web_search tool'u ile de Almanya'daki güncel fiyatı araştırır. Böylece
"training verisinden tahmini fiyat" değil, gerçek/güncel fiyat gelir.

## Mimari & Neden

- **Frontend: Expo (React Native, TypeScript)** — telefonda gerçek kamera erişimi lazım,
  Expo Go ile kendi telefonumda anında test ederim, PWA'dan daha iyi kamera deneyimi.
- **Backend: Vercel Serverless Function (Next.js API route)** — Anthropic API key'i asla
  app içine gömülmemeli. Key backend'de `.env`'de durur, app sadece proxy'e istek atar.
  Zaten Vercel + Next.js benim tanıdığım ortam.
- **AI: Anthropic Messages API** — `claude-sonnet-5` (vision + web_search destekli, hız/
  maliyet dengesi iyi). İstersem `claude-opus-4-8`'e geçebilirim daha zor tanımalar için.

## Teknoloji Stack

- Expo SDK (en güncel), `expo-camera` veya `expo-image-picker`
- TypeScript
- Backend: Next.js API route, Vercel'e deploy
- Anthropic Messages API — model `claude-sonnet-5`, `web_search` tool açık, image input
- State: sade React state, harici store gerekmez

## Backend — /api/analyze

**Endpoint:** `POST /api/analyze`

**İstek gövdesi:**
```json
{ "image": "<base64 jpeg, data URI prefix'siz>" }
```

**Anthropic çağrısı:** messages içinde image bloğu + text talimat, `web_search` tool açık.

Sistem/talimat promptu (Claude'a verilecek — sadece JSON döndürmesini zorla):
```
Sen bir ikinci el fiyat uzmanısın. Sana bir ürün fotoğrafı veriliyor.

1. Fotoğraftaki ürünü tanı: marka, model, kategori. Emin değilsen en olası tahmini yaz
   ve confidence'ı düşür.
2. web_search kullanarak bu ürünün ALMANYA'daki GÜNCEL fiyatını araştır (EUR):
   - Sıfır/yeni perakende fiyatı
   - Tipik ikinci el satış fiyatı aralığı (eBay Kleinanzeigen, Flohmarkt seviyesi)
3. SADECE aşağıdaki JSON'u döndür, başka hiçbir şey yazma (markdown, ``` yok):

{
  "name": "ürünün okunabilir adı",
  "brand": "marka ya da null",
  "category": "kategori",
  "condition_guess": "fotoğraftan tahmini durum, ya da null",
  "new_price_eur": <sayı ya da null>,
  "used_price_min_eur": <sayı>,
  "used_price_max_eur": <sayı>,
  "confidence": "high" | "medium" | "low",
  "negotiation_tip": "pazarlık için kısa Türkçe öneri",
  "notes": "kısa Türkçe açıklama, kaynak/belirsizlik notu"
}
```

**Yanıt işleme:** `data.content` içinden `type === "text"` bloklarını birleştir, olası
` ```json ` fence'lerini temizle, `JSON.parse` et. Parse hatasına karşı try/catch koy,
hata olursa app'e anlamlı bir hata mesajı dön.

**Güvenlik:** `ANTHROPIC_API_KEY` sadece Vercel env'de. App tarafında key YOK.

## Ekranlar

1. **Kamera / Tarama ekranı**
   - Canlı kamera önizleme + büyük "Tara" butonu
   - Alternatif: galeriden foto seç
2. **Analiz ekranı**
   - Yükleniyor animasyonu ("Ürün tanınıyor... fiyat araştırılıyor...")
3. **Sonuç kartı**
   - Ürün adı + marka (büyük)
   - Sıfır fiyatı: `~120€`
   - İkinci el makul aralık: `40€ – 60€` (vurgulu)
   - Pazarlık önerisi (negotiation_tip)
   - Confidence rozeti (yeşil/sarı/kırmızı)
   - "Tekrar tara" butonu

## Kurulum Adımları

```bash
# Expo app
npx create-expo-app flohfiyat -t
cd flohfiyat
npx expo install expo-camera expo-image-picker

# Backend (ayrı Next.js projesi ya da monorepo)
# /api/analyze route'unu oluştur, Vercel'e deploy et
vercel

# Vercel env değişkeni
# ANTHROPIC_API_KEY=sk-ant-...
```

App tarafında backend URL'ini bir config/env değişkeninde tut (Vercel deploy URL'i).

## Önemli Notlar & Sınırlamalar

- **Fiyatlar yaklaşık.** Web search + model tahmini; kesin değil. İkinci el fiyat ürün
  durumuna ve bölgeye göre çok değişir. Kart bunu belli etsin (confidence rozeti).
- **İnternet şart.** Pazarda mobil veri lazım, offline çalışmaz. Kötü bağlantıda timeout
  ve retry mantığı koy.
- **Almanca etiketler.** Ürünlerin üstünde Almanca yazılar olacak — vision zaten okur,
  ekstra bir şey gerekmez.
- **Maliyet.** Her tarama = 1 Anthropic çağrısı (web_search dahil). Kişisel kullanım için
  sorun değil ama gereksiz spam taramayı önlemek için "Tara" butonu tek çekim olsun.
- **Gizlilik/hız.** Fotoğrafı backend'e yolluyoruz, orada saklamıyoruz — sadece Anthropic'e
  iletip yanıtı dönüyoruz.
- **Fallback fikri (opsiyonel):** Web search'ü kapatan bir "hızlı mod" toggle'ı eklenebilir
  — daha hızlı ama fiyat tahmini modelin bilgisinden gelir, daha az güncel olur.

## Sonraki Adımlar (uygulama çalıştıktan sonra, opsiyonel)

- Tarama geçmişi (son baktığım ürünler + fiyatları)
- "Bu fiyata alır mıyım?" — kâr marjı hesaplayan basit mantık
- Birden fazla ürünü tek fotoğrafta tanıma
