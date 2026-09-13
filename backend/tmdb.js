// ============================================================
// tmdb.js — TMDb API ile konuşan tüm kodlar burada
// ============================================================
// Bu dosya sadece "TMDb'den veri al ve düzenle" işini yapar.
// Hangi filmin önerileceğine karar vermez (o iş recommendation.js'de).
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

// İstek 8 saniye içinde cevap vermezse iptal edilir.
// Böylece takılan bir bağlantı kullanıcıyı sonsuza kadar bekletmez.
function fetchWithTimeout(url) {
  return fetch(url, { signal: AbortSignal.timeout(8000) });
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

  let response;
  try {
    // Node.js 18+ sürümlerinde fetch yerleşik olarak gelir, paket gerekmez
    response = await fetchWithTimeout(url);
  } catch (firstError) {
    // Anlık ağ kopmaları olabilir; bir kez daha deneyelim
    try {
      response = await fetchWithTimeout(url);
    } catch (error) {
      console.error("TMDb bağlantı hatası:", error.cause ? error.cause.code || error.cause.message : error.message);
      throw createError("TMDb'ye bağlanılamadı. İnternet bağlantını kontrol et.", 502);
    }
  }

  if (response.status === 401) {
    throw createError("TMDb API key geçersiz. backend/.env dosyasındaki anahtarı kontrol et.", 500);
  }

  if (!response.ok) {
    throw createError(`TMDb şu an cevap veremiyor (HTTP ${response.status}).`, 502);
  }

  return response.json();
}

// ------------------------------------------------------------
// Dışarıya açtığımız fonksiyonlar
// ------------------------------------------------------------

// Film adına göre arama yapar, sonuç listesini döner
async function searchMovies(title) {
  const data = await tmdbRequest("/search/movie", { query: title, include_adult: false });
  return data.results;
}

// Belirli kriterlere göre film keşfi (tür, süre, yıl, puan...)
async function discoverMovies(filters) {
  const data = await tmdbRequest("/discover/movie", { include_adult: false, ...filters });
  return data.results;
}

// Bir filmi sevenlere TMDb'nin önerdiği filmler
async function getRecommendations(movieId) {
  const data = await tmdbRequest(`/movie/${movieId}/recommendations`);
  return data.results;
}

// Filmin tüm detaylarını alır ve kartta kullanacağımız sade bir nesneye çevirir
async function getMovieDetails(movieId) {
  // append_to_response=translations: Türkçe açıklama yoksa İngilizcesini kullanabilmek için
  const details = await tmdbRequest(`/movie/${movieId}`, { append_to_response: "translations" });
  return formatMovie(details);
}

// ------------------------------------------------------------
// TMDb'nin büyük cevabını, frontend'in ihtiyaç duyduğu alanlara indirger
// ------------------------------------------------------------
function formatMovie(details) {
  return {
    id: details.id,
    title: details.title,
    originalTitle: details.original_title,
    year: details.release_date ? Number(details.release_date.slice(0, 4)) : null,
    rating: Math.round(details.vote_average * 10) / 10,
    voteCount: details.vote_count,
    runtime: details.runtime || null,
    genreIds: details.genres.map((genre) => genre.id),
    genres: details.genres.map((genre) => genre.name),
    overview: details.overview || getEnglishOverview(details) || "Bu film için açıklama bulunamadı.",
    posterUrl: details.poster_path ? IMAGE_BASE_URL + details.poster_path : null,
    tmdbUrl: `https://www.themoviedb.org/movie/${details.id}`,
  };
}

function getEnglishOverview(details) {
  const translations = details.translations ? details.translations.translations : [];
  const english = translations.find((t) => t.iso_639_1 === "en" && t.data.overview);
  return english ? english.data.overview : null;
}

module.exports = {
  searchMovies,
  discoverMovies,
  getRecommendations,
  getMovieDetails,
  createError,
};
