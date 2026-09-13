// ============================================================
// AI Movie Assistant — Frontend JavaScript
// ============================================================
// Akış:
//   1. Kullanıcı isteğini yazar ve "Film Öner"e basar.
//   2. Bu dosya isteği KENDİ backend'imize gönderir: POST /api/recommend
//   3. Backend TMDb'den gerçek filmleri bulup JSON olarak döner.
//   4. Gelen filmleri kart olarak ekrana çizeriz.
//
// ÖNEMLİ: Bu dosyaya ASLA API key yazılmaz. Tarayıcıdaki
// her kodu kullanıcılar görebilir. Key'ler sadece backend/.env içinde.
// ============================================================

// ---------- 1) HTML elemanlarını seç ----------
const form = document.getElementById("search-form");
const input = document.getElementById("search-input");
const button = document.getElementById("search-button");
const resultsSection = document.getElementById("results");
const exampleChips = document.querySelectorAll(".chip");

// ---------- 2) Örnek isteklere tıklanınca input'a yaz ----------
exampleChips.forEach((chip) => {
  chip.addEventListener("click", () => {
    input.value = chip.textContent;
    input.focus();
  });
});

// Enter ile gönder, Shift+Enter ile alt satıra geç
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    form.requestSubmit();
  }
});

// ---------- 3) Form gönderildiğinde ----------
form.addEventListener("submit", async (event) => {
  event.preventDefault(); // Sayfanın yenilenmesini engelle

  const query = input.value.trim();

  // Basit doğrulama: boş istek gönderilmesin
  if (query.length < 3) {
    showError("Lütfen nasıl bir film istediğini biraz daha detaylı yaz.");
    return;
  }

  showLoading();

  try {
    const data = await fetchRecommendations(query);
    showMovies(data, query);
  } catch (error) {
    showError(error.message);
  }
});

// ---------- 4) Backend ile iletişim ----------
async function fetchRecommendations(query) {
  let response;

  try {
    response = await fetch("/api/recommend", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });
  } catch (error) {
    // fetch sadece ağ hatasında (sunucu kapalı vb.) hata fırlatır
    throw new Error("Sunucuya ulaşılamadı. Backend'in çalıştığından emin ol (npm start).");
  }

  const data = await response.json().catch(() => ({}));

  // 400, 500 gibi durum kodlarında backend'in gönderdiği mesajı göster
  if (!response.ok) {
    throw new Error(data.error || "Öneriler alınırken bir sorun oluştu. Lütfen tekrar dene.");
  }

  return data;
}

// ---------- 5) Ekran durumları ----------

function showLoading() {
  setButtonLoading(true);

  // 3 adet iskelet kart oluştur
  const skeletons = '<div class="skeleton"></div>'.repeat(3);

  resultsSection.innerHTML = `
    <div class="loading">
      <div class="spinner"></div>
      <p>Yapay zeka isteğini analiz ediyor ve filmleri arıyor...</p>
    </div>
    <div class="movie-grid">${skeletons}</div>
  `;
}

function showError(message) {
  setButtonLoading(false);

  resultsSection.innerHTML = `
    <div class="error" role="alert">
      <span class="error__icon">⚠️</span>
      <p><strong>Bir şeyler ters gitti.</strong> ${escapeHTML(message)}</p>
    </div>
  `;
}

function showMovies(data, query) {
  setButtonLoading(false);

  if (data.movies.length === 0) {
    showError("Bu isteğe uygun film bulunamadı. Farklı bir şekilde anlatmayı dene.");
    return;
  }

  // Backend'in algıladığı kriterleri etiket olarak göster
  const criteriaTags = data.criteria.length
    ? data.criteria.map((label) => `<span class="criteria__tag">${escapeHTML(label)}</span>`).join("")
    : '<span class="criteria__tag">Popüler ve beğenilen filmler</span>';

  // AI'ın isteği nasıl anladığını göster; AI kullanılamadıysa kullanıcıyı bilgilendir
  let aiInfo = "";
  if (data.summary) {
    aiInfo += `<p class="ai-summary"><strong>✨ AI analizi:</strong> ${escapeHTML(data.summary)}</p>`;
  }
  if (!data.aiUsed) {
    aiInfo += `
      <p class="ai-summary ai-summary--fallback">
        <strong>ℹ️ Not:</strong> Yapay zeka şu an kullanılamadığı için basit anahtar kelime analizi kullanıldı.
      </p>`;
  }

  const cards = data.movies.map(createMovieCard).join("");

  resultsSection.innerHTML = `
    <div class="results__header">
      <h2 class="results__title">"${escapeHTML(query)}" için öneriler</h2>
      <span class="results__note">Film verileri TMDb · Öneriler Gemini</span>
    </div>
    ${aiInfo}
    <div class="criteria">
      <span class="criteria__label">Algılanan kriterler:</span>
      ${criteriaTags}
    </div>
    <div class="movie-grid">${cards}</div>
  `;
}

// Tek bir film için kart HTML'i üretir
function createMovieCard(movie, index) {
  const genreTags = movie.genres
    .map((genre) => `<span class="genre-tag">${escapeHTML(genre)}</span>`)
    .join("");

  // Poster yoksa film emojisi göster
  const poster = movie.posterUrl
    ? `<img src="${escapeHTML(movie.posterUrl)}" alt="${escapeHTML(movie.title)} posteri" loading="lazy" />`
    : "🎞️";

  // "2016 · 116 dk" gibi bilgi satırı (eksik bilgiler atlanır)
  const meta = [movie.year, movie.runtime ? `${movie.runtime} dk` : null].filter(Boolean).join(" · ");

  const rating = movie.rating > 0 ? movie.rating.toFixed(1) : "—";

  return `
    <article class="movie-card" style="animation-delay: ${index * 80}ms">
      <div class="movie-card__poster">
        ${poster}
        <span class="movie-card__rating">★ ${rating}</span>
      </div>
      <div class="movie-card__body">
        <h3 class="movie-card__title">
          <a href="${escapeHTML(movie.tmdbUrl)}" target="_blank" rel="noopener">${escapeHTML(movie.title)}</a>
        </h3>
        <span class="movie-card__meta">${escapeHTML(meta)}</span>
        <div class="movie-card__genres">${genreTags}</div>
        <p class="movie-card__overview">${escapeHTML(movie.overview)}</p>
        <p class="movie-card__reason">
          <strong>Neden bu film?</strong>
          ${escapeHTML(movie.reason)}
        </p>
        <div class="movie-card__actions">
          <button type="button" class="btn btn--ghost" disabled title="Yakında">
            Benzer filmler
          </button>
        </div>
      </div>
    </article>
  `;
}

// ---------- 6) Yardımcı fonksiyonlar ----------

function setButtonLoading(isLoading) {
  button.disabled = isLoading;
  button.querySelector("span").textContent = isLoading ? "Aranıyor..." : "Film Öner";
}

// Kullanıcıdan veya API'den gelen metni HTML'e güvenle eklemek için.
// Böylece "<script>" gibi metinler kod olarak çalışmaz (XSS koruması).
function escapeHTML(text) {
  const div = document.createElement("div");
  div.textContent = String(text);
  return div.innerHTML.replace(/"/g, "&quot;");
}
