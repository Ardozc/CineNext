// ============================================================
// queryAnalyzer.js — Kullanıcının cümlesini "film/dizi kriterlerine" çevirir
// ============================================================
// Asıl analizi Google Gemini yapar (gemini.js). Bu dosya YEDEK analizcidir:
// Gemini'nin ücretsiz kotası dolarsa veya Gemini cevap vermezse devreye girer.
// İkisi de AYNI yapıda bir kriter nesnesi döndürdüğü için geri kalan kod
// (TMDb araması, kartlar) hangisinin kullanıldığını bilmek zorunda değildir.
//
// Örnek:
//   "Gerilim ama çok korkunç olmayan bir film"
//   → { genres: [53], excludeGenres: [27], ... }
// ============================================================

// TMDb tür ID'leri ve Türkçe cümlede onları yakalayacak kelime kökleri.
// ("kork" kökü hem "korku" hem "korkunç" kelimesini yakalar.)
const GENRES = [
  { id: 28, name: "Aksiyon", keywords: ["aksiyon"] },
  { id: 12, name: "Macera", keywords: ["macera"] },
  { id: 16, name: "Animasyon", keywords: ["animasyon", "çizgi film", "anime"] },
  { id: 35, name: "Komedi", keywords: ["komedi", "komik", "güldür", "eğlenceli"] },
  { id: 80, name: "Suç", keywords: ["suç", "polisiye", "mafya", "soygun"] },
  { id: 99, name: "Belgesel", keywords: ["belgesel"] },
  { id: 18, name: "Dram", keywords: ["dram", "duygusal"] },
  { id: 10751, name: "Aile", keywords: ["aile", "çocuk"] },
  { id: 14, name: "Fantastik", keywords: ["fantastik", "fantezi", "büyü"] },
  { id: 36, name: "Tarih", keywords: ["tarih"] },
  { id: 27, name: "Korku", keywords: ["kork", "dehşet"] },
  { id: 10402, name: "Müzik", keywords: ["müzik"] },
  { id: 9648, name: "Gizem", keywords: ["gizem", "esrarengiz"] },
  { id: 10749, name: "Romantik", keywords: ["romanti", "aşk"] },
  { id: 878, name: "Bilim Kurgu", keywords: ["bilim kurgu", "bilimkurgu", "bilim-kurgu", "uzay", "sci-fi"] },
  { id: 53, name: "Gerilim", keywords: ["gerilim", "gergin", "thriller"] },
  { id: 10752, name: "Savaş", keywords: ["savaş"] },
  { id: 37, name: "Western", keywords: ["western", "kovboy", "vahşi batı"] },
];

// TMDb'de dizi türleri filmlerden farklıdır (örn. dizide "Aksiyon" ve "Macera" tek türdür:
// 10759). Kriterler her zaman FİLM tür ID'leriyle tutulur; dizi ararken bu tablo kullanılır.
//   exact:  Dizide birebir karşılığı olan türler
//   approx: Karşılığı olmayan türler için en yakın dizi türleri (sadece aramada kullanılır,
//           "hariç tut" filtresinde kullanılmaz; yoksa alakasız diziler de elenirdi)
const TV_GENRES = {
  exact: {
    28: [10759], 12: [10759], 16: [16], 35: [35], 80: [80], 99: [99], 18: [18],
    10751: [10751], 14: [10765], 9648: [9648], 878: [10765], 10752: [10768], 37: [37],
  },
  approx: {
    53: [9648, 80],     // Gerilim → Gizem, Suç
    27: [9648, 10765],  // Korku → Gizem, Bilim Kurgu & Fantastik
    10749: [18],        // Romantik → Dram
    36: [18, 10768],    // Tarih → Dram, Savaş & Politika
    10402: [18],        // Müzik → Dram
  },
};

// Film tür ID'lerini, verilen yapım türünün (movie/tv) tür ID'lerine çevirir
function toMediaGenreIds(movieGenreIds, mediaType, { approximate = true } = {}) {
  if (mediaType !== "tv") return movieGenreIds;
  const ids = movieGenreIds.flatMap(
    (id) => TV_GENRES.exact[id] || (approximate ? TV_GENRES.approx[id] || [] : [])
  );
  return [...new Set(ids)];
}

