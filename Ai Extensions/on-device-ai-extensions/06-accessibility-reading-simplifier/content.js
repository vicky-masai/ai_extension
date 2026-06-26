(function () {
  const STYLE_ID = 'ars-styles';
  const TOOLBAR_ID = 'ars-toolbar';

  const DYSLEXIA_FONT_STACK =
    '"OpenDyslexic", "Comic Sans MS", "Arial", sans-serif';

  function injectStyles(settings) {
    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement('style');
      style.id = STYLE_ID;
      document.head.appendChild(style);
    }

    const fontSize = settings.fontSize || 18;
    const lineHeight = settings.lineSpacing || 1.8;
    const fontFamily = settings.dyslexiaFont ? DYSLEXIA_FONT_STACK : 'Georgia, serif';

    style.textContent = `
      html.ars-enabled body {
        font-family: ${settings.dyslexiaFont ? DYSLEXIA_FONT_STACK : "system-ui, -apple-system, 'Segoe UI', sans-serif"} !important;
        font-size: ${fontSize}px !important;
        line-height: ${lineHeight} !important;
        letter-spacing: 0.05em !important;
        word-spacing: 0.12em !important;
      }
      html.ars-enabled p, html.ars-enabled li, html.ars-enabled td,
      html.ars-enabled h1, html.ars-enabled h2, html.ars-enabled h3,
      html.ars-enabled article, html.ars-enabled section {
        max-width: 68ch !important;
        margin-left: auto !important;
        margin-right: auto !important;
      }
      html.ars-enabled p { margin-bottom: 1.2em !important; }
      .ars-simplified {
        background: #fef9c3 !important;
        border-radius: 8px !important;
        padding: 12px 16px !important;
        border-left: 4px solid #ca8a04 !important;
        margin: 8px 0 !important;
        font-family: ${fontFamily} !important;
        font-size: ${fontSize}px !important;
        line-height: ${lineHeight} !important;
      }
      .ars-simplify-btn {
        display: inline-block; margin-left: 8px; padding: 2px 8px;
        background: #ca8a04; color: #fff; border: none; border-radius: 4px;
        font-size: 11px; cursor: pointer; vertical-align: middle;
        font-family: -apple-system, sans-serif;
      }
      #${TOOLBAR_ID} {
        position: fixed; bottom: 20px; right: 20px; z-index: 2147483647;
        display: flex; gap: 8px; align-items: center;
        background: #1c1917; border-radius: 12px; padding: 10px 14px;
        box-shadow: 0 6px 24px rgba(0,0,0,0.25);
        font-family: -apple-system, sans-serif;
      }
      #${TOOLBAR_ID} button {
        background: #ca8a04; color: #fff; border: none; border-radius: 8px;
        padding: 8px 12px; font-size: 12px; font-weight: 600; cursor: pointer;
      }
      #${TOOLBAR_ID} button.secondary { background: rgba(255,255,255,0.12); }
      #${TOOLBAR_ID} span { color: #a8a29e; font-size: 11px; }
    `;
  }

  function createToolbar() {
    if (document.getElementById(TOOLBAR_ID)) return;

    const toolbar = document.createElement('div');
    toolbar.id = TOOLBAR_ID;
    toolbar.innerHTML = `
      <span>Reading Mode</span>
      <button id="ars-toggle-font">Toggle Dyslexia Font</button>
      <button id="ars-simplify-page" class="secondary">Simplify Selection</button>
    `;
    document.body.appendChild(toolbar);

    toolbar.querySelector('#ars-toggle-font').addEventListener('click', async () => {
      document.documentElement.classList.toggle('ars-enabled');
      const status = await chrome.runtime.sendMessage({ type: 'ARS_GET_STATUS' });
      const settings = status.settings || {};
      settings.dyslexiaFont = !settings.dyslexiaFont;
      injectStyles(settings);
      await chrome.runtime.sendMessage({ type: 'ARS_SAVE_SETTINGS', settings });
      document.documentElement.classList.add('ars-enabled');
    });

    toolbar.querySelector('#ars-simplify-page').addEventListener('click', simplifySelection);
  }

  async function init() {
    const status = await chrome.runtime.sendMessage({ type: 'ARS_GET_STATUS' });
    const settings = status.settings || { dyslexiaFont: true, lineSpacing: 1.8, fontSize: 18 };
    injectStyles(settings);
    document.documentElement.classList.add('ars-enabled');
    createToolbar();
    attachSimplifyButtons();
  }

  function attachSimplifyButtons() {
    const blocks = document.querySelectorAll(
      'p, li, blockquote, td, h2, h3, article section > div'
    );

    blocks.forEach((el) => {
      if (el.dataset.arsAttached || el.closest(`#${TOOLBAR_ID}`)) return;
      const text = (el.innerText || '').trim();
      if (text.length < 80 || text.length > 2000) return;

      el.dataset.arsAttached = '1';
      el.style.position = 'relative';

      const btn = document.createElement('button');
      btn.className = 'ars-simplify-btn';
      btn.textContent = 'Simplify';
      btn.title = 'Simplify with on-device AI';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        simplifyBlock(el);
      });
      el.appendChild(btn);
    });
  }

  async function simplifyBlock(el) {
    const text = (el.dataset.arsOriginal || el.innerText || '').replace('Simplify', '').trim();
    if (!text) return;

    el.style.opacity = '0.5';
    const response = await chrome.runtime.sendMessage({ type: 'ARS_SIMPLIFY', text });

    el.style.opacity = '';
    if (!response.success) {
      alert(response.error);
      return;
    }

    if (!el.dataset.arsOriginal) el.dataset.arsOriginal = text;

    const simplified = document.createElement('div');
    simplified.className = 'ars-simplified';
    simplified.textContent = response.simplified;
    el.parentNode.insertBefore(simplified, el.nextSibling);

    const btn = el.querySelector('.ars-simplify-btn');
    if (btn) btn.textContent = '✓ Done';
  }

  async function simplifySelection() {
    const sel = window.getSelection();
    const text = sel?.toString().trim();
    if (!text || text.length < 20) {
      alert('Select a passage of text first.');
      return;
    }

    const response = await chrome.runtime.sendMessage({ type: 'ARS_SIMPLIFY', text });
    if (!response.success) {
      alert(response.error);
      return;
    }

    const panel = document.createElement('div');
    panel.className = 'ars-simplified';
    panel.style.cssText =
      'position:fixed;top:80px;left:50%;transform:translateX(-50%);max-width:600px;z-index:2147483647;padding:20px;';
    panel.innerHTML = `
      <strong style="display:block;margin-bottom:8px;color:#854d0e;">Simplified (On-Device)</strong>
      ${response.simplified.replace(/</g, '&lt;')}
      <button style="margin-top:12px;background:#ca8a04;color:#fff;border:none;padding:6px 12px;border-radius:6px;cursor:pointer;" onclick="this.parentElement.remove()">Close</button>
    `;
    document.body.appendChild(panel);
  }

  const observer = new MutationObserver(() => attachSimplifyButtons());
  observer.observe(document.body, { childList: true, subtree: true });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
