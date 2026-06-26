(function () {
  const SIDEBAR_ID = 'srfc-sidebar';
  const STYLE_ID = 'srfc-styles';

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${SIDEBAR_ID} {
        position: fixed; top: 0; right: 0; width: 300px; height: 100vh;
        z-index: 2147483646; background: #0f172a; color: #e2e8f0;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        box-shadow: -4px 0 24px rgba(0,0,0,0.25); display: flex; flex-direction: column;
        transform: translateX(100%); transition: transform 0.25s ease;
      }
      #${SIDEBAR_ID}.open { transform: translateX(0); }
      #${SIDEBAR_ID} .srfc-header {
        padding: 16px; border-bottom: 1px solid rgba(255,255,255,0.1);
        display: flex; justify-content: space-between; align-items: center;
      }
      #${SIDEBAR_ID} .srfc-header h2 { font-size: 15px; font-weight: 700; color: #fff; }
      #${SIDEBAR_ID} .srfc-close {
        background: none; border: none; color: #94a3b8; font-size: 20px; cursor: pointer;
      }
      #${SIDEBAR_ID} .srfc-body { padding: 16px; flex: 1; overflow-y: auto; }
      #${SIDEBAR_ID} .srfc-profile-select {
        width: 100%; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.15);
        border-radius: 8px; padding: 8px 10px; color: #fff; font-size: 13px; margin-bottom: 12px;
      }
      #${SIDEBAR_ID} .srfc-btn {
        width: 100%; background: #059669; color: #fff; border: none; border-radius: 8px;
        padding: 11px; font-size: 13px; font-weight: 600; cursor: pointer; margin-bottom: 8px;
      }
      #${SIDEBAR_ID} .srfc-btn:hover { background: #047857; }
      #${SIDEBAR_ID} .srfc-btn.secondary { background: rgba(255,255,255,0.1); }
      #${SIDEBAR_ID} .srfc-status { font-size: 12px; color: #94a3b8; margin-top: 8px; min-height: 18px; }
      #${SIDEBAR_ID} .srfc-status.error { color: #f87171; }
      #${SIDEBAR_ID} .srfc-status.success { color: #34d399; }
      #srfc-fab {
        position: fixed; bottom: 24px; right: 24px; z-index: 2147483645;
        width: 52px; height: 52px; border-radius: 50%; background: #059669; color: #fff;
        border: none; font-size: 22px; cursor: pointer; box-shadow: 0 4px 16px rgba(5,150,105,0.4);
      }
    `;
    document.head.appendChild(style);
  }

  function collectFormFields() {
    const fields = [];
    const seen = new Set();

    document.querySelectorAll('input, textarea, select').forEach((el, idx) => {
      if (el.type === 'hidden' || el.type === 'submit' || el.type === 'button') return;
      if (!el.offsetParent && el.type !== 'radio' && el.type !== 'checkbox') return;

      const label =
        el.labels?.[0]?.textContent?.trim() ||
        el.getAttribute('aria-label') ||
        el.placeholder ||
        el.name ||
        `Field ${idx + 1}`;

      const id = el.id || el.name || `srfc-field-${idx}`;
      if (seen.has(id)) return;
      seen.add(id);

      fields.push({
        id,
        label: label.slice(0, 120),
        placeholder: el.placeholder || '',
        type: el.type || el.tagName.toLowerCase(),
        name: el.name || '',
      });
    });

    return fields;
  }

  function fillField(id, value) {
    if (!value) return false;
    const el = document.getElementById(id) || document.querySelector(`[name="${CSS.escape(id)}"]`);
    if (!el) return false;

    if (el.tagName === 'SELECT') {
      const opt = [...el.options].find(
        (o) => o.text.toLowerCase().includes(value.toLowerCase()) || o.value === value
      );
      if (opt) {
        el.value = opt.value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
    }

    el.focus();
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  function createSidebar() {
    injectStyles();

    const fab = document.createElement('button');
    fab.id = 'srfc-fab';
    fab.title = 'Form Copilot';
    fab.textContent = '✎';
    fab.addEventListener('click', toggleSidebar);

    const sidebar = document.createElement('div');
    sidebar.id = SIDEBAR_ID;
    sidebar.innerHTML = `
      <div class="srfc-header">
        <h2>Form Copilot</h2>
        <button class="srfc-close" aria-label="Close">×</button>
      </div>
      <div class="srfc-body">
        <select class="srfc-profile-select" id="srfc-profile-select">
          <option value="">Loading profiles…</option>
        </select>
        <button class="srfc-btn" id="srfc-autofill">Auto-Fill Form (On-Device AI)</button>
        <button class="srfc-btn secondary" id="srfc-detect">Re-scan Fields</button>
        <div class="srfc-status" id="srfc-status">Select a profile and click Auto-Fill.</div>
      </div>
    `;

    document.body.appendChild(fab);
    document.body.appendChild(sidebar);

    sidebar.querySelector('.srfc-close').addEventListener('click', () => {
      sidebar.classList.remove('open');
    });

    sidebar.querySelector('#srfc-autofill').addEventListener('click', runAutofill);
    sidebar.querySelector('#srfc-detect').addEventListener('click', () => {
      const count = collectFormFields().length;
      setStatus(`Found ${count} fillable fields on this page.`, 'success');
    });

    loadProfiles();
  }

  function toggleSidebar() {
    const sidebar = document.getElementById(SIDEBAR_ID);
    if (sidebar) {
      sidebar.classList.toggle('open');
      if (sidebar.classList.contains('open')) loadProfiles();
    }
  }

  function setStatus(msg, variant = '') {
    const el = document.getElementById('srfc-status');
    if (el) {
      el.textContent = msg;
      el.className = `srfc-status ${variant}`;
    }
  }

  async function loadProfiles() {
    const { profiles, activeId } = await chrome.runtime.sendMessage({ type: 'SRFC_GET_PROFILES' });
    const select = document.getElementById('srfc-profile-select');
    if (!select) return;

    select.innerHTML = profiles.length
      ? profiles.map((p) => `<option value="${p.id}" ${p.id === activeId ? 'selected' : ''}>${p.name}</option>`).join('')
      : '<option value="">No profiles — add in popup</option>';
  }

  async function runAutofill() {
    const fields = collectFormFields();
    if (!fields.length) {
      setStatus('No form fields detected on this page.', 'error');
      return;
    }

    setStatus(`Mapping ${fields.length} fields with on-device AI…`);

    const response = await chrome.runtime.sendMessage({ type: 'SRFC_AUTOFILL', fields });

    if (!response.success) {
      setStatus(response.error, 'error');
      return;
    }

    let filled = 0;
    Object.entries(response.mapping).forEach(([id, value]) => {
      if (fillField(id, value)) filled += 1;
    });

    const suffix = response.remaining === Infinity ? '' : ` · ${response.remaining} fills left`;
    setStatus(`Filled ${filled} of ${fields.length} fields on-device.${suffix}`, 'success');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', createSidebar);
  } else {
    createSidebar();
  }
})();
