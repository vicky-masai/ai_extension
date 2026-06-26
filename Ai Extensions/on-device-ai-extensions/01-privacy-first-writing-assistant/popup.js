document.addEventListener('DOMContentLoaded', async () => {
  const remainingEl = document.getElementById('remaining');
  const planBadge = document.getElementById('plan-badge');
  const upgradeBanner = document.getElementById('upgrade-banner');
  const proKeyInput = document.getElementById('pro-key');
  const saveBtn = document.getElementById('save-key');
  const statusMsg = document.getElementById('status-msg');

  function refreshUI(status) {
    if (status.pro) {
      remainingEl.innerHTML = '∞<span> unlimited</span>';
      planBadge.textContent = 'Pro Plan';
      planBadge.style.background = 'rgba(16, 185, 129, 0.3)';
      planBadge.style.color = '#6ee7b7';
      upgradeBanner.style.display = 'none';
    } else {
      remainingEl.innerHTML = `${status.remaining}<span> / ${status.dailyLimit}</span>`;
      planBadge.textContent = 'Free Plan';
      upgradeBanner.style.display = 'block';
    }
  }

  const status = await chrome.runtime.sendMessage({ type: 'PFWA_GET_STATUS' });
  refreshUI(status);

  const stored = await chrome.storage.local.get('pfwa_pro_key');
  if (stored.pfwa_pro_key) {
    proKeyInput.value = stored.pfwa_pro_key;
  }

  saveBtn.addEventListener('click', async () => {
    const key = proKeyInput.value.trim();
    await chrome.runtime.sendMessage({ type: 'PFWA_SET_PRO_KEY', key });
    statusMsg.style.display = 'block';
    statusMsg.textContent = key.length >= 8 ? 'Pro activated!' : 'Key saved (min 8 chars for Pro)';
    const updated = await chrome.runtime.sendMessage({ type: 'PFWA_GET_STATUS' });
    refreshUI(updated);
    setTimeout(() => { statusMsg.style.display = 'none'; }, 2500);
  });
});
