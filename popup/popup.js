document.addEventListener('DOMContentLoaded', () => {
  const { catalogs, localeCodes, themes, resolveLocale, normalizeLanguagePreference, normalizeTheme } = globalThis.FirelinkPopupI18n;
  const globalToggle = document.getElementById('global-toggle');
  const siteToggle = document.getElementById('site-toggle');
  const siteSettingRow = document.getElementById('site-setting-row');
  const hostnameSpan = document.getElementById('current-hostname');
  const settingsToggle = document.getElementById('settings-toggle');
  const settingsPanel = document.getElementById('settings-panel');
  const languageLabel = document.getElementById('language-label');
  const themeLabel = document.getElementById('theme-label');
  const languageSelect = document.getElementById('language-select');
  const themeSelect = document.getElementById('theme-select');
  const statusIndicator = document.getElementById('connection-status');
  const statusText = statusIndicator.querySelector('.status-text');
  const tokenInput = document.getElementById('extension-token');
  const saveTokenBtn = document.getElementById('save-token-btn');
  const pairingSection = document.getElementById('pairing-section');
  const pairingContent = document.getElementById('pairing-content');
  const pairingToggleBtn = document.getElementById('pairing-toggle-btn');
  const pairingDesc = document.getElementById('pairing-desc');
  const fetchMediaBtn = document.getElementById('fetch-media-btn');
  const mediaStatus = document.getElementById('media-status');
  const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
  const state = {
    languagePreference: 'system',
    locale: resolveLocale(navigator.language),
    theme: 'system',
    connection: 'checking',
    media: 'currentTab',
    activeTab: null,
    pairingExpanded: false,
    saveState: 'idle'
  };
  let saveResetTimer = null;
  let connectionRequestId = 0;
  let storageLoading = true;
  const storageChangedDuringLoad = new Set();

  const catalog = () => catalogs[state.locale];

  const isMediaFetchableTab = (tab) => {
    try {
      const url = new URL(tab?.url || '');
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch (error) {
      return false;
    }
  };

  const currentHostname = () => {
    try {
      return new URL(state.activeTab?.url || '').hostname;
    } catch (error) {
      return '';
    }
  };

  const setSelectOptions = (select, options) => {
    select.replaceChildren(...options.map(({ value, label }) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      return option;
    }));
  };

  const renderSettingsOptions = () => {
    const current = catalog();
    setSelectOptions(languageSelect, [
      { value: 'system', label: current.systemDefault },
      ...localeCodes.map((locale) => ({ value: locale, label: current.languageNames[locale] }))
    ]);
    languageSelect.value = state.languagePreference;

    setSelectOptions(themeSelect, themes.map((theme) => ({
      value: theme,
      label: current.themes[theme]
    })));
    themeSelect.value = state.theme;
  };

  const renderStaticCopy = () => {
    const current = catalog();
    document.documentElement.lang = state.locale;
    document.documentElement.dir = current.direction;
    document.documentElement.dataset.locale = state.locale;
    languageLabel.textContent = current.language;
    themeLabel.textContent = current.theme;
    document.getElementById('fetch-media-label').textContent = current.fetchMedia;
    document.getElementById('capture-downloads-label').textContent = current.captureDownloads;
    document.getElementById('disable-on-site-label').textContent = current.disableOnSite;
    document.getElementById('pairing-label').textContent = current.pairingToken;
    tokenInput.placeholder = current.pasteTokenPlaceholder;
    saveTokenBtn.textContent = state.saveState === 'saved' ? current.saved : current.save;
    settingsToggle.setAttribute('aria-label', current.settings);
    settingsToggle.title = current.settings;
    renderSettingsOptions();
    renderConnection();
    renderMediaStatus();
    renderPairing();
  };

  const renderConnection = () => {
    const current = catalog();
    statusIndicator.classList.remove('connected', 'disconnected');
    if (state.connection === 'connected') {
      statusIndicator.classList.add('connected');
      statusText.textContent = current.appConnected;
    } else if (state.connection === 'checking') {
      statusText.textContent = current.checkingConnection;
    } else if (state.connection === 'setup') {
      statusIndicator.classList.add('disconnected');
      statusText.textContent = current.setupRequired;
    } else if (state.connection === 'invalid') {
      statusIndicator.classList.add('disconnected');
      statusText.textContent = current.invalidToken;
    } else {
      statusIndicator.classList.add('disconnected');
      statusText.textContent = current.appClosed;
    }
  };

  const renderMediaStatus = () => {
    const current = catalog();
    if (state.media === 'currentTab') {
      mediaStatus.textContent = currentHostname() || current.currentTab;
    } else if (state.media === 'openWebPage') {
      mediaStatus.textContent = current.openWebPage;
    } else if (state.media === 'sending') {
      mediaStatus.textContent = current.sending;
    } else if (state.media === 'couldNotSend') {
      mediaStatus.textContent = current.couldNotSend;
    } else {
      mediaStatus.textContent = current.opened;
    }
  };

  const renderPairing = () => {
    const current = catalog();
    pairingContent.hidden = !state.pairingExpanded;
    pairingSection.dataset.expanded = String(state.pairingExpanded);
    pairingToggleBtn.setAttribute('aria-expanded', String(state.pairingExpanded));
    pairingToggleBtn.setAttribute('aria-label', state.pairingExpanded ? current.hidePairing : current.showPairing);

    if (state.connection === 'setup') {
      pairingDesc.textContent = current.pasteToken;
    } else if (state.connection === 'connected') {
      pairingDesc.textContent = current.connectedSecurely;
    } else if (state.connection === 'invalid') {
      pairingDesc.textContent = current.invalidTokenUpdate;
    } else if (state.connection === 'checking') {
      pairingDesc.textContent = current.checkingConnection;
    } else {
      pairingDesc.textContent = current.tokenSavedOffline;
    }
  };

  const setPairingExpanded = (expanded) => {
    state.pairingExpanded = expanded;
    renderPairing();
  };

  const setMediaStatusForTab = (tab) => {
    state.activeTab = tab;
    if (!isMediaFetchableTab(tab)) {
      state.media = 'openWebPage';
      fetchMediaBtn.disabled = true;
      renderMediaStatus();
      return;
    }

    state.media = 'currentTab';
    fetchMediaBtn.disabled = false;
    renderMediaStatus();
  };

  const applyTheme = (themePreference) => {
    state.theme = normalizeTheme(themePreference);
    const resolvedTheme = state.theme === 'system'
      ? (mediaQuery.matches ? 'dark' : 'light')
      : state.theme;
    document.documentElement.dataset.theme = state.theme;
    document.documentElement.style.colorScheme = resolvedTheme === 'light' ? 'light' : 'dark';
  };

  const setLanguagePreference = (preference) => {
    state.languagePreference = normalizeLanguagePreference(preference);
    state.locale = state.languagePreference === 'system'
      ? resolveLocale(navigator.language)
      : state.languagePreference;
    renderStaticCopy();
  };

  const checkConnection = async () => {
    const requestId = ++connectionRequestId;
    const token = tokenInput.value.trim();
    const isCurrentRequest = () => requestId === connectionRequestId
      && token === tokenInput.value.trim();
    state.connection = 'checking';
    renderConnection();
    renderPairing();

    if (!token) {
      state.connection = 'setup';
      setPairingExpanded(true);
      renderConnection();
      renderPairing();
      return;
    }

    try {
      await FirelinkProtocol.signedFetch("/ping", token);
      if (!isCurrentRequest()) return;
      state.connection = 'connected';
      setPairingExpanded(false);
    } catch (error) {
      if (!isCurrentRequest()) return;
      if (error.serverReached && error.status === 403) {
        state.connection = 'invalid';
        setPairingExpanded(true);
        renderConnection();
        return;
      }

      state.connection = 'offline';
    }

    renderConnection();
    renderPairing();
  };

  tokenInput.addEventListener('input', () => {
    connectionRequestId += 1;
  });

  const loadActiveTab = () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs.length > 0 && tabs[0].url ? tabs[0] : null;
      setMediaStatusForTab(tab);
      if (!isMediaFetchableTab(tab)) {
        siteSettingRow.hidden = true;
        return;
      }

      siteSettingRow.hidden = false;
      const hostname = currentHostname();
      hostnameSpan.textContent = hostname;
      chrome.storage.local.get(['siteToggles'], (result) => {
        const siteToggles = result.siteToggles || {};
        siteToggle.checked = siteToggles[hostname] === true;
      });
    });
  };

  const saveToken = () => {
    chrome.storage.local.set({ extensionToken: tokenInput.value.trim() }, () => {
      state.saveState = 'saved';
      renderStaticCopy();
      checkConnection();
      clearTimeout(saveResetTimer);
      saveResetTimer = setTimeout(() => {
        state.saveState = 'idle';
        renderStaticCopy();
      }, 2000);
    });
  };

  settingsToggle.addEventListener('click', () => {
    const expanded = settingsPanel.hidden;
    settingsPanel.hidden = !expanded;
    settingsToggle.setAttribute('aria-expanded', String(expanded));
  });

  languageSelect.addEventListener('change', () => {
    const preference = normalizeLanguagePreference(languageSelect.value);
    chrome.storage.local.set({ language: preference });
    setLanguagePreference(preference);
  });

  themeSelect.addEventListener('change', () => {
    const theme = normalizeTheme(themeSelect.value);
    chrome.storage.local.set({ theme });
    applyTheme(theme);
    renderSettingsOptions();
  });

  pairingSection.addEventListener('click', (event) => {
    if (event.target.closest('.pairing-content')) return;
    setPairingExpanded(!state.pairingExpanded);
  });

  globalToggle.addEventListener('change', (event) => {
    chrome.storage.local.set({ globalCapture: event.target.checked });
  });

  saveTokenBtn.addEventListener('click', saveToken);

  fetchMediaBtn.addEventListener('click', () => {
    if (!isMediaFetchableTab(state.activeTab)) {
      setMediaStatusForTab(state.activeTab);
      return;
    }

    fetchMediaBtn.disabled = true;
    state.media = 'sending';
    renderMediaStatus();
    chrome.runtime.sendMessage({ action: 'fetchMediaForActiveTab' }, (response) => {
      if (chrome.runtime.lastError || !response?.ok) {
        state.media = 'couldNotSend';
        fetchMediaBtn.disabled = false;
        renderMediaStatus();
        return;
      }

      state.media = 'opened';
      renderMediaStatus();
      setTimeout(() => setMediaStatusForTab(state.activeTab), 1600);
    });
  });

  siteToggle.addEventListener('change', (event) => {
    const hostname = currentHostname();
    if (!hostname) return;

    chrome.storage.local.get(['siteToggles'], (result) => {
      const siteToggles = result.siteToggles || {};
      siteToggles[hostname] = event.target.checked;
      chrome.storage.local.set({ siteToggles });
    });
  });

  const onSystemThemeChange = () => {
    if (state.theme === 'system') applyTheme('system');
  };
  if (typeof mediaQuery.addEventListener === 'function') {
    mediaQuery.addEventListener('change', onSystemThemeChange);
  } else if (typeof mediaQuery.addListener === 'function') {
    mediaQuery.addListener(onSystemThemeChange);
  }

  const applyStorageChange = (changes) => {
    if (Object.prototype.hasOwnProperty.call(changes, 'globalCapture')) {
      globalToggle.checked = changes.globalCapture.newValue === true;
    }

    if (Object.prototype.hasOwnProperty.call(changes, 'language')) {
      setLanguagePreference(changes.language.newValue);
    }

    if (Object.prototype.hasOwnProperty.call(changes, 'theme')) {
      applyTheme(changes.theme.newValue);
      renderSettingsOptions();
    }

    if (Object.prototype.hasOwnProperty.call(changes, 'siteToggles') && state.activeTab) {
      const hostname = currentHostname();
      siteToggle.checked = changes.siteToggles.newValue?.[hostname] === true;
    }

    if (Object.prototype.hasOwnProperty.call(changes, 'extensionToken')
      && document.activeElement !== tokenInput) {
      tokenInput.value = changes.extensionToken.newValue || '';
      void checkConnection();
    }
  };

  if (chrome.storage.onChanged?.addListener) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      for (const key of ['globalCapture', 'siteToggles', 'theme', 'language', 'extensionToken']) {
        if (Object.prototype.hasOwnProperty.call(changes, key) && storageLoading) {
          storageChangedDuringLoad.add(key);
        }
      }
      applyStorageChange(changes);
    });
  }

  chrome.storage.local.get(['globalCapture', 'siteToggles', 'theme', 'language', 'extensionToken'], (result) => {
    if (!storageChangedDuringLoad.has('globalCapture')) {
      globalToggle.checked = result.globalCapture === true;
    }
    if (!storageChangedDuringLoad.has('extensionToken')) {
      tokenInput.value = result.extensionToken || '';
    }
    if (!storageChangedDuringLoad.has('language')) {
      state.languagePreference = normalizeLanguagePreference(result.language);
      state.locale = state.languagePreference === 'system'
        ? resolveLocale(navigator.language)
        : state.languagePreference;
    }
    if (!storageChangedDuringLoad.has('theme')) {
      applyTheme(result.theme);
    }
    storageLoading = false;
    state.pairingExpanded = !tokenInput.value;
    renderStaticCopy();
    loadActiveTab();
    void checkConnection();
  });
});
