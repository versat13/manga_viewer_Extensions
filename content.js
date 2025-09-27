// content.js for Manga Viewer Extension

(async function () {
  'use strict';

  // ========== 設定 ==========
  const CONFIG = {
    minImageHeight: 400,
    minImageWidth: 200,
    enableKeyControls: true,
    enableMouseWheel: true,
    minMangaImageCount: 2,
    defaultBg: '#333333',
    refreshDebounceMs: 250,
    autoDetectionInterval: 3000,
    scrollDetectionThrottle: 500,
    niconico: {
      defaultThreshold: 0.65,
      minPixelCount: 200000,
      transparentAlpha: 10,
    }
  };

  // 検出モード設定
  const DETECTION_MODES = {
    'auto': { name: '🤖 自動検出', description: '全ての方法を試して最適なものを選択' },
    'smart': { name: '🧠 スマート検出', description: 'リソース情報から画像を検出' },
    'deep-scan': { name: '🔍 ディープスキャン', description: 'HTMLコードから画像URLを解析' },
    'basic': { name: '📄 基本型', description: 'ページ上の<img>タグを直接検索' },
    'frame-reader': { name: '🖼️ フレーム型', description: 'iframe内の画像を検索' },
    'niconico-seiga': { name: '📺 Canvasモード（ニコニコ静画等）', description: 'Canvasから画像を抽出', niconico: true },
    'reading-content': { name: '📱 エリア型', description: '.reading-content内を検索', selector: '.reading-content img', dataSrcSupport: true },
    'chapter-content': { name: '📄 チャプター型', description: '.chapter-content内を検索', selector: '.chapter-content img', dataSrcSupport: true },
    'manga-reader': { name: '📚 リーダー型', description: '.manga-reader内を検索', selector: '.manga-reader img', dataSrcSupport: false },
    'entry-content': { name: '📋 エントリー型', description: '.entry-content内を検索', selector: '.entry-content img', dataSrcSupport: true }
  };

  // ========== グローバル変数 ==========
  const state = {
    currentPage: 0,
    images: [],
    isFullscreen: false,
    lastImageCount: 0,
    detectedMode: null,
    settings: { // 設定を保持するオブジェクト
        siteMode: 'hide',
        detectionMode: 'auto',
        singlePageMode: false,
        bgColor: CONFIG.defaultBg,
        niconicoThreshold: CONFIG.niconico.defaultThreshold
    },
    niconico: {
      threshold: CONFIG.niconico.defaultThreshold
    }
  };

  const elements = {
    container: null,
    imageArea: null,
    bgToggleBtn: null,
    fullscreenBtn: null,
    toggleButton: null,
    niconicoThresholdUI: null,
    singlePageBtn: null,
    navigationElement: null
  };

  const observers = {
    intersection: null,
    mutation: null
  };

  const timers = {
    refresh: null,
    navigation: null,
    scroll: null,
    polling: null
  };

  const watched = new WeakSet();

  // ========== ユーティリティ関数 ==========
  const Utils = {
    debounce(func, delay) {
      let timeoutId;
      return (...args) => {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => func.apply(this, args), delay);
      };
    },
    throttle(func, delay) {
      let lastCall = 0;
      return (...args) => {
        const now = Date.now();
        if (now - lastCall >= delay) {
          lastCall = now;
          return func.apply(this, args);
        }
      };
    },
    createButton(text, styles = {}, clickHandler = null) {
      const button = document.createElement('button');
      button.textContent = text;
      button.type = 'button';
      const defaultStyles = {
        background: 'rgba(255,255,255,0.2)', color: 'white', border: 'none',
        padding: '6px 10px', borderRadius: '4px', cursor: 'pointer'
      };
      Object.assign(button.style, defaultStyles, styles);
      if (clickHandler) {
        button.addEventListener('click', (e) => {
          e.stopPropagation(); e.preventDefault(); clickHandler();
        });
      }
      return button;
    },
    showMessage(text, color = 'rgba(0,150,0,0.8)', duration = 2500) {
      const msg = document.createElement('div');
      msg.textContent = text;
      msg.style.cssText = `
        position: fixed; top: 20px; left: 50%; transform: translateX(-50%);
        z-index: 10001; background: ${color}; color: white;
        padding: 8px 12px; border-radius: 4px; font-size: 12px; pointer-events: none;
      `;
      document.body.appendChild(msg);
      setTimeout(() => msg.remove(), duration);
    },
    isNiconicoSeiga() {
      return window.location.hostname === 'manga.nicovideo.jp';
    }
  };

  // ========== 設定管理 (拡張機能版) ==========
  const Settings = {
    async load() {
        const hostname = window.location.hostname;
        const siteSettingsKey = 'mangaViewerDomains';
        const detectionModeKey = `mangaDetectionMode_${hostname}`;
        const singlePageKey = `mangaViewerSinglePage_${hostname}`;
        const bgKey = 'mangaViewerBg';
        const niconicoThresholdKey = 'mangaViewerNiconicoThreshold';

        const result = await chrome.storage.sync.get([
            siteSettingsKey,
            detectionModeKey,
            singlePageKey,
            bgKey,
            niconicoThresholdKey
        ]);
        
        const siteSettings = result[siteSettingsKey] || {};
        state.settings.siteMode = siteSettings[hostname] || 'hide';
        state.settings.detectionMode = result[detectionModeKey] || 'auto';
        state.settings.singlePageMode = result[singlePageKey] === 'true';
        state.settings.bgColor = result[bgKey] || CONFIG.defaultBg;
        state.settings.niconicoThreshold = parseFloat(result[niconicoThresholdKey] || CONFIG.niconico.defaultThreshold);

        state.niconico.threshold = state.settings.niconicoThreshold;

        console.log('Settings loaded:', state.settings);
    },
    getDetectionMode() {
        return state.settings.detectionMode;
    },
    getSinglePageMode() {
        return state.settings.singlePageMode;
    },
    getBgColor() {
        return state.settings.bgColor;
    },
    async toggleBgColor() {
        const newColor = this.getBgColor() === '#333333' ? '#F5F5F5' : '#333333';
        await chrome.storage.sync.set({ 'mangaViewerBg': newColor });
        state.settings.bgColor = newColor;

        if (elements.container) elements.container.style.background = newColor;
        if (elements.bgToggleBtn) {
            elements.bgToggleBtn.textContent = (newColor === '#F5F5F5') ? '背景：白' : '背景：黒';
        }
    },
    getNiconicoThreshold() {
        return state.settings.niconicoThreshold;
    },
    async setNiconicoThreshold(threshold) {
        await chrome.storage.sync.set({ 'mangaViewerNiconicoThreshold': threshold.toString() });
        state.settings.niconicoThreshold = threshold;
        state.niconico.threshold = threshold;
    },
    // UIの更新はメッセージ受信時に行う
    updateUI() {
        if (state.settings.siteMode === 'show') {
            UI.addToggleButton();
        } else {
            UI.removeToggleButton();
        }
    }
  };

  // ========== ニコニコ静画Canvas抽出システム (変更なし) ==========
  const NiconicoExtractor = {
    extractFromCanvas() {
      console.log('📺 ニコニコ静画Canvas抽出開始');
      const canvases = document.querySelectorAll('canvas');
      if (!canvases.length) {
        console.log('❌ Canvas が見つかりませんでした');
        return [];
      }
      const images = [];
      const threshold = 1 - state.niconico.threshold;
      canvases.forEach((canvas, i) => {
        try {
          const ctx = canvas.getContext('2d');
          const { width, height } = canvas;
          if (width * height < CONFIG.niconico.minPixelCount) {
            console.log(`Canvas ${i}: サイズが小さすぎます (${width}x${height})`);
            return;
          }
          const imgData = ctx.getImageData(0, 0, width, height).data;
          let transparentPixels = 0;
          for (let j = 3; j < imgData.length; j += 4) {
            if (imgData[j] < CONFIG.niconico.transparentAlpha) {
              transparentPixels++;
            }
          }
          const transparencyRatio = transparentPixels / (width * height);
          console.log(`Canvas ${i}: 透明度比率 ${transparencyRatio.toFixed(3)}, 閾値 ${threshold.toFixed(3)}`);
          if (transparencyRatio < threshold) {
            try {
              const url = canvas.toDataURL('image/png');
              const img = new Image();
              img.src = url;
              img.dataset.canvasIndex = String(i);
              img.dataset.isNiconicoCanvas = 'true';
              img.dataset.transparencyRatio = String(transparencyRatio);
              console.log(`Canvas ${i}: 抽出成功 (${width}x${height})`);
              images.push(img);
            } catch (e) { console.error(`Canvas ${i}: toDataURL エラー:`, e); }
          } else { console.log(`Canvas ${i}: 閾値により除外`); }
        } catch (e) { console.error(`Canvas ${i}: 処理エラー:`, e); }
      });
      console.log(`📺 ニコニコ静画: ${images.length}枚の画像を抽出`);
      return images;
    },
    loadAllPages(callback) {
      console.log('📺 ニコニコ静画: 全ページ読み込み開始');
      let lastHeight = 0, attempts = 0;
      const maxAttempts = 50;
      const scrollInterval = setInterval(() => {
        window.scrollTo(0, document.body.scrollHeight);
        attempts++;
        if (document.body.scrollHeight === lastHeight || attempts >= maxAttempts) {
          clearInterval(scrollInterval);
          console.log('📺 ニコニコ静画: スクロール完了');
          setTimeout(() => callback(), 1000);
        }
        lastHeight = document.body.scrollHeight;
      }, 800);
    }
  };

  // ========== ニコニコ静画UI (変更なし) ==========
  const NiconicoUI = {
    createThresholdControl() {
      if (elements.niconicoThresholdUI) return;
      const panel = document.createElement('div');
      panel.style.cssText = `position: absolute; top: 120px; right: 20px; background: rgba(0,0,0,0.8); color: white; padding: 12px; border-radius: 8px; z-index: 1; font-size: 13px; font-family: sans-serif; min-width: 200px;`;
      panel.setAttribute('data-mv-ui', '1');
      const title = document.createElement('div');
      title.textContent = '**ニコニコ静画設定**';
      title.style.cssText = `font-weight: bold; margin-bottom: 8px; color: #ff6b35;`;
      const label = document.createElement('div');
      label.textContent = `OCR判定閾値: ${(state.niconico.threshold * 100).toFixed(0)}%`;
      label.style.marginBottom = '6px';
      const slider = document.createElement('input');
      slider.type = 'range'; slider.min = '0.1'; slider.max = '0.9'; slider.step = '0.05';
      slider.value = state.niconico.threshold;
      slider.style.cssText = `width: 100%; margin: 4px 0;`;
      const description = document.createElement('div');
      description.style.cssText = `font-size: 11px; color: #ccc; margin-top: 4px; line-height: 1.3;`;
      description.textContent = '高い値=厳選抽出';
      slider.oninput = () => {
        const value = parseFloat(slider.value);
        state.niconico.threshold = value;
        Settings.setNiconicoThreshold(value); // 非同期だが、UIは即時反映
        label.textContent = `OCR判定閾値: ${(value * 100).toFixed(0)}%`;
      };
      panel.append(title, label, slider, description);
      elements.niconicoThresholdUI = panel;
      return panel;
    },
    removeThresholdControl() {
      if (elements.niconicoThresholdUI) {
        elements.niconicoThresholdUI.remove();
        elements.niconicoThresholdUI = null;
      }
    },
    updateVisibility() {
      const currentMode = Settings.getDetectionMode();
      if (currentMode === 'niconico-seiga' && elements.container && elements.container.style.display === 'flex') {
        if (!elements.niconicoThresholdUI) {
          const panel = this.createThresholdControl();
          elements.container.appendChild(panel);
        }
      } else {
        this.removeThresholdControl();
      }
    }
  };

  // ========== 画像検出システム (変更なし) ==========
  const ImageDetector = {
    detect(forceRefresh = false) {
      const detectionMode = Settings.getDetectionMode();
      console.log('Detection mode:', detectionMode);
      if (detectionMode !== 'auto') {
        return this.detectByMode(detectionMode);
      }
      return this.detectWithAutoFallback();
    },
    detectByMode(mode) {
      console.log(`Detecting by mode: ${mode}`);
      const detectors = {
        'auto': () => this.detectWithAutoFallback(), 'basic': () => this.detectFromDocument(),
        'smart': () => this.detectFromResources(), 'deep-scan': () => this.detectFromTextScan(),
        'frame-reader': () => this.detectFromIframe(), 'niconico-seiga': () => NiconicoExtractor.extractFromCanvas(),
        'reading-content': () => this.detectBySelector(mode), 'chapter-content': () => this.detectBySelector(mode),
        'manga-reader': () => this.detectBySelector(mode), 'entry-content': () => this.detectBySelector(mode)
      };
      const detector = detectors[mode];
      if (detector) return detector();
      console.warn(`Unknown detection mode: ${mode}, falling back to basic`);
      return this.detectFromDocument();
    },
    detectWithAutoFallback() {
      console.log('Starting auto-detection...');
      const strategies = [
        { name: 'basic', method: () => this.detectFromDocument() },
        { name: 'reading-content', method: () => this.detectBySelector('reading-content') },
        { name: 'chapter-content', method: () => this.detectBySelector('chapter-content') },
        { name: 'manga-reader', method: () => this.detectBySelector('manga-reader') },
        { name: 'entry-content', method: () => this.detectBySelector('entry-content') },
        { name: 'smart', method: () => this.detectFromResources() },
        { name: 'deep-scan', method: () => this.detectFromTextScan() },
        { name: 'frame-reader', method: () => this.detectFromIframe(), condition: () => document.querySelector('iframe') },
        { name: 'niconico-seiga', method: () => NiconicoExtractor.extractFromCanvas() }
      ];
      for (const strategy of strategies) {
        if (strategy.condition && !strategy.condition()) continue;
        const images = strategy.method();
        if (images.length >= CONFIG.minMangaImageCount) {
          console.log(`Auto-detected: ${strategy.name}`);
          state.detectedMode = strategy.name;
          return images;
        }
      }
      console.log('Auto-detection failed');
      state.detectedMode = null;
      return [];
    },
    detectFromDocument() {
      const allImages = document.querySelectorAll('img');
      const excludePatterns = ['icon', 'logo', 'avatar', 'banner', 'header', 'footer', 'thumb', 'thumbnail', 'profile', 'menu', 'button', 'bg', 'background', 'nav', 'sidebar', 'ad', 'advertisement', 'favicon', 'sprite'];
      const potential = Array.from(allImages).filter(img => {
        this.normalizeImageSrc(img);
        if (img.dataset.isResourceDetected || img.dataset.isTextScanned || img.dataset.isNiconicoCanvas) return true;
        if (img.dataset.preload === "yes") { console.log('Found preload image:', img.src); return true; }
        if (!img.src) return false;
        if (!this.isImageLoaded(img)) return this.isImageUrl(img.src);
        if (!this.isValidImageSize(img)) return false;
        return !this.matchesExcludePatterns(img.src, excludePatterns);
      });
      return this.filterAndSortImages(potential);
    },
    detectFromResources() {
      const resources = performance.getEntriesByType("resource");
      const imageUrls = resources.map(r => r.name).filter(url => this.isImageUrl(url))
        .filter(url => !this.matchesExcludePatterns(url.toLowerCase(), ['summary', 'icon', 'logo', 'avatar', 'banner', 'header', 'footer', 'thumb', 'thumbnail', 'profile', 'menu', 'button', 'bg', 'background', 'nav', 'sidebar', 'ad', 'advertisement', 'favicon', 'sprite']));
      return imageUrls.map((url, index) => {
        const img = new Image(); img.src = url; img.dataset.resourceIndex = String(index); img.dataset.isResourceDetected = 'true'; return img;
      });
    },
    detectFromTextScan() {
        const htmlText = document.documentElement.outerHTML;
        const imageUrlPatterns = [/https?:\/\/[^\s"'<>]+\.(?:jpe?g|png|webp|gif)(?:\?[^\s"'<>]*)?/gi];
        const foundUrls = new Set();
        imageUrlPatterns.forEach(pattern => {
            let match;
            while ((match = pattern.exec(htmlText)) !== null) {
                if (match[0]) foundUrls.add(match[0]);
            }
        });
        const filteredUrls = Array.from(foundUrls).filter(url => !this.matchesExcludePatterns(url.toLowerCase(), ['summary', 'icon', 'logo', 'avatar', 'banner', 'header', 'footer', 'thumb', 'thumbnail', 'profile', 'menu', 'button', 'bg', 'background', 'nav', 'sidebar', 'ad', 'advertisement', 'favicon', 'sprite']));
        return filteredUrls.map((url, index) => {
            const img = new Image(); img.src = url; img.dataset.textScanIndex = String(index); img.dataset.isTextScanned = 'true'; return img;
        });
    },
    detectBySelector(configName) {
      const config = DETECTION_MODES[configName];
      if (!config || !config.selector) return [];
      const images = Array.from(document.querySelectorAll(config.selector));
      if (config.dataSrcSupport) {
        images.forEach(img => { if (!img.src && img.dataset.src) img.src = img.dataset.src; });
      }
      return images.filter(img => {
        if (img.dataset.isResourceDetected || img.dataset.isTextScanned || img.dataset.isNiconicoCanvas) return true;
        if (!img.src) return false;
        if (!this.isImageLoaded(img)) return this.isImageUrl(img.src);
        return this.isValidImageSize(img);
      });
    },
    detectFromIframe() {
      const iframe = document.querySelector("iframe");
      if (!iframe) return [];
      try {
        const doc = iframe.contentDocument || iframe.contentWindow.document;
        if (!doc) return [];
        const potential = Array.from(doc.querySelectorAll('img')).filter(img => img.complete && img.naturalHeight > 0 && img.naturalWidth > 0 && img.naturalWidth >= 500);
        potential.forEach(img => {
          if (!img.src.startsWith('http')) {
            try {
              const iframeUrl = new URL(iframe.src);
              const fullSrc = new URL(img.src, iframeUrl.origin).href;
              Object.defineProperty(img, 'src', { value: fullSrc, writable: false });
            } catch (e) { console.log("URL conversion failed:", e); }
          }
        });
        return this.sortImagesByPosition(potential);
      } catch (e) { console.log("iframe access denied:", e); return []; }
    },
    normalizeImageSrc(img) {
      const candidates = [img.dataset.src, img.dataset.original, img.dataset.lazySrc];
      const candidate = candidates.find(c => c);
      if ((!img.src || img.src === '') && candidate) img.src = candidate;
      if ((!img.src || img.src === '') && img.srcset) {
        const src = img.currentSrc || img.srcset.split(',').pop().trim().split(' ')[0];
        if (src) img.src = src;
      }
    },
    isImageLoaded(img) { return img.complete && img.naturalHeight > 0 && img.naturalWidth > 0; },
    isValidImageSize(img) {
        if (img.dataset.isNiconicoCanvas) return true;
        return img.naturalHeight >= CONFIG.minImageHeight && img.naturalWidth >= CONFIG.minImageWidth;
    },
    isImageUrl(url) { return /\.(jpe?g|png|webp|gif)(\?.*)?$/i.test(url); },
    matchesExcludePatterns(src, patterns) { const lowerSrc = src.toLowerCase(); return patterns.some(pattern => lowerSrc.includes(pattern)); },
    filterAndSortImages(images) {
      if (images.length < CONFIG.minMangaImageCount) return [];
      const seenSrcs = new Set();
      const filtered = images.filter(img => {
        if (seenSrcs.has(img.src)) return false;
        seenSrcs.add(img.src); return true;
      });
      return this.sortImagesByPosition(filtered);
    },
    sortImagesByPosition(images) {
      return images.sort((a, b) => {
        if (a.dataset.canvasIndex && b.dataset.canvasIndex) return parseInt(a.dataset.canvasIndex) - parseInt(b.dataset.canvasIndex);
        if (a.dataset.resourceIndex && b.dataset.resourceIndex) return parseInt(a.dataset.resourceIndex) - parseInt(b.dataset.resourceIndex);
        if (a.dataset.textScanIndex && b.dataset.textScanIndex) return parseInt(a.dataset.textScanIndex) - parseInt(b.dataset.textScanIndex);
        const rectA = a.getBoundingClientRect(); const rectB = b.getBoundingClientRect();
        return rectA.top - rectB.top;
      });
    }
  };

  // ========== 自動検出システム (変更なし) ==========
  const AutoDetection = {
    setup() {
      this.setupMutationObserver();
      this.setupScrollListener();
      this.setupPolling();
    },
    setupMutationObserver() {
      observers.mutation = new MutationObserver((mutations) => {
        let shouldRefresh = false;
        mutations.forEach(mutation => {
          mutation.addedNodes.forEach(node => {
            if (node.nodeType === Node.ELEMENT_NODE && (node.tagName === 'IMG' || node.tagName === 'CANVAS' || node.querySelectorAll('img, canvas').length > 0)) {
              shouldRefresh = true;
            }
          });
        });
        if (shouldRefresh) ImageManager.scheduleRefresh();
      });
      observers.mutation.observe(document.body, { childList: true, subtree: true });
    },
    setupScrollListener() {
      const handleScroll = Utils.throttle(() => ImageManager.scheduleRefresh(), CONFIG.scrollDetectionThrottle);
      window.addEventListener('scroll', handleScroll, { passive: true });
    },
    setupPolling() {
      timers.polling = setInterval(() => {
        const currentImageCount = document.querySelectorAll('img, canvas').length;
        if (currentImageCount !== state.lastImageCount) {
          state.lastImageCount = currentImageCount;
          ImageManager.scheduleRefresh();
        }
      }, CONFIG.autoDetectionInterval);
    },
    stop() {
      if (observers.mutation) observers.mutation.disconnect();
      Object.values(timers).forEach(timer => { if (timer) clearTimeout(timer); });
    }
  };

  // ========== 画像管理 (変更なし) ==========
  const ImageManager = {
    scheduleRefresh: Utils.debounce(function() { this.refresh(); }, CONFIG.refreshDebounceMs),
    refresh() {
      const newImages = ImageDetector.detect();
      if (newImages.length !== state.images.length || newImages.some((img, i) => state.images[i] !== img)) {
        console.log(`Images updated: ${state.images.length} -> ${newImages.length}`);
        state.images = newImages;
        if (elements.container && elements.container.style.display === 'flex') {
          Viewer.updatePageInfo();
        }
      }
      const currentMode = Settings.getDetectionMode();
      if (currentMode === 'auto' || currentMode === 'basic') {
        newImages.forEach(img => this.attachWatchers(img));
      }
    },
    attachWatchers(img) {
      if (watched.has(img)) return; watched.add(img);
      img.addEventListener('load', () => this.scheduleRefresh(), { once: true });
      if (observers.intersection && !img.complete) observers.intersection.observe(img);
    },
    loadAll(buttonElement) {
      if (buttonElement?.dataset.loading === '1') return;
      if (buttonElement) {
        buttonElement.dataset.loading = '1'; buttonElement.textContent = '🔥読込中...'; buttonElement.style.opacity = '0.5';
      }
      const currentMode = Settings.getDetectionMode();
      if (currentMode === 'niconico-seiga') this.loadAllFromNiconico(buttonElement);
      else if (currentMode === 'frame-reader') this.loadAllFromIframe(buttonElement);
      else this.loadAllFromDocument(buttonElement);
    },
    loadAllFromNiconico(buttonElement) { NiconicoExtractor.loadAllPages(() => { this.refresh(); this.finishLoadAll(buttonElement); }); },
    loadAllFromDocument(buttonElement) { const originalScrollTop = window.pageYOffset; this.performScrollLoad(window, document.documentElement, originalScrollTop, buttonElement); },
    loadAllFromIframe(buttonElement) {
      const iframe = document.querySelector("iframe"); if (!iframe) return;
      try {
        const iframeWindow = iframe.contentWindow; const iframeDoc = iframe.contentDocument || iframeWindow.document;
        const originalScrollTop = iframeWindow.pageYOffset || iframeDoc.documentElement.scrollTop;
        this.performScrollLoad(iframeWindow, iframeDoc.documentElement, originalScrollTop, buttonElement);
      } catch (e) { console.log("iframe scroll failed:", e); this.finishLoadAll(buttonElement); }
    },
    performScrollLoad(windowObj, documentElement, originalScrollTop, buttonElement) {
      let currentScroll = 0;
      const documentHeight = Math.max(documentElement.scrollHeight, documentElement.offsetHeight, documentElement.clientHeight);
      const viewportHeight = windowObj.innerHeight; const scrollStep = Math.max(500, viewportHeight);
      const scrollAndLoad = () => {
        currentScroll += scrollStep; windowObj.scrollTo(0, currentScroll); this.scheduleRefresh();
        if (currentScroll < documentHeight - viewportHeight) { setTimeout(scrollAndLoad, 10); }
        else { setTimeout(() => { windowObj.scrollTo(0, originalScrollTop); this.refresh(); this.finishLoadAll(buttonElement); }, 100); }
      };
      scrollAndLoad();
    },
    finishLoadAll(buttonElement) {
      if (buttonElement) {
        buttonElement.textContent = '🔥全読込'; buttonElement.style.opacity = '0.8'; buttonElement.dataset.loading = '0';
      }
      Utils.showMessage(`${state.images.length}枚の画像を検出しました`);
    }
  };

  // ========== ビューア ==========
  const Viewer = {
    create() {
      if (elements.container) return;
      elements.container = this.createContainer();
      elements.imageArea = this.createImageArea();
      this.setupControls();
      this.setupEventListeners();
      elements.container.appendChild(elements.imageArea);
      document.body.appendChild(elements.container);
      this.initializeNavigation();
      NiconicoUI.updateVisibility();
    },
    createContainer() {
      const container = document.createElement('div');
      container.style.cssText = `position: fixed; top:0; left:0; width:100vw; height:100vh; background:${Settings.getBgColor()}; z-index:10000; display:none; justify-content:center; align-items:center; flex-direction:column;`;
      return container;
    },
    createImageArea() {
      const imageArea = document.createElement('div');
      const isSinglePage = Settings.getSinglePageMode();
      imageArea.style.cssText = `display:flex; ${isSinglePage ? 'flex-direction:column' : 'flex-direction:row-reverse'}; justify-content:center; align-items:center; max-width:calc(100vw - 10px); max-height:calc(100vh - 10px); gap:2px; padding:5px; box-sizing:border-box;`;
      return imageArea;
    },
    initializeNavigation() { if (!elements.navigationElement) this.setupNavigation(); },
    setupNavigation() {
      const nav = document.createElement('div');
      nav.setAttribute('data-mv-ui', '1'); nav.setAttribute('data-mv-navigation', '1');
      nav.style.cssText = `position:absolute; bottom:20px; left: 50%; transform: translateX(-50%); color:white; font-size:16px; background:rgba(0,0,0,0.7); padding:10px 20px; border-radius:20px; display:flex; align-items:center; gap:12px; opacity:1; transition:opacity 0.5s; pointer-events:auto;`;
      const isSinglePage = Settings.getSinglePageMode(); const step = isSinglePage ? 1 : 2;
      const btnNextSpread = Utils.createButton(isSinglePage ? '←次' : '←次', {}, () => this.nextPage(step));
      const btnNextSingle = Utils.createButton('←単', {}, () => this.nextPage(1));
      const btnPrevSingle = Utils.createButton('単→', {}, () => this.prevPage(1));
      const btnPrevSpread = Utils.createButton(isSinglePage ? '戻→' : '戻→', {}, () => this.prevPage(step));
      const progress = document.createElement('progress');
      progress.setAttribute('data-mv-ui', '1'); progress.max = 100; progress.value = 0;
      progress.style.cssText = `width:160px; height:8px; appearance:none; -webkit-appearance:none; direction: rtl;`;
      nav.append(btnNextSpread, btnNextSingle, progress, btnPrevSingle, btnPrevSpread);
      elements.container.appendChild(nav);
      elements.navigationElement = nav;
      const scheduleNavFade = () => { clearTimeout(timers.navigation); timers.navigation = setTimeout(() => nav.style.opacity = '0', 3000); };
      nav.addEventListener('mouseenter', () => { nav.style.opacity = '1'; clearTimeout(timers.navigation); });
      nav.addEventListener('mouseleave', scheduleNavFade);
      scheduleNavFade();
    },
    updateNavigation() {
      if (elements.navigationElement) { elements.navigationElement.remove(); elements.navigationElement = null; }
      this.setupNavigation();
    },
    setupControls() {
      const closeBtn = Utils.createButton('×', { position: 'absolute', top: '20px', right: '20px', background: 'rgba(0,0,0,0.5)', fontSize: '24px', width: '40px', height: '40px', borderRadius: '50%' }, () => { elements.container.style.display = 'none'; NiconicoUI.removeThresholdControl(); });
      closeBtn.setAttribute('data-mv-ui', '1'); closeBtn.setAttribute('data-mv-control', '1'); elements.container.appendChild(closeBtn);
      const loadAllBtn = Utils.createButton('🔥全読込', { position: 'absolute', top: '70px', right: '20px', background: 'rgba(0,0,0,0.5)', fontSize: '12px', padding: '6px 8px', borderRadius: '4px', opacity: '0.8' }, () => ImageManager.loadAll(loadAllBtn));
      loadAllBtn.setAttribute('data-mv-ui', '1'); loadAllBtn.setAttribute('data-mv-control', '1'); elements.container.appendChild(loadAllBtn);
      elements.fullscreenBtn = Utils.createButton('⛶', { position: 'absolute', bottom: '80px', right: '20px', background: 'rgba(0,0,0,0.5)', fontSize: '14px', padding: '4px 8px', borderRadius: '6px', fontFamily: 'monospace' }, () => this.toggleFullscreen());
      elements.fullscreenBtn.setAttribute('data-mv-ui', '1'); elements.fullscreenBtn.setAttribute('data-mv-control', '1'); elements.container.appendChild(elements.fullscreenBtn);
      const pageCounter = document.createElement('div');
      pageCounter.id = 'mv-page-counter'; pageCounter.setAttribute('data-mv-ui', '1'); pageCounter.setAttribute('data-mv-control', '1');
      pageCounter.style.cssText = `position:absolute; bottom:40px; right:20px; background:rgba(0,0,0,0.5); color:white; font-size:14px; padding:4px 8px; border-radius:6px; font-family:monospace; pointer-events:none;`;
      elements.container.appendChild(pageCounter);
      elements.singlePageBtn = Utils.createButton(Settings.getSinglePageMode() ? '📄単' : '📖見開き', { position: 'absolute', bottom: '80px', left: '20px', background: 'rgba(0,0,0,0.5)', fontSize: '14px', padding: '4px 8px', borderRadius: '6px', fontFamily: 'monospace' }, () => this.toggleSinglePageMode(elements.singlePageBtn));
      elements.singlePageBtn.setAttribute('data-mv-ui', '1'); elements.singlePageBtn.setAttribute('data-mv-control', '1'); elements.container.appendChild(elements.singlePageBtn);
      elements.bgToggleBtn = Utils.createButton(Settings.getBgColor() === '#F5F5F5' ? '背景：白' : '背景：黒', { position: 'absolute', bottom: '40px', left: '20px', background: 'rgba(0,0,0,0.5)', fontSize: '14px', padding: '4px 8px', borderRadius: '6px', fontFamily: 'monospace' }, () => Settings.toggleBgColor());
      elements.bgToggleBtn.setAttribute('data-mv-ui', '1'); elements.bgToggleBtn.setAttribute('data-mv-control', '1'); elements.container.appendChild(elements.bgToggleBtn);
    },
    setupEventListeners() {
      elements.container.addEventListener('click', e => {
        if (e.target.closest('[data-mv-ui="1"]')) return;
        const rect = elements.container.getBoundingClientRect();
        const isSinglePage = Settings.getSinglePageMode(); const step = isSinglePage ? 1 : 2;
        if ((e.clientX - rect.left) > rect.width / 2) this.prevPage(step); else this.nextPage(step);
      });
      if (CONFIG.enableMouseWheel) {
        elements.container.addEventListener('wheel', e => {
          e.preventDefault();
          const isSinglePage = Settings.getSinglePageMode(); const step = isSinglePage ? 1 : 2;
          if (e.deltaY > 0) this.nextPage(step); else this.prevPage(step);
        }, { passive: false });
      }
    },
    showPage(pageNum) {
      if (!state.images.length) return;
      this.create();
      pageNum = Math.max(0, Math.min(pageNum, state.images.length - 1));
      elements.imageArea.innerHTML = '';
      const isSinglePage = Settings.getSinglePageMode();
      const pagesToShow = isSinglePage ? 1 : 2;
      const maxWidth = isSinglePage ? 'calc(100vw - 10px)' : 'calc(50vw - 10px)';
      for (let i = 0; i < pagesToShow; i++) {
        const idx = pageNum + i;
        if (idx < state.images.length) {
          const wrapper = document.createElement('div'); wrapper.className = 'image-wrapper'; wrapper.style.cssText = 'pointer-events:none;';
          const img = document.createElement('img'); img.src = state.images[idx].src;
          img.style.cssText = `max-height:calc(100vh - 10px); max-width:${maxWidth}; object-fit:contain; display:block;`;
          wrapper.appendChild(img); elements.imageArea.appendChild(wrapper);
        }
      }
      state.currentPage = pageNum;
      this.updatePageInfo();
      elements.container.style.display = 'flex';
      NiconicoUI.updateVisibility();
    },
    updatePageInfo() {
      const pageCounter = document.getElementById('mv-page-counter');
      const progress = elements.container?.querySelector('progress[data-mv-ui]');
      if (!pageCounter || !progress) return;
      const current = state.currentPage + 1; const total = state.images.length;
      pageCounter.textContent = `${String(current).padStart(3, '0')}/${String(total).padStart(3, '0')}`;
      progress.value = Math.floor((current / total) * 100);
    },
    nextPage(step = null) {
      if (step === null) step = Settings.getSinglePageMode() ? 1 : 2;
      const target = state.currentPage + step;
      if (target < state.images.length) this.showPage(target);
    },
    prevPage(step = null) {
      if (step === null) step = Settings.getSinglePageMode() ? 1 : 2;
      const target = state.currentPage - step;
      if (target >= 0) this.showPage(target);
    },
    toggleSinglePageMode(button) {
      const newMode = !Settings.getSinglePageMode();
      state.settings.singlePageMode = newMode; // ローカルの状態を即時更新
      if (button) button.textContent = newMode ? '📄単' : '📖見開き';
      if (elements.imageArea) elements.imageArea.style.flexDirection = newMode ? 'column' : 'row-reverse';
      this.updateNavigation();
      this.showPage(state.currentPage);
    },
    toggleFullscreen() {
      if (!elements.container) return;
      if (!state.isFullscreen) {
        const requestFullscreen = elements.container.requestFullscreen || elements.container.webkitRequestFullscreen || elements.container.mozRequestFullScreen || elements.container.msRequestFullscreen;
        if (requestFullscreen) requestFullscreen.call(elements.container);
      } else {
        const exitFullscreen = document.exitFullscreen || document.webkitExitFullscreen || document.mozCancelFullScreen || document.msExitFullscreen;
        if (exitFullscreen) exitFullscreen.call(document);
      }
    }
  };

  // ========== UI管理 ==========
  const UI = {
    addToggleButton() {
      if (elements.toggleButton) return;
      elements.toggleButton = document.createElement('button');
      elements.toggleButton.textContent = '📖';
      elements.toggleButton.title = '見開き表示';
      this.setupToggleButtonStyles();
      this.setupToggleButtonEvents();
      document.body.appendChild(elements.toggleButton);
      this.preventExternalModifications();
    },
    removeToggleButton() {
        if (elements.toggleButton) {
            elements.toggleButton.remove();
            elements.toggleButton = null;
        }
    },
    setupToggleButtonStyles() {
      const preventAttributes = ['data-pageexpand-ignore', 'data-no-zoom', 'data-skip-pageexpand', 'data-manga-viewer-button'];
      preventAttributes.forEach(attr => elements.toggleButton.setAttribute(attr, 'true'));
      elements.toggleButton.className = 'pageexpand-ignore no-zoom manga-viewer-btn';
      elements.toggleButton.style.cssText = `position:fixed; top:50px; right:40px; z-index:9999; background:rgba(0,0,0,0.6); color:white; border:none; width:32px; height:32px; border-radius:6px; cursor:pointer; font-size:16px; opacity:0.7; transition:opacity 0.2s; text-align: center; line-height: 32px; vertical-align: middle; pointer-events: auto; transform: none !important; zoom: 1 !important; scale: 1 !important;`;
    },
    setupToggleButtonEvents() {
      elements.toggleButton.onmouseenter = () => elements.toggleButton.style.opacity = '1';
      elements.toggleButton.onmouseleave = () => elements.toggleButton.style.opacity = '0.7';
      elements.toggleButton.addEventListener('click', () => {
        ImageManager.refresh();
        if (state.images.length >= CONFIG.minMangaImageCount) {
          Viewer.showPage(0);
        } else {
          Utils.showMessage('画像が見つかりませんでした。拡張機能アイコンから検出モードを変更してください。', 'rgba(200,0,0,0.8)');
        }
      });
      ['mouseenter', 'mouseleave'].forEach(eventType => {
        elements.toggleButton.addEventListener(eventType, (e) => { e.stopImmediatePropagation(); this.resetToggleButtonStyle(); });
      });
    },
    resetToggleButtonStyle() {
      if (!elements.toggleButton) return;
      Object.assign(elements.toggleButton.style, { transform: 'none', zoom: '1', scale: '1' });
    },
    preventExternalModifications() {
      const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
          if (mutation.target === elements.toggleButton && mutation.type === 'attributes' && mutation.attributeName === 'style') {
            this.resetToggleButtonStyle();
          }
        });
      });
      observer.observe(elements.toggleButton, { attributes: true, attributeFilter: ['style', 'class'] });
    },
  };

  // ========== キーボード操作 (変更なし) ==========
  const KeyboardControls = {
    setup() {
      if (!CONFIG.enableKeyControls) return;
      document.addEventListener('keydown', (e) => {
        if (!elements.container || elements.container.style.display !== 'flex') return;
        const isSinglePage = Settings.getSinglePageMode(); const step = isSinglePage ? 1 : 2;
        const keyActions = {
          'ArrowLeft': () => Viewer.nextPage(step), ' ': () => Viewer.nextPage(step),
          'ArrowRight': () => Viewer.prevPage(step), 'ArrowDown': () => Viewer.nextPage(1),
          'ArrowUp': () => Viewer.prevPage(1),
          'Escape': () => { elements.container.style.display = 'none'; NiconicoUI.removeThresholdControl(); }
        };
        const action = keyActions[e.key];
        if (action) { e.preventDefault(); action(); }
      });
    }
  };

  // ========== 全画面管理 (変更なし) ==========
  const FullscreenManager = {
    setup() {
      const fullscreenEvents = ['fullscreenchange', 'webkitfullscreenchange', 'mozfullscreenchange', 'MSFullscreenChange'];
      fullscreenEvents.forEach(event => {
        document.addEventListener(event, () => {
          state.isFullscreen = !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement);
        });
      });
    }
  };

  // ========== メッセージリスナー (拡張機能の中核) ==========
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // 非同期応答のために true を返す
    let isAsync = false;

    switch (request.action) {
        case 'ping':
            sendResponse({ status: 'pong' });
            break;

        case 'launchViewer':
            ImageManager.refresh();
            if (state.images.length >= CONFIG.minMangaImageCount) {
                if (state.detectedMode && Settings.getDetectionMode() === 'auto') {
                    // 自動検出結果を保存
                    const key = `mangaDetectionMode_${window.location.hostname}`;
                    chrome.storage.sync.set({ [key]: state.detectedMode });
                    state.settings.detectionMode = state.detectedMode;
                }
                Viewer.showPage(0);
                sendResponse({ success: true });
            } else {
                sendResponse({ success: false, reason: 'insufficient_images' });
            }
            break;

        case 'testDetection':
            const results = {};
            const detectionMethods = {
                'auto': () => ImageDetector.detectWithAutoFallback(),
                'smart': () => ImageDetector.detectFromResources(),
                'deep-scan': () => ImageDetector.detectFromTextScan(),
                'basic': () => ImageDetector.detectFromDocument(),
                'frame-reader': () => ImageDetector.detectFromIframe(),
                'reading-content': () => ImageDetector.detectBySelector('reading-content'),
                'chapter-content': () => ImageDetector.detectBySelector('chapter-content'),
                'manga-reader': () => ImageDetector.detectBySelector('manga-reader'),
                'entry-content': () => ImageDetector.detectBySelector('entry-content'),
                'niconico-seiga': () => NiconicoExtractor.extractFromCanvas()
            };

            for (const [method, func] of Object.entries(detectionMethods)) {
                results[method] = func().length;
            }
            
            sendResponse({ success: true, results: results });
            break;

        case 'updateSiteMode':
            state.settings.siteMode = request.mode;
            Settings.updateUI();
            break;

        case 'updateDetectionMode':
            state.settings.detectionMode = request.mode;
            break;
            
        case 'updateDisplayMode':
            state.settings.singlePageMode = request.isSingle;
            // ビューアが表示されている場合は更新
            if (elements.container && elements.container.style.display === 'flex') {
                Viewer.toggleSinglePageMode(elements.singlePageBtn);
            }
            break;
    }

    return isAsync; // 非同期処理がない場合は省略可能
  });


  // ========== 初期化 ==========
  async function initialize() {
    console.log('Manga Viewer initializing...');
    
    await Settings.load(); // 最初に設定を読み込む
    
    Settings.updateUI(); // 設定に基づいてUIを更新
    AutoDetection.setup();
    FullscreenManager.setup();
    KeyboardControls.setup();
    
    // IntersectionObserver設定
    const detectionMode = Settings.getDetectionMode();
    if ((detectionMode === 'auto' || detectionMode === 'basic') && 'IntersectionObserver' in window) {
      observers.intersection = new IntersectionObserver(entries => {
        if (entries.some(e => e.isIntersecting)) {
          ImageManager.scheduleRefresh();
        }
      }, { root: null, rootMargin: '200px 0px', threshold: 0.01 });
    }
    
    ImageManager.refresh();

    window.addEventListener('beforeunload', () => {
      AutoDetection.stop();
      NiconicoUI.removeThresholdControl();
    });
    
    console.log('Manga Viewer initialized');
  }

  // 起動
  initialize();
})();