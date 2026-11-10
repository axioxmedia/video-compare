/*
 * 抽帧：按归一化时间进度对齐，输出
 *  - analysis：统一分析尺寸的像素帧（contain 留黑边，不拉伸），供差异引擎计算
 *  - thumbs：保持宽高比的缩略图 dataURL，供界面展示与持久化
 */
(function (global) {
  'use strict';

  var VC = global.VC || (global.VC = {});
  var THUMB_WIDTH = 320;
  var SEEK_TIMEOUT = 3000;

  function seekTo(video, t) {
    return new Promise(function (resolve) {
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        video.removeEventListener('seeked', onSeek);
        resolve(false); /* 超时也继续，避免整体卡死 */
      }, SEEK_TIMEOUT);

      function onSeek() {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(true);
      }

      if (Math.abs(video.currentTime - t) < 0.001) { onSeek(); return; }
      video.addEventListener('seeked', onSeek);
      video.currentTime = t;
    });
  }

  function drawContain(ctx, video, aw, ah) {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, aw, ah);
    var vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return;
    var scale = Math.min(aw / vw, ah / vh);
    var dw = vw * scale, dh = vh * scale;
    ctx.drawImage(video, (aw - dw) / 2, (ah - dh) / 2, dw, dh);
  }

  async function extractAll(video, n, aw, ah) {
    var analysisCanvas = document.createElement('canvas');
    analysisCanvas.width = aw; analysisCanvas.height = ah;
    var actx = analysisCanvas.getContext('2d', { willReadFrequently: true });

    var thumbH = Math.round(THUMB_WIDTH * (video.videoHeight || 9) / (video.videoWidth || 16));
    var thumbCanvas = document.createElement('canvas');
    thumbCanvas.width = THUMB_WIDTH; thumbCanvas.height = thumbH;
    var tctx = thumbCanvas.getContext('2d');

    var dur = video.duration || 0;
    var analysis = [];
    var thumbs = [];

    for (var i = 0; i < n; i++) {
      var progress = (i + 0.5) / n;
      var t = Math.min(progress * dur, Math.max(0, dur - 0.02));
      await seekTo(video, t);

      drawContain(actx, video, aw, ah);
      var img = actx.getImageData(0, 0, aw, ah);
      analysis.push({
        width: aw, height: ah, data: img.data,
        time: video.currentTime, progress: progress
      });

      tctx.fillStyle = '#000';
      tctx.fillRect(0, 0, THUMB_WIDTH, thumbH);
      tctx.drawImage(video, 0, 0, THUMB_WIDTH, thumbH);
      thumbs.push({
        src: thumbCanvas.toDataURL('image/jpeg', 0.7),
        time: video.currentTime, progress: progress
      });
    }

    await seekTo(video, 0);
    return { analysis: analysis, thumbs: thumbs };
  }

  VC.FrameExtractor = {
    extractAll: extractAll,
    seekTo: seekTo,
    drawContain: drawContain
  };
})(typeof window !== 'undefined' ? window : globalThis);
