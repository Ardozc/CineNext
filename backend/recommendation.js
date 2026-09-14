// ============================================================
// recommendation.js — Öneri akışını yöneten dosya
// ============================================================
// Adımlar:
//   1. Kullanıcının cümlesini kriterlere çevir
//        → Gemini (gemini.js). Çalışmazsa yedek: queryAnalyzer.js
//        → mediaType: "movie" (sadece film), "tv" (sadece dizi), "all" (karışık)
//   2. Kriterlere uyan GERÇEK film/dizileri TMDb'de bul (tmdb.js)
//        → Gemini'nin önerdiği adlar TMDb'de doğrulanır
//        → "X gibi" dendiyse X'in TMDb önerileri eklenir
//        → Hâlâ az sonuç varsa TMDb Discover ile tamamlanır
//   3. Her yapım için detayları al (poster, süre, puan...)
//   4. Gemini'ye bu gerçek bilgilerle "Neden bu film/dizi?" açıklaması yazdır
//
// Ad, yıl, puan, poster gibi bilgilerin HEPSİ TMDb'den gelir.
//
// Not: TMDb'de bir filmle bir dizinin ID'si aynı olabilir. Bu yüzden
// yapımları "movie-603" / "tv-1396" gibi bir anahtarla (getKey) ayırt ediyoruz.
// ============================================================

const tmdb = require("./tmdb");
const gemini = require("./gemini");
const { analyzeRequest, describeCriteria, getGenreName, toMediaGenreIds } = require("./queryAnalyzer");

const RESULT_COUNT = 6;      // Kullanıcıya gösterilecek yapım sayısı
const BATCH_SIZE = 10;       // Aynı anda detayı alınacak yapım sayısı
const MAX_DETAIL_CALLS = 30; // TMDb'ye aşırı istek atmamak için üst sınır

// Keşifte (discover) önerilmeyecek dizi türleri: Haber, Reality, Pembe Dizi, Talk Show
const UNWANTED_TV_GENRES = [10763, 10764, 10766, 10767];

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

  // 2) "X gibi" dendiyse referans yapımı bul.
  //    Hiçbir kriter bulunamadıysa, kullanıcı belki sadece bir film/dizi adı yazmıştır.
  let referenceMovie = null;
  if (criteria.similarTo.length > 0) {
    referenceMovie = await findReferenceMovie(criteria.similarTo, criteria);
  } else if (!hasAnyCriteria(criteria)) {
    referenceMovie = await findReferenceMovie([userQuery], criteria);
  }

  // 3) Aday yapımları topla (önem sırasına göre)
  let candidates = await findSuggestedMovies(criteria);

  if (referenceMovie) {
    const fromReference = await getCandidatesFromReference(referenceMovie, criteria);
    candidates = mergeWithoutDuplicates(candidates, fromReference);
  }
  // Discover sonuçlarını her zaman yedek olarak sona ekliyoruz: süre filtresinden
  // sonra sonuç sayısı 6'nın altına düşerse eksikler buradan tamamlanır.
  const discovered = await getCandidatesFromDiscover(criteria);
  candidates = mergeWithoutDuplicates(candidates, discovered);

  // Referans yapımın kendisini önermeyelim; kullanıcı sadece film/dizi istediyse diğerini ele
  candidates = candidates.filter(
    (movie) =>
      (!referenceMovie || getKey(movie) !== getKey(referenceMovie)) &&
      matchesMediaType(movie.media_type, criteria)
  );

  // 4) Detayları 10'arlı gruplar halinde al ve süre filtresini uygula.
  //    Süre sadece detaylarda olduğu için, 6 uygun yapım bulana kadar devam ediyoruz.
  //    (Promise.all bir gruptaki istekleri aynı anda gönderir)
  const suitableMovies = [];
  for (let start = 0; start < Math.min(candidates.length, MAX_DETAIL_CALLS); start += BATCH_SIZE) {
    const batch = candidates.slice(start, start + BATCH_SIZE);
    // Bir yapımın detayı alınamazsa (null) sadece o atlanır
    const detailedMovies = await Promise.all(
      batch.map((movie) => tmdb.getDetails(movie.media_type, movie.id).catch(() => null))
    );
    suitableMovies.push(...detailedMovies.filter((movie) => movie && matchesRuntime(movie, criteria)));

    if (suitableMovies.length >= RESULT_COUNT) break;
  }

  const selectedMovies = suitableMovies.slice(0, RESULT_COUNT);

  // 5) "Neden bu film/dizi?" açıklamaları: Gemini yazar, olmazsa şablon cümle kullanılır
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
    reason: aiReasons[movie.key] || buildTemplateReason(movie, criteria, referenceMovie),
  }));

  return {
    summary: criteria.summary,
    aiUsed,
    mediaType: criteria.mediaType,
    criteria: describeCriteria(criteria, referenceMovie),
    movies,
  };
}