// Bir türü "istemiyorum" anlamına gelen kelimeler
const NEGATION_WORDS = ["olmayan", "olmasın", "değil", "hariç", "istemiyorum"];

// "Interstellar gibi" kalıbında film adını ararken atlanacak dolgu kelimeleri
const FILLER_WORDS = [
  "bir", "bana", "tıpkı", "aynı", "film", "filmi", "filmine", "filme",
  "dizi", "dizisi", "dizisine", "diziye",
];

// ------------------------------------------------------------
// Ana fonksiyon
// ------------------------------------------------------------
function analyzeRequest(text) {
  // Türkçe büyük/küçük harf dönüşümü için "tr-TR" kullanıyoruz (İ → i, I → ı)
  const lowerText = text.toLocaleLowerCase("tr-TR");

  const criteria = {
    mediaType: "all",    // "movie" = sadece film, "tv" = sadece dizi, "all" = ikisi de
    genres: [],          // İstenen türlerin ID'leri (film tür ID'leri)
    excludeGenres: [],   // İstenmeyen türlerin ID'leri
    minRuntime: null,    // Dakika
    maxRuntime: null,    // Dakika
    minYear: null,
    maxYear: null,
    similarTo: [],       // Referans film adı için denenecek metinler
    suggestedTitles: [], // Sadece Gemini doldurur
    summary: null,       // Sadece Gemini doldurur
  };

  criteria.mediaType = detectMediaType(lowerText);
  detectGenres(lowerText, criteria);
  detectRuntime(lowerText, criteria);
  detectYears(lowerText, criteria);
  criteria.similarTo = detectSimilarMovie(text);

  return criteria;
}

// ------------------------------------------------------------
// Film mi dizi mi? "gizem dizisi" → tv, "komedi filmi" → movie
// İkisi birden geçiyorsa ("film veya dizi") ya da hiç geçmiyorsa → all
// ------------------------------------------------------------
function detectMediaType(lowerText) {
  const wantsTv = /(^|\s)(dizi|sezon|bölüm|seri\b)/.test(lowerText);
  // "çizgi film" bir tür adıdır, film isteği sayılmaz
  const wantsMovie = /(^|\s)(film|sinema)/.test(lowerText.replace(/çizgi\s+film\S*/g, ""));

  if (wantsTv && !wantsMovie) return "tv";
  if (wantsMovie && !wantsTv) return "movie";
  return "all";
}

// ------------------------------------------------------------
// Tür analizi
// ------------------------------------------------------------
function detectGenres(lowerText, criteria) {
  for (const genre of GENRES) {
    for (const keyword of genre.keywords) {
      const index = lowerText.indexOf(keyword);
      if (index === -1) continue;

      // Kelimeden sonraki 2 kelimeye bak: "korkunç olmayan", "korku filmi olmasın"
      const nextWords = lowerText.slice(index).split(/\s+/).slice(1, 3);
      const isNegated = nextWords.some((word) => NEGATION_WORDS.includes(word));

      if (isNegated) {
        addUnique(criteria.excludeGenres, genre.id);
      } else {
        addUnique(criteria.genres, genre.id);
      }
      break; // Bu tür için bir anahtar kelime bulmak yeterli
    }
  }
}

// ------------------------------------------------------------
// Süre analizi: "90 dakikadan kısa", "2 saatten uzun", "çok uzun olmayan"
// ------------------------------------------------------------
function detectRuntime(lowerText, criteria) {
  const minuteMatch = lowerText.match(/(\d+)\s*(?:dk|dakika)\S*\s*(\S+)?/);
  const hourMatch = lowerText.match(/(\d+(?:[.,]\d+)?)\s*saat\S*\s*(\S+)?/);
  const match = minuteMatch || hourMatch;

  if (match) {
    let minutes = Number(match[1].replace(",", "."));
    if (!minuteMatch) minutes = Math.round(minutes * 60);

    // "100 dakikadan uzun / fazla / üstü" → en az; diğer durumlar → en fazla
    const wordAfter = match[2] || "";
    if (["uzun", "fazla", "üstü", "üzeri"].includes(wordAfter)) {
      criteria.minRuntime = minutes;
    } else {
      criteria.maxRuntime = minutes;
    }
    return;
  }

  // Sayı yoksa: "kısa" veya "çok uzun olmayan" → en fazla 2 saat
  if (/\bkısa\b|uzun olmayan|uzun olmasın|uzun değil/.test(lowerText)) {
    criteria.maxRuntime = 120;
  }
}

