import { useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as ImagePicker from "expo-image-picker";
import * as ImageManipulator from "expo-image-manipulator";

import { analyzeQuery, identifyImage, RateLimitError } from "./api";
import type { AnalyzeResult, Confidence, IdentifyResult, PriceSource } from "./types";

type Screen =
  | { name: "camera" }
  | { name: "loading"; kind: "identify" | "analyze" }
  | { name: "identify"; result: IdentifyResult }
  | { name: "result"; result: AnalyzeResult }
  | { name: "error"; message: string; rateLimit?: boolean };

// Arka arkaya istekleri (ve 429'ları) frenlemek için buton cooldown süresi
const COOLDOWN_MS = 6_000;

// Manuel aramada API çağrısı olmadan direkt açılan site aramaları
const SEARCH_SITES: { name: string; url: (q: string) => string }[] = [
  {
    name: "eBay",
    url: (q) => `https://www.ebay.de/sch/i.html?_nkw=${encodeURIComponent(q)}`,
  },
  {
    name: "Kleinanzeigen",
    url: (q) =>
      `https://www.kleinanzeigen.de/s-suchanfrage.html?keywords=${encodeURIComponent(q)}`,
  },
  {
    name: "Vinted",
    url: (q) => `https://www.vinted.de/catalog?search_text=${encodeURIComponent(q)}`,
  },
];

const CONFIDENCE_STYLE: Record<Confidence, { label: string; color: string }> = {
  high: { label: "Yüksek güven", color: "#2e9e5b" },
  medium: { label: "Orta güven", color: "#d99a1b" },
  low: { label: "Düşük güven", color: "#d9534f" },
};

function formatEur(value: number | null): string {
  if (value === null || Number.isNaN(value)) return "—";
  return `${Math.round(value)}€`;
}

// Sitede gerçek ilan verisi var mı? Fiyatlar null ise ya da model
// "veri bulunamadı" notu düştüyse yok say.
function sourceHasData(source: PriceSource): boolean {
  if (source.price_min_eur === null && source.price_max_eur === null) return false;
  if (source.note?.toLowerCase().includes("veri bulunamadı")) return false;
  return true;
}

// Sitelerde aranacak sorgu — marka adı zaten ürün adının içindeyse tekrarlama
function buildSearchQuery(name: string, brand: string | null): string {
  return brand && !name.toLowerCase().includes(brand.toLowerCase())
    ? `${brand} ${name}`
    : name;
}

// Hatalardan ekran state'i üret: rate limit yumuşak mesajla gösterilir
function toErrorScreen(err: unknown, fallback: string): Screen {
  if (err instanceof RateLimitError) {
    return { name: "error", message: err.message, rateLimit: true };
  }
  return {
    name: "error",
    message: err instanceof Error ? err.message : fallback,
  };
}

// Fotoğrafı küçült + jpeg'e çevir + base64 al (upload boyutunu düşürür)
async function toBase64Jpeg(uri: string): Promise<string> {
  const saved = await ImageManipulator.manipulateAsync(
    uri,
    [{ resize: { width: 1024 } }],
    {
      format: ImageManipulator.SaveFormat.JPEG,
      compress: 0.6,
      base64: true,
    },
  );
  if (!saved.base64) throw new Error("Fotoğraf işlenemedi");
  return saved.base64;
}

export default function App() {
  const [screen, setScreen] = useState<Screen>({ name: "camera" });
  const [permission, requestPermission] = useCameraPermissions();
  const [searchText, setSearchText] = useState("");
  const [searchedQuery, setSearchedQuery] = useState<string | null>(null);
  const cameraRef = useRef<CameraView>(null);
  const busyRef = useRef(false); // "Tara" tek çekim olsun — çift tıklamayı engelle
  const [coolingDown, setCoolingDown] = useState(false);

  // API'ye giden her aksiyon sonrası butonları kısa süre pasifle (429 freni)
  function startCooldown() {
    setCoolingDown(true);
    setTimeout(() => setCoolingDown(false), COOLDOWN_MS);
  }

  // Fotoğraf akışı: sadece ürün tanıma (grounding yok) — bedava linkler için yeter
  async function runIdentify(uri: string) {
    setScreen({ name: "loading", kind: "identify" });
    try {
      const base64 = await toBase64Jpeg(uri);
      const result = await identifyImage(base64);
      setScreen({ name: "identify", result });
    } catch (err) {
      setScreen(toErrorScreen(err, "Bilinmeyen hata"));
    } finally {
      busyRef.current = false;
    }
  }

  // Grounding'li fiyat analizi — sadece "Fiyat analizi yap" butonuyla çalışır
  async function runQueryAnalysis(query: string) {
    if (busyRef.current || coolingDown) return;
    busyRef.current = true;
    startCooldown();
    setScreen({ name: "loading", kind: "analyze" });
    try {
      const result = await analyzeQuery(query);
      setScreen({ name: "result", result });
    } catch (err) {
      setScreen(toErrorScreen(err, "Bilinmeyen hata"));
    } finally {
      busyRef.current = false;
    }
  }

  async function handleCapture() {
    if (busyRef.current || coolingDown || !cameraRef.current) return;
    busyRef.current = true;
    startCooldown();
    try {
      const photo = await cameraRef.current.takePictureAsync({ quality: 0.7 });
      if (!photo?.uri) throw new Error("Fotoğraf çekilemedi");
      await runIdentify(photo.uri);
    } catch (err) {
      busyRef.current = false;
      setScreen({
        name: "error",
        message: err instanceof Error ? err.message : "Fotoğraf çekilemedi",
      });
    }
  }

  function handleSearch() {
    const q = searchText.trim();
    setSearchedQuery(q.length > 0 ? q : null);
  }

  async function handlePickFromGallery() {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      const picked = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        quality: 1,
      });
      if (picked.canceled || !picked.assets?.[0]?.uri) {
        busyRef.current = false;
        return;
      }
      await runIdentify(picked.assets[0].uri);
    } catch (err) {
      busyRef.current = false;
      setScreen({
        name: "error",
        message: err instanceof Error ? err.message : "Galeri açılamadı",
      });
    }
  }

  // --- Kamera ekranı (izin dahil) ---
  if (screen.name === "camera") {
    if (!permission) {
      return <View style={styles.centered} />;
    }

    const searchPanel = (
      <View style={styles.searchPanel}>
        <View style={styles.dividerRow}>
          <View style={styles.dividerLine} />
          <Text style={styles.dividerText}>veya elle ara</Text>
          <View style={styles.dividerLine} />
        </View>
        <View style={styles.searchRow}>
          <TextInput
            style={styles.searchInput}
            placeholder="Ürün / marka / model"
            placeholderTextColor="#6b7178"
            value={searchText}
            onChangeText={setSearchText}
            onSubmitEditing={handleSearch}
            returnKeyType="search"
            autoCapitalize="none"
          />
          <Pressable style={styles.searchButton} onPress={handleSearch}>
            <Text style={styles.searchButtonText}>Ara</Text>
          </Pressable>
        </View>
        {searchedQuery ? (
          <>
            {SEARCH_SITES.map((site) => (
              <Pressable
                key={site.name}
                style={styles.searchLinkRow}
                onPress={() => Linking.openURL(site.url(searchedQuery)).catch(() => {})}
              >
                <Text style={styles.searchLinkName}>{site.name}</Text>
                <Text style={styles.searchLinkOpen}>Aç ↗</Text>
              </Pressable>
            ))}
            <Pressable
              style={[styles.analyzeButton, coolingDown && styles.buttonDisabled]}
              disabled={coolingDown}
              onPress={() => searchedQuery && runQueryAnalysis(searchedQuery)}
            >
              <Text style={styles.analyzeButtonText}>
                {coolingDown ? "Birkaç saniye bekle…" : "Fiyat analizi yap"}
              </Text>
            </Pressable>
          </>
        ) : null}
      </View>
    );

    if (!permission.granted) {
      return (
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <View style={styles.centered}>
            <StatusBar style="light" />
            <Text style={styles.permissionText}>
              Ürünleri tarayabilmek için kamera izni gerekli.
            </Text>
            <Pressable style={styles.primaryButton} onPress={requestPermission}>
              <Text style={styles.primaryButtonText}>İzin ver</Text>
            </Pressable>
            <Pressable style={styles.secondaryButton} onPress={handlePickFromGallery}>
              <Text style={styles.secondaryButtonText}>Galeriden seç</Text>
            </Pressable>
          </View>
          {searchPanel}
        </KeyboardAvoidingView>
      );
    }
    return (
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <StatusBar style="light" />
        <CameraView ref={cameraRef} style={styles.flex} facing="back">
          <View style={styles.cameraOverlay}>
            <Text style={styles.hintText}>Ürünü kadraja al ve Tara'ya bas</Text>
            <View style={styles.captureRow}>
              <Pressable style={styles.galleryButton} onPress={handlePickFromGallery}>
                <Text style={styles.galleryButtonText}>Galeri</Text>
              </Pressable>
              <Pressable
                style={[styles.captureButton, coolingDown && styles.buttonDisabled]}
                disabled={coolingDown}
                onPress={handleCapture}
              >
                <Text style={styles.captureButtonText}>
                  {coolingDown ? "Bekle" : "Tara"}
                </Text>
              </Pressable>
              <View style={styles.galleryButton} />
            </View>
          </View>
        </CameraView>
        {searchPanel}
      </KeyboardAvoidingView>
    );
  }

  // --- Yükleniyor ---
  if (screen.name === "loading") {
    const identifying = screen.kind === "identify";
    return (
      <View style={styles.centered}>
        <StatusBar style="light" />
        <ActivityIndicator size="large" color="#f4b400" />
        <Text style={styles.loadingTitle}>
          {identifying ? "Ürün tanınıyor…" : "Fiyatlar araştırılıyor…"}
        </Text>
        <Text style={styles.loadingSubtitle}>
          {identifying
            ? "Fotoğraftaki ürün belirleniyor, birkaç saniye sürer"
            : "Almanya'daki güncel fiyatlar araştırılıyor, bu 10-30 saniye sürebilir"}
        </Text>
      </View>
    );
  }

  // --- Hata ---
  if (screen.name === "error") {
    return (
      <View style={styles.centered}>
        <StatusBar style="light" />
        <Text style={styles.errorTitle}>
          {screen.rateLimit ? "Çok istek oldu" : "Bir şeyler ters gitti"}
        </Text>
        <Text style={screen.rateLimit ? styles.rateLimitMessage : styles.errorMessage}>
          {screen.message}
        </Text>
        <Pressable
          style={styles.primaryButton}
          onPress={() => setScreen({ name: "camera" })}
        >
          <Text style={styles.primaryButtonText}>Tekrar dene</Text>
        </Pressable>
      </View>
    );
  }

  // --- Tanıma sonucu: bedava arama linkleri + opsiyonel fiyat analizi ---
  if (screen.name === "identify") {
    const identified = screen.result;
    const identifyConfidence =
      CONFIDENCE_STYLE[identified.confidence] ?? CONFIDENCE_STYLE.low;
    const identifyQuery = buildSearchQuery(identified.name, identified.brand);

    return (
      <ScrollView
        style={styles.resultScreen}
        contentContainerStyle={styles.resultContent}
      >
        <StatusBar style="light" />
        <View style={styles.card}>
          <View style={[styles.badge, { backgroundColor: identifyConfidence.color }]}>
            <Text style={styles.badgeText}>{identifyConfidence.label}</Text>
          </View>

          <Text style={styles.productName}>{identified.name}</Text>
          {identified.brand ? <Text style={styles.brand}>{identified.brand}</Text> : null}
          <Text style={styles.category}>
            {identified.category}
            {identified.condition_guess ? ` · ${identified.condition_guess}` : ""}
          </Text>

          <View style={styles.sourcesBox}>
            <Text style={styles.priceLabel}>İlanlara kendin bak (ücretsiz)</Text>
            {SEARCH_SITES.map((site) => (
              <Pressable
                key={site.name}
                style={styles.sourceRow}
                onPress={() => Linking.openURL(site.url(identifyQuery)).catch(() => {})}
              >
                <Text style={styles.sourceSite}>{site.name}</Text>
                <Text style={styles.searchLinkOpen}>Aç ↗</Text>
              </Pressable>
            ))}
          </View>

          <Pressable
            style={[styles.analyzeButton, coolingDown && styles.buttonDisabled]}
            disabled={coolingDown}
            onPress={() => runQueryAnalysis(identifyQuery)}
          >
            <Text style={styles.analyzeButtonText}>
              {coolingDown ? "Birkaç saniye bekle…" : "Fiyat analizi yap"}
            </Text>
          </Pressable>
          <Text style={styles.notes}>
            Fiyat analizi Google aramalı ve kotalı — hızlı bakış için üstteki linkler
            yeterli olabilir.
          </Text>
        </View>

        <Pressable
          style={styles.primaryButton}
          onPress={() => setScreen({ name: "camera" })}
        >
          <Text style={styles.primaryButtonText}>Tekrar tara</Text>
        </Pressable>
      </ScrollView>
    );
  }

  // --- Sonuç kartı ---
  const { result } = screen;
  const confidence = CONFIDENCE_STYLE[result.confidence] ?? CONFIDENCE_STYLE.low;
  const resultQuery = buildSearchQuery(result.name, result.brand);

  return (
    <ScrollView style={styles.resultScreen} contentContainerStyle={styles.resultContent}>
      <StatusBar style="light" />
      <View style={styles.card}>
        <View style={[styles.badge, { backgroundColor: confidence.color }]}>
          <Text style={styles.badgeText}>{confidence.label}</Text>
        </View>

        <Text style={styles.productName}>{result.name}</Text>
        {result.brand ? <Text style={styles.brand}>{result.brand}</Text> : null}
        <Text style={styles.category}>
          {result.category}
          {result.condition_guess ? ` · ${result.condition_guess}` : ""}
        </Text>

        <View style={styles.priceRow}>
          <View style={styles.priceBox}>
            <Text style={styles.priceLabel}>Sıfır fiyatı</Text>
            <Text style={styles.newPrice}>~{formatEur(result.new_price_eur)}</Text>
          </View>
          <View style={styles.priceBox}>
            <Text style={styles.priceLabel}>Normal satış fiyatı</Text>
            <Text style={styles.newPrice}>~{formatEur(result.market_price_eur)}</Text>
          </View>
        </View>

        {result.sources.length > 0 ? (
          <View style={styles.sourcesBox}>
            <Text style={styles.priceLabel}>İkinci el fiyatları (kaynak kırılımı)</Text>
            {result.sources.map((source) => {
              const hasData = sourceHasData(source);
              return (
                <View key={source.site} style={styles.sourceBlock}>
                  <View style={styles.sourceRow}>
                    <Text style={styles.sourceSite}>{source.site}</Text>
                    {hasData ? (
                      <Text style={styles.sourceRange} numberOfLines={1}>
                        {formatEur(source.price_min_eur)} –{" "}
                        {formatEur(source.price_max_eur)}
                      </Text>
                    ) : (
                      <Text style={styles.sourceNoData} numberOfLines={1}>
                        veri bulunamadı
                      </Text>
                    )}
                  </View>
                  {source.listings.map((listing) => (
                    <Pressable
                      key={listing.url}
                      style={styles.listingRow}
                      onPress={() => Linking.openURL(listing.url).catch(() => {})}
                    >
                      <Text style={styles.listingTitle} numberOfLines={1}>
                        {listing.title}
                      </Text>
                      <View style={styles.sourceRight}>
                        {listing.price_eur !== null ? (
                          <Text style={styles.listingPrice}>
                            {formatEur(listing.price_eur)}
                          </Text>
                        ) : null}
                        <Text style={styles.sourceArrow}>→</Text>
                      </View>
                    </Pressable>
                  ))}
                </View>
              );
            })}
          </View>
        ) : null}

        <View style={styles.sourcesBox}>
          <Text style={styles.priceLabel}>İlanlara kendin bak</Text>
          {SEARCH_SITES.map((site) => (
            <Pressable
              key={site.name}
              style={styles.sourceRow}
              onPress={() => Linking.openURL(site.url(resultQuery)).catch(() => {})}
            >
              <Text style={styles.sourceSite}>{site.name}</Text>
              <Text style={styles.searchLinkOpen}>Aç ↗</Text>
            </Pressable>
          ))}
        </View>

        {result.max_buy_price_eur !== null ? (
          <View style={[styles.priceBox, styles.usedPriceBox]}>
            <Text style={styles.priceLabel}>Alış hedefi (yeniden satış için)</Text>
            <Text style={styles.usedPrice}>≤ {formatEur(result.max_buy_price_eur)}</Text>
            <Text style={styles.buyHint}>
              İlan aralığı: {formatEur(result.used_price_min_eur)} –{" "}
              {formatEur(result.used_price_max_eur)}
            </Text>
          </View>
        ) : (
          <View style={[styles.priceBox, styles.usedPriceBox]}>
            <Text style={styles.priceLabel}>Ortalama makul aralık</Text>
            <Text style={styles.usedPrice}>
              {formatEur(result.used_price_min_eur)} –{" "}
              {formatEur(result.used_price_max_eur)}
            </Text>
          </View>
        )}

        <View style={styles.tipBox}>
          <Text style={styles.tipTitle}>Pazarlık önerisi</Text>
          <Text style={styles.tipText}>{result.negotiation_tip}</Text>
        </View>

        {result.notes ? <Text style={styles.notes}>{result.notes}</Text> : null}
      </View>

      <Pressable
        style={styles.primaryButton}
        onPress={() => setScreen({ name: "camera" })}
      >
        <Text style={styles.primaryButtonText}>Tekrar tara</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  centered: {
    flex: 1,
    backgroundColor: "#14161a",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    gap: 12,
  },
  permissionText: {
    color: "#e8e8e8",
    fontSize: 17,
    textAlign: "center",
    marginBottom: 8,
  },
  cameraOverlay: {
    flex: 1,
    justifyContent: "flex-end",
    paddingBottom: 40,
    paddingHorizontal: 20,
  },
  hintText: {
    color: "#ffffff",
    textAlign: "center",
    fontSize: 15,
    marginBottom: 16,
    textShadowColor: "rgba(0,0,0,0.7)",
    textShadowRadius: 4,
  },
  captureRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  captureButton: {
    backgroundColor: "#f4b400",
    width: 96,
    height: 96,
    borderRadius: 48,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 4,
    borderColor: "#ffffff",
  },
  captureButtonText: { color: "#14161a", fontSize: 20, fontWeight: "700" },
  galleryButton: {
    width: 72,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: "center",
  },
  galleryButtonText: {
    color: "#ffffff",
    fontSize: 15,
    fontWeight: "600",
    textShadowColor: "rgba(0,0,0,0.7)",
    textShadowRadius: 4,
  },
  searchPanel: {
    backgroundColor: "#14161a",
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 24,
    gap: 10,
  },
  dividerRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  dividerLine: { flex: 1, height: 1, backgroundColor: "#2a2e35" },
  dividerText: { color: "#6b7178", fontSize: 12 },
  searchRow: { flexDirection: "row", gap: 8 },
  searchInput: {
    flex: 1,
    backgroundColor: "#1e2127",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: "#e8e8e8",
    fontSize: 15,
  },
  searchButton: {
    backgroundColor: "#2a2e35",
    borderRadius: 10,
    paddingHorizontal: 18,
    justifyContent: "center",
  },
  searchButtonText: { color: "#ffffff", fontSize: 15, fontWeight: "700" },
  searchLinkRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#1e2127",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  searchLinkName: { color: "#c8cdd3", fontSize: 14, fontWeight: "600" },
  searchLinkOpen: { color: "#7fb3ff", fontSize: 14, fontWeight: "700" },
  analyzeButton: {
    backgroundColor: "#f4b400",
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
    marginTop: 2,
  },
  analyzeButtonText: { color: "#14161a", fontSize: 15, fontWeight: "700" },
  buttonDisabled: { opacity: 0.4 },
  loadingTitle: { color: "#ffffff", fontSize: 20, fontWeight: "700", marginTop: 16 },
  loadingSubtitle: {
    color: "#9aa0a6",
    fontSize: 14,
    textAlign: "center",
    lineHeight: 20,
  },
  errorTitle: { color: "#ffffff", fontSize: 20, fontWeight: "700" },
  errorMessage: {
    color: "#d9534f",
    fontSize: 15,
    textAlign: "center",
    lineHeight: 21,
  },
  // Rate limit geçici bir durum — kırmızı hata yerine sakin sarı ton
  rateLimitMessage: {
    color: "#d99a1b",
    fontSize: 15,
    textAlign: "center",
    lineHeight: 21,
  },
  resultScreen: { flex: 1, backgroundColor: "#14161a" },
  resultContent: { padding: 20, paddingTop: 64, gap: 16 },
  card: {
    backgroundColor: "#1e2127",
    borderRadius: 16,
    padding: 20,
    gap: 8,
  },
  badge: {
    alignSelf: "flex-start",
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  badgeText: { color: "#ffffff", fontSize: 12, fontWeight: "700" },
  productName: { color: "#ffffff", fontSize: 24, fontWeight: "800", marginTop: 4 },
  brand: { color: "#c8cdd3", fontSize: 17, fontWeight: "600" },
  category: { color: "#9aa0a6", fontSize: 14 },
  priceRow: { flexDirection: "row", gap: 12, marginTop: 12 },
  priceBox: {
    flex: 1,
    backgroundColor: "#14161a",
    borderRadius: 12,
    padding: 14,
    gap: 4,
  },
  usedPriceBox: { borderWidth: 2, borderColor: "#f4b400", flex: undefined },
  sourcesBox: {
    backgroundColor: "#14161a",
    borderRadius: 12,
    padding: 14,
    marginTop: 12,
    gap: 8,
  },
  sourceBlock: { gap: 6 },
  sourceRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  listingRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingLeft: 12,
    paddingVertical: 2,
  },
  listingTitle: { color: "#7fb3ff", fontSize: 13, flexShrink: 1 },
  listingPrice: { color: "#e8e8e8", fontSize: 13, fontWeight: "600" },
  sourceSite: { color: "#c8cdd3", fontSize: 14, fontWeight: "600" },
  sourceRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flexShrink: 1,
  },
  sourceRange: { color: "#e8e8e8", fontSize: 14, fontWeight: "700", flexShrink: 1 },
  sourceNoData: { color: "#6b7178", fontSize: 13, fontStyle: "italic", flexShrink: 1 },
  sourceArrow: { color: "#7fb3ff", fontSize: 15, fontWeight: "700" },
  priceLabel: { color: "#9aa0a6", fontSize: 12 },
  newPrice: { color: "#e8e8e8", fontSize: 22, fontWeight: "700" },
  usedPrice: { color: "#f4b400", fontSize: 22, fontWeight: "800" },
  buyHint: { color: "#9aa0a6", fontSize: 12, marginTop: 2 },
  tipBox: {
    backgroundColor: "#26313f",
    borderRadius: 12,
    padding: 14,
    marginTop: 12,
    gap: 4,
  },
  tipTitle: { color: "#7fb3ff", fontSize: 13, fontWeight: "700" },
  tipText: { color: "#e8e8e8", fontSize: 15, lineHeight: 21 },
  notes: { color: "#9aa0a6", fontSize: 13, lineHeight: 19, marginTop: 8 },
  primaryButton: {
    backgroundColor: "#f4b400",
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 32,
    alignItems: "center",
  },
  primaryButtonText: { color: "#14161a", fontSize: 17, fontWeight: "700" },
  secondaryButton: { paddingVertical: 10 },
  secondaryButtonText: { color: "#7fb3ff", fontSize: 15, fontWeight: "600" },
});