// ------------------------------------------------------------
// Aday bulma yöntemleri
// ------------------------------------------------------------

// Gemini'nin önerdiği adları TMDb'de arar.
// Sadece TMDb'de gerçekten bulunanlar kalır; böylece AI var olmayan
// bir yapım uydursa bile kullanıcıya asla gösterilmez.
async function findSuggestedMovies(criteria) {
  const searches = criteria.suggestedTitles.map(async (suggestion) => {
    // Tür belliyse sadece o türde ara; değilse film ve diziyi birlikte ara.
    // Tek bir arama başarısız olursa tüm öneriyi bozmasın; o yapımı atla.
    const results = await (suggestion.type
      ? tmdb.search(suggestion.type, suggestion.title)
      : tmdb.searchMulti(suggestion.title)
    ).catch(() => []);
    // Aynı isimli farklı yapımları ayırt etmek için yılı da kontrol et (±1 yıl tolerans)
    return results.find(
      (movie) =>
        movie.vote_count >= 50 &&
        matchesMediaType(movie.media_type, criteria) &&
        isAboutSameYear(movie, suggestion.year)
    );
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

// Olası adları sırayla dener, yeterince bilinen ilk eşleşmeyi döner.
// Film ve dizi birlikte aranır; kullanıcı sadece birini istediyse o tür öncelikli.
// ("Breaking Bad gibi bir film" → referans yine dizi olabilir, bu normal)
async function findReferenceMovie(titleCandidates, criteria) {
  for (const title of titleCandidates) {
    const results = (await tmdb.searchMulti(title)).filter((movie) => movie.vote_count >= 50);
    const match = results.find((movie) => matchesMediaType(movie.media_type, criteria)) || results[0];
    if (match) return match;
  }
  return null;
}

// Referans yapıma göre TMDb önerilerini alır ve kullanıcının kriterlerine göre sıralar.
// TMDb film için film, dizi için dizi önerir. Kullanıcı diğer türü istiyorsa
// bu adımı atlıyoruz; Gemini önerileri ve Discover o durumu karşılar.
async function getCandidatesFromReference(referenceMovie, criteria) {
  if (!matchesMediaType(referenceMovie.media_type, criteria)) return [];

  const recommendations = await tmdb.getRecommendations(referenceMovie.media_type, referenceMovie.id);

  const filtered = recommendations.filter(
    (movie) => movie.vote_count >= 100 && !hasExcludedGenre(movie, criteria) && matchesYear(movie, criteria)
  );

  // Kullanıcının istediği türlerle en çok eşleşenler öne gelsin.
  // Örn: "Interstellar gibi ama daha gizemli" → Gizem türündekiler başa geçer.
  // Eşitlik varsa puanı yüksek olan öne geçer.
  const countMatches = (movie) => {
    const requested = toMediaGenreIds(criteria.genres, movie.media_type);
    return movie.genre_ids.filter((id) => requested.includes(id)).length;
  };
  return filtered.sort(
    (a, b) => countMatches(b) - countMatches(a) || b.vote_average - a.vote_average
  );
}

// TMDb "discover" ile tür/süre/yıl filtrelerine uyan, bilinen ve beğenilen yapımlar.
// mediaType "all" ise film ve dizi aramaları paralel yapılır ve sırayla karıştırılır
// (film, dizi, film, dizi...) ki ikisi de listede adil yer bulsun.
async function getCandidatesFromDiscover(criteria) {
  const mediaTypes = criteria.mediaType === "all" ? ["movie", "tv"] : [criteria.mediaType];
  const resultLists = await Promise.all(
    mediaTypes.map((mediaType) => discoverByMediaType(mediaType, criteria))
  );
  return interleave(resultLists);
}

// "vote_count.desc" sıralaması çok oy almış (yani çok izlenmiş) yapımları öne getirir;
// "popularity.desc" ise henüz az oy almış yeni yapımları öne çıkarıyordu.
async function discoverByMediaType(mediaType, criteria) {
  const isTv = mediaType === "tv";
  const dateField = isTv ? "first_air_date" : "primary_release_date";
  const genres = toMediaGenreIds(criteria.genres, mediaType);

  // Dizide bir tür birden çok türe karşılık gelebilir (Gerilim → Gizem, Suç).
  // "Hepsini içersin" (VE) aramasında her türün sadece ilk karşılığını kullanıyoruz.
  const primaryGenres = [...new Set(criteria.genres.map((id) => toMediaGenreIds([id], mediaType)[0]).filter(Boolean))];
  const excludeGenres = toMediaGenreIds(criteria.excludeGenres, mediaType, { approximate: false });

  const filters = {
    with_genres: primaryGenres.join(","), // virgül = hepsini içersin (VE)
    without_genres: [...excludeGenres, ...(isTv ? UNWANTED_TV_GENRES : [])].join(","),
    "with_runtime.gte": criteria.minRuntime,
    "with_runtime.lte": criteria.maxRuntime,
    [`${dateField}.gte`]: criteria.minYear ? `${criteria.minYear}-01-01` : null,
    [`${dateField}.lte`]: criteria.maxYear ? `${criteria.maxYear}-12-31` : null,
    "vote_average.gte": 6.5,
    // Diziler filmlere göre daha az oy alıyor, eşiği biraz düşük tutuyoruz
    "vote_count.gte": isTv ? 150 : 300,
    sort_by: "vote_count.desc",
  };

  let results = await tmdb.discover(mediaType, filters);

  // Birden fazla tür istendiyse ve az sonuç çıktıysa, "herhangi biri" (VEYA) ile tekrar dene
  if (results.length < RESULT_COUNT && genres.length > 1) {
    const moreResults = await tmdb.discover(mediaType, { ...filters, with_genres: genres.join("|") });
    results = mergeWithoutDuplicates(results, moreResults);
  }

  return results;
}

// ------------------------------------------------------------
// Yedek "Neden bu film/dizi?" açıklaması (Gemini kullanılamazsa)
// ------------------------------------------------------------
function buildTemplateReason(movie, criteria, referenceMovie) {
  const parts = [];
  const isTv = movie.mediaType === "tv";

  if (referenceMovie) {
    parts.push(`${referenceMovie.title} yapımına benzer bir ${isTv ? "dizi" : "film"}.`);
  }

  // Tür adlarını yapımın kendi (Türkçe) tür listesinden alıyoruz; dizi türleri filmlerden farklı
  const requested = toMediaGenreIds(criteria.genres, movie.mediaType);
  const matchedGenres = movie.genres.filter((name, index) => requested.includes(movie.genreIds[index]));
  if (matchedGenres.length > 0) {
    parts.push(`İstediğin ${matchedGenres.join(" ve ")} türüne uyuyor.`);
  }

  if (criteria.excludeGenres.length > 0) {
    parts.push(`${criteria.excludeGenres.map(getGenreName).join(", ")} türünde değil.`);
  }

  if ((criteria.maxRuntime || criteria.minRuntime) && movie.runtime) {
    parts.push(
      isTv
        ? `Bölüm başına ${movie.runtime} dakika ile süre tercihine uygun.`
        : `${movie.runtime} dakika ile süre tercihine uygun.`
    );
  }

  if (parts.length === 0) {
    parts.push(
      `TMDb'de ${movie.voteCount} oyla ${movie.rating}/10 puan almış, izleyicilerin beğendiği bir ${isTv ? "dizi" : "film"}.`
    );
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

function getKey(movie) {
  return `${movie.media_type}-${movie.id}`;
}

function matchesMediaType(mediaType, criteria) {
  return criteria.mediaType === "all" || criteria.mediaType === mediaType;
}

// Sadece birebir karşılığı olan türler hariç tutulur (bkz. queryAnalyzer.js TV_GENRES)
function hasExcludedGenre(movie, criteria) {
  const excluded = toMediaGenreIds(criteria.excludeGenres, movie.media_type, { approximate: false });
  return movie.genre_ids.some((id) => excluded.includes(id));
}

// Tür istendiyse, yapım TMDb'ye göre bu türlerden (dizide yakın karşılıklarından) en az birine sahip olmalı
function sharesRequestedGenre(movie, criteria) {
  if (criteria.genres.length === 0) return true;
  const requested = toMediaGenreIds(criteria.genres, movie.media_type);
  return movie.genre_ids.some((id) => requested.includes(id));
}

function getReleaseYear(movie) {
  return Number((movie.release_date || "").slice(0, 4));
}

function isAboutSameYear(movie, year) {
  if (!year) return true;
  return Math.abs(getReleaseYear(movie) - year) <= 1;
}

// Dizilerde runtime bölüm başına süredir
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
  const keys = new Set(firstList.map(getKey));
  const merged = [...firstList];
  for (const movie of secondList) {
    if (!keys.has(getKey(movie))) {
      keys.add(getKey(movie));
      merged.push(movie);
    }
  }
  return merged;
}

// [[a1, a2], [b1, b2, b3]] → [a1, b1, a2, b2, b3]
function interleave(lists) {
  const result = [];
  const longest = Math.max(0, ...lists.map((list) => list.length));
  for (let i = 0; i < longest; i++) {
    for (const list of lists) {
      if (i < list.length) result.push(list[i]);
    }
  }
  return result;
}

module.exports = { recommendMovies };
