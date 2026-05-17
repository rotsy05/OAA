/**
 * Ode à l'art et à l'amour — mini-router progressif
 * ---------------------------------------------------
 * Intercepte les clics sur les liens internes et remplace UNIQUEMENT le
 * <main> de la page. Le hero (header + nav + frise verte) reste intact
 * d'une page à l'autre — pas de re-render, pas de clignotement.
 *
 * Sans JavaScript, le site fonctionne normalement : chaque page est un
 * fichier HTML complet, chaque URL est accessible en direct, la
 * navigation devient simplement un rechargement classique. C'est un
 * "progressive enhancement" — le JS améliore, il n'est pas indispensable.
 */

(function () {
  'use strict';

  /**
   * Convertit les href des liens de la nav en URL absolues, une fois pour
   * toutes au chargement initial. Sans ça, un href="musique.html" écrit
   * dans la nav d'index.html serait, après pushState vers /articles/foo.html,
   * résolu en /articles/musique.html — bug.
   */
  function freezeNavLinks() {
    document.querySelectorAll('.site-nav a').forEach(a => {
      // a.href renvoie l'URL absolue résolue contre l'URL courante du
      // document, qui à ce stade est encore l'URL d'origine du chargement.
      a.setAttribute('href', a.href);
    });
  }
  freezeNavLinks();

  function isSwappable(a, evt) {
    if (!a || !a.href) return false;
    if (evt.metaKey || evt.ctrlKey || evt.shiftKey || evt.altKey) return false;
    if (evt.defaultPrevented) return false;
    if (a.target === '_blank' || a.hasAttribute('download')) return false;
    const url = new URL(a.href, location.href);
    if (url.origin !== location.origin) return false;
    // Liens d'ancre dans la page courante : laissés au navigateur
    if (url.pathname === location.pathname && url.hash) return false;
    return true;
  }

  async function navigate(href, push) {
    let html;
    try {
      const res = await fetch(href, { headers: { Accept: 'text/html' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      html = await res.text();
    } catch (e) {
      // En cas d'échec, on retombe sur une navigation classique
      window.location.href = href;
      return;
    }

    const doc = new DOMParser().parseFromString(html, 'text/html');
    const newMain = doc.querySelector('main');
    const curMain = document.querySelector('main');
    if (!newMain || !curMain) {
      window.location.href = href;
      return;
    }

    // Pousser l'URL d'abord pour que les URL relatives s'évaluent
    // dans le bon contexte une fois le DOM mis à jour.
    if (push) history.pushState({}, '', href);

    const apply = () => {
      // 1. Remplacer <main>
      curMain.replaceWith(newMain);

      // 2. Mettre à jour <title> et meta description
      document.title = doc.title;
      const newDesc = doc.querySelector('meta[name="description"]');
      const curDesc = document.querySelector('meta[name="description"]');
      if (newDesc && curDesc) {
        curDesc.setAttribute('content', newDesc.getAttribute('content'));
      }

      // 3. Charger les feuilles de style supplémentaires (article.css par ex.)
      const present = new Set(
        Array.from(document.querySelectorAll('link[rel="stylesheet"]'))
          .map(l => l.href)
      );
      doc.querySelectorAll('link[rel="stylesheet"]').forEach(link => {
        const abs = new URL(link.getAttribute('href'), href).href;
        if (!present.has(abs)) {
          const clone = document.createElement('link');
          clone.rel = 'stylesheet';
          clone.href = abs;
          document.head.appendChild(clone);
        }
      });

      // 4. Mettre à jour aria-current sur la nav
      document.querySelectorAll('.site-nav a[aria-current="page"]')
        .forEach(a => a.removeAttribute('aria-current'));
      const newCurrent = doc.querySelector('.site-nav a[aria-current="page"]');
      if (newCurrent) {
        const wanted = new URL(newCurrent.getAttribute('href'), href).href;
        document.querySelectorAll('.site-nav a').forEach(a => {
          const abs = new URL(a.getAttribute('href'), location.href).href;
          if (abs === wanted) a.setAttribute('aria-current', 'page');
        });
      }

      // 5. Stratégie de scroll : on ne remonte JAMAIS dans le hero.
      //    - Si l'utilisateur est déjà passé sous la nav (en train de lire
      //      le contenu), on ne touche pas au scroll : la nouvelle page
      //      s'affiche sous ses yeux, sans saut.
      //    - S'il est encore dans le hero (au-dessus de la nav), on
      //      remonte juste assez pour coller la nav en haut du viewport.
      if (push) {
        const nav = document.querySelector('.site-nav');
        if (nav) {
          const navTop = nav.getBoundingClientRect().top + window.scrollY;
          if (window.scrollY < navTop) {
            window.scrollTo({ top: navTop });
          }
        }
      }
    };

    // View Transitions API quand disponible — fondu doux entre les deux mains
    if (document.startViewTransition) {
      document.startViewTransition(apply);
    } else {
      apply();
    }
  }

  document.addEventListener('click', (e) => {
    const a = e.target.closest('a');
    if (!isSwappable(a, e)) return;
    e.preventDefault();
    navigate(a.href, true);
  });

  window.addEventListener('popstate', () => {
    navigate(location.href, false);
  });
})();
