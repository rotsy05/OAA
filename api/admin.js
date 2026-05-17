/**
 * api/admin.js — fonction serverless Vercel
 * -----------------------------------------
 * Reçoit les actions admin (verify / list / create / delete) et commit
 * les changements dans le repo GitHub via l'API. Le mot de passe et le
 * PAT GitHub sont des variables d'environnement Vercel — jamais exposés
 * au navigateur.
 *
 * Variables d'environnement requises (à définir dans Vercel) :
 *   - ADMIN_PASSWORD  : le code secret
 *   - GITHUB_TOKEN    : Personal Access Token GitHub avec scope `repo`
 *   - GITHUB_OWNER    : ton username GitHub
 *   - GITHUB_REPO     : nom du repo
 *   - GITHUB_BRANCH   : branche (optionnel, par défaut "main")
 */

const GITHUB_API = 'https://api.github.com';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const { action, password } = body;
  if (!password || password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Code secret incorrect.' });
  }
  if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_OWNER || !process.env.GITHUB_REPO) {
    return res.status(500).json({ error: 'Configuration GitHub incomplète côté serveur.' });
  }

  try {
    switch (action) {
      case 'verify':
        return res.json({ ok: true });
      case 'list':
        return res.json(await listArticles());
      case 'create':
        return res.json(await createArticle(body.article || {}));
      case 'delete':
        return res.json(await deleteArticle(body.slug));
      default:
        return res.status(400).json({ error: 'Action inconnue.' });
    }
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || 'Erreur serveur.' });
  }
};

/* ─── GitHub API helpers ────────────────────────────────────────────────── */

const branch = () => process.env.GITHUB_BRANCH || 'main';

async function ghRequest(path, init = {}) {
  const url = `${GITHUB_API}/repos/${process.env.GITHUB_OWNER}/${process.env.GITHUB_REPO}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function getFile(path) {
  try {
    const data = await ghRequest(`/contents/${path}?ref=${branch()}`);
    return {
      sha: data.sha,
      content: Buffer.from(data.content, 'base64').toString('utf-8'),
    };
  } catch (err) {
    if (err.message.includes('404')) return null;
    throw err;
  }
}

async function putFile(path, content, sha, message) {
  const body = {
    message,
    content: Buffer.from(content, 'utf-8').toString('base64'),
    branch: branch(),
  };
  if (sha) body.sha = sha;
  return ghRequest(`/contents/${path}`, { method: 'PUT', body: JSON.stringify(body) });
}

async function deleteFile(path, sha, message) {
  return ghRequest(`/contents/${path}`, {
    method: 'DELETE',
    body: JSON.stringify({ message, sha, branch: branch() }),
  });
}

/* ─── Opérations ────────────────────────────────────────────────────────── */

async function listArticles() {
  const m = await getFile('articles/manifest.json');
  if (!m) return { articles: [] };
  return JSON.parse(m.content);
}

async function createArticle(article) {
  const { title, category, date, author = '', sections = [] } = article;
  if (!title || !category || !date) {
    throw new Error('Titre, catégorie et date sont obligatoires.');
  }
  const validCats = ['Littérature', 'Cinéma & Documentaires', 'Arts visuels', 'Musique'];
  if (!validCats.includes(category)) throw new Error('Catégorie invalide.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Date au format YYYY-MM-DD attendue.');

  const slug = `${date}-${slugify(title)}.html`;

  // 1. créer le fichier de l'article
  const html = renderArticleHTML({ title, category, date, author, sections });
  await putFile(`articles/${slug}`, html, null, `ajoute l'article « ${title} »`);

  // 2. mettre à jour le manifest
  const m = await getFile('articles/manifest.json');
  const manifest = m ? JSON.parse(m.content) : { articles: [] };
  manifest.articles = manifest.articles.filter(a => a.slug !== slug);
  manifest.articles.unshift({ slug, title, category, date, author });
  manifest.articles.sort((a, b) => b.date.localeCompare(a.date));
  await putFile('articles/manifest.json', JSON.stringify(manifest, null, 2),
                m ? m.sha : null, `manifest: + « ${title} »`);

  // 3. régénérer les galeries
  await updateGalleries(manifest);

  return { ok: true, slug };
}

async function deleteArticle(slug) {
  if (!slug) throw new Error('Slug manquant.');

  const m = await getFile('articles/manifest.json');
  if (!m) throw new Error('Manifest introuvable.');
  const manifest = JSON.parse(m.content);
  const article = manifest.articles.find(a => a.slug === slug);

  // 1. supprimer le fichier d'article
  const file = await getFile(`articles/${slug}`);
  if (file) {
    await deleteFile(`articles/${slug}`, file.sha,
                     `supprime « ${article ? article.title : slug} »`);
  }

  // 2. mettre à jour le manifest
  manifest.articles = manifest.articles.filter(a => a.slug !== slug);
  await putFile('articles/manifest.json', JSON.stringify(manifest, null, 2), m.sha,
                `manifest: − « ${article ? article.title : slug} »`);

  // 3. régénérer les galeries
  await updateGalleries(manifest);

  return { ok: true };
}

/* ─── Régénération des galeries ─────────────────────────────────────────── */

const CATEGORY_PAGES = {
  'Littérature': 'litterature.html',
  'Cinéma & Documentaires': 'cinema.html',
  'Arts visuels': 'arts-visuels.html',
  'Musique': 'musique.html',
};

