/* AI 报告渲染：本地姿态结果与云端语义结果。 */
(function (global) {
  'use strict';

  var VC = global.VC || (global.VC = {});
  if (!VC.AI) VC.AI = {};
  var U = VC.Util;

  function armGrade(v) {
    if (v == null) return { label: '未检测到可靠人体', color: '#6b7280' };
    if (v < 0.02) return { label: '手臂位置基本一致', color: '#16a34a' };
    if (v < 0.05) return { label: '手臂位置轻微差异', color: '#65a30d' };
    if (v < 0.12) return { label: '手臂位置明显差异', color: '#d97706' };
    return { label: '手臂位置显著不同', color: '#dc2626' };
  }

  function metricCard(label, value, sub) {
    return '<div class="metric"><div class="metric-label">' + label + '</div>' +
      '<div class="metric-value">' + value + '</div>' +
      (sub ? '<div class="metric-sub">' + sub + '</div>' : '') + '</div>';
  }

  function renderLocal(out) {
    var s = out.poseResult.summary;
    var grade = armGrade(s.avgWristDisp);
    var html = '';

    html += '<div class="ai-report-wrap">';
    html += '<div class="report-hero" style="border-left:5px solid ' + grade.color + ';">';
    html += '<div class="hero-left"><div class="hero-grade" style="color:' + grade.color + '">' +
      grade.label + '</div>';
    html += '<div class="hero-conclusion">本地 MoveNet 逐帧姿态比对（' + out.variant + '，17 关键点），' +
      '在 ' + s.personFrameCount + '/' + s.totalFrames + ' 帧可靠检测到人体。</div></div></div>';

    html += '<div class="metric-grid">';
    html += metricCard('平均手腕位移', s.avgWristDisp == null ? '—' : U.formatPercent(s.avgWristDisp, 2),
      '归一化画面坐标，越小越接近');
    html += metricCard('最大手腕位移', s.maxWristDisp == null ? '—' : U.formatPercent(s.maxWristDisp, 2),
      '出现于相对位置 ' + U.formatPercent(s.maxWristProgress, 0));
    html += metricCard('整体关键点位移', s.avgDisplacement == null ? '—' : U.formatPercent(s.avgDisplacement, 2),
      '全部 17 点平均');
    html += metricCard('可靠人体帧', s.personFrameCount + ' / ' + s.totalFrames, '置信度阈值 0.3');
    html += '</div>';

    /* 手臂逐指标（取所有帧平均） */
    html += '<h5 class="report-h5"><i class="fa-solid fa-person-walking"></i> 手臂与关节差异（全帧平均）</h5>';
    var pairs = out.poseResult.pairs;
    function avgOf(sel) {
      var vals = pairs.map(sel).filter(function (x) { return x != null; });
      return vals.length ? vals.reduce(function (a, b) { return a + b; }, 0) / vals.length : null;
    }
    function pct(v) { return v == null ? '—' : U.formatPercent(v, 2); }
    function ang(v) { return v == null ? '—' : v.toFixed(1) + '°'; }

    html += '<div class="table-wrap"><table class="diff-table"><thead><tr><th>部位 / 指标</th><th>左</th><th>右</th></tr></thead><tbody>';
    html += '<tr><td>手腕位置位移</td><td>' + pct(avgOf(function (p) { return p.arm.leftWrist; })) +
      '</td><td>' + pct(avgOf(function (p) { return p.arm.rightWrist; })) + '</td></tr>';
    html += '<tr><td>肘部位置位移</td><td>' + pct(avgOf(function (p) { return p.arm.leftElbow; })) +
      '</td><td>' + pct(avgOf(function (p) { return p.arm.rightElbow; })) + '</td></tr>';
    html += '<tr><td>肩部位置位移</td><td>' + pct(avgOf(function (p) { return p.arm.leftShoulder; })) +
      '</td><td>' + pct(avgOf(function (p) { return p.arm.rightShoulder; })) + '</td></tr>';
    html += '<tr><td>肘关节角度差</td><td>' + ang(avgOf(function (p) { return p.arm.leftElbowAngle; })) +
      '</td><td>' + ang(avgOf(function (p) { return p.arm.rightElbowAngle; })) + '</td></tr>';
    html += '</tbody></table></div>';

    /* 骨架可视化：A 骨架 / B 骨架 / 叠加 */
    html += '<h5 class="report-h5"><i class="fa-solid fa-layer-group"></i> 骨架对比（绿=A，红=B）</h5>';
    html += '<div class="compare-strip-head"><span>视频 A 骨架</span><span>视频 B 骨架</span><span>A/B 叠加（看手臂位置差）</span></div>';
    html += '<div class="compare-strip">';
    out.visuals.forEach(function (v) {
      html += '<div class="strip-row"><img src="' + v.skelA + '"><img src="' + v.skelB +
        '"><img src="' + v.overlay + '"></div>';
    });
    html += '</div></div>';
    return html;
  }

  function renderCloud(out) {
    var r = out.result || {};
    var html = '<div class="ai-report-wrap">';
    html += '<div class="report-hero"><div class="hero-left"><div class="hero-grade">云端 AI 语义分析</div>';
    html += '<div class="hero-conclusion">' + U.escapeHtml(r.conclusion || '') + '</div></div></div>';

    if (r.armPosition) {
      html += '<h5 class="report-h5"><i class="fa-solid fa-person-walking"></i> 手臂位置</h5>';
      html += '<p><strong>' + U.escapeHtml(r.armPosition.status || '') + '：</strong>' +
        U.escapeHtml(r.armPosition.detail || '') + '</p>';
    }
    if (r.bodyDifferences && r.bodyDifferences.length) {
      html += '<h5 class="report-h5"><i class="fa-solid fa-table-list"></i> 肢体差异</h5>';
      html += '<div class="table-wrap"><table class="diff-table"><thead><tr><th>时间 / 位置</th><th>差异内容</th></tr></thead><tbody>';
      r.bodyDifferences.forEach(function (d) {
        html += '<tr><td>' + U.escapeHtml(d.time || '') + '</td><td>' +
          U.escapeHtml(d.difference || '') + '</td></tr>';
      });
      html += '</tbody></table></div>';
    }
    if (r.sceneAndObjects) {
      html += '<h5 class="report-h5"><i class="fa-solid fa-cube"></i> 场景与物体</h5><p>' +
        U.escapeHtml(r.sceneAndObjects) + '</p>';
    }
    if (r.findings && r.findings.length) {
      html += '<h5 class="report-h5"><i class="fa-solid fa-magnifying-glass"></i> 关键发现</h5><ul class="narrative">';
      r.findings.forEach(function (f) { html += '<li>' + U.escapeHtml(f) + '</li>'; });
      html += '</ul>';
    }
    if (r.suggestions && r.suggestions.length) {
      html += '<h5 class="report-h5"><i class="fa-solid fa-circle-check"></i> 建议</h5><ul class="narrative">';
      r.suggestions.forEach(function (g) { html += '<li>' + U.escapeHtml(g) + '</li>'; });
      html += '</ul>';
    }
    html += '</div>';
    return html;
  }

  function render(container, out) {
    var html = '<h5 class="report-h5"><i class="fa-solid fa-wand-magic-sparkles"></i> AI 进阶分析报告</h5>';
    html += out.mode === 'cloud' ? renderCloud(out) : renderLocal(out);
    /* 保留现有基础报告，追加 AI 分区 */
    container.insertAdjacentHTML('beforeend', '<div class="ai-extra">' + html + '</div>');
  }

  VC.AI.AIReport = { render: render, renderLocal: renderLocal, renderCloud: renderCloud };
})(typeof window !== 'undefined' ? window : globalThis);
