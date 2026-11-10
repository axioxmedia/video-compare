/* 公共工具与默认配置：无外部依赖，file:// 与 node 均可运行 */
(function (global) {
  'use strict';

  var VC = global.VC || (global.VC = {});

  var Util = {
    clamp: function (v, min, max) { return Math.min(max, Math.max(min, v)); },
    lerp: function (a, b, t) { return a + (b - a) * t; },

    gcd: function (a, b) {
      a = Math.abs(Math.round(a)); b = Math.abs(Math.round(b));
      while (b) { var t = b; b = a % b; a = t; }
      return a || 1;
    },
    aspectRatio: function (w, h) {
      if (!w || !h) return '—';
      var g = Util.gcd(w, h);
      return Math.round(w / g) + ':' + Math.round(h / g);
    },

    formatBytes: function (bytes) {
      if (!bytes && bytes !== 0) return '—';
      var units = ['B', 'KB', 'MB', 'GB', 'TB'];
      var i = 0;
      while (bytes >= 1024 && i < units.length - 1) { bytes /= 1024; i++; }
      return bytes.toFixed(i === 0 ? 0 : 2) + ' ' + units[i];
    },

    /* 秒 -> 00:00.000 */
    formatClock: function (sec) {
      if (sec == null || isNaN(sec)) return '—';
      sec = Math.max(0, sec);
      var h = Math.floor(sec / 3600);
      var m = Math.floor((sec % 3600) / 60);
      var s = Math.floor(sec % 60);
      var ms = Math.round((sec - Math.floor(sec)) * 1000);
      var pad = function (n) { return String(n).padStart(2, '0'); };
      var text = pad(m) + ':' + pad(s);
      if (h) text = pad(h) + ':' + text;
      return text + '.' + String(ms).padStart(3, '0');
    },

    formatPercent: function (ratio, digits) {
      if (ratio == null || isNaN(ratio)) return '—';
      return (ratio * 100).toFixed(digits == null ? 1 : digits) + '%';
    },

    formatDate: function (ts) {
      if (!ts) return '—';
      return new Date(ts).toLocaleString('zh-CN', { hour12: false });
    },

    escapeHtml: function (str) {
      return String(str == null ? '' : str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    },

    round: function (n, digits) {
      if (n == null || isNaN(n)) return null;
      var f = Math.pow(10, digits || 0);
      return Math.round(n * f) / f;
    },

    mean: function (arr) {
      if (!arr || !arr.length) return 0;
      var sum = 0;
      for (var i = 0; i < arr.length; i++) sum += arr[i];
      return sum / arr.length;
    },
    max: function (arr) {
      return arr.length ? Math.max.apply(null, arr) : 0;
    },
    min: function (arr) {
      return arr.length ? Math.min.apply(null, arr) : 0;
    }
  };

  VC.Util = Util;

  /* 全局默认分析参数（可被设置页覆盖并持久化） */
  VC.DEFAULTS = {
    sampleCount: 12,          // 时间轴采样/对齐帧数
    analysisWidth: 320,       // 统一分析分辨率（宽）
    analysisHeight: 180,      // 统一分析分辨率（高）
    diffThreshold: 25,        // 差异像素判定阈值（灰度差 0-255）
    spatialGrid: 3,           // 空间差异分区（3×3）
    autoRestore: true,        // 重开自动恢复上次会话
    heatmapColor: 'red',      // 热力图配色：red / thermal

    /* AI 进阶分析（默认关闭） */
    aiEnabled: false,         // 总开关
    aiMode: 'local',          // local 本地模型 / cloud 云端 API
    modelVariant: 'lightning',// lightning / thunder
    modelAutoLoad: true,      // 下次开启自动加载已下载模型
    cloudBaseUrl: '',         // OpenAI 兼容接口地址
    cloudApiKey: '',          // API Key
    cloudModel: ''            // 云端模型名
  };

  VC.GRADE_META = {
    identical:  { label: '基本一致', color: '#16a34a' },
    minor:      { label: '轻微差异', color: '#65a30d' },
    noticeable: { label: '明显差异', color: '#d97706' },
    major:      { label: '显著差异', color: '#ea580c' },
    different:  { label: '内容不同', color: '#dc2626' }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Util;
})(typeof window !== 'undefined' ? window : globalThis);
