// content.js - Manga Viewer Extension v3.4.1 (Complete & Fixed)

(async function () {
  'use strict';

  if (!document.body) return;

  const CONFIG = {
    minImageHeight: 400, minImageWidth: 200, enableKeyControls: true, enableMouseWheel: true,
    minMangaImageCount: 2, defaultBg: '#333333', refreshDebounceMs: 250,
    autoDetectionInterval: 3000, scrollDetectionThrottle: 500,
    niconico: { defaultThreshold: 0.65, minPixelCount: 200000, transparentAlpha: 10 }
  };

  const DETECTION_MODES = {
    'auto': { name: '自動検出' }, 'smart': { name: 'スマート検出' }, 'deep-scan': { name: 'ディープスキャン' },
    'basic': { name: '基本型' }, 'frame-reader': { name: 'フレーム型' }, 'niconico-seiga': { name: 'Canvasモード' },
    'reading-content': { name: 'エリア型', selector: '.reading-content img', dataSrcSupport: true },
    'chapter-content': { name: 'チャプター型', selector: '.chapter-content img', dataSrcSupport: true },
    'manga-reader': { name: 'リーダー型', selector: '.manga-reader img', dataSrcSupport: false },
    'entry-content': { name: 'エントリー型', selector: '.entry-content img', dataSrcSupport: true }
  };

  const state = {
    currentPage: 0, images: [], isFullscreen: false, lastImageCount: 0, detectedMode: null, isEnabled: false,
    settings: { siteMode: 'hide', detectionMode: 'auto', singlePageMode: false, bgColor: CONFIG.defaultBg, niconicoThreshold: CONFIG.niconico.defaultThreshold },
    niconico: { threshold: CONFIG.niconico.defaultThreshold }
  };

  const elements = { container: null, imageArea: null, bgToggleBtn: null, fullscreenBtn: null, toggleButton: null, niconicoThresholdUI: null, singlePageBtn: null, navigationElement: null, downloadPanel: null, downloadBtn: null };
  const observers = { intersection: null, mutation: null };
  const timers = { refresh: null, navigation: null, scroll: null, polling: null };
  const watched = new WeakSet();

  const Utils = {
    debounce(func, delay) { let t; return function(...args) { clearTimeout(t); t = setTimeout(() => func.apply(this, args), delay); }; },
    throttle(func, delay) { let last = 0; return function(...args) { const now = Date.now(); if (now - last >= delay) { last = now; return func.apply(this, args); } }; },
    createButton(text, styles = {}, handler = null) {
      const btn = document.createElement('button');
      btn.textContent = text; btn.type = 'button';
      Object.assign(btn.style, { background: 'rgba(255,255,255,0.2)', color: 'white', border: 'none', padding: '6px 10px', borderRadius: '4px', cursor: 'pointer' }, styles);
      if (handler) btn.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); handler(); });
      return btn;
    },
    showMessage(text, color = 'rgba(0,150,0,0.8)', duration = 2500) {
      const msg = document.createElement('div');
      msg.textContent = text;
      msg.style.cssText = `position:fixed;top:20px;left:50%;transform:translateX(-50%);z-index:10001;background:${color};color:white;padding:8px 12px;border-radius:4px;font-size:12px;pointer-events:none;`;
      document.body.appendChild(msg);
      setTimeout(() => msg.remove(), duration);
    }
  };

  const Settings = {
    async load() {
      try {
        const hostname = window.location.hostname;
        const result = await chrome.storage.sync.get(['mangaViewerDomains', `mangaDetectionMode_${hostname}`, `mangaViewerSinglePage_${hostname}`, 'mangaViewerBg', 'mangaViewerNiconicoThreshold']);
        const siteSettings = result.mangaViewerDomains || {};
        state.settings.siteMode = siteSettings[hostname] || 'hide';
        state.settings.detectionMode = result[`mangaDetectionMode_${hostname}`] || 'auto';
        state.settings.singlePageMode = result[`mangaViewerSinglePage_${hostname}`] === 'true';
        state.settings.bgColor = result.mangaViewerBg || CONFIG.defaultBg;
        state.settings.niconicoThreshold = parseFloat(result.mangaViewerNiconicoThreshold || CONFIG.niconico.defaultThreshold);
        state.niconico.threshold = state.settings.niconicoThreshold;
        state.isEnabled = (state.settings.siteMode === 'show');
      } catch (error) {
        state.isEnabled = false;
      }
    },
    getDetectionMode() { return state.settings.detectionMode; },
    getSinglePageMode() { return state.settings.singlePageMode; },
    getBgColor() { return state.settings.bgColor; },
    async toggleBgColor() {
      const newColor = this.getBgColor() === '#333333' ? '#F5F5F5' : '#333333';
      await chrome.storage.sync.set({ 'mangaViewerBg': newColor });
      state.settings.bgColor = newColor;
      if (elements.container) elements.container.style.background = newColor;
      if (elements.bgToggleBtn) elements.bgToggleBtn.textContent = (newColor === '#F5F5F5') ? '背景:白' : '背景:黒';
    },
    async setNiconicoThreshold(threshold) {
      await chrome.storage.sync.set({ 'mangaViewerNiconicoThreshold': threshold.toString() });
      state.settings.niconicoThreshold = threshold;
      state.niconico.threshold = threshold;
    },
    updateUI() {
      if (state.isEnabled && state.settings.siteMode === 'show') UI.addToggleButton();
      else UI.removeToggleButton();
    }
  };

  const NiconicoExtractor = {
    extractFromCanvas() {
      if (!state.isEnabled) return [];
      const canvases = document.querySelectorAll('canvas');
      if (!canvases.length) return [];
      const images = [], threshold = 1 - state.niconico.threshold;
      canvases.forEach((canvas, i) => {
        try {
          const ctx = canvas.getContext('2d'), { width, height } = canvas;
          if (width * height < CONFIG.niconico.minPixelCount) return;
          const imgData = ctx.getImageData(0, 0, width, height).data;
          let transparentPixels = 0;
          for (let j = 3; j < imgData.length; j += 4) {
            if (imgData[j] < CONFIG.niconico.transparentAlpha) transparentPixels++;
          }
          const transparencyRatio = transparentPixels / (width * height);
          if (transparencyRatio < threshold) {
            const img = new Image();
            img.src = canvas.toDataURL('image/png');
            img.dataset.canvasIndex = String(i);
            img.dataset.isNiconicoCanvas = 'true';
            images.push(img);
          }
        } catch (e) { }
      });
      return images;
    },
    loadAllPages(callback) {
      let lastHeight = 0, attempts = 0;
      const scrollInterval = setInterval(() => {
        window.scrollTo(0, document.body.scrollHeight);
        attempts++;
        if (document.body.scrollHeight === lastHeight || attempts >= 50) {
          clearInterval(scrollInterval);
          setTimeout(() => callback(), 1000);
        }
        lastHeight = document.body.scrollHeight;
      }, 800);
    }
  };

  const NiconicoUI = {
    createThresholdControl() {
      if (elements.niconicoThresholdUI) return elements.niconicoThresholdUI;
      const panel = document.createElement('div');
      panel.style.cssText = `position:absolute;top:120px;right:20px;background:rgba(0,0,0,0.8);color:white;padding:12px;border-radius:8px;z-index:1;font-size:13px;min-width:200px;`;
      panel.setAttribute('data-mv-ui', '1');
      const label = document.createElement('div');
      label.textContent = `OCR閾値: ${(state.niconico.threshold * 100).toFixed(0)}%`;
      const slider = document.createElement('input');
      slider.type = 'range'; slider.min = '0.1'; slider.max = '0.9'; slider.step = '0.05';
      slider.value = state.niconico.threshold;
      slider.style.cssText = `width:100%;margin:4px 0;`;
      slider.oninput = () => {
        const value = parseFloat(slider.value);
        state.niconico.threshold = value;
        Settings.setNiconicoThreshold(value);
        label.textContent = `OCR閾値: ${(value * 100).toFixed(0)}%`;
      };
      panel.append(label, slider);
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
      const mode = Settings.getDetectionMode();
      if (mode === 'niconico-seiga' && elements.container?.style.display === 'flex') {
        if (!elements.niconicoThresholdUI) elements.container.appendChild(this.createThresholdControl());
      } else this.removeThresholdControl();
    }
  };

  const ImageDetector = {
    detect() {
      if (!state.isEnabled) return [];
      const mode = Settings.getDetectionMode();
      return mode === 'auto' ? this.detectWithAutoFallback() : this.detectByMode(mode);
    },
    detectByMode(mode) {
      const detectors = {
        'basic': () => this.detectFromDocument(), 'smart': () => this.detectFromResources(), 'deep-scan': () => this.detectFromTextScan(),
        'frame-reader': () => this.detectFromIframe(), 'niconico-seiga': () => NiconicoExtractor.extractFromCanvas(),
        'reading-content': () => this.detectBySelector(mode), 'chapter-content': () => this.detectBySelector(mode),
        'manga-reader': () => this.detectBySelector(mode), 'entry-content': () => this.detectBySelector(mode)
      };
      return (detectors[mode] || detectors.basic)();
    },
    detectWithAutoFallback() {
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
          state.detectedMode = strategy.name;
          return images;
        }
      }
      return [];
    },
    detectFromDocument() {
      const allImages = document.querySelectorAll('img');
      const excludePatterns = ['icon', 'logo', 'avatar', 'banner', 'header', 'footer', 'thumb', 'profile', 'menu', 'button', 'bg', 'nav', 'sidebar', 'ad', 'favicon'];
      const potential = Array.from(allImages).filter(img => {
        this.normalizeImageSrc(img);
        if (img.dataset.isResourceDetected || img.dataset.isTextScanned || img.dataset.isNiconicoCanvas) return true;
        if (!img.src) return false;
        if (!this.isImageLoaded(img)) return this.isImageUrl(img.src);
        if (!this.isValidImageSize(img)) return false;
        return !this.matchesExcludePatterns(img.src, excludePatterns);
      });
      return this.filterAndSortImages(potential);
    },
    detectFromResources() {
      const resources = performance.getEntriesByType("resource");
      const imageUrls = resources.map(r => r.name).filter(url => this.isImageUrl(url) && !this.matchesExcludePatterns(url.toLowerCase(), ['icon', 'logo', 'avatar', 'thumb', 'profile']));
      return imageUrls.map((url, i) => {
        const img = new Image(); img.src = url; img.dataset.resourceIndex = String(i); img.dataset.isResourceDetected = 'true'; return img;
      });
    },
    detectFromTextScan() {
      const htmlText = document.documentElement.outerHTML;
      const pattern = /https?:\/\/[^\s"'<>]+\.(?:jpe?g|png|webp|gif)(?:\?[^\s"'<>]*)?/gi;
      const foundUrls = new Set();
      let match;
      while ((match = pattern.exec(htmlText)) !== null) {
        if (match[0]) foundUrls.add(match[0]);
      }
      const filtered = Array.from(foundUrls).filter(url => !this.matchesExcludePatterns(url.toLowerCase(), ['icon', 'logo', 'avatar', 'thumb']));
      return filtered.map((url, i) => {
        const img = new Image(); img.src = url; img.dataset.textScanIndex = String(i); img.dataset.isTextScanned = 'true'; return img;
      });
    },
    detectBySelector(configName) {
      const config = DETECTION_MODES[configName];
      if (!config?.selector) return [];
      const images = Array.from(document.querySelectorAll(config.selector));
      if (config.dataSrcSupport) images.forEach(img => { if (!img.src && img.dataset.src) img.src = img.dataset.src; });
      return images.filter(img => {
        if (img.dataset.isResourceDetected || img.dataset.isTextScanned) return true;
        if (!img.src) return false;
        return this.isImageLoaded(img) ? this.isValidImageSize(img) : this.isImageUrl(img.src);
      });
    },
    detectFromIframe() {
      const iframe = document.querySelector("iframe");
      if (!iframe) return [];
      try {
        const doc = iframe.contentDocument || iframe.contentWindow.document;
        if (!doc) return [];
        const potential = Array.from(doc.querySelectorAll('img')).filter(img => img.complete && img.naturalHeight > 0 && img.naturalWidth >= 500);
        potential.forEach(img => {
          if (!img.src.startsWith('http')) {
            try {
              const fullSrc = new URL(img.src, new URL(iframe.src).origin).href;
              Object.defineProperty(img, 'src', { value: fullSrc, writable: false });
            } catch (e) { }
          }
        });
        return this.sortImagesByPosition(potential);
      } catch (e) { return []; }
    },
    normalizeImageSrc(img) {
      const candidate = img.dataset.src || img.dataset.original || img.dataset.lazySrc;
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
    matchesExcludePatterns(src, patterns) { const lower = src.toLowerCase(); return patterns.some(p => lower.includes(p)); },
    filterAndSortImages(images) {
      if (images.length < CONFIG.minMangaImageCount) return [];
      const seen = new Set();
      const filtered = images.filter(img => { if (seen.has(img.src)) return false; seen.add(img.src); return true; });
      return this.sortImagesByPosition(filtered);
    },
    sortImagesByPosition(images) {
      return images.sort((a, b) => {
        if (a.dataset.canvasIndex && b.dataset.canvasIndex) return parseInt(a.dataset.canvasIndex) - parseInt(b.dataset.canvasIndex);
        if (a.dataset.resourceIndex && b.dataset.resourceIndex) return parseInt(a.dataset.resourceIndex) - parseInt(b.dataset.resourceIndex);
        if (a.dataset.textScanIndex && b.dataset.textScanIndex) return parseInt(a.dataset.textScanIndex) - parseInt(b.dataset.textScanIndex);
        return a.getBoundingClientRect().top - b.getBoundingClientRect().top;
      });
    }
  };

  const AutoDetection = {
    setup() {
      if (!state.isEnabled) return;
      this.setupMutationObserver(); this.setupScrollListener(); this.setupPolling();
    },
    setupMutationObserver() {
      if (!state.isEnabled) return;
      observers.mutation = new MutationObserver((mutations) => {
        let shouldRefresh = false;
        mutations.forEach(mutation => {
          mutation.addedNodes.forEach(node => {
            if (node.nodeType === Node.ELEMENT_NODE && (node.tagName === 'IMG' || node.tagName === 'CANVAS' || node.querySelectorAll('img, canvas').length > 0)) shouldRefresh = true;
          });
        });
        if (shouldRefresh) ImageManager.scheduleRefresh();
      });
      observers.mutation.observe(document.body, { childList: true, subtree: true });
    },
    setupScrollListener() {
      if (!state.isEnabled) return;
      const handleScroll = Utils.throttle(() => ImageManager.scheduleRefresh(), CONFIG.scrollDetectionThrottle);
      window.addEventListener('scroll', handleScroll, { passive: true });
    },
    setupPolling() {
      if (!state.isEnabled) return;
      timers.polling = setInterval(() => {
        const count = document.querySelectorAll('img, canvas').length;
        if (count !== state.lastImageCount) { state.lastImageCount = count; ImageManager.scheduleRefresh(); }
      }, CONFIG.autoDetectionInterval);
    },
    stop() {
      if (observers.mutation) observers.mutation.disconnect();
      Object.values(timers).forEach(timer => { if (timer) clearTimeout(timer); });
    }
  };

  const ImageManager = {
    scheduleRefresh() {
      if (!state.isEnabled) return;
      if (timers.refresh) clearTimeout(timers.refresh);
      timers.refresh = setTimeout(() => this.refresh(), CONFIG.refreshDebounceMs);
    },
    refresh() {
      if (!state.isEnabled) return;
      const newImages = ImageDetector.detect();
      if (newImages.length !== state.images.length || newImages.some((img, i) => state.images[i] !== img)) {
        state.images = newImages;
        if (elements.container?.style.display === 'flex') Viewer.updatePageInfo();
      }
      const mode = Settings.getDetectionMode();
      if (mode === 'auto' || mode === 'basic') newImages.forEach(img => this.attachWatchers(img));
    },
    attachWatchers(img) {
      if (watched.has(img)) return; watched.add(img);
      img.addEventListener('load', () => this.scheduleRefresh(), { once: true });
      if (observers.intersection && !img.complete) observers.intersection.observe(img);
    },
    loadAll(btn) {
      if (btn?.dataset.loading === '1') return;
      if (btn) { btn.dataset.loading = '1'; btn.textContent = '読込中...'; btn.style.opacity = '0.5'; }
      const mode = Settings.getDetectionMode();
      if (mode === 'niconico-seiga') this.loadAllFromNiconico(btn);
      else if (mode === 'frame-reader') this.loadAllFromIframe(btn);
      else this.loadAllFromDocument(btn);
    },
    loadAllFromNiconico(btn) { NiconicoExtractor.loadAllPages(() => { this.refresh(); this.finishLoadAll(btn); }); },
    loadAllFromDocument(btn) { this.performScrollLoad(window, document.documentElement, window.pageYOffset, btn); },
    loadAllFromIframe(btn) {
      const iframe = document.querySelector("iframe");
      if (!iframe) return;
      try {
        const win = iframe.contentWindow, doc = iframe.contentDocument || win.document;
        this.performScrollLoad(win, doc.documentElement, win.pageYOffset || doc.documentElement.scrollTop, btn);
      } catch (e) { this.finishLoadAll(btn); }
    },
    performScrollLoad(win, doc, originalScroll, btn) {
      let scroll = 0;
      const height = Math.max(doc.scrollHeight, doc.offsetHeight, doc.clientHeight);
      const step = Math.max(500, win.innerHeight);
      const scrollAndLoad = () => {
        scroll += step; win.scrollTo(0, scroll); this.scheduleRefresh();
        if (scroll < height - win.innerHeight) setTimeout(scrollAndLoad, 10);
        else setTimeout(() => { win.scrollTo(0, originalScroll); this.refresh(); this.finishLoadAll(btn); }, 100);
      };
      scrollAndLoad();
    },
    finishLoadAll(btn) {
      if (btn) { btn.textContent = '全読込'; btn.style.opacity = '0.8'; btn.dataset.loading = '0'; }
      Utils.showMessage(`${state.images.length}枚の画像を検出しました`);
    }
  };

  const DownloadManager = {
    async getLastFolderName() {
      const result = await chrome.storage.sync.get('mangaViewerLastFolder');
      return result.mangaViewerLastFolder || '';
    },
    async saveLastFolderName(folderName) {
      await chrome.storage.sync.set({ 'mangaViewerLastFolder': folderName });
    },
    suggestNextFolderName(lastFolder) {
      if (!lastFolder) {
        return this.getFolderNameFromURL();
      }
      const match = lastFolder.match(/^(.+?)(\d+)$/);
      if (match) {
        const base = match[1];
        const num = parseInt(match[2]);
        const nextNum = num + 1;
        const padding = match[2].length;
        return base + String(nextNum).padStart(padding, '0');
      }
      return lastFolder + '1';
    },
    getFolderNameFromURL() {
      const path = window.location.pathname;
      const segments = path.split('/').filter(s => s);
      if (segments.length > 0) {
        const lastSegment = segments[segments.length - 1];
        // URLデコードして日本語を保持
        const decoded = decodeURIComponent(lastSegment);
        // 拡張子を削除し、ファイルシステムで使えない文字のみ置換
        return decoded.replace(/\.[^/.]+$/, '').replace(/[\\/:*?"<>|]/g, '_');
      }
      return 'manga-download';
    },
    async downloadAsZip(folderName, startPage, endPage, useOriginalNames) {
      // ZIP機能は現在サポートされていません
      throw new Error('ZIP形式は現在サポートされていません。連番画像を使用してください。');
    },
    async downloadIndividual(folderName, startPage, endPage, useOriginalNames) {
      const start = Math.min(startPage, endPage);
      const end = Math.max(startPage, endPage);
      
      for (let i = start; i <= end; i++) {
        const idx = i - 1;
        if (idx >= 0 && idx < state.images.length) {
          const img = state.images[idx];
          try {
            let filename;
            if (useOriginalNames) {
              filename = this.getOriginalFilename(img.src, i);
            } else {
              const ext = this.getExtension(img.src);
              filename = `${folderName}_${String(i).padStart(3, '0')}.${ext}`;
            }
            
            await chrome.runtime.sendMessage({
              action: 'downloadImage',
              url: img.src,
              filename: `manga-viewer/${folderName}/${filename}`,
              conflictAction: 'overwrite'
            });
            
            await new Promise(resolve => setTimeout(resolve, 50));
          } catch (e) {
            console.error(`Failed to download image ${i}:`, e);
          }
        }
      }
      
      await this.saveLastFolderName(folderName);
    },
    getOriginalFilename(src, pageNum) {
      const url = new URL(src, window.location.href);
      const pathname = url.pathname;
      const filename = pathname.split('/').pop();
      if (filename && filename.includes('.')) {
        return filename;
      }
      return `page_${String(pageNum).padStart(3, '0')}.jpg`;
    },
    getExtension(src) {
      if (src.startsWith('data:image/png')) return 'png';
      if (src.startsWith('data:image/jpeg')) return 'jpg';
      if (src.startsWith('data:image/webp')) return 'webp';
      const url = new URL(src, window.location.href);
      const pathname = url.pathname;
      const match = pathname.match(/\.([^.]+)$/);
      if (match) return match[1].toLowerCase();
      return 'jpg';
    }
  };

  const DownloadUI = {
    async createDownloadPanel() {
      if (elements.downloadPanel) return;
      
      const panel = document.createElement('div');
      panel.style.cssText = `position:absolute;bottom:140px;left:20px;background:rgba(0,0,0,0.9);color:white;padding:15px;border-radius:8px;z-index:2;font-size:13px;min-width:280px;display:none;`;
      panel.setAttribute('data-mv-ui', '1');
      
      const lastFolder = await DownloadManager.getLastFolderName();
      const suggestedFolder = DownloadManager.suggestNextFolderName(lastFolder);
      
      panel.innerHTML = `
        <div style="position:relative;">
          <div style="font-weight:bold;margin-bottom:10px;color:#4FC3F7;">画像をダウンロード</div>
          <button id="mv-download-close" style="position:absolute;top:-5px;right:-5px;background:rgba(255,255,255,0.2);color:white;border:none;width:24px;height:24px;border-radius:50%;cursor:pointer;font-size:16px;line-height:24px;padding:0;">×</button>
        </div>
        
        <div style="margin-bottom:10px;">
          <label style="display:block;margin-bottom:4px;font-size:12px;">フォルダ名（ダウンロードフォルダ内に新規作成）:</label>
          <input type="text" id="mv-folder-name" value="${suggestedFolder}" placeholder="空欄の場合はURL末尾を使用" style="width:100%;padding:6px;border:1px solid #555;border-radius:4px;background:#2a2a2a;color:white;font-size:12px;">
          ${lastFolder ? `<div style="font-size:11px;color:#888;margin-top:4px;">💡 前回: ${lastFolder}</div>` : ''}
        </div>
        
        <div style="margin-bottom:10px;">
          <label style="display:block;margin-bottom:6px;font-size:12px;">画像リネーム:</label>
          <label style="display:block;margin-bottom:4px;font-size:11px;cursor:pointer;">
            <input type="radio" name="mv-filename-type" value="original" style="margin-right:6px;cursor:pointer;">
            元ファイル名
          </label>
          <label style="display:block;font-size:11px;cursor:pointer;">
            <input type="radio" name="mv-filename-type" value="numbered" checked style="margin-right:6px;cursor:pointer;">
            フォルダ名_3桁連番
          </label>
        </div>
        
        <div style="margin-bottom:10px;">
          <label style="display:block;margin-bottom:6px;font-size:12px;">保存ページ範囲:</label>
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
            <span style="font-size:11px;width:32px;">開始</span>
            <input type="number" id="mv-start-page" min="1" max="${state.images.length}" value="1" style="width:50px;padding:4px;border:1px solid #555;border-radius:4px;background:#2a2a2a;color:white;text-align:center;font-size:12px;">
            <input type="range" id="mv-range-slider-start" min="1" max="${state.images.length}" value="1" style="flex:1;direction:rtl;height:8px;">
          </div>
          <div style="display:flex;align-items:center;gap:8px;">
            <span style="font-size:11px;width:32px;">終了</span>
            <input type="number" id="mv-end-page" min="1" max="${state.images.length}" value="${state.images.length}" style="width:50px;padding:4px;border:1px solid #555;border-radius:4px;background:#2a2a2a;color:white;text-align:center;font-size:12px;">
            <input type="range" id="mv-range-slider-end" min="1" max="${state.images.length}" value="${state.images.length}" style="flex:1;direction:rtl;height:8px;">
          </div>
        </div>
        
        <div style="margin-bottom:12px;">
          <label style="display:block;margin-bottom:6px;font-size:12px;">保存形式:</label>
          <label style="display:inline-block;margin-right:15px;font-size:11px;cursor:pointer;">
            <input type="radio" name="mv-download-type" value="individual" checked style="margin-right:6px;cursor:pointer;">
            連番画像
          </label>
          <label style="display:inline-block;font-size:11px;color:#666;cursor:not-allowed;" title="現在サポートされていません">
            <input type="radio" name="mv-download-type" value="zip" disabled style="margin-right:6px;">
            ZIP形式（準備中）
          </label>
        </div>
        
        <button id="mv-download-execute" style="width:100%;padding:8px;background:#4FC3F7;color:#000;border:none;border-radius:4px;font-weight:bold;cursor:pointer;font-size:13px;">
          ダウンロード
        </button>
        
        <style>
          input[type="range"]#mv-range-slider-start::-webkit-slider-thumb,
          input[type="range"]#mv-range-slider-end::-webkit-slider-thumb {
            appearance: none;
            width: 12px;
            height: 12px;
            border-radius: 50%;
            background: #4FC3F7;
            cursor: pointer;
          }
          input[type="range"]#mv-range-slider-start::-webkit-slider-runnable-track,
          input[type="range"]#mv-range-slider-end::-webkit-slider-runnable-track {
            width: 100%;
            height: 8px;
            background: linear-gradient(to left, #4FC3F7 var(--progress), #555 var(--progress));
            border-radius: 4px;
          }
        </style>
      `;
      
      elements.container.appendChild(panel);
      elements.downloadPanel = panel;
      
      this.setupEventListeners();
    },
    setupEventListeners() {
      const endPageInput = document.getElementById('mv-end-page');
      const endPageSlider = document.getElementById('mv-range-slider-end');
      const startPageInput = document.getElementById('mv-start-page');
      const startPageSlider = document.getElementById('mv-range-slider-start');
      
      // スライダーのプログレス表示を更新
      const updateSliderProgress = (slider, value, max) => {
        const progress = ((max - value + 1) / max) * 100;
        slider.style.setProperty('--progress', `${progress}%`);
      };
      
      endPageInput.addEventListener('input', (e) => {
        endPageSlider.value = e.target.value;
        updateSliderProgress(endPageSlider, e.target.value, state.images.length);
      });
      endPageSlider.addEventListener('input', (e) => {
        endPageInput.value = e.target.value;
        updateSliderProgress(endPageSlider, e.target.value, state.images.length);
        // ビューアをそのページにジャンプ
        const pageNum = parseInt(e.target.value) - 1;
        if (pageNum >= 0 && pageNum < state.images.length) {
          Viewer.showPage(pageNum);
        }
      });
      startPageInput.addEventListener('input', (e) => {
        startPageSlider.value = e.target.value;
        updateSliderProgress(startPageSlider, e.target.value, state.images.length);
      });
      startPageSlider.addEventListener('input', (e) => {
        startPageInput.value = e.target.value;
        updateSliderProgress(startPageSlider, e.target.value, state.images.length);
        // ビューアをそのページにジャンプ
        const pageNum = parseInt(e.target.value) - 1;
        if (pageNum >= 0 && pageNum < state.images.length) {
          Viewer.showPage(pageNum);
        }
      });
      
      // 初期プログレス設定
      updateSliderProgress(startPageSlider, 1, state.images.length);
      updateSliderProgress(endPageSlider, state.images.length, state.images.length);
      
      // 閉じるボタン
      document.getElementById('mv-download-close').addEventListener('click', () => {
        elements.downloadPanel.style.display = 'none';
      });
      
      document.getElementById('mv-download-execute').addEventListener('click', async () => {
        let folderName = document.getElementById('mv-folder-name').value.trim();
        
        // フォルダ名が空の場合、URLから自動取得
        if (!folderName) {
          folderName = DownloadManager.getFolderNameFromURL();
          document.getElementById('mv-folder-name').value = folderName;
        }
        
        const startPage = parseInt(startPageInput.value);
        const endPage = parseInt(endPageInput.value);
        const useOriginalNames = document.querySelector('input[name="mv-filename-type"]:checked').value === 'original';
        const downloadType = document.querySelector('input[name="mv-download-type"]:checked').value;
        
        elements.downloadPanel.style.display = 'none';
        const totalImages = Math.abs(endPage - startPage) + 1;
        Utils.showMessage('ダウンロード開始...', 'rgba(0,150,200,0.8)', 3000);
        
        try {
          if (downloadType === 'zip') {
            await DownloadManager.downloadAsZip(folderName, startPage, endPage, useOriginalNames);
          } else {
            await DownloadManager.downloadIndividual(folderName, startPage, endPage, useOriginalNames);
            Utils.showMessage(`${totalImages}枚のダウンロードを開始しました`);
          }
        } catch (error) {
          console.error('Download failed:', error);
          Utils.showMessage(`エラー: ${error.message || 'ダウンロードに失敗しました'}`, 'rgba(200,0,0,0.8)');
        }
      });
    },
    toggle() {
      if (!elements.downloadPanel) return;
      const isVisible = elements.downloadPanel.style.display === 'block';
      elements.downloadPanel.style.display = isVisible ? 'none' : 'block';
    }
  };

  const Viewer = {
    create() {
      if (elements.container) return;
      elements.container = this.createContainer();
      elements.imageArea = this.createImageArea();
      this.setupControls(); this.setupEventListeners();
      elements.container.appendChild(elements.imageArea);
      document.body.appendChild(elements.container);
      this.initializeNavigation();
      NiconicoUI.updateVisibility();
    },
    createContainer() {
      const container = document.createElement('div');
      container.style.cssText = `position:fixed;top:0;left:0;width:100vw;height:100vh;background:${Settings.getBgColor()};z-index:10000;display:none;justify-content:center;align-items:center;flex-direction:column;`;
      return container;
    },
    createImageArea() {
      const imageArea = document.createElement('div');
      const isSingle = Settings.getSinglePageMode();
      imageArea.style.cssText = `display:flex;${isSingle ? 'flex-direction:column' : 'flex-direction:row-reverse'};justify-content:center;align-items:center;max-width:calc(100vw - 10px);max-height:calc(100vh - 10px);gap:2px;padding:5px;box-sizing:border-box;`;
      return imageArea;
    },
    initializeNavigation() { if (!elements.navigationElement) this.setupNavigation(); },
    setupNavigation() {
      const nav = document.createElement('div');
      nav.setAttribute('data-mv-ui', '1');
      nav.style.cssText = `position:absolute;bottom:20px;left:50%;transform:translateX(-50%);color:white;font-size:16px;background:rgba(0,0,0,0.7);padding:10px 20px;border-radius:20px;display:flex;align-items:center;gap:12px;opacity:1;transition:opacity 0.5s;`;
      const isSingle = Settings.getSinglePageMode(), step = isSingle ? 1 : 2;
      const btnNext = Utils.createButton(isSingle ? '←次' : '←次', {}, () => this.nextPage(step));
      const btnNextSingle = Utils.createButton('←単', {}, () => this.nextPage(1));
      const btnPrevSingle = Utils.createButton('単→', {}, () => this.prevPage(1));
      const btnPrev = Utils.createButton(isSingle ? '戻→' : '戻→', {}, () => this.prevPage(step));
      const progress = document.createElement('progress');
      progress.setAttribute('data-mv-ui', '1'); progress.max = 100; progress.value = 0;
      progress.style.cssText = `width:160px;height:8px;direction:rtl;`;
      nav.append(btnNext, btnNextSingle, progress, btnPrevSingle, btnPrev);
      elements.container.appendChild(nav); elements.navigationElement = nav;
      const scheduleFade = () => { clearTimeout(timers.navigation); timers.navigation = setTimeout(() => nav.style.opacity = '0', 3000); };
      nav.addEventListener('mouseenter', () => { nav.style.opacity = '1'; clearTimeout(timers.navigation); });
      nav.addEventListener('mouseleave', scheduleFade);
      scheduleFade();
    },
    updateNavigation() {
      if (elements.navigationElement) { elements.navigationElement.remove(); elements.navigationElement = null; }
      this.setupNavigation();
    },
    setupControls() {
      const closeBtn = Utils.createButton('×', { position: 'absolute', top: '20px', right: '20px', background: 'rgba(0,0,0,0.5)', fontSize: '24px', width: '40px', height: '40px', borderRadius: '50%' }, () => { elements.container.style.display = 'none'; NiconicoUI.removeThresholdControl(); });
      closeBtn.setAttribute('data-mv-ui', '1'); elements.container.appendChild(closeBtn);
      const loadAllBtn = Utils.createButton('全読込', { position: 'absolute', top: '70px', right: '20px', background: 'rgba(0,0,0,0.5)', fontSize: '12px', padding: '6px 8px', borderRadius: '4px', opacity: '0.8' }, () => ImageManager.loadAll(loadAllBtn));
      loadAllBtn.setAttribute('data-mv-ui', '1'); elements.container.appendChild(loadAllBtn);
      elements.fullscreenBtn = Utils.createButton('⛶', { position: 'absolute', bottom: '80px', right: '20px', background: 'rgba(0,0,0,0.5)', fontSize: '14px', padding: '4px 8px', borderRadius: '6px' }, () => this.toggleFullscreen());
      elements.fullscreenBtn.setAttribute('data-mv-ui', '1'); elements.container.appendChild(elements.fullscreenBtn);
      const pageCounter = document.createElement('div');
      pageCounter.id = 'mv-page-counter'; pageCounter.setAttribute('data-mv-ui', '1');
      pageCounter.style.cssText = `position:absolute;bottom:40px;right:20px;background:rgba(0,0,0,0.5);color:white;font-size:14px;padding:4px 8px;border-radius:6px;pointer-events:none;`;
      elements.container.appendChild(pageCounter);
      elements.singlePageBtn = Utils.createButton(Settings.getSinglePageMode() ? '単' : '見開', { position: 'absolute', bottom: '80px', left: '20px', background: 'rgba(0,0,0,0.5)', fontSize: '14px', padding: '4px 8px', borderRadius: '6px' }, () => this.toggleSinglePageMode(elements.singlePageBtn));
      elements.singlePageBtn.setAttribute('data-mv-ui', '1'); elements.container.appendChild(elements.singlePageBtn);
      elements.bgToggleBtn = Utils.createButton(Settings.getBgColor() === '#F5F5F5' ? '背景:白' : '背景:黒', { position: 'absolute', bottom: '40px', left: '20px', background: 'rgba(0,0,0,0.5)', fontSize: '14px', padding: '4px 8px', borderRadius: '6px' }, () => Settings.toggleBgColor());
      elements.bgToggleBtn.setAttribute('data-mv-ui', '1'); elements.container.appendChild(elements.bgToggleBtn);
      elements.downloadBtn = Utils.createButton('DL', { position: 'absolute', bottom: '120px', left: '20px', background: 'rgba(0,0,0,0.5)', fontSize: '14px', padding: '6px 10px', borderRadius: '6px', title: 'ダウンロード' }, async () => { 
        if (!elements.downloadPanel) await DownloadUI.createDownloadPanel();
        DownloadUI.toggle(); 
      });
      elements.downloadBtn.setAttribute('data-mv-ui', '1'); elements.container.appendChild(elements.downloadBtn);
    },
    setupEventListeners() {
      elements.container.addEventListener('click', e => {
        if (e.target.closest('[data-mv-ui="1"]')) return;
        const rect = elements.container.getBoundingClientRect();
        const isSingle = Settings.getSinglePageMode(), step = isSingle ? 1 : 2;
        if ((e.clientX - rect.left) > rect.width / 2) this.prevPage(step);
        else this.nextPage(step);
      });
      if (CONFIG.enableMouseWheel) {
        elements.container.addEventListener('wheel', e => {
          e.preventDefault();
          const isSingle = Settings.getSinglePageMode(), step = isSingle ? 1 : 2;
          if (e.deltaY > 0) this.nextPage(step);
          else this.prevPage(step);
        }, { passive: false });
      }
    },
    showPage(pageNum) {
      if (!state.images.length) return;
      this.create();
      pageNum = Math.max(0, Math.min(pageNum, state.images.length - 1));
      elements.imageArea.innerHTML = '';
      const isSingle = Settings.getSinglePageMode();
      const pagesToShow = isSingle ? 1 : 2;
      const maxWidth = isSingle ? 'calc(100vw - 10px)' : 'calc(50vw - 10px)';
      for (let i = 0; i < pagesToShow; i++) {
        const idx = pageNum + i;
        if (idx < state.images.length) {
          const wrapper = document.createElement('div');
          wrapper.className = 'image-wrapper';
          wrapper.style.cssText = 'pointer-events:none;';
          const img = document.createElement('img');
          img.src = state.images[idx].src;
          img.style.cssText = `max-height:calc(100vh - 10px);max-width:${maxWidth};object-fit:contain;display:block;`;
          wrapper.appendChild(img);
          elements.imageArea.appendChild(wrapper);
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
      const current = state.currentPage + 1, total = state.images.length;
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
      state.settings.singlePageMode = newMode;
      if (button) button.textContent = newMode ? '単' : '見開';
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
      elements.toggleButton.style.cssText = `position:fixed;top:50px;right:40px;z-index:9999;background:rgba(0,0,0,0.6);color:white;border:none;width:32px;height:32px;border-radius:6px;cursor:pointer;font-size:16px;opacity:0.7;transition:opacity 0.2s;text-align:center;line-height:32px;pointer-events:auto;transform:none !important;zoom:1 !important;`;
    },
    setupToggleButtonEvents() {
      elements.toggleButton.onmouseenter = () => elements.toggleButton.style.opacity = '1';
      elements.toggleButton.onmouseleave = () => elements.toggleButton.style.opacity = '0.7';
      elements.toggleButton.addEventListener('click', () => {
        ImageManager.refresh();
        if (state.images.length >= CONFIG.minMangaImageCount) Viewer.showPage(0);
        else Utils.showMessage('画像が見つかりませんでした。拡張機能アイコンから検出モードを変更してください。', 'rgba(200,0,0,0.8)');
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
    }
  };

  const KeyboardControls = {
    setup() {
      if (!CONFIG.enableKeyControls) return;
      document.addEventListener('keydown', (e) => {
        if (!elements.container || elements.container.style.display !== 'flex') return;
        const isSingle = Settings.getSinglePageMode(), step = isSingle ? 1 : 2;
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

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'downloadImage') {
      chrome.downloads.download({
        url: request.url,
        filename: request.filename,
        saveAs: false
      });
      return false;
    }
    
    switch (request.action) {
      case 'ping':
        sendResponse({ status: 'pong' });
        break;
      case 'launchViewer':
        if (state.images.length === 0) {
          ImageManager.refresh();
          setTimeout(() => {
            if (state.images.length >= CONFIG.minMangaImageCount) {
              if (state.detectedMode && Settings.getDetectionMode() === 'auto') {
                const key = `mangaDetectionMode_${window.location.hostname}`;
                chrome.storage.sync.set({ [key]: state.detectedMode });
                state.settings.detectionMode = state.detectedMode;
              }
              Viewer.showPage(0);
              sendResponse({ success: true });
            } else {
              sendResponse({ success: false, reason: 'insufficient_images' });
            }
          }, 300);
          return true;
        }
        if (state.images.length >= CONFIG.minMangaImageCount) {
          if (state.detectedMode && Settings.getDetectionMode() === 'auto') {
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
        state.isEnabled = (request.mode === 'show');
        Settings.updateUI();
        if (state.isEnabled) {
          AutoDetection.setup();
          ImageManager.refresh();
        } else {
          AutoDetection.stop();
        }
        break;
      case 'updateDetectionMode':
        state.settings.detectionMode = request.mode;
        break;
      case 'updateDisplayMode':
        state.settings.singlePageMode = request.isSingle;
        if (elements.container && elements.container.style.display === 'flex') {
          Viewer.toggleSinglePageMode(elements.singlePageBtn);
        }
        break;
    }
    return false;
  });

  async function initialize() {
    await Settings.load();
    if (!state.isEnabled) {
      console.log('[MangaViewer] Disabled on this site');
      return;
    }
    console.log('[MangaViewer] Initializing...');
    Settings.updateUI();
    AutoDetection.setup();
    FullscreenManager.setup();
    KeyboardControls.setup();
    const detectionMode = Settings.getDetectionMode();
    if ((detectionMode === 'auto' || detectionMode === 'basic') && 'IntersectionObserver' in window) {
      observers.intersection = new IntersectionObserver(entries => {
        if (entries.some(e => e.isIntersecting)) ImageManager.scheduleRefresh();
      }, { root: null, rootMargin: '200px 0px', threshold: 0.01 });
    }
    ImageManager.refresh();
    window.addEventListener('beforeunload', () => {
      AutoDetection.stop();
      NiconicoUI.removeThresholdControl();
    });
    console.log('[MangaViewer] Ready');
  }

  initialize();
})();