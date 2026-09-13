// ============================================================
// recommendation.js — Öneri akışını yöneten dosya
// ============================================================
// Adımlar:
//   1. Kullanıcının cümlesini kriterlere çevir
//        → Gemini (gemini.js). Çalışmazsa yedek: queryAnalyzer.js
//   2. Kriterlere uyan GERÇEK filmleri TMDb'de bul (tmdb.js)
//        → Gemini'nin önerdiği adlar TMDb'de doğrulanır
//        → "X gibi" dendiyse X'in TMDb önerileri eklenir
//        → Hâlâ az film varsa TMDb Discover ile tamamlanır
//   3. Her film için detayları al (poster, süre, puan...)
//   4. Gemini'ye bu gerçek bilgilerle "Neden bu film?" açıklaması yazdır
//
// Film adı, yılı, puanı, posteri gibi bilgilerin HEPSİ TMDb'den gelir.
// ============================================================

const tmdb = require("./tmdb");
const gemini = require("./gemini");
const { analyzeRequest, describeCriteria, getGenreName } = require("./queryAnalyzer");

const RESULT_COUNT = 6;      // Kullanıcıya gösterilecek film sayısı
const BATCH_SIZE = 10;       // Aynı anda detayı alınacak film sayısı
const MAX_DETAIL_CALLS = 30; // TMDb'ye aşırı istek atmamak için üst sınır

async function recommendMovies(userQuery) {
  // 1) Analiz: Önce Gemini'yi dene. Kota dolmuşsa, key yoksa veya
  //    Gemini cevap vermezse uygulama bozulmasın; basit analize geç.
  let criteria;
  let aiUsed = true;
  try {
    criteria = await gemini.analyzeRequest(userQuery);
  } catch (error) {
    console.warn("⚠️  Gemini analizi kullanılamadı, basit analize geçildi:", error.message);
    criteria = analyzeRequest(userQuery);
    aiUsed = false;
  }

  // 2) "X gibi" dendiyse referans filmi bul.
  //    Hiçbir kriter bulunamadıysa, kullanıcı belki sadece bir film adı yazmıştır.
  let referenceMovie = null;
  if (criteria.similarTo.length > 0) {
    referenceMovie = await findReferenceMovie(criteria.similarTo);
  } else if (!hasAnyCriteria(criteria)) {
    referenceMovie = await findReferenceMovie([userQuery]);
  }

  // 3) Aday filmleri topla (önem sırasına göre)
  let candidates = await findSuggestedMovies(criteria);

  if (referenceMovie) {
    const fromReference = await getCandidatesFromReference(referenceMovie, criteria);
    candidates = mergeWithoutDuplicates(candidates, fromReference);
  }
  // Discover sonuçlarını her zaman yedek olarak sona ekliyoruz: süre filtresinden
  // sonra film sayısı 6'nın altına düşerse eksikler buradan tamamlanır.
  // (Detaylar sadece gerektiği kadar alındığı için ek maliyeti tek bir istek)
  const discovered = await getCandidatesFromDiscover(criteria);
  candidates = mergeWithoutDuplicates(candidates, discovered);

  // Referans filmin kendisini önermeyelim
  if (referenceMovie) {
    candidates = candidates.filter((movie) => movie.id !== referenceMovie.id);
  }

  // 4) Detayları 10'arlı gruplar halinde al ve süre filtresini uygula.
  //    Süre sadece detaylarda olduğu için, 6 uygun film bulana kadar devam ediyoruz.
  //    (Promise.all bir gruptaki istekleri aynı anda gönderir)
  const suitableMovies = [];
  for (let start = 0; start < Math.min(candidates.length, MAX_DETAIL_CALLS); start += BATCH_SIZE) {
    const batch = candidates.slice(start, start + BATCH_SIZE);
    // Bir filmin detayı alınamazsa (null) sadece o film atlanır
    const detailedMovies = await Promise.all(
      batch.map((movie) => tmdb.getMovieDetails(movie.id).catch(() => null))
    );
    suitableMovies.push(...detailedMovies.filter((movie) => movie && matchesRuntime(movie, criteria)));

    if (suitableMovies.length >= RESULT_COUNT) break;
  }

  const selectedMovies = suitableMovies.slice(0, RESULT_COUNT);

  // 5) "Neden bu film?" açıklamaları: Gemini yazar, olmazsa şablon cümle kullanılır
  let aiReasons = {};
  if (aiUsed && selectedMovies.length > 0) {
    try {
      aiReasons = await gemini.generateReasons(userQuery, criteria.summary, selectedMovies);
    } catch (error) {
      console.warn("⚠️  Gemini açıklamaları alınamadı, şablon açıklamalar kullanıldı:", error.message);
      aiUsed = false;
    }
  }

  const movies = selectedMovies.map((movie) => ({
    ...movie,
    reason: aiReasons[movie.id] || buildTemplateReason(movie, criteria, referenceMovie),
  }));

  return {
    summary: criteria.summary,
    aiUsed,
    criteria: describeCriteria(criteria, referenceMovie),
    movies,
  };
}

