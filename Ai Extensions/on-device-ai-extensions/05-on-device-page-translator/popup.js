let glossary = {};

function renderGlossary() {
  const container = document.getElementById('glossary-rows');
  const entries = Object.entries(glossary);

  if (!entries.length) {
    container.innerHTML = '<p style="font-size:11px;color:#475569;margin-bottom:8px;">No glossary terms yet.</p>';
    return;
  }

  container.innerHTML = entries
    .map(
      ([term, replacement], i) => `
    <div class="glossary-row" data-idx="${i}">
      <input type="text" class="term-input" value="${escapeAttr(term)}" placeholder="Term" />
      <input type="text" class="replace-input" value="${escapeAttr(replacement)}" placeholder="Keep as" />
      <button class="remove-term" data-term="${escapeAttr(term)}">×</button>
    </div>`
    )
    .join('');

  container.querySelectorAll('.remove-term').forEach((btn) => {
    btn.addEventListener('click', () => {
      delete glossary[btn.dataset.term];
      renderGlossary();
    });
  });
}

function escapeAttr(s) {
  return String(s || '').replace(/"/g, '&quot;');
}

function collectGlossary() {
  const result = {};
  document.querySelectorAll('.glossary-row').forEach((row) => {
    const term = row.querySelector('.term-input')?.value.trim();
    const replacement = row.querySelector('.replace-input')?.value.trim();
    if (term) result[term] = replacement || term;
  });
  return result;
}

document.addEventListener('DOMContentLoaded', async () => {
  const targetLang = document.getElementById('target-lang');
  const usageEl = document.getElementById('usage');
  const proKeyInput = document.getElementById('pro-key');

  const settings = await chrome.runtime.sendMessage({ type: 'ODPT_GET_SETTINGS' });
  glossary = settings.glossary;
  targetLang.value = settings.targetLang;
  renderGlossary();

  const status = await chrome.runtime.sendMessage({ type: 'ODPT_GET_STATUS' });
  usageEl.textContent = status.pro
    ? 'Pro · Unlimited translations'
    : `${status.remaining} of ${status.dailyLimit} translations left today`;

  const stored = await chrome.storage.local.get('odpt_pro_key');
  if (stored.odpt_pro_key) proKeyInput.value = stored.odpt_pro_key;

  document.getElementById('add-term').addEventListener('click', () => {
    glossary = collectGlossary();
    glossary[''] = '';
    const keys = Object.keys(glossary);
    const lastKey = keys[keys.length - 1];
    glossary[`NewTerm${keys.length}`] = glossary[lastKey] === '' ? '' : glossary[lastKey];
    if (lastKey === '') delete glossary[''];
    renderGlossary();
  });

  document.getElementById('save-btn').addEventListener('click', async () => {
    glossary = collectGlossary();
    await chrome.runtime.sendMessage({
      type: 'ODPT_SAVE_SETTINGS',
      glossary,
      targetLang: targetLang.value,
    });
    usageEl.textContent = 'Settings saved!';
    setTimeout(async () => {
      const s = await chrome.runtime.sendMessage({ type: 'ODPT_GET_STATUS' });
      usageEl.textContent = s.pro
        ? 'Pro · Unlimited translations'
        : `${s.remaining} of ${s.dailyLimit} translations left today`;
    }, 1500);
  });

  proKeyInput.addEventListener('change', async () => {
    await chrome.runtime.sendMessage({ type: 'ODPT_SET_PRO_KEY', key: proKeyInput.value.trim() });
  });
});