// ------------------------------------------------------------
// Yıl analizi: "90'lar", "2000'ler", "yeni", "klasik"
// ------------------------------------------------------------
function detectYears(lowerText, criteria) {
  const decadeMatch = lowerText.match(/(\d{4}|\d0)['’]?l[ae]r/);

  if (decadeMatch) {
    let decade = Number(decadeMatch[1]);
    if (decade < 100) decade += decade >= 30 ? 1900 : 2000; // "90'lar" → 1990, "10'lar" → 2010
    criteria.minYear = decade;
    criteria.maxYear = decade + 9;
  } else if (/\byeni\b|son yıllar/.test(lowerText)) {
    criteria.minYear = new Date().getFullYear() - 8;
  } else if (/\beski\b|klasik/.test(lowerText)) {
    criteria.maxYear = 1999;
  }
}

// ------------------------------------------------------------
// Benzer film analizi: "Interstellar gibi", "Inception'a benzer"
// ------------------------------------------------------------
// Film adının kaç kelime olduğunu bilemediğimiz için, kalıptan önceki
// son 4 kelimeden başlayıp kısaltarak birkaç aday oluşturuyoruz:
//   "Ben de The Dark Knight gibi" → ["de The Dark Knight", "The Dark Knight", "Dark Knight", "Knight"]
// recommendation.js bu adayları sırayla TMDb'de arar.
function detectSimilarMovie(text) {
  const match = text.match(/^(.*?)\s+(?:gibi|benzer|tarzı|tarzında|andıran)(?:\s|$)/i);
  if (!match) return [];

  const words = match[1]
    .replace(/['’]\S*/g, "") // "Inception'a" → "Inception"
    .split(/\s+/)
    .filter((word) => word && !FILLER_WORDS.includes(word.toLocaleLowerCase("tr-TR")))
    .slice(-4);

  const candidates = [];
  for (let i = 0; i < words.length; i++) {
    candidates.push(words.slice(i).join(" "));
  }
  return candidates;
}

// ------------------------------------------------------------
// Yardımcılar
// ------------------------------------------------------------
function addUnique(list, value) {
  if (!list.includes(value)) list.push(value);
}

function getGenreName(id) {
  const genre = GENRES.find((g) => g.id === id);
  return genre ? genre.name : "";
}

// Kullanıcının hangi kriterlerin algılandığını görebilmesi için okunabilir etiketler
function describeCriteria(criteria, referenceMovie) {
  const labels = [];

  if (criteria.mediaType === "movie") labels.push("Sadece film");
  if (criteria.mediaType === "tv") labels.push("Sadece dizi");
  if (referenceMovie) labels.push(`Benzer: ${referenceMovie.title}`);
  criteria.genres.forEach((id) => labels.push(getGenreName(id)));
  criteria.excludeGenres.forEach((id) => labels.push(`${getGenreName(id)} hariç`));
  if (criteria.maxRuntime) labels.push(`En fazla ${criteria.maxRuntime} dk`);
  if (criteria.minRuntime) labels.push(`En az ${criteria.minRuntime} dk`);
  if (criteria.minYear && criteria.maxYear) labels.push(`${criteria.minYear}–${criteria.maxYear}`);
  else if (criteria.minYear) labels.push(`${criteria.minYear} ve sonrası`);
  else if (criteria.maxYear) labels.push(`${criteria.maxYear} ve öncesi`);

  return labels;
}

module.exports = { GENRES, analyzeRequest, describeCriteria, getGenreName, toMediaGenreIds };