// ------------------------------------------------------------
// Aday bulma yöntemleri
// ------------------------------------------------------------

// Gemini'nin önerdiği film adlarını TMDb'de arar.
// Sadece TMDb'de gerçekten bulunan filmler kalır; böylece AI var olmayan
// bir film uydursa bile kullanıcıya asla gösterilmez.
async function findSuggestedMovies(criteria) {
  const searches = criteria.suggestedTitles.map(async (suggestion) => {
    // Tek bir arama başarısız olursa tüm öneriyi bozmasın; o filmi atla
    const results = await tmdb.searchMovies(suggestion.title).catch(() => []);
    // Aynı isimli farklı filmleri ayırt etmek için yılı da kontrol et (±1 yıl tolerans)
    return results.find((movie) => movie.vote_count >= 50 && isAboutSameYear(movie, suggestion.year));
  });

  const foundMovies = (await Promise.all(searches)).filter(Boolean);

  // AI'ın önerisini TMDb verisiyle de kontrol et: istenen türe, yıla uymuyorsa ele
  return mergeWithoutDuplicates([], foundMovies).filter(
    (movie) =>
      sharesRequestedGenre(movie, criteria) &&
      !hasExcludedGenre(movie, criteria) &&
      matchesYear(movie, criteria)
  );
}

// Olası film adlarını sırayla dener, yeterince bilinen ilk eşleşmeyi döner
async function findReferenceMovie(titleCandidates) {
  for (const title of titleCandidates) {
    const results = await tmdb.searchMovies(title);
    const match = results.find((movie) => movie.vote_count >= 50);
    if (match) return match;
  }
  return null;
}

// Referans filme göre TMDb önerilerini alır ve kullanıcının kriterlerine göre sıralar
async function getCandidatesFromReference(referenceMovie, criteria) {
  const recommendations = await tmdb.getRecommendations(referenceMovie.id);

  const filtered = recommendations.filter(
    (movie) => movie.vote_count >= 100 && !hasExcludedGenre(movie, criteria) && matchesYear(movie, criteria)
  );

  // Kullanıcının istediği türlerle en çok eşleşen filmler öne gelsin.
  // Örn: "Interstellar gibi ama daha gizemli" → Gizem türündekiler başa geçer.
  // Eşitlik varsa puanı yüksek olan öne geçer.
  const countMatches = (movie) => movie.genre_ids.filter((id) => criteria.genres.includes(id)).length;
  return filtered.sort(
    (a, b) => countMatches(b) - countMatches(a) || b.vote_average - a.vote_average
  );
}

