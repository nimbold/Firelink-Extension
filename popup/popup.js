document.addEventListener('DOMContentLoaded', () => {
  const globalToggle = document.getElementById('global-toggle');
  const siteToggle = document.getElementById('site-toggle');
  const hostnameSpan = document.getElementById('current-hostname');
  const themeToggleBtn = document.getElementById('theme-toggle');
  const sunIcon = document.getElementById('sun-icon');
  const moonIcon = document.getElementById('moon-icon');

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
  chrome.storage.local.get(['globalCapture', 'siteToggles', 'theme'], (result) => {
    globalToggle.checked = result.globalCapture || false;

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
          if (url.protocol.startsWith('http')) {
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
  });

  // Handle global toggle change
  globalToggle.addEventListener('change', (e) => {
    chrome.storage.local.set({ globalCapture: e.target.checked });
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
