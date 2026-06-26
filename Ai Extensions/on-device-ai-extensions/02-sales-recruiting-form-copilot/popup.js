let profiles = [];
let activeId = null;

function uid() {
  return `p_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function renderProfiles() {
  const list = document.getElementById('profiles-list');
  if (!profiles.length) {
    list.innerHTML = '<div class="empty">No profiles yet. Add one to get started.</div>';
    return;
  }

  list.innerHTML = profiles
    .map(
      (p) => `
    <div class="profile-card" data-id="${p.id}">
      <h3>${escapeHtml(p.name || 'Unnamed')}</h3>
      <div class="field"><label>Name</label><input data-key="name" value="${escapeAttr(p.name)}" /></div>
      <div class="field"><label>Company</label><input data-key="company" value="${escapeAttr(p.company)}" /></div>
      <div class="field"><label>Pitch</label><textarea data-key="pitch">${escapeHtml(p.pitch || '')}</textarea></div>
      <div class="field"><label>Skills</label><input data-key="skills" value="${escapeAttr(p.skills)}" /></div>
      <div class="field"><label>Email</label><input data-key="email" value="${escapeAttr(p.email)}" /></div>
      <div class="field"><label>Phone</label><input data-key="phone" value="${escapeAttr(p.phone)}" /></div>
      <div class="btn-row">
        <button class="btn-primary save-profile">Save</button>
        <button class="btn-secondary set-active">${p.id === activeId ? '✓ Active' : 'Set Active'}</button>
        <button class="btn-danger del-profile">✕</button>
      </div>
    </div>`
    )
    .join('');

  list.querySelectorAll('.profile-card').forEach((card) => {
    const id = card.dataset.id;

    card.querySelector('.save-profile').addEventListener('click', () => {
      const updated = { id };
      card.querySelectorAll('[data-key]').forEach((input) => {
        updated[input.dataset.key] = input.value;
      });
      profiles = profiles.map((p) => (p.id === id ? updated : p));
      saveProfiles();
    });

    card.querySelector('.set-active').addEventListener('click', () => {
      activeId = id;
      saveProfiles();
    });

    card.querySelector('.del-profile').addEventListener('click', () => {
      profiles = profiles.filter((p) => p.id !== id);
      if (activeId === id) activeId = profiles[0]?.id || null;
      saveProfiles();
    });
  });
}

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s) {
  return String(s || '').replace(/"/g, '&quot;');
}

async function saveProfiles() {
  await chrome.runtime.sendMessage({ type: 'SRFC_SAVE_PROFILES', profiles, activeId });
  renderProfiles();
}

async function load() {
  const status = await chrome.runtime.sendMessage({ type: 'SRFC_GET_STATUS' });
  const usageEl = document.getElementById('usage');
  usageEl.textContent = status.pro
    ? 'Pro · Unlimited autofills'
    : `${status.remaining} of ${status.dailyLimit} autofills remaining today`;

  const data = await chrome.runtime.sendMessage({ type: 'SRFC_GET_PROFILES' });
  profiles = data.profiles;
  activeId = data.activeId;
  renderProfiles();
}

document.getElementById('add-profile').addEventListener('click', () => {
  const id = uid();
  profiles.push({ id, name: 'New Profile', company: '', pitch: '', skills: '', email: '', phone: '' });
  activeId = activeId || id;
  renderProfiles();
});

document.getElementById('export-btn').addEventListener('click', async () => {
  const { config } = await chrome.runtime.sendMessage({ type: 'SRFC_EXPORT_CONFIG' });
  const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'form-copilot-team-config.json';
  a.click();
  URL.revokeObjectURL(url);
});

document.getElementById('import-btn').addEventListener('click', () => {
  document.getElementById('import-file').click();
});

document.getElementById('import-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  try {
    const config = JSON.parse(text);
    const result = await chrome.runtime.sendMessage({ type: 'SRFC_IMPORT_CONFIG', config });
    if (result.success) {
      await load();
      alert(`Imported ${result.count} profile(s).`);
    }
  } catch {
    alert('Invalid JSON file.');
  }
  e.target.value = '';
});

document.addEventListener('DOMContentLoaded', load);
