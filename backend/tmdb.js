// ============================================================
// tmdb.js — TMDb API ile konuşan tüm kodlar burada
// ============================================================
// Bu dosya sadece "TMDb'den veri al ve düzenle" işini yapar.
// Hangi yapımın önerileceğine karar vermez (o iş recommendation.js'de).
//
// Film ve dizi desteklenir. mediaType her yerde "movie" veya "tv" olur.
// TMDb'de filmler "title / release_date", diziler "name / first_air_date"
// kullanır; bu dosya ikisini aynı alan adlarına çevirir ki geri kalan kod
// film mi dizi mi olduğunu çoğu yerde umursamasın.
//
// TMDb dokümantasyonu: https://developer.themoviedb.org/reference
// ============================================================

const TMDB_BASE_URL = "https://api.themoviedb.org/3";
const IMAGE_BASE_URL = "https://image.tmdb.org/t/p/w500";
const LANGUAGE = "tr-TR";

// Hata oluştururken HTTP durum kodunu da ekleyelim ki
// server.js kullanıcıya doğru cevabı dönebilsin.
function createError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

// İsteği gönderir (Node.js 18+ sürümlerinde fetch yerleşiktir, paket gerekmez).
// - Her deneme 8 saniyede cevap vermezse iptal edilir; takılan bağlantı kullanıcıyı bekletmez.
// - Anlık ağ kopmalarında (ECONNRESET vb.) kısa bir bekleyişle en fazla 3 kez denenir.
async function fetchWithRetry(url, attempts = 3) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fetch(url, { signal: AbortSignal.timeout(8000) });
    } catch (error) {
      const reason = error.cause ? error.cause.code || error.cause.message : error.message;
      console.warn(`TMDb bağlantı hatası (deneme ${attempt}/${attempts}):`, reason);

      if (attempt === attempts) {
        throw createError("TMDb'ye bağlanılamadı. İnternet bağlantını kontrol et.", 502);
      }
      // Her denemede biraz daha uzun bekle: 300ms, 600ms
      await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
    }
  }
}

// ------------------------------------------------------------
// Tüm TMDb isteklerinin geçtiği ortak fonksiyon
// ------------------------------------------------------------
// endpoint: "/search/movie" gibi bir yol
// params:   { query: "Inception" } gibi ek parametreler
async function tmdbRequest(endpoint, params = {}) {
  const apiKey = process.env.TMDB_API_KEY;

  if (!apiKey || apiKey.startsWith("your_")) {
    throw createError("Sunucuda TMDB_API_KEY tanımlı değil. backend/.env dosyasını kontrol et.", 500);
  }

  // URL nesnesi, parametreleri güvenle (doğru kodlamayla) eklememizi sağlar
  const url = new URL(TMDB_BASE_URL + endpoint);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("language", LANGUAGE);

  for (const [key, value] of Object.entries(params)) {
    // Boş değerleri URL'e eklemiyoruz
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, value);
    }
  }

  const response = await fetchWithRetry(url);

  if (response.status === 401) {
    throw createError("TMDb API key geçersiz. backend/.env dosyasındaki anahtarı kontrol et.", 500);
  }

  if (!response.ok) {
    throw createError(`TMDb şu an cevap veremiyor (HTTP ${response.status}).`, 502);
  }

  return response.json();
}

// ------------------------------------------------------------
// Liste sonuçlarını ortak yapıya çevirir
// ------------------------------------------------------------
// Dizilerde "name" ve "first_air_date" gelir; filmlerle aynı adlara kopyalıyoruz.
// media_type: /search/movie gibi uç noktalar bu alanı göndermez, biz ekliyoruz.
function normalizeResults(results, mediaType) {
  return results.map((item) => ({
    ...item,
    media_type: mediaType,
    title: item.title || item.name,
    release_date: item.release_date || item.first_air_date,
  }));
}

// ------------------------------------------------------------
// Dışarıya açtığımız fonksiyonlar
// ------------------------------------------------------------

