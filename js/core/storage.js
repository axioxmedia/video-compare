/*
 * 持久化层：IndexedDB。
 * 保存视频 Blob、抽帧、技术参数、差异分析结果与设置；重开页面自动恢复。
 * 不支持 IndexedDB 的环境（或配额不足）自动降级为内存模式，不阻断使用。
 */
(function (global) {
  'use strict';

  var VC = global.VC || (global.VC = {});
  var DB_NAME = 'video-compare-db';
  var DB_VERSION = 2;
  var SETTINGS_KEY = 'settings';
  var SESSION_ID = 'session';

  var supported = typeof indexedDB !== 'undefined';
  var dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (!supported) { reject(new Error('IndexedDB 不可用')); return; }
      var req;
      try {
        req = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (e) { reject(e); return; }

      req.onupgradeneeded = function (event) {
        var db = event.target.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('videos')) db.createObjectStore('videos', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('frames')) db.createObjectStore('frames', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('analysis')) db.createObjectStore('analysis', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('aimodels')) db.createObjectStore('aimodels', { keyPath: 'key' });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('打开本地数据库失败')); };
      req.onblocked = function () { reject(new Error('本地数据库被其他标签页占用')); };
    });
    return dbPromise;
  }

  function tx(storeName, mode, fn) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(storeName, mode);
        var store = t.objectStore(storeName);
        var request;
        try { request = fn(store); } catch (e) { reject(e); return; }
        t.oncomplete = function () {
          /* get/getAll 需要返回请求结果，而非 IDBRequest 对象本身 */
          if (request && typeof request === 'object' && ('result' in request)) {
            resolve(request.result);
          } else {
            resolve(request);
          }
        };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error); };
      });
    });
  }

  function put(storeName, value) {
    return tx(storeName, 'readwrite', function (store) { store.put(value); });
  }
  function get(storeName, key) {
    return tx(storeName, 'readonly', function (store) { return store.get(key); }).then(function (res) {
      return res || null;
    });
  }
  function clear(storeName) {
    return tx(storeName, 'readwrite', function (store) { store.clear(); });
  }
  function del(storeName, key) {
    return tx(storeName, 'readwrite', function (store) { store.delete(key); });
  }

  /* ---- 设置 ---- */
  function getSettings() {
    return get('kv', SETTINGS_KEY).then(function (row) {
      var saved = row && row.value ? row.value : {};
      var merged = {};
      var key;
      for (key in VC.DEFAULTS) merged[key] = VC.DEFAULTS[key];
      for (key in saved) merged[key] = saved[key];
      return merged;
    }).then(null, function () {
      /* 数据库不可用时回退默认值，并尝试迁移旧 localStorage */
      return Object.assign({}, VC.DEFAULTS, migrateLegacy());
    });
  }

  function saveSettings(settings) {
    return put('kv', { key: SETTINGS_KEY, value: settings });
  }

  /* 兼容旧版本 localStorage 字段 */
  function migrateLegacy() {
    var out = {};
    try {
      var fc = localStorage.getItem('videoCompare_frameCount');
      if (fc) out.sampleCount = parseInt(fc, 10);
    } catch (e) {}
    return out;
  }

  /* ---- 视频 ---- */
  function saveVideo(side, file) {
    return put('videos', {
      id: side,
      blob: file,
      name: file.name,
      size: file.size,
      type: file.type,
      lastModified: file.lastModified,
      savedAt: Date.now()
    });
  }
  function getVideo(side) { return get('videos', side); }

  /* ---- 抽帧 ---- */
  function saveFrames(framesA, framesB) {
    return put('frames', { id: SESSION_ID, framesA: framesA, framesB: framesB, savedAt: Date.now() });
  }
  function getFrames() { return get('frames', SESSION_ID); }

  /* ---- 分析结果 ---- */
  function saveAnalysis(infoA, infoB, result) {
    return put('analysis', {
      id: SESSION_ID,
      infoA: infoA, infoB: infoB,
      result: result,
      updatedAt: Date.now()
    });
  }
  function getAnalysis() { return get('analysis', SESSION_ID); }

  /* 一次性恢复整个会话 */
  function loadSession() {
    return Promise.all([
      getVideo('A'), getVideo('B'), getFrames(), getAnalysis()
    ]).then(function (arr) {
      return { videoA: arr[0], videoB: arr[1], frames: arr[2], analysis: arr[3] };
    });
  }

  /* 清空业务会话（保留设置） */
  function clearSession() {
    return Promise.all([clear('videos'), clear('frames'), clear('analysis')]);
  }

  function isQuotaError(err) {
    return err && (err.name === 'QuotaExceededError' ||
      err.code === 22 || /quota/i.test(err.message || ''));
  }

  function isSupported() {
    return supported;
  }

  VC.Storage = {
    open: openDB,
    isSupported: isSupported,
    isQuotaError: isQuotaError,
    getSettings: getSettings,
    saveSettings: saveSettings,
    saveVideo: saveVideo,
    getVideo: getVideo,
    saveFrames: saveFrames,
    getFrames: getFrames,
    saveAnalysis: saveAnalysis,
    getAnalysis: getAnalysis,
    loadSession: loadSession,
    clearSession: clearSession,
    genericPut: function (store, value) { return put(store, value); },
    genericGet: function (store, key) { return get(store, key); },
    genericDelete: function (store, key) { return del(store, key); }
  };
})(typeof window !== 'undefined' ? window : globalThis);
