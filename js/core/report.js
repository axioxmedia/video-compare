/*
 * 报告渲染：差异热力图、时间轴曲线、指标表、自动归因与建议。
 * 输入 compareSequence 的结果、技术参数与两侧缩略图，输出完整报告。
 */
(function (global) {
  'use strict';

  var VC = global.VC || (global.VC = {});
  var U = VC.Util;

  function fmtPsnr(v) {
    if (v == null) return '—';
    if (!isFinite(v)) return '∞ 完全相同';
    return v.toFixed(2) + ' dB';
  }

  /* ---- 热力图 ---- */
  function mix(a, b, t) { return a + (b - a) * t; }
  function thermalColor(d, out, p) {
    var stops = [
      [8, 12, 90], [0, 190, 255], [255, 225, 40], [255, 45, 0]
    ];
    var seg = d * (stops.length - 1);
    var i = Math.min(stops.length - 2, Math.floor(seg));
    var t = seg - i;
    out[p] = mix(stops[i][0], stops[i + 1][0], t);
    out[p + 1] = mix(stops[i][1], stops[i + 1][1], t);
    out[p + 2] = mix(stops[i][2], stops[i + 1][2], t);
  }

  function heatmapDataUrl(diffMap, width, height, mode) {
    var canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    var ctx = canvas.getContext('2d');
    var img = ctx.createImageData(width, height);
    var out = img.data;
    for (var i = 0; i < width * height; i++) {
      var d = diffMap[i] / 255;
      var e = Math.pow(d, 0.55); /* 增强弱差异可见性 */
      var p = i * 4;
      if (mode === 'thermal') {
        thermalColor(e, out, p);
      } else {
        out[p] = e * 255;
        out[p + 1] = e * e * 80;
        out[p + 2] = e * e * 45;
      }
      out[p + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return canvas.toDataURL('image/jpeg', 0.85);
  }

  /* 向上取整到友好量程，最大不超过 255 */
  function niceCeil(v) {
    var candidates = [10, 25, 50, 100, 150, 200, 255];
    for (var i = 0; i < candidates.length; i++) {
      if (candidates[i] >= v) return candidates[i];
    }
    return Math.ceil(v);
  }

  /* ---- 时间轴曲线 ---- */
  function drawCurve(canvas, curve, summary) {
    var dpr = global.devicePixelRatio || 1;
    var W = 720, H = 230;
    canvas.width = W * dpr; canvas.height = H * dpr;
    canvas.style.width = '100%';
    var ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    var ml = 46, mr = 16, mt = 18, mb = 30;
    var pw = W - ml - mr, ph = H - mt - mb;
    var xAt = function (i) { return ml + (curve.mae.length <= 1 ? 0 : i / (curve.mae.length - 1) * pw); };

    /* 纵轴自适应：取两条线最大值并向上取整到友好量程，小差异也能看清形状 */
    var ratioScaled = curve.ratio.map(function (r) { return r * 255; });
    var rawMax = Math.max(Math.max.apply(null, curve.mae), Math.max.apply(null, ratioScaled));
    var yMax = niceCeil(Math.max(rawMax * 1.15, 10));
    var yAt = function (v) { return mt + ph - (v / yMax) * ph; };

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);

    /* 网格与纵轴标签（按当前量程分 4 档） */
    ctx.font = '11px system-ui';
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (var g = 0; g <= 4; g++) {
      var v = yMax * g / 4;
      var y = yAt(v);
      ctx.strokeStyle = '#eef0f3'; ctx.beginPath();
      ctx.moveTo(ml, y); ctx.lineTo(W - mr, y); ctx.stroke();
      ctx.fillStyle = '#9aa1ac'; ctx.fillText(U.round(v, 0), ml - 8, y);
    }
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#9aa1ac';
    ctx.fillText('量程 0–' + yMax, W - mr, 6);

    function line(values, color, fill) {
      ctx.beginPath();
      values.forEach(function (v, i) {
        var x = xAt(i), y = yAt(v);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      if (fill) {
        ctx.save();
        ctx.lineTo(xAt(values.length - 1), yAt(0));
        ctx.lineTo(xAt(0), yAt(0));
        ctx.closePath();
        ctx.fillStyle = fill; ctx.fill();
        ctx.restore();
      }
      ctx.strokeStyle = color; ctx.lineWidth = 2;
      ctx.stroke();
    }

    line(curve.mae, '#dc2626', 'rgba(220,38,38,0.10)');
    line(ratioScaled, '#2563eb', null);

    /* 峰值点 */
    var pi = summary.maxDiffFrameIndex;
    var px = xAt(pi), py = yAt(curve.mae[pi]);
    ctx.fillStyle = '#dc2626';
    ctx.beginPath(); ctx.arc(px, py, 4, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#dc2626'; ctx.textAlign = 'left';
    ctx.fillText('峰值 ' + curve.mae[pi].toFixed(1), px + 7, py - 8);

    /* 横轴时间标签 */
    ctx.fillStyle = '#9aa1ac'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    [0, Math.floor(curve.timeA.length / 2), curve.timeA.length - 1].forEach(function (i) {
      ctx.fillText(U.formatClock(curve.timeA[i]), xAt(i), mt + ph + 8);
    });

    /* 图例 */
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#dc2626'; ctx.fillRect(ml, 4, 14, 4);
    ctx.fillStyle = '#4b5563'; ctx.fillText('平均帧差 MAE', ml + 18, 6);
    ctx.fillStyle = '#2563eb'; ctx.fillRect(ml + 120, 4, 14, 4);
    ctx.fillStyle = '#4b5563'; ctx.fillText('差异像素占比', ml + 138, 6);
  }

  /* ---- 自动归因 ---- */
  function buildNarrative(result, infoA, infoB) {
    var s = result.summary;
    var findings = [];
    var suggestions = [];

    if (s.temporal.concentrated) {
      findings.push('时间分布上，差异并非均匀出现，而是集中在「' + s.temporal.parts[s.temporal.dominantPart].name + '」，其余时间段高度接近。');
    } else {
      findings.push('时间分布上，差异在整条时间轴上较为均匀，没有单独突兀的差异片段。');
    }

    if (s.spatial.localized) {
      findings.push('空间分布上，差异主要集中在画面「' + s.spatial.dominantRegionName + '」，属于局部改动特征，常见于贴片、水印、角标、局部特效或局部遮挡。');
      suggestions.push('重点核对「' + s.spatial.dominantRegionName + '」区域在差异峰值时间点前后的画面，确认是否为预期的局部修改。');
    } else {
      findings.push('空间分布上，差异散布在整个画面而非某一角落，属于全局性变化，常见于重编码、分辨率或码率调整、整体调色、滤镜或降噪。');
    }

    /* 规格归因 */
    if (infoA && infoB) {
      if (infoA.width !== infoB.width || infoA.height !== infoB.height) {
        findings.push('两侧分辨率不同（' + infoA.width + '×' + infoA.height + ' 对 ' + infoB.width + '×' + infoB.height + '），画面经过缩放或重压制，这会带来全画面的像素差异。');
      }
      if (Math.abs((infoA.duration || 0) - (infoB.duration || 0)) > 0.05) {
        findings.push('两侧时长相差 ' + Math.abs(infoA.duration - infoB.duration).toFixed(3) + ' 秒，可能存在片段增删或变速，时间轴已按相对进度对齐，请注意对应关系。');
      }
      if (infoA.fps != null && infoB.fps != null && Math.abs(infoA.fps - infoB.fps) > 0.01) {
        findings.push('两侧帧率不同（' + infoA.fps + ' 对 ' + infoB.fps + ' fps），帧节奏存在差异。');
      }
      if (infoA.codec !== infoB.codec && infoA.codec !== '—' && infoB.codec !== '—') {
        findings.push('两侧编码格式不同（' + infoA.codec + ' 对 ' + infoB.codec + '），属于转码产物。');
      }
      if (s.avgPsnr > 40 && !s.spatial.localized) {
        findings.push('平均 PSNR 达 ' + s.avgPsnr.toFixed(1) + ' dB，虽有全局像素差但数值很高，符合「同源内容、不同压缩参数」的特征，画面内容本身可视为一致。');
        suggestions.push('若用途是确认内容是否被篡改，可优先相信本结论：内容一致，差异主要来自压缩/封装，无需逐帧人工排查。');
      }
    }

    if (s.grade === 'different' || s.grade === 'major') {
      suggestions.push('整体相似度偏低，建议直接查看下方差异热力图与峰值帧，确认内容是否为同一素材。');
    }
    if (!suggestions.length) {
      suggestions.push('对照下方「视频 A / 视频 B / 热力图」三列，复核峰值时间点；热力图越亮代表该位置差异越大。');
    }
    suggestions.push('报告所有数值均由本地像素计算得出，可重复复算；如需更高灵敏度，可在设定页调低差异阈值或增加采样帧数。');

    return { findings: findings, suggestions: suggestions };
  }

  /* ---- 主渲染 ---- */
  function render(container, payload) {
    var result = payload.result;
    var infoA = payload.infoA, infoB = payload.infoB;
    var thumbsA = payload.thumbsA, thumbsB = payload.thumbsB;
    var s = result.summary;
    var gradeMeta = VC.GRADE_META[s.grade];
    var narrative = buildNarrative(result, infoA, infoB);
    var heatMode = payload.heatmapColor || 'red';

    var conclusion = {
      identical: '两个视频在采样范围内画面基本一致，未发现实质性内容差异。',
      minor: '两个视频内容一致，仅存在轻微可感知差异。',
      noticeable: '两个视频存在可明确观察到的差异，但主体内容仍可对应。',
      major: '两个视频存在显著差异，多处画面明显不同。',
      different: '两个视频画面差异很大，可能并非同一素材或经过大幅改动。'
    }[s.grade];

    var metricCard = function (label, value, sub) {
      return '<div class="metric"><div class="metric-label">' + label + '</div>' +
        '<div class="metric-value">' + value + '</div>' +
        (sub ? '<div class="metric-sub">' + sub + '</div>' : '') + '</div>';
    };

    var html = '';
    html += '<div class="report-hero" style="border-left:5px solid ' + gradeMeta.color + ';">';
    html += '<div class="hero-left"><div class="hero-grade" style="color:' + gradeMeta.color + ';">' + gradeMeta.label + '</div>';
    html += '<div class="hero-conclusion">' + conclusion + '</div></div>';
    html += '<div class="hero-score"><div class="score-num">' + s.similarity.toFixed(1) + '</div><div class="score-label">综合相似度 / 100</div></div>';
    html += '</div>';

    html += '<div class="metric-grid">';
    html += metricCard('平均 PSNR', fmtPsnr(s.avgPsnr), '峰值信噪比，越高越接近');
    html += metricCard('平均帧差 MAE', s.avgMae.toFixed(2), '0-255，越低越接近');
    html += metricCard('差异像素占比', U.formatPercent(s.avgDiffRatio), '峰值 ' + U.formatPercent(s.maxDiffRatio));
    html += metricCard('差异最大时间点', U.formatClock(s.maxDiffTimeA), '相对进度 ' + U.formatPercent(s.maxDiffProgress, 0));
    html += metricCard('整体 RMSE', s.rmse.toFixed(2), '基于均方误差');
    html += metricCard('采样 / 对齐帧数', s.pairCount, '按归一化时间一一对应');
    html += '</div>';

    html += '<h5 class="report-h5"><i class="fa-solid fa-magnifying-glass-chart"></i> 差异原因分析</h5><ul class="narrative">';
    narrative.findings.forEach(function (f) { html += '<li>' + f + '</li>'; });
    html += '</ul>';

    html += '<h5 class="report-h5"><i class="fa-solid fa-chart-line"></i> 时间轴差异曲线</h5>';
    html += '<canvas id="diffCurve"></canvas>';

    html += '<h5 class="report-h5"><i class="fa-solid fa-table-list"></i> 逐帧比对指标</h5>';
    html += '<div class="table-wrap"><table class="diff-table"><thead><tr><th>#</th><th>相对位置</th><th>视频 A 时间</th><th>视频 B 时间</th><th>PSNR</th><th>MAE</th><th>差异占比</th></tr></thead><tbody>';
    result.pairs.forEach(function (pr) {
      var rowCls = pr.mae > s.avgMae * 1.4 ? 'row-hot' : '';
      html += '<tr class="' + rowCls + '"><td>' + (pr.index + 1) + '</td><td>' + U.formatPercent(pr.progress, 0) +
        '</td><td>' + U.formatClock(pr.timeA) + '</td><td>' + U.formatClock(pr.timeB) +
        '</td><td>' + fmtPsnr(pr.psnr) + '</td><td>' + pr.mae.toFixed(2) +
        '</td><td>' + U.formatPercent(pr.diffPixelRatio) + '</td></tr>';
    });
    html += '</tbody></table></div>';

    html += '<h5 class="report-h5"><i class="fa-solid fa-layer-group"></i> 帧差异可视化（A / B / 热力图）</h5>';
    html += '<div class="compare-strip-head"><span>视频 A</span><span>视频 B</span><span>差异热力图</span></div>';
    html += '<div class="compare-strip">';
    result.pairs.forEach(function (pr) {
      var heat = heatmapDataUrl(pr.diffMap, pr.width, pr.height, heatMode);
      html += '<div class="strip-row">';
      html += '<img src="' + thumbsA[pr.index].src + '" alt="A">';
      html += '<img src="' + thumbsB[pr.index].src + '" alt="B">';
      html += '<img class="heat" src="' + heat + '" alt="heat">';
      html += '</div>';
    });
    html += '</div>';

    html += '<h5 class="report-h5"><i class="fa-solid fa-circle-check"></i> 处置建议</h5><ul class="narrative">';
    narrative.suggestions.forEach(function (g) { html += '<li>' + g + '</li>'; });
    html += '</ul>';

    container.innerHTML = html;
    var curveCanvas = container.querySelector('#diffCurve');
    if (curveCanvas) drawCurve(curveCanvas, result.curve, s);
  }

  VC.Report = {
    render: render,
    heatmapDataUrl: heatmapDataUrl,
    drawCurve: drawCurve,
    buildNarrative: buildNarrative
  };
})(typeof window !== 'undefined' ? window : globalThis);
