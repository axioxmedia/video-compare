/*
 * 差异引擎：纯函数、零依赖、不操作 DOM。
 * 输入帧统一为 { width, height, data: Uint8Array|Uint8ClampedArray (RGBA), time }
 * 浏览器与 node 均可运行，便于自动化测试。
 */
(function (global) {
  'use strict';

  var VC = global.VC || (global.VC = {});
  var DEFAULTS = VC.DEFAULTS;

  function luma(r, g, b) { return 0.299 * r + 0.587 * g + 0.114 * b; }
  function psnrFromMse(mse) {
    if (mse <= 0) return Infinity;
    return 10 * (Math.log(255 * 255 / mse) / Math.LN10);
  }

  var REGION_NAMES_3 = [
    '左上角', '上方', '右上角',
    '左侧', '中央', '右侧',
    '左下角', '下方', '右下角'
  ];
  var PART_NAMES = ['前 1/3 段', '中 1/3 段', '后 1/3 段'];

  /* 比较一对已归一化到相同尺寸的帧 */
  function compareFrame(a, b, opts) {
    opts = opts || {};
    var threshold = opts.diffThreshold != null ? opts.diffThreshold : DEFAULTS.diffThreshold;
    var gridN = opts.spatialGrid || DEFAULTS.spatialGrid;

    var width = a.width, height = a.height;
    var n = width * height;
    var da = a.data, db = b.data;
    var diffMap = new Uint8Array(n);

    var sadLuma = 0, sseLuma = 0, diffPixelCount = 0;
    var sad = { r: 0, g: 0, b: 0 };
    var sse = { r: 0, g: 0, b: 0 };

    for (var i = 0; i < n; i++) {
      var p = i * 4;
      var dr = da[p] - db[p];
      var dg = da[p + 1] - db[p + 1];
      var dl = da[p + 2] - db[p + 2];
      var ar = da[p], ag = da[p + 1], ab = da[p + 2];
      var br = db[p], bg = db[p + 1], bb = db[p + 2];

      var adr = Math.abs(dr), adg = Math.abs(dg), adb = Math.abs(dl);
      sad.r += adr; sad.g += adg; sad.b += adb;
      sse.r += dr * dr; sse.g += dg * dg; sse.b += dl * dl;

      var lum = Math.abs(luma(ar, ag, ab) - luma(br, bg, bb));
      diffMap[i] = UtilClamp(lum);
      sadLuma += lum;
      sseLuma += lum * lum;
      if (lum > threshold) diffPixelCount++;
    }

    /* 空间分区统计 */
    var regions = [];
    for (var gy = 0; gy < gridN; gy++) {
      for (var gx = 0; gx < gridN; gx++) {
        var x0 = Math.floor(gx * width / gridN), x1 = Math.floor((gx + 1) * width / gridN);
        var y0 = Math.floor(gy * height / gridN), y1 = Math.floor((gy + 1) * height / gridN);
        var rSad = 0, rCount = 0, rDiff = 0;
        for (var y = y0; y < y1; y++) {
          for (var x = x0; x < x1; x++) {
            var idx = y * width + x;
            rSad += diffMap[idx];
            rCount++;
            if (diffMap[idx] > threshold) rDiff++;
          }
        }
        regions.push({
          index: gy * gridN + gx,
          name: gridN === 3 ? REGION_NAMES_3[gy * gridN + gx] : ('区域 ' + (gy * gridN + gx + 1)),
          mae: rCount ? rSad / rCount : 0,
          diffRatio: rCount ? rDiff / rCount : 0
        });
      }
    }

    var maeLuma = sadLuma / n;
    var mseLuma = sseLuma / n;
    return {
      width: width,
      height: height,
      timeA: a.time != null ? a.time : null,
      timeB: b.time != null ? b.time : null,
      progress: a.progress != null ? a.progress : null,
      mae: maeLuma,
      mse: mseLuma,
      rmse: Math.sqrt(mseLuma),
      psnr: psnrFromMse(mseLuma),
      diffPixelRatio: diffPixelCount / n,
      channel: {
        r: { mae: sad.r / n, mse: sse.r / n },
        g: { mae: sad.g / n, mse: sse.g / n },
        b: { mae: sad.b / n, mse: sse.b / n }
      },
      regions: regions,
      diffMap: diffMap
    };
  }

  function UtilClamp(v) { return v > 255 ? 255 : (v < 0 ? 0 : v); }

  /* 相似度 0-100 与等级 */
  function scoreSimilarity(avgMae, avgDiffRatio) {
    var s1 = (1 - avgMae / 255) * 100;
    var s2 = (1 - avgDiffRatio) * 100;
    return Math.round((s1 * 0.5 + s2 * 0.5) * 10) / 10;
  }
  function gradeOf(similarity) {
    if (similarity >= 98) return 'identical';
    if (similarity >= 90) return 'minor';
    if (similarity >= 75) return 'noticeable';
    if (similarity >= 55) return 'major';
    return 'different';
  }

  /* 整条序列：framesA/framesB 等长、已按归一化进度对齐 */
  function compareSequence(framesA, framesB, opts) {
    opts = opts || {};
    if (!framesA || !framesB || framesA.length !== framesB.length || !framesA.length) {
      throw new Error('两侧帧序列为空或长度不一致，无法对齐比较');
    }
    var pairs = [];
    var curve = { progress: [], timeA: [], timeB: [], mae: [], mse: [], psnr: [], ratio: [] };

    for (var i = 0; i < framesA.length; i++) {
      var r = compareFrame(framesA[i], framesB[i], opts);
      r.index = i;
      pairs.push(r);
      curve.progress.push(r.progress);
      curve.timeA.push(r.timeA);
      curve.timeB.push(r.timeB);
      curve.mae.push(r.mae);
      curve.mse.push(r.mse);
      curve.psnr.push(isFinite(r.psnr) ? r.psnr : null);
      curve.ratio.push(r.diffPixelRatio);
    }

    var count = pairs.length;
    var avgMae = meanOf(curve.mae);
    var maxMae = maxOf(curve.mae);
    var avgMse = meanOf(curve.mse);
    var avgRatio = meanOf(curve.ratio);
    var maxRatio = maxOf(curve.ratio);
    var finitePsnr = curve.psnr.filter(function (v) { return v != null && isFinite(v); });
    var avgPsnr = finitePsnr.length ? meanOf(finitePsnr) : Infinity;
    var minPsnr = finitePsnr.length ? minOf(finitePsnr) : Infinity;

    var maxDiffFrameIndex = indexOfMax(curve.mae);
    var similarity = scoreSimilarity(avgMae, avgRatio);
    var gradeKey = gradeOf(similarity);

    /* 时间分布：前/中/后三段 */
    var thirds = splitThirds(curve.mae);
    var timeParts = thirds.map(function (v, i) { return { name: PART_NAMES[i], mae: v }; });
    var dominantPart = indexOfMax(thirds);
    var partSpread = maxOf(thirds) - minOf(thirds);

    /* 空间分布：聚合各区域，找差异最集中方位 */
    var gridN = opts.spatialGrid || DEFAULTS.spatialGrid;
    var regionAgg = [];
    for (var ri = 0; ri < gridN * gridN; ri++) {
      var rArr = pairs.map(function (pr) { return pr.regions[ri].mae; });
      regionAgg.push({
        index: ri,
        name: pairs[0].regions[ri].name,
        mae: meanOf(rArr)
      });
    }
    var dominantRegion = indexOfMax(regionAgg.map(function (x) { return x.mae; }));
    var regionMax = regionAgg[dominantRegion].mae;
    var regionMean = meanOf(regionAgg.map(function (x) { return x.mae; }));

    var summary = {
      pairCount: count,
      avgMae: avgMae,
      maxMae: maxMae,
      avgMse: avgMse,
      rmse: Math.sqrt(avgMse),
      psnr: psnrFromMse(avgMse),
      avgPsnr: avgPsnr,
      minPsnr: minPsnr,
      avgDiffRatio: avgRatio,
      maxDiffRatio: maxRatio,
      similarity: similarity,
      grade: gradeKey,
      maxDiffFrameIndex: maxDiffFrameIndex,
      maxDiffProgress: curve.progress[maxDiffFrameIndex],
      maxDiffTimeA: curve.timeA[maxDiffFrameIndex],
      maxDiffTimeB: curve.timeB[maxDiffFrameIndex],
      temporal: {
        parts: timeParts,
        dominantPart: dominantPart,
        concentrated: partSpread > Math.max(2, avgMae * 0.35)
      },
      spatial: {
        regions: regionAgg,
        dominantRegion: dominantRegion,
        dominantRegionName: regionAgg[dominantRegion].name,
        localized: regionMax > regionMean * 1.6 && regionMean > 0.5
      }
    };

    return { pairs: pairs, curve: curve, summary: summary };
  }

  function splitThirds(arr) {
    var out = [];
    var size = arr.length / 3;
    for (var k = 0; k < 3; k++) {
      var seg = arr.slice(Math.floor(k * size), Math.floor((k + 1) * size));
      out.push(seg.length ? meanOf(seg) : 0);
    }
    return out;
  }

  function meanOf(arr) { var s = 0; for (var i = 0; i < arr.length; i++) s += arr[i]; return arr.length ? s / arr.length : 0; }
  function maxOf(arr) { return Math.max.apply(null, arr); }
  function minOf(arr) { return Math.min.apply(null, arr); }
  function indexOfMax(arr) {
    var idx = 0;
    for (var i = 1; i < arr.length; i++) if (arr[i] > arr[idx]) idx = i;
    return idx;
  }

  var Diff = {
    compareFrame: compareFrame,
    compareSequence: compareSequence,
    scoreSimilarity: scoreSimilarity,
    gradeOf: gradeOf,
    psnrFromMse: psnrFromMse,
    luma: luma
  };
  VC.Diff = Diff;
  if (typeof module !== 'undefined' && module.exports) module.exports = Diff;
})(typeof window !== 'undefined' ? window : globalThis);
