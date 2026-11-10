/*
 * 主编排：加载视频 → 技术参数解析 → 对齐抽帧 → 差异计算 → 报告渲染，
 * 并在每个关键节点自动持久化；启动时按需恢复上次会话。
 */
(function () {
  'use strict';

  var settings = null;
  var infoA = null, infoB = null;
  var objectUrls = { A: null, B: null };
  var persistOK = true;
  var busy = false;
  var aiBusy = false;
  var lastEx = null;   // 最近一次抽帧（分析像素帧 + 缩略图），供 AI 重跑

  function $(id) { return document.getElementById(id); }

  function setStatus(text) { $('status').textContent = text; }

  /* ---------- 技术参数卡片 ---------- */
  function compareVal(a, b, key) {
    var va = a[key], vb = b[key];
    if (va == null || vb == null || va === '—' || vb === '—') return 'match-neutral';
    if (typeof va === 'number' && typeof vb === 'number') {
      return Math.abs(va - vb) < 0.01 ? 'match-ok' : 'match-err';
    }
    return String(va) === String(vb) ? 'match-ok' : 'match-err';
  }

  function renderMeta() {
    var U = VC.Util;
    function one(info, el, label) {
      if (!info) {
        el.innerHTML = '<h4>视频 ' + label + ' 参数</h4><div class="muted-text">尚未加载</div>';
        return;
      }
      var cls = function (key) { return (infoA && infoB) ? compareVal(infoA, infoB, key) : 'match-neutral'; };
      var fpsText = info.fps != null ? (Number.isInteger(info.fps) ? info.fps : info.fps.toFixed(3)) + ' fps' : '未能解析';
      el.innerHTML =
        '<h4><i class="fa-solid fa-circle-info"></i> 视频 ' + label + ' 参数</h4>' +
        '<table class="meta-table">' +
        '<tr><td>文件名</td><td class="val">' + U.escapeHtml(info.name) + '</td></tr>' +
        '<tr><td>文件大小</td><td class="val ' + cls('size') + '">' + U.formatBytes(info.size) + '</td></tr>' +
        '<tr><td>修改时间</td><td class="val">' + U.formatDate(info.lastModified) + '</td></tr>' +
        '<tr><td>分辨率</td><td class="val ' + cls('width') + '">' + info.width + ' × ' + info.height + '</td></tr>' +
        '<tr><td>长宽比</td><td class="val ' + cls('aspect') + '">' + info.aspect + '</td></tr>' +
        '<tr><td>时长</td><td class="val ' + cls('duration') + '">' + (info.duration || 0).toFixed(3) + ' s</td></tr>' +
        '<tr><td>精确帧率</td><td class="val ' + cls('fps') + '">' + fpsText + '</td></tr>' +
        '<tr><td>帧率模式</td><td class="val ' + cls('frameRateMode') + '">' + info.frameRateMode + '</td></tr>' +
        '<tr><td>总帧数</td><td class="val ' + cls('frameCount') + '">' + (info.frameCount != null ? info.frameCount : '—') + '</td></tr>' +
        '<tr><td>编码</td><td class="val ' + cls('codec') + '">' + info.codec + '</td></tr>' +
        '<tr><td>码率</td><td class="val">' + info.bitrate + '</td></tr>' +
        '</table>';
    }
    one(infoA, $('metaA'), 'A');
    one(infoB, $('metaB'), 'B');
  }

  function checkReady() {
    var ready = $('videoA').readyState >= 1 && $('videoB').readyState >= 1;
    $('analyzeBtn').disabled = !ready || busy;
    $('playSyncBtn').disabled = !ready;
  }

  /* ---------- 持久化（best effort，不阻断） ---------- */
  function persist(promise, label) {
    return promise.then(function () { return true; }, function (err) {
      persistOK = false;
      updateStorageTag();
      if (VC.Storage.isQuotaError(err)) {
        setStatus('本地存储空间不足，' + label + '未持久化；当前结果仍可在本页查看。');
      } else {
        setStatus('本地保存失败，当前为内存模式（结果仍可在本页查看）。');
      }
      console.warn('persist failed', err);
      return false;
    });
  }

  function updateStorageTag() {
    var tag = $('storageTag');
    if (!VC.Storage.isSupported()) {
      persistOK = false;
      tag.textContent = '内存模式（浏览器不支持本地数据库）';
      tag.className = 'storage-tag warn';
    } else if (!persistOK) {
      tag.textContent = '内存模式（刷新后不保留）';
      tag.className = 'storage-tag warn';
    } else {
      tag.textContent = '自动保存已开启';
      tag.className = 'storage-tag ok';
    }
  }

  /* ---------- 加载视频 ---------- */
  function loadVideo(file, videoEl, side) {
    if (objectUrls[side]) URL.revokeObjectURL(objectUrls[side]);
    var url = URL.createObjectURL(file);
    objectUrls[side] = url;
    videoEl.src = url;
    videoEl.parentElement.classList.add('has-video');

    videoEl.onloadedmetadata = async function () {
      try {
        var result = await VC.MediaAnalyzer.analyzeFile(file);
        var info = VC.MediaAnalyzer.extractVideoInfo(result, file, videoEl);
        if (side === 'A') infoA = info; else infoB = info;
        renderMeta();
        checkReady();
        persist(VC.Storage.saveVideo(side, file), '视频');
      } catch (e) {
        console.error(e);
        setStatus('视频 ' + side + ' 解析失败：' + e.message);
      }
    };
  }

  function renderGrid(container, srcs) {
    container.innerHTML = '';
    srcs.forEach(function (src) {
      var img = document.createElement('img');
      img.src = typeof src === 'string' ? src : src.src;
      container.appendChild(img);
    });
  }

  /* ---------- 核心差异分析 ---------- */
  async function runAnalysis() {
    if (busy) return;
    var videoA = $('videoA'), videoB = $('videoB');
    if (videoA.readyState < 1 || videoB.readyState < 1) {
      setStatus('请先加载两个视频'); return;
    }
    busy = true; checkReady();
    var n = settings.sampleCount;
    var aw = settings.analysisWidth, ah = settings.analysisHeight;

    try {
      setStatus('正在对齐并抽取视频 A 帧...');
      var exA = await VC.FrameExtractor.extractAll(videoA, n, aw, ah);
      setStatus('正在对齐并抽取视频 B 帧...');
      var exB = await VC.FrameExtractor.extractAll(videoB, n, aw, ah);

      renderGrid($('gridA'), exA.thumbs);
      renderGrid($('gridB'), exB.thumbs);

      setStatus('正在逐帧计算像素差异...');
      var result = VC.Diff.compareSequence(exA.analysis, exB.analysis, settings);

      setStatus('正在生成差异报告...');
      VC.Report.render($('report'), {
        result: result,
        infoA: infoA, infoB: infoB,
        thumbsA: exA.thumbs, thumbsB: exB.thumbs,
        heatmapColor: settings.heatmapColor
      });

      setStatus('比对完成：相似度 ' + result.summary.similarity.toFixed(1) + ' / 100（' +
        VC.GRADE_META[result.summary.grade].label + '）');

      lastEx = {
        analysisA: exA.analysis, analysisB: exB.analysis,
        thumbsA: exA.thumbs, thumbsB: exB.thumbs
      };

      await persist(VC.Storage.saveFrames(exA.thumbs, exB.thumbs), '抽帧');
      await persist(VC.Storage.saveAnalysis(infoA, infoB, result), '分析结果');

      /* AI 开关打开时，基础分析后自动追加 AI 进阶章节 */
      if (settings.aiEnabled) await runAi();
    } catch (e) {
      console.error(e);
      setStatus('分析失败：' + e.message);
    } finally {
      busy = false; checkReady();
    }
  }

  /* ---------- AI 进阶分析 ---------- */
  async function runAi() {
    if (aiBusy) return;
    if (!settings.aiEnabled) { setStatus('请先在设定中开启 AI 进阶分析'); return; }
    if (!lastEx) {
      setStatus('正在重新抽取帧以运行 AI...');
      var reA = await VC.FrameExtractor.extractAll($('videoA'), settings.sampleCount,
        settings.analysisWidth, settings.analysisHeight);
      var reB = await VC.FrameExtractor.extractAll($('videoB'), settings.sampleCount,
        settings.analysisWidth, settings.analysisHeight);
      lastEx = {
        analysisA: reA.analysis, analysisB: reB.analysis,
        thumbsA: reA.thumbs, thumbsB: reB.thumbs
      };
    }
    aiBusy = true;
    try {
      var old = $('report').querySelector('.ai-extra');
      if (old) old.remove();

      if (settings.aiMode === 'cloud') {
        setStatus('正在调用云端 AI 接口分析...');
        var cloudOut = await VC.AI.Controller.runCloud(lastEx.thumbsA, lastEx.thumbsB, settings);
        VC.AI.AIReport.render($('report'), cloudOut);
      } else {
        var ready = await VC.AI.ModelStore.isReady(settings.modelVariant);
        if (!ready) { setStatus('本地模型未下载，请到设定页下载后再运行 AI 分析'); return; }
        setStatus('正在用本地模型进行姿态分析...');
        var localOut = await VC.AI.Controller.runLocal(lastEx.analysisA, lastEx.analysisB, settings);
        VC.AI.AIReport.render($('report'), localOut);
      }
      setStatus('AI 进阶分析完成');
    } catch (e) {
      console.error(e);
      setStatus('AI 分析失败：' + e.message);
    } finally {
      aiBusy = false;
    }
  }

  function updateAiButton() {
    var btn = $('aiRunBtn');
    if (btn) btn.style.display = settings.aiEnabled ? 'inline-block' : 'none';
  }

  /* ---------- 同步播放 ---------- */
  function syncPlay() {
    var a = $('videoA'), b = $('videoB');
    a.currentTime = 0; b.currentTime = 0;
    a.play(); b.play();
  }

  /* ---------- 恢复会话 ---------- */
  function restoreSide(side, record) {
    return new Promise(function (resolve) {
      var videoEl = side === 'A' ? $('videoA') : $('videoB');
      if (objectUrls[side]) URL.revokeObjectURL(objectUrls[side]);
      var url = URL.createObjectURL(record.blob);
      objectUrls[side] = url;
      videoEl.src = url;
      videoEl.parentElement.classList.add('has-video');
      videoEl.onloadedmetadata = function () { resolve(); };
      videoEl.onerror = function () { resolve(); };
    });
  }

  async function restoreSession() {
    var session;
    try {
      session = await VC.Storage.loadSession();
    } catch (e) {
      updateStorageTag();
      return;
    }
    if (!session.videoA && !session.videoB) return;

    if (session.videoA) await restoreSide('A', session.videoA);
    if (session.videoB) await restoreSide('B', session.videoB);

    if (session.analysis) {
      infoA = session.analysis.infoA;
      infoB = session.analysis.infoB;
      renderMeta();
    }

    var framesA = session.frames && session.frames.framesA;
    var framesB = session.frames && session.frames.framesB;
    if (framesA) renderGrid($('gridA'), framesA);
    if (framesB) renderGrid($('gridB'), framesB);

    if (session.analysis && session.analysis.result && framesA && framesB) {
      VC.Report.render($('report'), {
        result: session.analysis.result,
        infoA: infoA, infoB: infoB,
        thumbsA: framesA, thumbsB: framesB,
        heatmapColor: settings.heatmapColor
      });
      var s = session.analysis.result.summary;
      setStatus('已恢复上次会话：相似度 ' + s.similarity.toFixed(1) + ' / 100');
    } else {
      setStatus('已恢复上次加载的视频');
    }

    var banner = $('restoreBanner');
    var time = session.analysis && session.analysis.updatedAt ? session.analysis.updatedAt :
      (session.videoA && session.videoA.savedAt);
    $('restoreText').textContent = '已恢复 ' + VC.Util.formatDate(time) + ' 的会话';
    banner.style.display = 'flex';
    checkReady();
  }

  /* ---------- 清空会话 ---------- */
  async function resetSession() {
    ['A', 'B'].forEach(function (side) {
      var v = side === 'A' ? $('videoA') : $('videoB');
      v.removeAttribute('src'); v.load();
      v.parentElement.classList.remove('has-video');
      if (objectUrls[side]) { URL.revokeObjectURL(objectUrls[side]); objectUrls[side] = null; }
    });
    infoA = null; infoB = null;
    lastEx = null;
    renderMeta();
    $('gridA').innerHTML = ''; $('gridB').innerHTML = '';
    $('report').innerHTML = '<div class="report-title"><i class="fa-solid fa-file-lines"></i>比对报告</div>等待加载两个视频并开始差异分析...';
    try { await VC.Storage.clearSession(); } catch (e) {}
    $('restoreBanner').style.display = 'none';
    setStatus('已清空会话');
    checkReady();
  }

  /* ---------- 事件绑定 ---------- */
  function setupDrop(dropId, inputId, videoId, side) {
    var drop = $(dropId), input = $(inputId), video = $(videoId);
    drop.addEventListener('click', function () { input.click(); });
    ['dragenter', 'dragover'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('dragover'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('dragover'); });
    });
    drop.addEventListener('drop', function (e) {
      if (e.dataTransfer.files[0]) loadVideo(e.dataTransfer.files[0], video, side);
    });
    input.addEventListener('change', function () {
      if (input.files[0]) loadVideo(input.files[0], video, side);
    });
  }

  document.addEventListener('DOMContentLoaded', async function () {
    settings = await VC.Storage.getSettings();
    updateStorageTag();
    VC.MediaAnalyzer.init();

    setupDrop('dropA', 'fileA', 'videoA', 'A');
    setupDrop('dropB', 'fileB', 'videoB', 'B');

    $('analyzeBtn').addEventListener('click', runAnalysis);
    $('playSyncBtn').addEventListener('click', syncPlay);
    $('resetBtn').addEventListener('click', resetSession);
    $('aiRunBtn').addEventListener('click', runAi);
    $('dismissRestore').addEventListener('click', function () {
      $('restoreBanner').style.display = 'none';
    });

    renderMeta();
    checkReady();
    updateAiButton();

    if (settings.autoRestore) await restoreSession();

    /* 按设定自动预加载本地模型，不阻塞界面 */
    if (settings.aiEnabled && settings.aiMode === 'local' && settings.modelAutoLoad) {
      VC.AI.Controller.preloadLocalModel(settings).then(function (m) {
        if (m) setStatus('本地 AI 模型已按设定自动加载');
      }, function (e) { console.warn('模型预加载失败', e); });
    }
  });
})();
