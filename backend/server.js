// ============================================================
// CineNext — Backend (Express sunucusu)
// ============================================================
// Bu dosya iki iş yapar:
// 1. frontend/ klasöründeki HTML, CSS ve JS dosyalarını tarayıcıya sunar.
// 2. /api ile başlayan adreslerde kendi REST API'mizi çalıştırır.
//
// Neden backend var? API key'ler tarayıcıya giden JavaScript içine konursa
// herkes görebilir. Bu yüzden akış şöyle olacak:
//   Frontend  →  Bizim Express backend'imiz  →  TMDb / Gemini API
// ============================================================

const path = require("path");
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

// backend/.env dosyasındaki değişkenleri process.env içine yükler
require("dotenv").config({ path: path.join(__dirname, ".env") });

// Öneri mantığını ayrı bir dosyada tutuyoruz ki server.js sade kalsın
const { recommendMovies } = require("./recommendation");

const app = express();
const PORT = process.env.PORT || 3000;

// Ters vekil (reverse proxy) arkasında çalışıyorsan (Render, Railway, Nginx...)
// .env içinde TRUST_PROXY=1 yaz. Böylece hız sınırı ziyaretçinin gerçek IP'sini
// görür. Vekil yokken açmak tehlikelidir: herkes IP'sini taklit edebilir.
if (process.env.TRUST_PROXY) {
  app.set("trust proxy", Number(process.env.TRUST_PROXY));
}

// ------------------------------------------------------------
// GÜVENLİK BAŞLIKLARI (helmet)
// ------------------------------------------------------------
// Tarayıcıya "bu sayfada neye izin var" diyen başlıkları ekler.
// CSP'yi elle yazıyoruz: helmet'in varsayılanı sadece kendi sunucumuza izin
// verir, o hâlde Google Fonts yazı tipleri ve TMDb posterleri yüklenemezdi.
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "default-src": ["'self'"],
        "script-src": ["'self'"],
        "style-src": ["'self'", "https://fonts.googleapis.com"],
        "font-src": ["'self'", "https://fonts.gstatic.com"],
        "img-src": ["'self'", "https://image.tmdb.org", "data:"],
        "connect-src": ["'self'"],
        "form-action": ["'self'"],
        "frame-ancestors": ["'none'"],
        // Varsayılanda açık gelir ama yerel geliştirmede (http://localhost)
        // kendi dosyalarımızı https'e zorlayıp sayfayı bozardı
        "upgrade-insecure-requests": null,
      },
    },
    // Posterler başka bir alan adından (image.tmdb.org) geliyor
    crossOriginEmbedderPolicy: false,
  })
);

// Gelen isteklerdeki JSON gövdesini okuyabilmek için
app.use(express.json({ limit: "64kb" }));

// frontend/ klasörünü statik dosya olarak sun (http://localhost:3000)
app.use(express.static(path.join(__dirname, "..", "frontend")));

// ------------------------------------------------------------
// HIZ SINIRI (rate limit)
// ------------------------------------------------------------
// Tek bir öneri isteği arka planda ~2 Gemini + 20-30 TMDb isteği yapıyor.
// Sınır olmadan herkese açık bir adreste biri ücretsiz kotamızı dakikalar
// içinde bitirebilir. Dakikada 10 istek, normal kullanıcıya fazlasıyla yeter.
const recommendLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Çok fazla istek gönderdin. Lütfen bir dakika bekle." },
});

// ------------------------------------------------------------
// API ROUTE'LARI
// ------------------------------------------------------------

// Sunucunun çalışıp çalışmadığını kontrol etmek için basit bir endpoint
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", message: "CineNext backend çalışıyor 🎬" });
});

