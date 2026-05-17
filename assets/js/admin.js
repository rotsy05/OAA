/**
 * admin.js — interface d'administration côté navigateur
 * -----------------------------------------------------
 * Clic sur l'icône clé → prompt code secret → ouvre la modale d'admin.
 * Toutes les actions (list / create / delete) passent par /api/admin,
 * qui vérifie le code et commit les changements dans le repo GitHub.
 *
 * Le code secret saisi reste en mémoire pendant la session (sessionStorage),
 * il est ré-utilisé pour chaque appel API et oublié à la fermeture de
 * l'onglet.
 */

(function () {
  'use strict';

  const API = '/api/admin';
  const PASS_KEY = 'oaa_admin_pass';
  const CATEGORIES = [
    'Littérature',
    'Cinéma & Documentaires',
    'Arts visuels',
    'Musique',
  ];

  let password = sessionStorage.getItem(PASS_KEY) || null;

  /* ─── Click handler global pour l'icône clé ───────────────────────── */
  document.addEventListener('click', (e) => {
    const trigger = e.target.closest('[data-admin-trigger]');
    if (!trigger) return;
    e.preventDefault();
    openAdmin();
  });

  async function openAdmin() {
    if (!password) {
      const entered = window.prompt('Quel est le code secret ?');
      if (!entered) return;
      try {
        await api('verify', { passwordOverride: entered });
        password = entered;
        sessionStorage.setItem(PASS_KEY, password);
      } catch (err) {
        window.alert(err.message);
        return;
      }
    }
    showPanel();
  }

  /* ─── Appel API ───────────────────────────────────────────────────── */
  async function api(action, { passwordOverride, ...extra } = {}) {
    const pwd = passwordOverride !== undefined ? passwordOverride : password;
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, password: pwd, ...extra }),
    });
    let data = {};
    try { data = await res.json(); } catch {}
    if (!res.ok) {
      if (res.status === 401) {
        sessionStorage.removeItem(PASS_KEY);
        password = null;
      }
      throw new Error(data.error || `Erreur HTTP ${res.status}`);
    }
    return data;
  }

  /* ─── Construction et rendu du panneau ────────────────────────────── */
  let overlay;

  function showPanel() {
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'admin-overlay';
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closePanel();
      });
      document.body.appendChild(overlay);
    }
    overlay.style.display = 'block';
    overlay.innerHTML = '<div class="admin-modal"><p>Chargement…</p></div>';
    refreshPanel();
  }

  function closePanel() {
    if (overlay) overlay.style.display = 'none';
  }

  async function refreshPanel() {
    let data;
    try {
      data = await api('list');
    } catch (err) {
      overlay.innerHTML = `<div class="admin-modal"><p>Erreur : ${esc(err.message)}</p>
        <button class="admin-btn" id="close-admin">Fermer</button></div>`;
      overlay.querySelector('#close-admin').onclick = closePanel;
      return;
    }
    renderPanel(data.articles || []);
  }

  function renderPanel(articles) {
    const modal = document.createElement('div');
    modal.className = 'admin-modal';

    modal.innerHTML = `
      <header class="admin-modal__header">
        <h2>Administration</h2>
        <button type="button" class="admin-btn" data-act="close">Fermer</button>
      </header>

      <h3>Articles existants (${articles.length})</h3>
      <ul class="admin-list">
        ${articles.length === 0
          ? `<li class="admin-empty">Aucun article pour le moment.</li>`
          : articles.map(a => `
              <li class="admin-list__item">
                <div>
                  <strong>${esc(a.title)}</strong>
                  <small>${esc(a.category)} · ${esc(a.date)}${a.author ? ' · ' + esc(a.author) : ''}</small>
                </div>
                <button type="button" class="admin-btn admin-btn--danger" data-act="delete" data-slug="${esc(a.slug)}">Supprimer</button>
              </li>`).join('')
        }
      </ul>

      <h3>Nouvel article</h3>
      <form class="admin-form" data-act="create">
        <label><span>Titre</span>
          <input type="text" name="title" required></label>

        <div class="admin-form__row">
          <label><span>Catégorie</span>
            <select name="category" required>
              <option value="">— choisir —</option>
              ${CATEGORIES.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('')}
            </select>
          </label>
          <label><span>Date d'entrée</span>
            <input type="date" name="date" value="${new Date().toISOString().slice(0, 10)}" required></label>
        </div>

        <label><span>Auteur de l'œuvre (optionnel)</span>
          <input type="text" name="author"></label>

        <fieldset class="admin-sections">
          <span class="admin-sections__legend">Sections de l'article</span>
          <div class="admin-sections__list"></div>
          <button type="button" class="admin-btn" data-act="add-section">+ Ajouter une section</button>
        </fieldset>

        <div class="admin-form__actions">
          <button type="submit" class="admin-btn admin-btn--primary">Publier l'article</button>
          <span class="admin-status"></span>
        </div>
      </form>
    `;

    overlay.innerHTML = '';
    overlay.appendChild(modal);

    // Sections : démarrer avec une section vide
    const sectionsList = modal.querySelector('.admin-sections__list');
    addSection(sectionsList);

    // Wire up handlers
    modal.addEventListener('click', async (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === 'close') closePanel();
      if (act === 'add-section') addSection(sectionsList);
      if (act === 'remove-section') btn.closest('.admin-section-row').remove();
      if (act === 'delete') {
        const slug = btn.dataset.slug;
        const title = btn.closest('.admin-list__item').querySelector('strong').textContent;
        if (!window.confirm(`Supprimer « ${title} » ?`)) return;
        btn.disabled = true;
        btn.textContent = 'Suppression…';
        try {
          await api('delete', { slug });
          await refreshPanel();
        } catch (err) {
          btn.disabled = false;
          btn.textContent = 'Supprimer';
          window.alert(err.message);
        }
      }
    });

    modal.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      const status = form.querySelector('.admin-status');
      const submitBtn = form.querySelector('button[type=submit]');

      const article = {
        title: form.title.value.trim(),
        category: form.category.value,
        date: form.date.value,
        author: form.author.value.trim(),
        sections: Array.from(sectionsList.querySelectorAll('.admin-section-row')).map(row => ({
          title: row.querySelector('[name=section_title]').value.trim(),
          content: row.querySelector('[name=section_content]').value.trim(),
        })).filter(s => s.title || s.content),
      };

      if (article.sections.length === 0) {
        status.textContent = 'Ajoute au moins une section.';
        status.className = 'admin-status admin-status--err';
        return;
      }

      submitBtn.disabled = true;
      status.textContent = 'Publication en cours…';
      status.className = 'admin-status';

      try {
        await api('create', { article });
        status.textContent = 'Publié ! Le site va se redéployer (~20–60 s).';
        status.className = 'admin-status admin-status--ok';
        form.reset();
        sectionsList.innerHTML = '';
        addSection(sectionsList);
        await refreshPanel();
      } catch (err) {
        status.textContent = 'Erreur : ' + err.message;
        status.className = 'admin-status admin-status--err';
      } finally {
        submitBtn.disabled = false;
      }
    });
  }

  function addSection(container) {
    const row = document.createElement('div');
    row.className = 'admin-section-row';
    row.innerHTML = `
      <div class="admin-section-row__head">
        <input type="text" name="section_title" placeholder="Titre de la section (ex. la rencontre)">
        <button type="button" class="admin-btn admin-btn--danger" data-act="remove-section" aria-label="retirer">×</button>
      </div>
      <textarea name="section_content" placeholder="Contenu de la section. Sépare les paragraphes par une ligne vide." rows="6"></textarea>
    `;
    container.appendChild(row);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }
})();
