# 🎬 CineNext

Ne izlemek istediğini doğal bir dille yaz, yapay zeka isteğini analiz etsin ve **gerçek TMDb verileriyle** sana film ve dizi önersin.

> "Interstellar gibi ama daha gizemli ve çok uzun olmayan bir film istiyorum."
> "Breaking Bad gibi sürükleyici bir dizi."

**Film mi dizi mi?** İstekte sadece "film" geçiyorsa yalnızca film, sadece "dizi" geçiyorsa yalnızca dizi önerilir.
Belirtilmezse (veya ikisi birden istenirse) isteğe en uygun yapımlar film ve dizi karışık olarak döner.

## 🚧 Proje Durumu

| Aşama | İçerik | Durum |
|------|--------|-------|
| 1 | Proje iskeleti, Express sunucusu, frontend tasarımı (demo veri) | ✅ |
| 2 | TMDb API entegrasyonu + anahtar kelime tabanlı istek analizi | ✅ |
| 3 | Google Gemini API ile istek analizi ve öneri açıklamaları | ✅ |
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

1. **AI analizi (Gemini):** Kullanıcının cümlesi kriterlere çevrilir ve uygun film/dizi adları önerilir.
   `"Gerilim ama çok korkunç olmayan bir dizi"` → `{ mediaType: "tv", genres: [Gerilim], excludeGenres: [Korku], suggestedTitles: [...] }`
2. **Doğrulama (TMDb):** Gemini'nin önerdiği her yapım TMDb'de aranır. Bulunamayan elenir, yani AI bir yapım uydursa bile kullanıcıya gösterilmez.
3. **Tamamlama (TMDb):** "X gibi" dendiyse X'in TMDb önerileri, hâlâ eksik varsa TMDb Discover sonuçları eklenir (`mediaType: "all"` ise film ve dizi sırayla karıştırılır).
4. **Detay (TMDb):** Poster, puan, süre (dizide bölüm süresi), sezon sayısı, tür ve açıklama TMDb'den alınır.
5. **Açıklama (Gemini):** "Neden bu film/dizi?" metni, sadece TMDb'den gelen gerçek bilgilere dayanarak yazılır.

> TMDb'de dizi türleri filmlerden farklıdır (örn. dizide Aksiyon ve Macera tek tür). Kriterler film tür ID'leriyle tutulur,
> dizi ararken `queryAnalyzer.js` içindeki `TV_GENRES` tablosuyla çevrilir.

### Yedek plan

Gemini'nin ücretsiz kotası dolarsa, key tanımlı değilse veya servis cevap vermezse uygulama çökmez:
anahtar kelime tabanlı analizci (`queryAnalyzer.js`) ve şablon açıklamalar devreye girer, kullanıcıya küçük bir not gösterilir.

## 💸 Ücretsiz Gemini Kullanımı

- Varsayılan model: `gemini-3.5-flash-lite` (hızlı, ücretsiz katmanda kullanılabilir). `.env` içinde `GEMINI_MODEL` ile değiştirilebilir.
- Key'i [Google AI Studio](https://aistudio.google.com/app/apikey)'dan alın ve projede **faturalandırmayı (billing) açmayın**. Böylece limit aşılsa bile ücret çıkmaz, sadece `429` hatası döner.
- Her öneri araması 2 Gemini isteği kullanır (analiz + açıklamalar).
- Ücretsiz katmanda gönderilen veriler Google tarafından ürün geliştirme amacıyla kullanılabilir; kişisel bilgi girmeyin.

## 🔌 API

### `POST /api/recommend`

```json
// İstek
{ "query": "90 dakikadan kısa gizem filmi" }

// Cevap
{
  "summary": "90 dakikayı geçmeyen, sürükleyici bir gizem filmi arıyor.",
  "aiUsed": true,
  "mediaType": "movie",              // "movie" | "tv" | "all"
  "criteria": ["Sadece film", "Gizem", "En fazla 90 dk"],
  "movies": [
    {
      "id": 598,
      "key": "movie-598",
      "mediaType": "movie",          // Dizilerde "tv"; ek olarak "seasons" ve "endYear" gelir, "runtime" bölüm süresidir
      "title": "Kimlik",
      "year": 2003,
      "rating": 7.2,
      "runtime": 90,
      "genres": ["Gizem", "Gerilim"],
      "overview": "...",
      "posterUrl": "https://image.tmdb.org/t/p/w500/...",
      "tmdbUrl": "https://www.themoviedb.org/movie/...",
      "reason": "Tam 90 dakikalık süresiyle sınırına uyuyor ve sonuna kadar tahmin yürütmeni sağlayacak bir gizem sunuyor."
    }
  ]
}
```

### `GET /api/health`

Sunucunun çalışıp çalışmadığını kontrol eder.

## 📁 Proje Yapısı

```
cinenext/
├── frontend/
│   ├── index.html     # Sayfa yapısı
│   ├── style.css      # Tasarım
│   └── script.js      # Arayüz mantığı
├── backend/
│   ├── server.js          # Express sunucusu ve API route'ları
│   ├── recommendation.js  # Öneri akışı: analiz → TMDb → açıklama
│   ├── gemini.js          # Gemini API: istek analizi + öneri açıklamaları
│   ├── queryAnalyzer.js   # Yedek analizci (Gemini kullanılamazsa)
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