// TMDb "discover" ile tür/süre/yıl filtrelerine uyan, bilinen ve beğenilen filmler.
// "vote_count.desc" sıralaması çok oy almış (yani çok izlenmiş) filmleri öne getirir;
// "popularity.desc" ise henüz az oy almış yeni filmleri öne çıkarıyordu.
async function getCandidatesFromDiscover(criteria) {
  const filters = {
    with_genres: criteria.genres.join(","), // virgül = hepsini içersin (VE)
    without_genres: criteria.excludeGenres.join(","),
    "with_runtime.gte": criteria.minRuntime,
    "with_runtime.lte": criteria.maxRuntime,
    "primary_release_date.gte": criteria.minYear ? `${criteria.minYear}-01-01` : null,
    "primary_release_date.lte": criteria.maxYear ? `${criteria.maxYear}-12-31` : null,
    "vote_average.gte": 6.5,
    "vote_count.gte": 300,
    sort_by: "vote_count.desc",
  };

  let results = await tmdb.discoverMovies(filters);

  // Birden fazla tür istendiyse ve az sonuç çıktıysa, "herhangi biri" (VEYA) ile tekrar dene
  if (results.length < RESULT_COUNT && criteria.genres.length > 1) {
    const moreResults = await tmdb.discoverMovies({ ...filters, with_genres: criteria.genres.join("|") });
    results = mergeWithoutDuplicates(results, moreResults);
  }

  return results;
}

// ------------------------------------------------------------
// Yedek "Neden bu film?" açıklaması (Gemini kullanılamazsa)
// ------------------------------------------------------------
function buildTemplateReason(movie, criteria, referenceMovie) {
  const parts = [];

  if (referenceMovie) {
    parts.push(`${referenceMovie.title} filmine benzer bir yapım.`);
  }

  const matchedGenres = movie.genreIds.filter((id) => criteria.genres.includes(id)).map(getGenreName);
  if (matchedGenres.length > 0) {
    parts.push(`İstediğin ${matchedGenres.join(" ve ")} türüne uyuyor.`);
  }

  if (criteria.excludeGenres.length > 0) {
    parts.push(`${criteria.excludeGenres.map(getGenreName).join(", ")} türünde değil.`);
  }

  if ((criteria.maxRuntime || criteria.minRuntime) && movie.runtime) {
    parts.push(`${movie.runtime} dakika ile süre tercihine uygun.`);
  }

  if (parts.length === 0) {
    parts.push(`TMDb'de ${movie.voteCount} oyla ${movie.rating}/10 puan almış, izleyicilerin beğendiği bir film.`);
  }

  return parts.join(" ");
}

// ------------------------------------------------------------
// Yardımcı fonksiyonlar
// ------------------------------------------------------------
function hasAnyCriteria(criteria) {
  return (
    criteria.genres.length > 0 ||
    criteria.excludeGenres.length > 0 ||
    criteria.suggestedTitles.length > 0 ||
    criteria.minRuntime || criteria.maxRuntime ||
    criteria.minYear || criteria.maxYear
  );
}

function hasExcludedGenre(movie, criteria) {
  return movie.genre_ids.some((id) => criteria.excludeGenres.includes(id));
}

// Tür istendiyse, film TMDb'ye göre bu türlerden en az birine sahip olmalı
function sharesRequestedGenre(movie, criteria) {
  if (criteria.genres.length === 0) return true;
  return movie.genre_ids.some((id) => criteria.genres.includes(id));
}

function getReleaseYear(movie) {
  return Number((movie.release_date || "").slice(0, 4));
}

function isAboutSameYear(movie, year) {
  if (!year) return true;
  return Math.abs(getReleaseYear(movie) - year) <= 1;
}

function matchesRuntime(movie, criteria) {
  if (!criteria.minRuntime && !criteria.maxRuntime) return true;
  if (!movie.runtime) return false; // Süresi bilinmiyorsa filtreyi geçemez
  if (criteria.minRuntime && movie.runtime < criteria.minRuntime) return false;
  if (criteria.maxRuntime && movie.runtime > criteria.maxRuntime) return false;
  return true;
}

function matchesYear(movie, criteria) {
  const year = getReleaseYear(movie);
  if (criteria.minYear && year < criteria.minYear) return false;
  if (criteria.maxYear && year > criteria.maxYear) return false;
  return true;
}

function mergeWithoutDuplicates(firstList, secondList) {
  const ids = new Set(firstList.map((movie) => movie.id));
  const merged = [...firstList];
  for (const movie of secondList) {
    if (!ids.has(movie.id)) {
      ids.add(movie.id);
      merged.push(movie);
    }
  }
  return merged;
}

module.exports = { recommendMovies };
