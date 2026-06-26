(function () {
  const TOOLTIP_ID = 'odpt-tooltip';
  const STYLE_ID = 'odpt-styles';

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${TOOLTIP_ID} {
        position: fixed; z-index: 2147483647; max-width: 400px;
        background: #0f172a; color: #e2e8f0; border-radius: 12px;
        padding: 14px 16px; font-family: -apple-system, sans-serif; font-size: 13px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.25); border: 1px solid rgba(255,255,255,0.1);
        line-height: 1.5;
      }
      #${TOOLTIP_ID} .odpt-label { font-size: 10px; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; }
      #${TOOLTIP_ID} .odpt-translated { margin-top: 6px; color: #38bdf8; }
      #${TOOLTIP_ID} .odpt-close {
        position: absolute; top: 8px; right: 10px; background: none; border: none;
        color: #94a3b8; cursor: pointer; font-size: 16px;
      }
      .odpt-translated-block {
        background: rgba(56, 189, 248, 0.08) !important;
        border-left: 3px solid #0284c7 !important;
        padding-left: 8px !important;
      }
      #odpt-translate-btn {
        position: fixed; bottom: 20px; left: 20px; z-index: 2147483646;
        background: #0284c7; color: #fff; border: none; border-radius: 10px;
        padding: 10px 16px; font-size: 13px; font-weight: 600; cursor: pointer;
        font-family: -apple-system, sans-serif; box-shadow: 0 4px 16px rgba(2,132,199,0.35);
      }
    `;
    document.head.appendChild(style);
  }

  function showTooltip(x, y, original, translated, meta) {
    injectStyles();
    let tip = document.getElementById(TOOLTIP_ID);
    if (!tip) {
      tip = document.createElement('div');
      tip.id = TOOLTIP_ID;
      document.body.appendChild(tip);
    }

    tip.innerHTML = `
      <button class="odpt-close" aria-label="Close">×</button>
      <div class="odpt-label">${meta.sourceLang} → ${meta.targetLang} · On-Device</div>
      <div class="odpt-translated">${escapeHtml(translated)}</div>
      <div class="odpt-label" style="margin-top:10px;">Original</div>
      <div style="color:#94a3b8;font-size:12px;">${escapeHtml(original.slice(0, 200))}${original.length > 200 ? '…' : ''}</div>
    `;
    tip.style.left = `${Math.min(x, window.innerWidth - 420)}px`;
    tip.style.top = `${Math.min(y, window.innerHeight - 200)}px`;
    tip.querySelector('.odpt-close').addEventListener('click', () => tip.remove());
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'ODPT_LOADING') {
      showTooltip(window.innerWidth / 2 - 100, 100, '', 'Translating on-device…', { sourceLang: '…', targetLang: '…' });
    }
    if (msg.type === 'ODPT_RESULT') {
      const sel = window.getSelection();
      const range = sel?.rangeCount ? sel.getRangeAt(0) : null;
      const rect = range?.getBoundingClientRect();
      const x = rect ? rect.left : window.innerWidth / 2 - 150;
      const y = rect ? rect.bottom + 8 : 120;
      showTooltip(x, y, msg.original, msg.translated, {
        sourceLang: msg.sourceLang,
        targetLang: msg.targetLang,
      });
    }
    if (msg.type === 'ODPT_ERROR') {
      showTooltip(100, 100, '', msg.error, { sourceLang: '!', targetLang: '!' });
    }
  });

  function getSelectedElement() {
    const sel = window.getSelection();
    if (!sel?.rangeCount) return null;
    let node = sel.anchorNode;
    if (node?.nodeType === Node.TEXT_NODE) node = node.parentElement;
    return node?.closest?.('p, article, section, div, li, td, h1, h2, h3, h4, blockquote') || node;
  }

  async function translateBlock(el) {
    const text = (el.innerText || el.textContent || '').trim();
    if (text.length < 10) return;

    el.style.opacity = '0.6';
    const response = await chrome.runtime.sendMessage({ type: 'ODPT_TRANSLATE_ELEMENT', text });

    el.style.opacity = '';
    if (!response.success) {
      alert(response.error);
      return;
    }

    el.classList.add('odpt-translated-block');
    el.dataset.odptOriginal = text;
    el.innerHTML = `<span class="odpt-translation">${escapeHtml(response.translated)}</span>`;
    el.title = `Translated from ${response.sourceLang} (on-device)`;
  }

  function injectTranslateButton() {
    injectStyles();
    if (document.getElementById('odpt-translate-btn')) return;

    const btn = document.createElement('button');
    btn.id = 'odpt-translate-btn';
    btn.textContent = '🌐 Translate Block';
    btn.addEventListener('click', () => {
      const el = getSelectedElement();
      if (el) translateBlock(el);
      else alert('Select or click inside a text block first.');
    });
    document.body.appendChild(btn);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectTranslateButton);
  } else {
    injectTranslateButton();
  }
})();
