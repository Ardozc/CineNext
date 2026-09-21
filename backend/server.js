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

// backend/.env dosyasındaki değişkenleri process.env içine yükler
require("dotenv").config({ path: path.join(__dirname, ".env") });

// Öneri mantığını ayrı bir dosyada tutuyoruz ki server.js sade kalsın
const { recommendMovies } = require("./recommendation");

const app = express();
const PORT = process.env.PORT || 3000;

// Gelen isteklerdeki JSON gövdesini okuyabilmek için
app.use(express.json());

// frontend/ klasörünü statik dosya olarak sun (http://localhost:3000)
app.use(express.static(path.join(__dirname, "..", "frontend")));

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
app.post("/api/recommend", async (req, res) => {
  const query = typeof req.body.query === "string" ? req.body.query.trim() : "";

  // Kullanıcıdan gelen veriyi her zaman backend'de de kontrol et
  if (query.length < 3 || query.length > 300) {
    return res.status(400).json({ error: "İstek 3 ile 300 karakter arasında olmalı." });
  }

  // Kullanıcının ekranda gördüğü yapımlar: tekrar önerilmemeleri için gelir.
  // Frontend ne gönderirse göndersin, sadece beklediğimiz biçimdekileri alıyoruz.
  const exclude = (Array.isArray(req.body.exclude) ? req.body.exclude : [])
    .filter((item) => item && typeof item.key === "string" && /^(movie|tv)-[0-9]+$/.test(item.key))
    .slice(0, 60)
    .map((item) => ({
      key: item.key,
      title: typeof item.title === "string" ? item.title.slice(0, 100) : "",
    }));

  try {
    const result = await recommendMovies(query, exclude);
    res.json(result);
  } catch (error) {
    console.error("❌ Öneri hatası:", error.message);
    // statusCode'u olan hatalar bizim oluşturduğumuz, kullanıcıya gösterilebilir mesajlardır
    const statusCode = error.statusCode || 500;
    const message = error.statusCode ? error.message : "Beklenmeyen bir hata oluştu.";
    res.status(statusCode).json({ error: message });
  }
});

// ------------------------------------------------------------
// SUNUCUYU BAŞLAT
// ------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`✅ Sunucu çalışıyor: http://localhost:${PORT}`);
});
