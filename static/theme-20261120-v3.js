/* Solid Studio · keep the GitHub credit after the complete mobile workspace. */
(() => {
  'use strict';
  const initialise = () => {
    const workspace = document.querySelector('main.workspace');
    const link = document.querySelector('.stage-github');
    if (!workspace || !link || document.querySelector('.studio-page-footer')) return;

    const origin = document.createComment('Desktop GitHub credit');
    link.before(origin);
    const footer = document.createElement('footer');
    footer.className = 'studio-page-footer';
    footer.setAttribute('aria-label', 'Project author');
    footer.hidden = true;
    workspace.after(footer);

    const mobile = window.matchMedia('(max-width: 860px)');
    const placeCredit = () => {
      if (mobile.matches) {
        footer.append(link);
        footer.hidden = false;
      } else {
        origin.after(link);
        footer.hidden = true;
      }
    };
    placeCredit();
    mobile.addEventListener('change', placeCredit);
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', '#fdf5f2');
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialise, { once: true });
  } else {
    initialise();
  }
})();