// Film ve dizi önerisi endpoint'i
// İstek:  POST /api/recommend   gövde: { "query": "90 dakikadan kısa gizem filmi" }
// Cevap:  { mediaType: "movie", criteria: ["Sadece film", "Gizem"], movies: [ {...}, ... ] }
//         movies içindeki her öğenin mediaType alanı "movie" veya "tv" olur
//
// "Başka öner" için: gövdeye exclude eklenirse o yapımlar bir daha önerilmez.
//   { "query": "...", "exclude": [{ "key": "tv-1396", "title": "Breaking Bad" }] }
app.post("/api/recommend", recommendLimiter, async (req, res) => {
  const query = typeof req.body.query === "string" ? req.body.query.trim() : "";

  // Kullanıcıdan gelen veriyi her zaman backend'de de kontrol et
  if (query.length < 3 || query.length > 300) {
    return res.status(400).json({ error: "İstek 3 ile 300 karakter arasında olmalı." });
  }

  // Kullanıcının ekranda gördüğü yapımlar: tekrar önerilmemeleri için gelir.
  // Frontend ne gönderirse göndersin, sadece beklediğimiz biçimdekileri alıyoruz.
  const exclude = (Array.isArray(req.body.exclude) ? req.body.exclude : [])
    .filter((item) => item && typeof item.key === "string" && /^(movie|tv)-[0-9]+$/.test(item.key))
    .slice(-60) // Sınıra takılınca en yeni 60 kayıt tutulur ki en son görülenler tekrar çıkmasın
    .map((item) => ({ key: item.key, title: cleanTitle(item.title) }));

  try {
    const result = await recommendMovies(query, exclude);
    res.json(result);
  } catch (error) {
    // Ayrıntı sadece sunucu log'una; kullanıcıya genel bir mesaj gider
    console.error("❌ Öneri hatası:", error.message);
    const statusCode = error.statusCode || 500;
    res.status(statusCode).json({ error: error.userMessage || genericMessage(statusCode) });
  }
});

// Bilinmeyen /api adresleri için HTML değil JSON dönelim
app.use("/api", (req, res) => {
  res.status(404).json({ error: "Böyle bir adres yok." });
});

// ------------------------------------------------------------
// SON HATA YAKALAYICI
// ------------------------------------------------------------
// Bozuk JSON gövdesi, çok büyük istek gibi durumlarda Express kendi HTML hata
// sayfasını döndürür ve o sayfa hata yığınını (stack trace) gösterebilir.
// Kullanıcının iç detayları görmesine gerek yok: JSON ve genel mesaj.
app.use((error, req, res, next) => {
  console.error("❌ İstek hatası:", error.message);
  const statusCode = error.status || error.statusCode || 500;
  res.status(statusCode).json({ error: genericMessage(statusCode) });
});

// ------------------------------------------------------------
// YARDIMCILAR
// ------------------------------------------------------------

// Duruma göre, iç detay içermeyen kullanıcı mesajı
function genericMessage(statusCode) {
  if (statusCode === 400) return "İstek anlaşılamadı. Lütfen tekrar dene.";
  if (statusCode === 413) return "İstek çok büyük.";
  if (statusCode === 429) return "Şu an çok fazla istek var. Lütfen biraz sonra tekrar dene.";
  if (statusCode === 502 || statusCode === 503) {
    return "Servise şu an ulaşılamıyor. Lütfen birazdan tekrar dene.";
  }
  return "Beklenmeyen bir hata oluştu. Lütfen tekrar dene.";
}

// Başlıklar Gemini'ye "bunları tekrar önerme" notu olarak gidiyor.
// Tarayıcıdan geldikleri için içlerine talimat yazılabilir; satır sonlarını ve
// kontrol karakterlerini boşluğa çevirip kısaltıyoruz ki prompt'a tek satırlık
// düz metinden başka bir şey giremesin.
function cleanTitle(value) {
  if (typeof value !== "string") return "";

  const withoutControlChars = Array.from(value)
    .map((ch) => (ch.codePointAt(0) < 32 || ch.codePointAt(0) === 127 ? " " : ch))
    .join("");

  return withoutControlChars.split(" ").filter(Boolean).join(" ").slice(0, 60);
}

// ------------------------------------------------------------
// SUNUCUYU BAŞLAT
// ------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`✅ Sunucu çalışıyor: http://localhost:${PORT}`);
});
