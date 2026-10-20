// Shared by the popup and the settings page. Feature toggles live in
// chrome.storage.sync; the API token stays in chrome.storage.local (not synced).
const DEFAULTS = {
  thickMonthDividers: true,
  forecastMenu: true, // "Show Pacing in the left menu" (key kept from Forecast)
  compactMenu: true,
  hideNetWorth: true,
  hideCurrency: false,
  highlightErrors: true,
  futureAssigned: true,
  reportsIncludeAll: true,
  cashFlowTab: true,
  availIncludesUpcoming: false,
  bufferWidget: true,
  bufferGroup: 'Liquid',
  bufferDays: 90,
  bufferIncludeCards: false,
  bufferCardsGroup: 'Credit Cards',
  retireWidget: true,
};

const $ = (id) => document.getElementById(id);

function flash(text) {
  const status = $('status');
  if (!status) return;
  status.textContent = text;
  setTimeout(() => (status.textContent = ''), 900);
}

function loadToggles() {
  chrome.storage.sync.get(DEFAULTS, (stored) => {
    document.querySelectorAll('input[data-setting]').forEach((el) => {
      el.checked = !!stored[el.dataset.setting];
    });
    document.querySelectorAll('input[data-text-setting]').forEach((el) => {
      el.value = stored[el.dataset.textSetting] || '';
    });
    document.querySelectorAll('select[data-number-setting]').forEach((el) => {
      el.value = String(stored[el.dataset.numberSetting]);
    });
  });
}

document.querySelectorAll('select[data-number-setting]').forEach((el) => {
  el.addEventListener('change', () => {
    chrome.storage.sync.set({ [el.dataset.numberSetting]: Number(el.value) }, () => flash('Saved'));
  });
});

document.querySelectorAll('input[data-text-setting]').forEach((el) => {
  el.addEventListener('change', () => {
    const v = el.value.trim() || DEFAULTS[el.dataset.textSetting];
    el.value = v;
    chrome.storage.sync.set({ [el.dataset.textSetting]: v }, () => flash('Saved'));
  });
});

document.querySelectorAll('input[data-setting]').forEach((el) => {
  el.addEventListener('change', () => {
    chrome.storage.sync.set({ [el.dataset.setting]: el.checked }, () => flash('Saved'));
  });
});

// Token (settings page only)
function setTokenStatus(kind, text) {
  const el = $('tokenStatus');
  if (!el) return;
  el.className = kind;
  el.textContent = text;
}

if ($('lbToken')) {
  chrome.storage.local.get('lbToken', ({ lbToken }) => {
    $('lbToken').value = lbToken || '';
  });
  $('saveToken').addEventListener('click', async () => {
    const token = $('lbToken').value.trim();
    if (!token) {
      await chrome.storage.local.remove('lbToken');
      setTokenStatus('', 'Token removed.');
      return;
    }
    setTokenStatus('', 'Testing…');
    const res = await chrome.runtime.sendMessage({ type: 'lbt-test-token', token });
    if (!res || !res.ok) {
      setTokenStatus('err', (res && res.error) || 'Could not test the token.');
      return;
    }
    await chrome.storage.local.set({ lbToken: token });
    await chrome.runtime.sendMessage({ type: 'lbt-clear-cache' });
    const n = res.result.budgets.length;
    setTokenStatus('ok', `Saved. Token works and can see ${n} budget${n === 1 ? '' : 's'}.`);
  });
  $('showToken').addEventListener('click', () => {
    const show = $('lbToken').type === 'password';
    $('lbToken').type = show ? 'text' : 'password';
    $('showToken').textContent = show ? 'Hide' : 'Show';
  });
}

// Popup only
if ($('openSettings')) {
  $('openSettings').addEventListener('click', () => chrome.runtime.openOptionsPage());
  if ($('ver')) $('ver').textContent = `Version ${chrome.runtime.getManifest().version}`;
  chrome.storage.local.get(['lbToken', 'lbtTheme'], ({ lbToken, lbtTheme }) => {
    // Match whichever Liquid Budget theme was last on screen.
    if (lbtTheme && typeof lbtTheme === 'object') {
      for (const [k, v] of Object.entries(lbtTheme)) if (/^[a-z-]+$/.test(k) && typeof v === 'string' && v) document.documentElement.style.setProperty(`--${k}`, v);
    }
    const dot = $('apiDot');
    const text = $('apiText');
    if (lbToken) {
      dot.classList.add('ok');
      text.textContent = 'API token connected';
    } else {
      text.textContent = 'No API token yet';
      $('openSettings').classList.add('primary');
    }
  });
}

loadToggles();
