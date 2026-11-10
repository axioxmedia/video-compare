/*
 * AI 模型存储：流式下载（进度回调）→ IndexedDB 缓存 → 自定义 IOHandler 加载，
 * 并支持通过 File System Access API 写入用户授权的项目文件夹；
 * 不支持时降级为浏览器普通下载。运行时模型一律以 IndexedDB 为准，file:// 也可用。
 */
(function (global) {
  'use strict';

  var VC = global.VC || (global.VC = {});
  if (!VC.AI) VC.AI = {};
  var Storage = VC.Storage;
  var AIMODEL_STORE = 'aimodels';
  var FOLDER_KEY = '__folder';
  var graphCache = {};

  var MODELS = {
    lightning: {
      base: 'https://tfhub.dev/google/tfjs-model/movenet/singlepose/lightning/4',
      input: 192,
      label: 'MoveNet 单人 Lightning（192，快）'
    },
    thunder: {
      base: 'https://tfhub.dev/google/tfjs-model/movenet/singlepose/thunder/4',
      input: 256,
      label: 'MoveNet 单人 Thunder（256，高精度）'
    }
  };

  /* ---------- 流式下载单个响应 ---------- */
  function readWithProgress(resp, onProgress, baseLoaded, grandTotal, label) {
    return new Promise(function (resolve, reject) {
      var reader = resp.body.getReader();
      var chunks = [];
      var loaded = 0;
      function pump() {
        reader.read().then(function (r) {
          if (r.done) {
            resolve({ blob: new Blob(chunks), bytes: loaded });
            return;
          }
          chunks.push(r.value);
          loaded += r.value.length;
          if (onProgress) {
            onProgress({
              label: label,
              loaded: baseLoaded + loaded,
              total: grandTotal,
              percent: grandTotal ? (baseLoaded + loaded) / grandTotal : 0
            });
          }
          pump();
        }, reject);
      }
      pump();
    });
  }

  /* ---------- 完整下载流程 ---------- */
  async function downloadModel(variant, onProgress) {
    var cfg = MODELS[variant];
    if (!cfg) throw new Error('未知模型：' + variant);

    if (onProgress) onProgress({ phase: 'connect', percent: 0, label: '正在读取模型清单...' });
    var jsonResp = await fetch(cfg.base + '/model.json?tfjs-format=file');
    if (!jsonResp.ok) throw new Error('模型清单请求失败 HTTP ' + jsonResp.status);
    var jsonText = await jsonResp.text();
    var json = JSON.parse(jsonText);

    var shardPaths = [];
    json.weightsManifest.forEach(function (m) {
      m.paths.forEach(function (p) { shardPaths.push(p); });
    });

    /* 并行建立连接以获取总大小，再逐个读取，保证总进度准确 */
    var items = await Promise.all(shardPaths.map(async function (p) {
      var r = await fetch(cfg.base + '/' + p + '?tfjs-format=file');
      if (!r.ok) throw new Error(p + ' 请求失败 HTTP ' + r.status);
      return {
        path: p, resp: r,
        total: parseInt(r.headers.get('content-length') || '0', 10)
      };
    }));
    var grandTotal = items.reduce(function (a, x) { return a + x.total; }, 0);

    var shards = [];
    var baseLoaded = 0;
    for (var i = 0; i < items.length; i++) {
      var out = await readWithProgress(items[i].resp, onProgress,
        baseLoaded, grandTotal, items[i].path);
      shards.push({ name: items[i].path, blob: out.blob });
      baseLoaded += items[i].total;
    }

    var record = {
      key: variant,
      modelJson: jsonText,
      shards: shards,
      inputSize: cfg.input,
      bytes: grandTotal,
      savedAt: Date.now()
    };
    await Storage.genericPut(AIMODEL_STORE, record);

    /* 若已授权项目文件夹，则同步写入磁盘；未授权不阻断 */
    var folderInfo = null;
    try {
      if (await getFolderRow()) folderInfo = await writeToFolder(record);
    } catch (e) { folderInfo = { error: e.message }; }

    return { record: record, folderInfo: folderInfo };
  }

  /* ---------- 记录查询 ---------- */
  function getRecord(variant) {
    return Storage.genericGet(AIMODEL_STORE, variant);
  }
  async function isReady(variant) {
    var r = await getRecord(variant);
    return !!(r && r.modelJson && r.shards && r.shards.length);
  }

  /* ---------- 自定义 IOHandler ---------- */
  function makeHandler(record) {
    return {
      async load() {
        var json = JSON.parse(record.modelJson);
        var byName = {};
        record.shards.forEach(function (s) { byName[s.name] = s.blob; });

        var buffers = [];
        var specs = [];
        json.weightsManifest.forEach(function (m) {
          if (m.weights) specs.push.apply(specs, m.weights);
          m.paths.forEach(function (p) { buffers.push(byName[p]); });
        });

        var arr = await Promise.all(buffers.map(function (b) { return b.arrayBuffer(); }));
        var total = arr.reduce(function (a, b) { return a + b.byteLength; }, 0);
        var merged = new Uint8Array(total);
        var off = 0;
        arr.forEach(function (b) {
          merged.set(new Uint8Array(b), off);
          off += b.byteLength;
        });

        return {
          modelTopology: json.modelTopology,
          weightSpecs: specs,
          weightData: merged.buffer,
          format: json.format
        };
      }
    };
  }

  async function loadGraphModel(variant) {
    if (graphCache[variant]) return graphCache[variant];
    var record = await getRecord(variant);
    if (!record) throw new Error('本地模型不存在，请先下载');
    var model = await tf.loadGraphModel(makeHandler(record));
    graphCache[variant] = model;
    return model;
  }

  async function removeModel(variant) {
    delete graphCache[variant];
    return Storage.genericDelete(AIMODEL_STORE, variant);
  }

  /* ---------- 项目文件夹（File System Access） ---------- */
  function supportsFolderPicker() {
    return typeof global.showDirectoryPicker === 'function';
  }

  async function pickFolder() {
    if (!supportsFolderPicker()) {
      throw new Error('当前浏览器不支持文件夹选择，已改用本地数据库缓存');
    }
    var handle = await global.showDirectoryPicker();
    await Storage.genericPut(AIMODEL_STORE, {
      key: FOLDER_KEY, handle: handle, name: handle.name, savedAt: Date.now()
    });
    return handle;
  }

  function getFolderRow() {
    return Storage.genericGet(AIMODEL_STORE, FOLDER_KEY);
  }

  async function ensurePermission(handle) {
    var opts = { mode: 'readwrite' };
    if (handle.queryPermission && (await handle.queryPermission(opts)) === 'granted') return true;
    if (handle.requestPermission && (await handle.requestPermission(opts)) === 'granted') return true;
    return false;
  }

  function writeFile(dirHandle, name, blob) {
    return dirHandle.getFileHandle(name, { create: true }).then(function (fh) {
      return fh.createWritable().then(function (w) {
        return w.write(blob).then(function () { return w.close(); });
      });
    });
  }

  async function writeToFolder(record) {
    var row = await getFolderRow();
    if (!row || !row.handle) throw new Error('尚未授权项目文件夹');
    var root = row.handle;
    if (!(await ensurePermission(root))) throw new Error('文件夹写入权限被拒绝');

    var aiDir = await root.getDirectoryHandle('ai-models', { create: true });
    var sub = await aiDir.getDirectoryHandle('movenet-' + record.key, { create: true });

    await writeFile(sub, 'model.json',
      new Blob([record.modelJson], { type: 'application/json' }));
    for (var i = 0; i < record.shards.length; i++) {
      await writeFile(sub, record.shards[i].name, record.shards[i].blob);
    }
    return { folder: row.name, path: 'ai-models/movenet-' + record.key };
  }

  /* ---------- 普通下载兜底 ---------- */
  function browserDownload(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 3000);
  }

  VC.AI.ModelStore = {
    MODELS: MODELS,
    downloadModel: downloadModel,
    getRecord: getRecord,
    isReady: isReady,
    loadGraphModel: loadGraphModel,
    removeModel: removeModel,
    supportsFolderPicker: supportsFolderPicker,
    pickFolder: pickFolder,
    getFolderRow: getFolderRow,
    writeToFolder: writeToFolder,
    browserDownload: browserDownload
  };
})(typeof window !== 'undefined' ? window : globalThis);