// Ada göre arama yapar. mediaType: "movie" veya "tv"
async function search(mediaType, title) {
  const data = await tmdbRequest(`/search/${mediaType}`, { query: title, include_adult: false });
  return normalizeResults(data.results, mediaType);
}

// Film ve dizileri birlikte arar (kişi sonuçları atılır)
async function searchMulti(title) {
  const data = await tmdbRequest("/search/multi", { query: title, include_adult: false });
  const movies = data.results.filter((item) => item.media_type === "movie" || item.media_type === "tv");
  return movies.map((item) => normalizeResults([item], item.media_type)[0]);
}

// Belirli kriterlere göre keşif (tür, süre, yıl, puan...)
async function discover(mediaType, filters) {
  const data = await tmdbRequest(`/discover/${mediaType}`, { include_adult: false, ...filters });
  return normalizeResults(data.results, mediaType);
}

// Bir yapımı sevenlere TMDb'nin önerdikleri (aynı türde döner: film → film, dizi → dizi)
async function getRecommendations(mediaType, id) {
  const data = await tmdbRequest(`/${mediaType}/${id}/recommendations`);
  return normalizeResults(data.results, mediaType);
}

// Tüm detayları alır ve kartta kullanacağımız sade bir nesneye çevirir
async function getDetails(mediaType, id) {
  // append_to_response=translations: Türkçe açıklama yoksa İngilizcesini kullanabilmek için
  const details = await tmdbRequest(`/${mediaType}/${id}`, { append_to_response: "translations" });
  return mediaType === "tv" ? formatTv(details) : formatMovie(details);
}

// ------------------------------------------------------------
// TMDb'nin büyük cevabını, frontend'in ihtiyaç duyduğu alanlara indirger
// ------------------------------------------------------------
function formatMovie(details) {
  return {
    ...formatCommon(details, "movie"),
    title: details.title,
    originalTitle: details.original_title,
    year: toYear(details.release_date),
    runtime: details.runtime || null,
  };
}

function formatTv(details) {
  // Dizi bittiyse bitiş yılını da gösterelim: "2008–2013"
  const hasEnded = details.status === "Ended" || details.status === "Canceled";
  // Bölüm süresi: TMDb bazı dizilerde episode_run_time'ı boş bırakıyor, son bölüme bakıyoruz
  const episodeRuntime =
    (details.episode_run_time && details.episode_run_time[0]) ||
    (details.last_episode_to_air && details.last_episode_to_air.runtime) ||
    null;

  return {
    ...formatCommon(details, "tv"),
    title: details.name,
    originalTitle: details.original_name,
    year: toYear(details.first_air_date),
    endYear: hasEnded ? toYear(details.last_air_date) : null,
    seasons: details.number_of_seasons || null,
    runtime: episodeRuntime, // Dizilerde bölüm başına süre
  };
}

// Film ve dizide ortak olan alanlar
function formatCommon(details, mediaType) {
  const typeName = mediaType === "tv" ? "dizi" : "film";
  return {
    id: details.id,
    key: `${mediaType}-${details.id}`, // Film ve dizi ID'leri çakışabilir; benzersiz anahtar
    mediaType,
    rating: Math.round(details.vote_average * 10) / 10,
    voteCount: details.vote_count,
    genreIds: details.genres.map((genre) => genre.id),
    genres: details.genres.map((genre) => genre.name),
    overview: details.overview || getEnglishOverview(details) || `Bu ${typeName} için açıklama bulunamadı.`,
    posterUrl: details.poster_path ? IMAGE_BASE_URL + details.poster_path : null,
    tmdbUrl: `https://www.themoviedb.org/${mediaType}/${details.id}`,
  };
}

function toYear(date) {
  return date ? Number(date.slice(0, 4)) : null;
}

function getEnglishOverview(details) {
  const translations = details.translations ? details.translations.translations : [];
  const english = translations.find((t) => t.iso_639_1 === "en" && t.data.overview);
  return english ? english.data.overview : null;
}

module.exports = {
  search,
  searchMulti,
  discover,
  getRecommendations,
  getDetails,
  createError,
};
