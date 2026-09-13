# 🎬 AI Movie Assistant

Ne izlemek istediğini doğal bir dille yaz, yapay zeka isteğini analiz etsin ve **gerçek TMDb verileriyle** sana film önersin.

> "Interstellar gibi ama daha gizemli ve çok uzun olmayan bir film istiyorum."

## 🚧 Proje Durumu

| Aşama | İçerik | Durum |
|------|--------|-------|
| 1 | Proje iskeleti, Express sunucusu, frontend tasarımı (demo veri) | ✅ |
| 2 | TMDb API entegrasyonu + anahtar kelime tabanlı istek analizi | ✅ |
| 3 | Google Gemini API ile istek analizi ve öneri açıklamaları | ⏳ |
| 4 | "Benzer filmler" özelliği ve iyileştirmeler | ⏳ |

## 🛠️ Teknolojiler

- **Frontend:** HTML, CSS, Vanilla JavaScript (framework yok)
- **Backend:** Node.js, Express.js
- **API'ler:** TMDb API, Google Gemini API

## 🔐 Güvenli Mimari

API key'ler tarayıcıya asla gönderilmez:

```
Tarayıcı (frontend)  →  Express backend  →  TMDb / Gemini API
                          (key'ler .env içinde)
```

## ⚙️ Öneri Nasıl Çalışır?

1. **Analiz:** Kullanıcının cümlesi kriterlere çevrilir.
   `"Gerilim ama çok korkunç olmayan"` → `{ genres: [Gerilim], excludeGenres: [Korku] }`
2. **Arama:** "X gibi" kalıbı varsa X filmi TMDb'de bulunur ve onun önerileri alınır; yoksa TMDb Discover ile tür/süre/yıl filtrelenir.
3. **Detay:** Poster, puan, süre, tür ve açıklama TMDb'den alınır. Film bilgileri asla uydurulmaz.
4. **Açıklama:** Her filmin neden önerildiği yazılır.

## 🔌 API

### `POST /api/recommend`

```json
// İstek
{ "query": "90 dakikadan kısa gizem filmi" }

// Cevap
{
  "criteria": ["Gizem", "En fazla 90 dk"],
  "movies": [
    {
      "id": 598,
      "title": "Kimlik",
      "year": 2003,
      "rating": 7.2,
      "runtime": 90,
      "genres": ["Gizem", "Gerilim"],
      "overview": "...",
      "posterUrl": "https://image.tmdb.org/t/p/w500/...",
      "tmdbUrl": "https://www.themoviedb.org/movie/...",
      "reason": "İstediğin Gizem türüne uyuyor. 90 dakika ile süre tercihine uygun."
    }
  ]
}
```

### `GET /api/health`

Sunucunun çalışıp çalışmadığını kontrol eder.

## 📁 Proje Yapısı

```
ai-movie-assistant/
├── frontend/
│   ├── index.html     # Sayfa yapısı
│   ├── style.css      # Tasarım
│   └── script.js      # Arayüz mantığı
├── backend/
│   ├── server.js          # Express sunucusu ve API route'ları
│   ├── recommendation.js  # Öneri akışı: analiz → TMDb → açıklama
│   ├── queryAnalyzer.js   # Cümleyi kriterlere çevirir (3. aşamada Gemini)
│   ├── tmdb.js            # TMDb API istekleri
│   └── .env               # Gizli anahtarlar (GitHub'a gönderilmez)
├── .gitignore
├── .env.example       # .env için şablon
├── package.json
└── README.md
```

## 🚀 Kurulum

```bash
# 1. Bağımlılıkları yükle
npm install

# 2. Ortam değişkenlerini hazırla
cp .env.example backend/.env
# backend/.env içine kendi API key'lerini yaz

# 3. Sunucuyu başlat
npm start
```

Tarayıcıda aç: **http://localhost:3000**

Geliştirirken dosya değiştikçe otomatik yeniden başlatma için: `npm run dev`

## 🙏 Teşekkür

Bu ürün TMDb API'sini kullanır ancak TMDb tarafından onaylanmamış veya sertifikalandırılmamıştır.
Film verileri ve posterler [The Movie Database (TMDb)](https://www.themoviedb.org/) kaynaklıdır.
