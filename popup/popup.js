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

  // Check connection to Firelink
  async function checkConnection() {
    const FIRELINK_PORTS = Array.from({ length: 11 }, (_, index) => 6412 + index);
    const token = tokenInput.value.trim();

    if (!token) {
      statusIndicator.classList.remove('connected');
      statusIndicator.classList.add('disconnected');
      statusText.textContent = 'Setup required';
      pairingDesc.textContent = 'Paste the token from Firelink App';
      return;
    }

    for (const port of FIRELINK_PORTS) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/ping`, {
          method: "GET",
          headers: {
            "X-Firelink-Extension": token
          }
        });
        if (response.ok) {
          statusIndicator.classList.remove('disconnected');
          statusIndicator.classList.add('connected');
          statusText.textContent = 'App connected';

          pairingContent.classList.add('is-collapsed');
          pairingToggleBtn.textContent = '▼';
          pairingDesc.textContent = 'Connected securely';
          return;
        } else if (response.status === 403) {
          statusIndicator.classList.remove('connected');
          statusIndicator.classList.add('disconnected');
          statusText.textContent = 'Invalid token';

          pairingContent.classList.remove('is-collapsed');
          pairingToggleBtn.textContent = '▲';
          pairingDesc.textContent = 'Invalid token. Please update.';
          return;
        }
      } catch (error) {
        // Try next port
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

    // Get current active tab
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs.length > 0 && tabs[0].url) {
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
