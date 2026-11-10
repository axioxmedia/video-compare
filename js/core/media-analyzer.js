/*
 * 媒体解析：mp4box 优先（纯 JS，file:// 稳定），mediainfo WASM 兜底。
 * 输出统一的技术参数对象。
 */
(function (global) {
  'use strict';

  var VC = global.VC || (global.VC = {});
  var U = VC.Util;

  var mediaInfoReady = null;

  function initMediaInfo() {
    if (mediaInfoReady) return mediaInfoReady;
    mediaInfoReady = new Promise(function (resolve) {
      /* file:// 下 WASM 会被 CORS 拦截，直接跳过，由纯 JS 的 mp4box 承担解析 */
      if (location.protocol === 'file:' ||
        typeof MediaInfo === 'undefined' || !MediaInfo.mediaInfoFactory) {
        resolve(null);
        return;
      }
      MediaInfo.mediaInfoFactory({
        format: 'object',
        locateFile: function (path) {
          if (path.indexOf('.wasm') !== -1) return 'vendor/mediainfo/MediaInfoModule.wasm';
          return path;
        }
      }, function (mi) { resolve(mi); }, function (err) {
        console.error('MediaInfo init error', err);
        resolve(null);
      });
    });
    return mediaInfoReady;
  }

  function fallbackInfo(file, videoEl) {
    return {
      source: 'video-element',
      name: file.name, size: file.size, lastModified: file.lastModified,
      width: videoEl.videoWidth || 0, height: videoEl.videoHeight || 0,
      duration: videoEl.duration || 0, fps: null, frameCount: null,
      aspect: U.aspectRatio(videoEl.videoWidth, videoEl.videoHeight),
      bitrate: '—', codec: '—', frameRateMode: '—'
    };
  }

  /* ---- mp4box ---- */
  function analyzeWithMp4box(file) {
    return new Promise(function (resolve) {
      if (typeof MP4Box === 'undefined') { resolve(null); return; }
      var mp4 = MP4Box.createFile();
      var done = false;
      var finish = function (info) {
        if (done) return;
        done = true;
        resolve(info);
      };
      mp4.onError = function () { finish(null); };
      mp4.onReady = function (info) { finish(info); };

      function feed(buffer) {
        buffer.fileStart = 0;
        try {
          mp4.appendBuffer(buffer);
          mp4.flush();
        } catch (e) { finish(null); }
      }

      var head = new FileReader();
      head.onload = function (e) {
        feed(e.target.result);
        if (done) return;
        /* moov 可能在文件尾，读全文件再试 */
        setTimeout(function () {
          if (done) return;
          var full = new FileReader();
          full.onload = function (ev) {
            feed(ev.target.result);
            setTimeout(function () { finish(null); }, 600);
          };
          full.onerror = function () { finish(null); };
          full.readAsArrayBuffer(file);
        }, 250);
      };
      head.onerror = function () { finish(null); };
      head.readAsArrayBuffer(file.slice(0, Math.min(file.size, 4 * 1024 * 1024)));
    });
  }

  function extractFromMp4box(info, file, videoEl) {
    var fb = fallbackInfo(file, videoEl);
    if (!info || !info.tracks) return fb;
    var vtrack = info.tracks.find(function (t) { return t.video; }) ||
      (info.videoTracks && info.videoTracks[0]);
    if (!vtrack) return fb;

    var nb = vtrack.nb_samples || 0;
    var timescale = vtrack.timescale || 1;
    var trackDur = vtrack.duration || 0;
    var durSec = trackDur / timescale;
    var fps = nb && durSec ? nb / durSec : null;
    var width = (vtrack.video && vtrack.video.width) || vtrack.track_width || videoEl.videoWidth;
    var height = (vtrack.video && vtrack.video.height) || vtrack.track_height || videoEl.videoHeight;

    return {
      source: 'mp4box',
      name: file.name, size: file.size, lastModified: file.lastModified,
      width: Math.round(width), height: Math.round(height),
      duration: durSec || videoEl.duration || 0,
      fps: fps ? U.round(fps, 3) : null,
      frameCount: nb || null,
      aspect: U.aspectRatio(Math.round(width), Math.round(height)),
      bitrate: vtrack.bitrate ? U.round(vtrack.bitrate / 1000, 0) + ' kbps' : '—',
      codec: vtrack.codec || '—',
      frameRateMode: 'CFR（按样本数计算）'
    };
  }

  /* ---- mediainfo ---- */
  function extractFromMediaInfo(result, file, videoEl) {
    var fb = fallbackInfo(file, videoEl);
    if (!result || !result.media || !Array.isArray(result.media.track)) return fb;
    var tracks = result.media.track;
    var general = tracks.find(function (t) { return t['@type'] === 'General'; }) || {};
    var video = tracks.find(function (t) { return t['@type'] === 'Video'; }) || {};

    var fps = parseFloat(video.FrameRate) || null;
    var frameCount = parseInt(video.FrameCount, 10) || null;
    var duration = parseFloat(general.Duration) || videoEl.duration || 0;
    var width = parseInt(video.Width, 10) || videoEl.videoWidth;
    var height = parseInt(video.Height, 10) || videoEl.videoHeight;

    return {
      source: 'mediainfo',
      name: file.name, size: file.size, lastModified: file.lastModified,
      width: width, height: height, duration: duration,
      fps: fps ? U.round(fps, 3) : null,
      frameCount: frameCount,
      aspect: U.aspectRatio(width, height),
      bitrate: general.OverallBitRate ? U.round(parseInt(general.OverallBitRate, 10) / 1000, 0) + ' kbps' : '—',
      codec: video.Format || video.CodecID || '—',
      frameRateMode: video.FrameRate_Mode || '—'
    };
  }

  async function analyzeFile(file) {
    var mp4info = await analyzeWithMp4box(file);
    if (mp4info && mp4info.tracks) return { source: 'mp4box', data: mp4info };

    var mi = await initMediaInfo();
    if (!mi) return null;
    try {
      var readChunk = function (chunkSize, offset) {
        return file.slice(offset, offset + chunkSize).arrayBuffer().then(function (buf) {
          return new Uint8Array(buf);
        });
      };
      var result = await mi.analyzeData(file.size, readChunk);
      return { source: 'mediainfo', data: result };
    } catch (e) {
      console.error(e);
      return null;
    }
  }

  function extractVideoInfo(result, file, videoEl) {
    if (!result) return fallbackInfo(file, videoEl);
    if (result.source === 'mp4box') return extractFromMp4box(result.data, file, videoEl);
    if (result.source === 'mediainfo') return extractFromMediaInfo(result.data, file, videoEl);
    return fallbackInfo(file, videoEl);
  }

  VC.MediaAnalyzer = {
    init: initMediaInfo,
    analyzeFile: analyzeFile,
    extractVideoInfo: extractVideoInfo,
    fallbackInfo: fallbackInfo
  };
})(typeof window !== 'undefined' ? window : globalThis);
