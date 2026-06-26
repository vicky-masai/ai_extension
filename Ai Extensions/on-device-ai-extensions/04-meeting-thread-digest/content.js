(function () {
  const PANEL_ID = 'mtd-digest-panel';
  const STYLE_ID = 'mtd-styles';

  const isSlack = /slack\.com/.test(location.hostname);
  const isGmail = /mail\.google\.com/.test(location.hostname);

  if (!isSlack && !isGmail) return;

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .mtd-digest-btn {
        display: inline-flex; align-items: center; gap: 6px;
        background: linear-gradient(135deg, #7c3aed, #4f46e5); color: #fff;
        border: none; border-radius: 8px; padding: 7px 14px; font-size: 13px;
        font-weight: 600; cursor: pointer; font-family: -apple-system, sans-serif;
        box-shadow: 0 2px 8px rgba(79,70,229,0.35); margin: 8px; z-index: 9999;
      }
      .mtd-digest-btn:hover { filter: brightness(1.1); }
      .mtd-digest-btn:disabled { opacity: 0.6; cursor: wait; }
      #${PANEL_ID} {
        position: fixed; top: 60px; right: 20px; width: 480px; max-height: 70vh;
        z-index: 2147483647; background: #fff; border-radius: 14px;
        box-shadow: 0 12px 48px rgba(0,0,0,0.2); overflow: hidden;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        display: none; flex-direction: column;
      }
      #${PANEL_ID}.open { display: flex; }
      #${PANEL_ID} .mtd-panel-header {
        background: linear-gradient(135deg, #1e1b4b, #312e81); color: #fff;
        padding: 14px 18px; display: flex; justify-content: space-between; align-items: center;
      }
      #${PANEL_ID} .mtd-panel-header h3 { font-size: 14px; font-weight: 700; }
      #${PANEL_ID} .mtd-close {
        background: rgba(255,255,255,0.15); border: none; color: #fff;
        width: 28px; height: 28px; border-radius: 50%; cursor: pointer; font-size: 16px;
      }
      #${PANEL_ID} .mtd-panel-body {
        padding: 16px 18px; overflow-y: auto; flex: 1; font-size: 13px; color: #1e293b;
      }
      #${PANEL_ID} table { width: 100%; border-collapse: collapse; margin-top: 8px; }
      #${PANEL_ID} th, #${PANEL_ID} td {
        border: 1px solid #e2e8f0; padding: 8px 10px; text-align: left; vertical-align: top;
      }
      #${PANEL_ID} th { background: #f8fafc; font-weight: 600; color: #475569; }
      #${PANEL_ID} .mtd-loading { color: #64748b; font-style: italic; }
      #${PANEL_ID} .mtd-error { color: #dc2626; }
      #${PANEL_ID} .mtd-badge {
        font-size: 10px; background: rgba(255,255,255,0.2); padding: 2px 8px;
        border-radius: 99px; margin-left: 8px;
      }
    `;
    document.head.appendChild(style);
  }

  function extractSlackThread() {
    const messages = document.querySelectorAll('[data-qa="message_container"], .c-message_kit__blocks');
    const texts = [];
    messages.forEach((el) => {
      const author = el.querySelector('[data-qa="message_sender_name"], .c-message__sender')?.textContent?.trim();
      const body = el.querySelector('[data-qa="message-text"], .c-message__body')?.textContent?.trim();
      if (body) texts.push(`${author ? author + ': ' : ''}${body}`);
    });
    return texts.join('\n');
  }

  function extractGmailThread() {
    const emails = document.querySelectorAll('.gs, .ii.gt');
    const texts = [];
    emails.forEach((el) => {
      const from = el.querySelector('.gD, .go')?.textContent?.trim();
      const body = el.querySelector('.a3s')?.textContent?.trim();
      if (body) texts.push(`${from ? from + ': ' : ''}${body}`);
    });
    if (!texts.length) {
      const active = document.querySelector('[role="main"]');
      if (active) return active.innerText.slice(0, 15000);
    }
    return texts.join('\n\n');
  }

  function createPanel() {
    injectStyles();
    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <div class="mtd-panel-header">
        <h3>Executive Thread Digest <span class="mtd-badge">On-Device</span></h3>
        <button class="mtd-close" aria-label="Close">×</button>
      </div>
      <div class="mtd-panel-body" id="mtd-body">
        <p class="mtd-loading">Analyzing thread locally…</p>
      </div>
    `;
    document.body.appendChild(panel);
    panel.querySelector('.mtd-close').addEventListener('click', () => panel.classList.remove('open'));
    return panel;
  }

  function showPanel() {
    let panel = document.getElementById(PANEL_ID);
    if (!panel) panel = createPanel();
    panel.classList.add('open');
    return panel;
  }

  async function runDigest(btn) {
    const platform = isSlack ? 'Slack' : 'Gmail';
    const text = isSlack ? extractSlackThread() : extractGmailThread();

    if (!text || text.length < 30) {
      alert('Could not extract enough thread content. Open a conversation first.');
      return;
    }

    btn.disabled = true;
    btn.textContent = '⏳ Digesting…';

    const panel = showPanel();
    const body = panel.querySelector('#mtd-body');
    body.innerHTML = '<p class="mtd-loading">Processing on-device with Summarizer + Prompt API…</p>';

    const response = await chrome.runtime.sendMessage({
      type: 'MTD_DIGEST',
      text,
      platform,
    });

    btn.disabled = false;
    btn.textContent = '📋 Digest Thread';

    if (!response.success) {
      body.innerHTML = `<p class="mtd-error">${response.error}</p>`;
      return;
    }

    body.innerHTML = response.html;
    const footer = document.createElement('p');
    footer.style.cssText = 'font-size:11px;color:#94a3b8;margin-top:12px;';
    footer.textContent = `Generated on-device · ${response.remaining === Infinity ? 'Pro' : response.remaining + ' digests left today'}`;
    body.appendChild(footer);
  }

  function injectButton() {
    if (document.querySelector('.mtd-digest-btn')) return;

    const btn = document.createElement('button');
    btn.className = 'mtd-digest-btn';
    btn.textContent = '📋 Digest Thread';
    btn.title = 'Generate executive summary (on-device AI)';
    btn.addEventListener('click', () => runDigest(btn));

    if (isSlack) {
      const toolbar = document.querySelector('[data-qa="channel_header"], .p-view_header');
      (toolbar || document.body).appendChild(btn);
    } else {
      const header = document.querySelector('[role="banner"], .nH');
      (header || document.body).appendChild(btn);
    }
  }

  const observer = new MutationObserver(() => injectButton());
  observer.observe(document.body, { childList: true, subtree: true });
  injectButton();
})();