async function updateGalleries(manifest) {
  // Page d'accueil : derniers articles, toutes catégories
  const indexFile = await getFile('index.html');
  if (indexFile) {
    const block = renderGridBlock(manifest.articles.slice(0, 8));
    const newHtml = replaceBetweenMarkers(indexFile.content, 'GALERIE', block);
    if (newHtml !== indexFile.content) {
      await putFile('index.html', newHtml, indexFile.sha, 'galerie accueil');
    }
  }

  // Chaque page catégorie
  for (const [cat, page] of Object.entries(CATEGORY_PAGES)) {
    const articlesInCat = manifest.articles.filter(a => a.category === cat);
    const pageFile = await getFile(page);
    if (!pageFile) continue;
    const block = articlesInCat.length
      ? renderGridBlock(articlesInCat)
      : `      <p class="galerie__vide">\n        aucune ode pour le moment, revenez bientôt…\n      </p>`;
    const newHtml = replaceBetweenMarkers(pageFile.content, 'GALERIE', block);
    if (newHtml !== pageFile.content) {
      await putFile(page, newHtml, pageFile.sha, `galerie ${cat}`);
    }
  }
}

function renderGridBlock(articles) {
  if (!articles.length) {
    return `      <p class="galerie__vide">\n        aucune ode pour le moment, revenez bientôt…\n      </p>`;
  }
  const envelopes = articles.map(a => {
    return `        <article class="enveloppe">
          <a href="articles/${escapeHtml(a.slug)}" class="enveloppe__lien">
            <h2 class="enveloppe__titre">${escapeHtml(a.title)}</h2>
            <p class="enveloppe__meta">
              ${escapeHtml(a.category)} · <time datetime="${escapeHtml(a.date)}">${escapeHtml(formatDateFr(a.date))}</time>
            </p>
          </a>
        </article>`;
  }).join('\n\n');
  return `      <div class="galerie__grille">\n\n${envelopes}\n\n      </div>`;
}

function replaceBetweenMarkers(content, name, replacement) {
  const startMarker = `<!-- ${name}:start -->`;
  const endMarker = `<!-- ${name}:end -->`;
  const re = new RegExp(`(${escapeRegex(startMarker)})[\\s\\S]*?(${escapeRegex(endMarker)})`);
  if (!re.test(content)) return content;
  return content.replace(re, `$1\n${replacement}\n      $2`);
}

/* ─── Génération du HTML d'un article ───────────────────────────────────── */

function renderArticleHTML({ title, category, date, author, sections }) {
  const dateFr = formatDateFr(date);
  const sectionsHtml = sections
    .filter(s => (s.title && s.title.trim()) || (s.content && s.content.trim()))
    .map(s => {
      const paras = (s.content || '')
        .split(/\n\n+/)
        .map(p => p.trim())
        .filter(Boolean)
        .map(p => `        <p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
        .join('\n');
      return `      <section>\n        <h2>${escapeHtml(s.title || '')}</h2>\n${paras}\n      </section>`;
    })
    .join('\n\n');

  const authorBit = author ? ` · <span class="auteur-oeuvre">de ${escapeHtml(author)}</span>` : '';

  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="description" content="${escapeHtml(`Une ode à ${title}.`)}">
  <title>${escapeHtml(title)} — Ode à l'art et à l'amour</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Cedarville+Cursive&family=Meddon&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="../assets/css/style.css">
  <link rel="stylesheet" href="../assets/css/article.css">
  <link rel="stylesheet" href="../assets/css/admin.css">
  <script defer src="../assets/js/main.js"></script>
  <script defer src="../assets/js/admin.js"></script>
</head>
<body>

  <header class="site-header">
    <h1 class="site-title">Ode à l'art et à l'amour</h1>
    <p class="site-tagline">un recueil d'œuvres aimées</p>
  </header>

  <nav class="site-nav" aria-label="navigation principale">
    <ul>
      <li><a href="../index.html">accueil</a></li>
      <li><a href="../litterature.html">littérature</a></li>
      <li><a href="../cinema.html">cinéma & documentaires</a></li>
      <li><a href="../arts-visuels.html">arts visuels</a></li>
      <li><a href="../musique.html">musique</a></li>
      <li><a href="../constellations.html">constellations</a></li>
      <li><a href="../a-propos.html">à propos</a></li>
    </ul>
  </nav>

  <main class="article">
    <article>
      <div class="lettre">
      <header>
        <span class="categorie">${escapeHtml(category)}</span>
        <h1>${escapeHtml(title)}</h1>
        <p class="meta">
          <time datetime="${escapeHtml(date)}">${escapeHtml(dateFr)}</time>${authorBit}
        </p>
      </header>

${sectionsHtml}
      </div><!-- /.lettre -->
    </article>
  </main>

  <footer class="site-footer">
    <p>écrit avec tendresse · <time datetime="2026">2026</time><a href="#admin" class="admin-trigger" data-admin-trigger aria-label="administration"><img src="../assets/images/ornements/clef.png" alt="" aria-hidden="true"></a></p>
  </footer>

</body>
</html>
`;
}

/* ─── Utilitaires ───────────────────────────────────────────────────────── */

function slugify(s) {
  return String(s)
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // retire les accents
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

function formatDateFr(iso) {
  const months = ['janvier','février','mars','avril','mai','juin',
                  'juillet','août','septembre','octobre','novembre','décembre'];
  const [y, m, d] = iso.split('-');
  return `${parseInt(d, 10)} ${months[parseInt(m, 10) - 1]} ${y}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
