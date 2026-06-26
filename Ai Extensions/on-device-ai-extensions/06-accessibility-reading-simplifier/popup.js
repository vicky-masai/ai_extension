document.addEventListener('DOMContentLoaded', async () => {
  const remainingEl = document.getElementById('remaining');
  const dyslexiaFont = document.getElementById('dyslexia-font');
  const fontSize = document.getElementById('font-size');
  const lineSpacing = document.getElementById('line-spacing');
  const fontSizeVal = document.getElementById('font-size-val');
  const lineSpacingVal = document.getElementById('line-spacing-val');
  const proKeyInput = document.getElementById('pro-key');

  const status = await chrome.runtime.sendMessage({ type: 'ARS_GET_STATUS' });
  const settings = status.settings;

  remainingEl.textContent = status.pro ? '∞' : `${status.remaining} / ${status.dailyLimit}`;
  dyslexiaFont.checked = settings.dyslexiaFont !== false;
  fontSize.value = settings.fontSize || 18;
  lineSpacing.value = settings.lineSpacing || 1.8;
  fontSizeVal.textContent = `${fontSize.value}px`;
  lineSpacingVal.textContent = lineSpacing.value;

  const stored = await chrome.storage.local.get('ars_pro_key');
  if (stored.ars_pro_key) proKeyInput.value = stored.ars_pro_key;

  fontSize.addEventListener('input', () => {
    fontSizeVal.textContent = `${fontSize.value}px`;
  });
  lineSpacing.addEventListener('input', () => {
    lineSpacingVal.textContent = lineSpacing.value;
  });

  document.getElementById('save-settings').addEventListener('click', async () => {
    const newSettings = {
      dyslexiaFont: dyslexiaFont.checked,
      fontSize: parseInt(fontSize.value, 10),
      lineSpacing: parseFloat(lineSpacing.value),
    };
    await chrome.runtime.sendMessage({ type: 'ARS_SAVE_SETTINGS', settings: newSettings });

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      chrome.tabs.reload(tab.id);
    }
  });

  proKeyInput.addEventListener('change', async () => {
    await chrome.runtime.sendMessage({ type: 'ARS_SET_PRO_KEY', key: proKeyInput.value.trim() });
    const updated = await chrome.runtime.sendMessage({ type: 'ARS_GET_STATUS' });
    remainingEl.textContent = updated.pro ? '∞' : `${updated.remaining} / ${updated.dailyLimit}`;
  });
});
