document.addEventListener('DOMContentLoaded', async () => {
  const remainingEl = document.getElementById('remaining');
  const proKeyInput = document.getElementById('pro-key');

  async function refresh() {
    const status = await chrome.runtime.sendMessage({ type: 'MTD_GET_STATUS' });
    remainingEl.textContent = status.pro ? '∞' : `${status.remaining} / ${status.dailyLimit}`;
  }

  const stored = await chrome.storage.local.get('mtd_pro_key');
  if (stored.mtd_pro_key) proKeyInput.value = stored.mtd_pro_key;

  proKeyInput.addEventListener('change', async () => {
    await chrome.runtime.sendMessage({ type: 'MTD_SET_PRO_KEY', key: proKeyInput.value.trim() });
    await refresh();
  });

  await refresh();
});
