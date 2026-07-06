document.addEventListener('DOMContentLoaded', () => {
  const globalToggle = document.getElementById('global-toggle');
  const siteToggle = document.getElementById('site-toggle');
  const hostnameSpan = document.getElementById('current-hostname');
  const themeToggleBtn = document.getElementById('theme-toggle');
  const sunIcon = document.getElementById('sun-icon');
  const moonIcon = document.getElementById('moon-icon');
  const statusIndicator = document.getElementById('connection-status');
  const statusText = statusIndicator.querySelector('.status-text');
  const tokenInput = document.getElementById('extension-token');
  const saveTokenBtn = document.getElementById('save-token-btn');
  const pairingContent = document.getElementById('pairing-content');
  const pairingToggleBtn = document.getElementById('pairing-toggle-btn');
  const pairingDesc = document.getElementById('pairing-desc');
  const fetchMediaBtn = document.getElementById('fetch-media-btn');
  const mediaStatus = document.getElementById('media-status');
  let activeTab = null;

  const isMediaFetchableTab = (tab) => {
    try {
      const url = new URL(tab?.url || '');
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch (error) {
      return false;
    }
  };

  const setMediaStatusForTab = (tab) => {
    if (!isMediaFetchableTab(tab)) {
      mediaStatus.textContent = 'Open a web page first';
      fetchMediaBtn.disabled = true;
      return;
    }

    mediaStatus.textContent = new URL(tab.url).hostname;
    fetchMediaBtn.disabled = false;
  };

  // Check connection to Firelink
  async function checkConnection() {
    const token = tokenInput.value.trim();

    if (!token) {
      statusIndicator.classList.remove('connected');
      statusIndicator.classList.add('disconnected');
      statusText.textContent = 'Setup required';
      pairingDesc.textContent = 'Paste the token from Firelink App';
      return;
    }

    try {
      await FirelinkProtocol.signedFetch("/ping", token);
      statusIndicator.classList.remove('disconnected');
      statusIndicator.classList.add('connected');
      statusText.textContent = 'App connected';

      pairingContent.classList.add('is-collapsed');
      pairingToggleBtn.textContent = '▼';
      pairingDesc.textContent = 'Connected securely';
      return;
    } catch (error) {
      if (error.serverReached && error.status === 403) {
        statusIndicator.classList.remove('connected');
        statusIndicator.classList.add('disconnected');
        statusText.textContent = 'Invalid token';

        pairingContent.classList.remove('is-collapsed');
        pairingToggleBtn.textContent = '▲';
        pairingDesc.textContent = 'Invalid token. Please update.';
        return;
      }
    }

    statusIndicator.classList.remove('connected');
    statusIndicator.classList.add('disconnected');
    statusText.textContent = 'App closed';
    if (token) {
      pairingDesc.textContent = 'Token saved. App is offline.';
    }
  }

  // Apply theme function
  const applyTheme = (theme) => {
    document.documentElement.setAttribute('data-theme', theme);
    if (theme === 'light') {
      sunIcon.style.display = 'none';
      moonIcon.style.display = 'block';
    } else {
      sunIcon.style.display = 'block';
      moonIcon.style.display = 'none';
    }
  };

  // Load current settings including theme
  chrome.storage.local.get(['globalCapture', 'siteToggles', 'theme', 'extensionToken'], (result) => {
    globalToggle.checked = result.globalCapture || false;
    tokenInput.value = result.extensionToken || "";

    if (result.extensionToken) {
      pairingContent.classList.add('is-collapsed');
      pairingToggleBtn.textContent = '▼';
      pairingDesc.textContent = 'Checking connection...';
    } else {
      pairingContent.classList.remove('is-collapsed');
      pairingToggleBtn.textContent = '▲';
      pairingDesc.textContent = 'Paste the token from Firelink App';
    }

    // Determine initial theme
    let currentTheme = result.theme;
    if (!currentTheme) {
      currentTheme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    }
    applyTheme(currentTheme);

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs.length > 0 && tabs[0].url) {
        activeTab = tabs[0];
        setMediaStatusForTab(activeTab);
        try {
          const url = new URL(tabs[0].url);
          // Only show site toggle for valid http/https URLs
          if (url.protocol === 'http:' || url.protocol === 'https:') {
            const hostname = url.hostname;
            hostnameSpan.textContent = hostname;
            
            const siteToggles = result.siteToggles || {};
            // If the site is in siteToggles and value is true, it means capture is DISABLED for this site
            siteToggle.checked = siteToggles[hostname] === true;
          } else {
            document.getElementById('site-setting-row').style.display = 'none';
          }
        } catch (e) {
          document.getElementById('site-setting-row').style.display = 'none';
        }
      }
      if (!activeTab) {
        setMediaStatusForTab(null);
      }
    });

    // Check connection only after token is loaded
    checkConnection();
  });

  // Handle global toggle change
  globalToggle.addEventListener('change', (e) => {
    chrome.storage.local.set({ globalCapture: e.target.checked });
  });

  // Handle save token click
  saveTokenBtn.addEventListener('click', () => {
    chrome.storage.local.set({ extensionToken: tokenInput.value.trim() }, () => {
      saveTokenBtn.textContent = "Saved!";
      setTimeout(() => { saveTokenBtn.textContent = "Save"; }, 2000);
      checkConnection();
    });
  });

  // Handle pairing toggle click
  pairingToggleBtn.addEventListener('click', () => {
    if (pairingContent.classList.contains('is-collapsed')) {
      pairingContent.classList.remove('is-collapsed');
      pairingToggleBtn.textContent = '▲';
    } else {
      pairingContent.classList.add('is-collapsed');
      pairingToggleBtn.textContent = '▼';
    }
  });

  // Handle theme toggle change
  themeToggleBtn.addEventListener('click', () => {
    const currentTheme = document.documentElement.getAttribute('data-theme') || 
                         (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    const newTheme = currentTheme === 'light' ? 'dark' : 'light';
    applyTheme(newTheme);
    chrome.storage.local.set({ theme: newTheme });
  });

  fetchMediaBtn.addEventListener('click', () => {
    if (!isMediaFetchableTab(activeTab)) {
      setMediaStatusForTab(activeTab);
      return;
    }

    fetchMediaBtn.disabled = true;
    mediaStatus.textContent = 'Sending to Firelink...';
    chrome.runtime.sendMessage({ action: 'fetchMediaForActiveTab' }, response => {
      if (chrome.runtime.lastError || !response?.ok) {
        mediaStatus.textContent = 'Could not send media page';
        fetchMediaBtn.disabled = false;
        return;
      }

      mediaStatus.textContent = 'Opened in Firelink';
      setTimeout(() => {
        setMediaStatusForTab(activeTab);
      }, 1600);
    });
  });

  // Handle site toggle change
  siteToggle.addEventListener('change', (e) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs.length > 0 && tabs[0].url) {
        try {
          const url = new URL(tabs[0].url);
          const hostname = url.hostname;

          chrome.storage.local.get(['siteToggles'], (result) => {
            const siteToggles = result.siteToggles || {};
            siteToggles[hostname] = e.target.checked;
            chrome.storage.local.set({ siteToggles: siteToggles });
          });
        } catch (error) {
          console.error("Invalid URL");
        }
      }
    });
  });
});
