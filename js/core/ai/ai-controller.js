/*
 * AI 控制器：统一本地模型与云端 API 两条路径，
 * 为报告准备结构化结果与可视化骨架图。
 */
(function (global) {
  'use strict';

  var VC = global.VC || (global.VC = {});
  if (!VC.AI) VC.AI = {};

  /* 选取代表帧索引：首 / 中 / 尾加均匀采样，上限 maxN */
  function representativeIndices(n, maxN) {
    var want = Math.min(n, maxN || 6);
    var set = {};
    for (var k = 0; k < want; k++) {
      var idx = Math.min(n - 1, Math.floor((k + 0.5) * n / want));
      set[idx] = true;
    }
    return Object.keys(set).map(Number).sort(function (a, b) { return a - b; });
  }

  async function runLocal(framesA, framesB, settings) {
    var variant = settings.modelVariant;
    var poseResult = await VC.AI.PoseEngine.analyzeSequence(framesA, framesB, variant);

    var visuals = representativeIndices(framesA.length, 6).map(function (i) {
      var pair = poseResult.pairs[i];
      return {
        index: i,
        progress: framesA[i].progress,
        skelA: VC.AI.PoseEngine.drawSkeleton(framesA[i], pair.poseA.keypoints, '#22c55e'),
        skelB: VC.AI.PoseEngine.drawSkeleton(framesB[i], pair.poseB.keypoints, '#ef4444'),
        overlay: VC.AI.PoseEngine.overlaySkeletons(framesA[i],
          pair.poseA.keypoints, pair.poseB.keypoints)
      };
    });

    return { mode: 'local', variant: variant, poseResult: poseResult, visuals: visuals };
  }

  async function runCloud(thumbsA, thumbsB, settings) {
    var indices = representativeIndices(thumbsA.length, 4);
    var frames = [];
    indices.forEach(function (i) {
      var pct = VC.Util.formatPercent(thumbsA[i].progress, 0);
      frames.push({ src: thumbsA[i].src, label: '视频 A', progress: pct });
      frames.push({ src: thumbsB[i].src, label: '视频 B', progress: pct });
    });
    var parsed = await VC.AI.CloudApi.analyze({
      frames: frames,
      config: settings
    });
    return { mode: 'cloud', result: parsed };
  }

  async function preloadLocalModel(settings) {
    if (settings.aiMode !== 'local') return null;
    var ready = await VC.AI.ModelStore.isReady(settings.modelVariant);
    if (!ready) return null;
    return VC.AI.ModelStore.loadGraphModel(settings.modelVariant);
  }

  VC.AI.Controller = {
    runLocal: runLocal,
    runCloud: runCloud,
    preloadLocalModel: preloadLocalModel,
    representativeIndices: representativeIndices
  };
})(typeof window !== 'undefined' ? window : globalThis);
