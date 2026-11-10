/*
 * 姿态引擎：MoveNet 推理（17 关键点），手臂位置 / 关节角度 / 关键点位移差异，
 * 骨架叠加与 A/B 对比图。坐标统一使用归一化值，跨分辨率可比。
 */
(function (global) {
  'use strict';

  var VC = global.VC || (global.VC = {});
  if (!VC.AI) VC.AI = {};

  var KEYPOINT_NAMES = [
    '鼻', '左眼', '右眼', '左耳', '右耳',
    '左肩', '右肩', '左肘', '右肘', '左腕', '右腕',
    '左髋', '右髋', '左膝', '右膝', '左踝', '右踝'
  ];
  var SKELETON = [
    [0, 1], [0, 2], [1, 3], [2, 4],
    [5, 6], [5, 7], [7, 9], [6, 8], [8, 10],
    [5, 11], [6, 12], [11, 12],
    [11, 13], [13, 15], [12, 14], [14, 16]
  ];
  var SCORE_MIN = 0.3;

  /* 单帧推理：frame 为 {width,height,data}，输出关键点（归一化坐标 + 像素坐标） */
  async function estimate(frame, model, inputSize) {
    var img = new ImageData(new Uint8ClampedArray(frame.data), frame.width, frame.height);
    var src = document.createElement('canvas');
    src.width = frame.width; src.height = frame.height;
    src.getContext('2d').putImageData(img, 0, 0);
    /* 官方做法：直接缩放到方形，跨视频一致，归一化坐标可比 */
    var c = document.createElement('canvas');
    c.width = inputSize; c.height = inputSize;
    c.getContext('2d').drawImage(src, 0, 0, inputSize, inputSize);

    var tensor = tf.browser.fromPixels(c).toInt().reshape([1, inputSize, inputSize, 3]);
    var output = model.execute(tensor);
    var raw = await output.data();
    tensor.dispose(); output.dispose();

    var kps = [];
    for (var i = 0; i < 17; i++) {
      var ny = raw[i * 3], nx = raw[i * 3 + 1], score = raw[i * 3 + 2];
      kps.push({
        index: i, name: KEYPOINT_NAMES[i],
        nx: nx, ny: ny, score: score,
        px: nx * frame.width, py: ny * frame.height
      });
    }
    return {
      keypoints: kps,
      avgScore: kps.reduce(function (a, k) { return a + k.score; }, 0) / kps.length,
      width: frame.width, height: frame.height
    };
  }

  function dist(a, b) {
    return Math.hypot(a.nx - b.nx, a.ny - b.ny);
  }

  /* 以 b 为顶点的关节角度（度） */
  function jointAngle(a, b, c) {
    var ab = Math.atan2(a.ny - b.ny, a.nx - b.nx);
    var cb = Math.atan2(c.ny - b.ny, c.nx - b.nx);
    var d = Math.abs(ab - cb) * 180 / Math.PI;
    return d > 180 ? 360 - d : d;
  }

  /* 比较一对姿态 */
  function comparePose(pa, pb) {
    var kA = pa.keypoints, kB = pb.keypoints;
    var perPoint = [];
    var valid = 0;
    for (var i = 0; i < 17; i++) {
      var usable = kA[i].score >= SCORE_MIN && kB[i].score >= SCORE_MIN;
      var d = usable ? dist(kA[i], kB[i]) : null;
      perPoint.push({
        index: i, name: KEYPOINT_NAMES[i],
        displacement: d,
        scoreA: kA[i].score, scoreB: kB[i].score
      });
      if (usable) valid++;
    }

    function get(idx) { return perPoint[idx].displacement; }
    function safe(v) { return v == null ? null : v; }

    /* 手臂：肩 5/6、肘 7/8、腕 9/10；肘角：肩-肘-腕 */
    var arm = {
      leftWrist: get(9), rightWrist: get(10),
      leftElbow: get(7), rightElbow: get(8),
      leftShoulder: get(5), rightShoulder: get(6),
      leftElbowAngle: (kA[5].score >= SCORE_MIN && kA[9].score >= SCORE_MIN &&
        kB[5].score >= SCORE_MIN && kB[9].score >= SCORE_MIN)
        ? Math.abs(jointAngle(kA[5], kA[7], kA[9]) - jointAngle(kB[5], kB[7], kB[9])) : null,
      rightElbowAngle: (kA[6].score >= SCORE_MIN && kA[10].score >= SCORE_MIN &&
        kB[6].score >= SCORE_MIN && kB[10].score >= SCORE_MIN)
        ? Math.abs(jointAngle(kA[6], kA[8], kA[10]) - jointAngle(kB[6], kB[8], kB[10])) : null
    };

    var validDisps = perPoint.filter(function (p) { return p.displacement != null; })
      .map(function (p) { return p.displacement; });
    var avgDisplacement = validDisps.length ?
      validDisps.reduce(function (a, x) { return a + x; }, 0) / validDisps.length : null;

    var wristVals = [arm.leftWrist, arm.rightWrist].filter(function (x) { return x != null; });
    var wristDisp = wristVals.length ?
      wristVals.reduce(function (a, x) { return a + x; }, 0) / wristVals.length : null;

    return {
      perPoint: perPoint,
      arm: arm,
      avgDisplacement: avgDisplacement,
      wristDisp: wristDisp,
      personDetected: valid >= 8,
      avgScoreA: pa.avgScore,
      avgScoreB: pb.avgScore
    };
  }

  /* 整条序列：framesA/framesB 与像素分析同源、等长 */
  async function analyzeSequence(framesA, framesB, variant) {
    var model = await VC.AI.ModelStore.loadGraphModel(variant);
    var inputSize = VC.AI.ModelStore.MODELS[variant].input;
    var pairs = [];
    var curve = { progress: [], wrist: [], avg: [] };

    for (var i = 0; i < framesA.length; i++) {
      var pa = await estimate(framesA[i], model, inputSize);
      var pb = await estimate(framesB[i], model, inputSize);
      var cmp = comparePose(pa, pb);
      cmp.index = i;
      cmp.progress = framesA[i].progress;
      cmp.poseA = pa; cmp.poseB = pb;
      pairs.push(cmp);
      curve.progress.push(framesA[i].progress);
      curve.wrist.push(cmp.wristDisp);
      curve.avg.push(cmp.avgDisplacement);
    }

    var wristSeries = curve.wrist.filter(function (x) { return x != null; });
    var avgSeries = curve.avg.filter(function (x) { return x != null; });
    var maxWristIndex = indexOfMax(curve.wrist);

    return {
      variant: variant,
      pairs: pairs,
      curve: curve,
      summary: {
        avgWristDisp: wristSeries.length ? mean(wristSeries) : null,
        maxWristDisp: wristSeries.length ? max(wristSeries) : null,
        maxWristProgress: curve.progress[maxWristIndex],
        avgDisplacement: avgSeries.length ? mean(avgSeries) : null,
        personFrameCount: pairs.filter(function (p) { return p.personDetected; }).length,
        totalFrames: pairs.length
      }
    };
  }

  /* ---------- 骨架绘制 ---------- */
  function drawSkeleton(frame, kps, color) {
    var c = document.createElement('canvas');
    c.width = frame.width; c.height = frame.height;
    var ctx = c.getContext('2d');
    ctx.putImageData(new ImageData(new Uint8ClampedArray(frame.data), frame.width, frame.height), 0, 0);

    ctx.lineWidth = 2;
    SKELETON.forEach(function (seg) {
      var a = kps[seg[0]], b = kps[seg[1]];
      if (a.score < SCORE_MIN || b.score < SCORE_MIN) return;
      ctx.strokeStyle = color;
      ctx.beginPath(); ctx.moveTo(a.px, a.py); ctx.lineTo(b.px, b.py); ctx.stroke();
    });
    kps.forEach(function (k) {
      if (k.score < SCORE_MIN) return;
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(k.px, k.py, 3, 0, Math.PI * 2); ctx.fill();
    });
    return c.toDataURL('image/jpeg', 0.8);
  }

  /* A 骨架（绿）与 B 骨架（红）叠加在同一画面，直观看手臂位置差 */
  function overlaySkeletons(frame, kpsA, kpsB) {
    var c = document.createElement('canvas');
    c.width = frame.width; c.height = frame.height;
    var ctx = c.getContext('2d');
    ctx.putImageData(new ImageData(new Uint8ClampedArray(frame.data), frame.width, frame.height), 0, 0);

    function one(kps, color, lw) {
      ctx.lineWidth = lw;
      SKELETON.forEach(function (seg) {
        var a = kps[seg[0]], b = kps[seg[1]];
        if (a.score < SCORE_MIN || b.score < SCORE_MIN) return;
        ctx.strokeStyle = color;
        ctx.beginPath(); ctx.moveTo(a.px, a.py); ctx.lineTo(b.px, b.py); ctx.stroke();
      });
    }
    one(kpsA, 'rgba(34,197,94,0.9)', 2);
    one(kpsB, 'rgba(239,68,68,0.9)', 2);
    return c.toDataURL('image/jpeg', 0.82);
  }

  function mean(a) { return a.reduce(function (x, y) { return x + y; }, 0) / a.length; }
  function max(a) { return Math.max.apply(null, a); }
  function indexOfMax(a) {
    var idx = 0;
    for (var i = 1; i < a.length; i++) {
      if (a[i] != null && (a[idx] == null || a[i] > a[idx])) idx = i;
    }
    return idx;
  }

  VC.AI.PoseEngine = {
    estimate: estimate,
    comparePose: comparePose,
    analyzeSequence: analyzeSequence,
    drawSkeleton: drawSkeleton,
    overlaySkeletons: overlaySkeletons,
    KEYPOINT_NAMES: KEYPOINT_NAMES
  };
})(typeof window !== 'undefined' ? window : globalThis);
