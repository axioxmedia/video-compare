/*
 * 云端 AI 模式：OpenAI 兼容多模态视觉接口。
 * 可配置 base URL / API Key / 模型名，把代表帧发送到云端，返回结构化差异分析。
 * API Key 仅保存在本地数据库，请求直接发往配置的服务。
 */
(function (global) {
  'use strict';

  var VC = global.VC || (global.VC = {});
  if (!VC.AI) VC.AI = {};

  var SYSTEM_PROMPT =
    '你是专业的视频差异分析助手。用户会按顺序给你同一时间点的视频 A 与视频 B 的若干对应帧。' +
    '请逐帧比较两个视频的差异，重点关注：手臂与肢体的位置和姿态、关节角度、动作是否同步、' +
    '人物身份与朝向、场景与物体、画面内的贴片或文字、整体色调。' +
    '只依据画面证据判断，不要编造。必须返回 JSON 对象，结构为：' +
    '{"conclusion":"一句话总体结论","armPosition":{"status":"一致|轻微差异|明显不同","detail":"具体描述手臂位置差异"},' +
    '"bodyDifferences":[{"time":"相对位置或时间","difference":"差异内容"}],"sceneAndObjects":"场景与物体差异",' +
    '"findings":["关键发现"],"suggestions":["可执行建议"]}';

  function endpoint(baseUrl) {
    var b = String(baseUrl || '').trim().replace(/\/+$/, '');
    if (/\/chat\/completions$/.test(b)) return b;
    return b + '/chat/completions';
  }

  function buildMessages(frames) {
    var content = [{
      type: 'text',
      text: '下面是按时间顺序排列的对应帧，每帧已标注来源与相对位置，请比较视频 A 与视频 B 的差异。'
    }];
    frames.forEach(function (f) {
      content.push({ type: 'text', text: '【' + f.label + '，相对位置 ' + f.progress + '】' });
      content.push({ type: 'image_url', image_url: { url: f.src } });
    });
    return [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: content }
    ];
  }

  function parseResponse(payload) {
    var message = payload && payload.choices && payload.choices[0] && payload.choices[0].message;
    if (!message) throw new Error('云端返回结构异常，缺少 choices/message');
    var text = message.content || '';
    try {
      return { parsed: JSON.parse(text), raw: text };
    } catch (e) {
      var match = text.match(/\{[\s\S]*\}/);
      if (match) {
        try { return { parsed: JSON.parse(match[0]), raw: text }; } catch (e2) {}
      }
      return { parsed: { conclusion: text, armPosition: { status: '未知', detail: '' }, bodyDifferences: [], sceneAndObjects: '', findings: [], suggestions: [] }, raw: text };
    }
  }

  async function post(config, body, timeoutMs) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, timeoutMs || 90000);
    var resp;
    try {
      resp = await fetch(endpoint(config.cloudBaseUrl), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + config.cloudApiKey
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } catch (e) {
      clearTimeout(timer);
      if (e.name === 'AbortError') throw new Error('请求超时（' + (timeoutMs / 1000) + ' 秒）');
      throw new Error('网络请求失败：' + e.message);
    }
    clearTimeout(timer);

    var respText = await resp.text();
    if (!resp.ok) {
      throw new Error('云端返回 HTTP ' + resp.status + '：' + respText.slice(0, 300));
    }
    var json;
    try { json = JSON.parse(respText); } catch (e) {
      throw new Error('云端响应不是有效 JSON');
    }
    return json;
  }

  async function analyze(params) {
    var config = params.config || {};
    if (!config.cloudBaseUrl) throw new Error('请先填写接口地址');
    if (!config.cloudApiKey) throw new Error('请先填写 API Key');
    if (!config.cloudModel) throw new Error('请先填写模型名称');
    if (!params.frames || !params.frames.length) throw new Error('没有可发送的帧');

    var body = {
      model: config.cloudModel,
      messages: buildMessages(params.frames),
      temperature: 0.2
    };
    var json = await post(config, body, params.timeoutMs || 90000);
    var result = parseResponse(json);
    return result.parsed;
  }

  async function testConnection(config) {
    if (!config.cloudBaseUrl) throw new Error('请先填写接口地址');
    if (!config.cloudApiKey) throw new Error('请先填写 API Key');
    if (!config.cloudModel) throw new Error('请先填写模型名称');
    var body = {
      model: config.cloudModel,
      messages: [{ role: 'user', content: 'ping，请回复 pong' }],
      max_tokens: 10
    };
    var json = await post(config, body, 20000);
    return json && json.choices ? '连接成功，接口与密钥可用' : '连接异常';
  }

  VC.AI.CloudApi = {
    analyze: analyze,
    testConnection: testConnection,
    endpoint: endpoint
  };
})(typeof window !== 'undefined' ? window : globalThis);
