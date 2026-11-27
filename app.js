(() => {
  'use strict';

  /* ------------------------------------------------------------------ *
   * DX-BT24：默认 Service FFE0，Notify/Write FFE1，Write FFE2。
   * 这些 UUID 来自模块手册；FFE1 同时支持通知和写入。
   * ------------------------------------------------------------------ */
  const BLE = {
    service: '0000ffe0-0000-1000-8000-00805f9b34fb',
    char: '0000ffe1-0000-1000-8000-00805f9b34fb',
    writeChar: '0000ffe2-0000-1000-8000-00805f9b34fb',
  };

  /* 与固件 bsp_motor.c / bsp_debug.c 中的参数范围一致 */
  const PARAM_DEFS = [
    { key: 'ARM', name: '预励磁', min: 0, max: 1000, step: 1, def: 100 },
    { key: 'ARMMS', name: '预励磁时间', min: 0, max: 5000, step: 1, def: 150 },
    { key: 'BRK', name: '死点占空比', min: 0, max: 1000, step: 1, def: 300 },
    { key: 'BRKMS', name: '爬升时间', min: 1, max: 10000, step: 1, def: 600 },
    { key: 'SMS', name: 'S 曲线时间', min: 1, max: 10000, step: 1, def: 1200 },
    { key: 'SLEW', name: '运行过渡', min: 1, max: 10000, step: 1, def: 800 },
  ];

  const ST_MAP = {
    0: ['停止', ''],
    1: ['启动中', 'run'],
    2: ['到目标', 'ready'],
  };

  const CHART_WINDOW_MS = 60000;
  const decoder = new TextDecoder('utf-8');
  const encoder = new TextEncoder();

  const state = {
    device: null,
    server: null,
    service: null,
    rxChar: null,
    txChar: null,
    connected: false,
    connecting: false,
    locked: false,
    streaming: false,
    rate: 200,
    rxBuffer: '',
    txChain: Promise.resolve(),
    history: [],
    lastStatus: null,
  };

  const $ = (id) => document.getElementById(id);

  const els = {
    unsupported: $('unsupported'),
    connBadge: $('connBadge'),
    connectBtn: $('connectBtn'),
    disconnectBtn: $('disconnectBtn'),
    allDevices: $('allDevices'),
    dutyVal: $('dutyVal'),
    tgtVal: $('tgtVal'),
    ccrVal: $('ccrVal'),
    stateChip: $('stateChip'),
    lockChip: $('lockChip'),
    streamChip: $('streamChip'),
    lastUpdate: $('lastUpdate'),
    sumArm: $('sumArm'),
    sumArmMs: $('sumArmMs'),
    sumBrk: $('sumBrk'),
    sumBrkMs: $('sumBrkMs'),
    sumSms: $('sumSms'),
    sumSlew: $('sumSlew'),
    chart: $('chart'),
    chartEmpty: $('chartEmpty'),
    sampleInfo: $('sampleInfo'),
    params: $('params'),
    applyBtn: $('applyBtn'),
    saveBtn: $('saveBtn'),
    readBtn: $('readBtn'),
    defaultBtn: $('defaultBtn'),
    lockHint: $('lockHint'),
    rateSelect: $('rateSelect'),
    streamOnBtn: $('streamOnBtn'),
    streamOffBtn: $('streamOffBtn'),
    getBtn: $('getBtn'),
    rawCmd: $('rawCmd'),
    rawSendBtn: $('rawSendBtn'),
    log: $('log'),
    clearLogBtn: $('clearLogBtn'),
    toast: $('toast'),
  };

  const chartCtx = els.chart.getContext('2d');
  let chartSize = { w: 0, h: 0, dpr: 1 };
  let toastTimer = 0;

  /* ------------------------------------------------------------------ *
   * 基础工具
   * ------------------------------------------------------------------ */

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function fmt(value) {
    return Number.isFinite(value) ? String(Math.round(value)) : '--';
  }

  function nowText() {
    return new Date().toLocaleTimeString('zh-CN', { hour12: false });
  }

  function toast(message, isError = false) {
    els.toast.textContent = message;
    els.toast.classList.toggle('error', Boolean(isError));
    els.toast.classList.add('show');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      els.toast.classList.remove('show');
    }, 2600);
  }

  function log(kind, text) {
    const line = document.createElement('div');
    line.className = `log-line log-${String(kind).toLowerCase()}`;

    const time = document.createElement('span');
    time.className = 'log-time';
    time.textContent = nowText();

    const tag = document.createElement('span');
    tag.className = 'log-kind';
    tag.textContent = kind;

    const body = document.createElement('span');
    body.className = 'log-text';
    body.textContent = text;

    line.append(time, tag, body);
    els.log.appendChild(line);

    while (els.log.children.length > 260) {
      els.log.removeChild(els.log.firstChild);
    }
    els.log.scrollTop = els.log.scrollHeight;
  }

  function formatError(err) {
    if (!err) return '未知错误';
    if (err.name === 'NotFoundError') return '没有找到设备或已取消选择';
    if (err.name === 'SecurityError') return '需要 HTTPS、蓝牙权限和用户点击';
    if (err.name === 'NetworkError') return '连接失败，设备可能已被占用或距离太远';
    if (err.name === 'InvalidStateError') return '手机蓝牙未开启';
    if (err.name === 'NotSupportedError') return '该设备不支持所需 BLE 特征';
    return err.message || String(err);
  }

  /* ------------------------------------------------------------------ *
   * 参数 UI
   * ------------------------------------------------------------------ */

  function buildParams() {
    const fragment = document.createDocumentFragment();

    for (const def of PARAM_DEFS) {
      const row = document.createElement('div');
      row.className = 'param';
      row.dataset.key = def.key;

      const label = document.createElement('div');
      label.className = 'param-label';
      label.innerHTML = `<b>${def.key}</b><span>${def.name}</span>`;

      const range = document.createElement('input');
      range.type = 'range';
      range.className = 'param-range';
      range.min = String(def.min);
      range.max = String(def.max);
      range.step = String(def.step);
      range.value = String(def.def);
      range.setAttribute('aria-label', `${def.key} ${def.name}`);

      const number = document.createElement('input');
      number.type = 'number';
      number.className = 'param-number';
      number.min = String(def.min);
      number.max = String(def.max);
      number.step = String(def.step);
      number.value = String(def.def);
      number.inputMode = 'numeric';
      number.setAttribute('aria-label', `${def.key} 数值`);

      range.addEventListener('input', () => {
        number.value = range.value;
      });

      number.addEventListener('input', () => {
        if (number.value !== '') {
          range.value = number.value;
        }
      });

      number.addEventListener('change', () => {
        const value = clamp(
          Number(number.value) || def.min,
          def.min,
          def.max,
        );
        number.value = String(Math.round(value));
        range.value = String(Math.round(value));
      });

      row.append(label, range, number);
      fragment.appendChild(row);
    }

    els.params.appendChild(fragment);
  }

  function paramRow(key) {
    return els.params.querySelector(`.param[data-key="${key}"]`);
  }

  function readParams() {
    const values = {};

    for (const def of PARAM_DEFS) {
      const row = paramRow(def.key);
      const input = row ? row.querySelector('.param-number') : null;
      const raw = input ? Number(input.value) : def.def;
      values[def.key] = Math.round(
        clamp(Number.isFinite(raw) ? raw : def.def, def.min, def.max),
      );
    }

    return values;
  }

  function setParamValues(status) {
    for (const def of PARAM_DEFS) {
      const value = status[def.key];
      if (!Number.isFinite(value)) continue;

      const row = paramRow(def.key);
      if (!row) continue;

      // 用户正在输入时不要抢走光标/数值
      if (row.contains(document.activeElement)) continue;

      const range = row.querySelector('.param-range');
      const number = row.querySelector('.param-number');
      range.value = String(value);
      number.value = String(value);
    }
  }

  /* ------------------------------------------------------------------ *
   * 连接状态 / 控件状态
   * ------------------------------------------------------------------ */

  function setChip(el, text, className = '') {
    el.textContent = text;
    el.className = `chip${className ? ` ${className}` : ''}`;
  }

  function updateControls() {
    const connected = state.connected;

    els.connectBtn.disabled = connected || state.connecting;
    els.connectBtn.textContent = state.connecting ? '连接中…' : '连接蓝牙';
    els.disconnectBtn.disabled = !connected;
    els.allDevices.disabled = connected || state.connecting;

    if (state.connecting) {
      els.connBadge.textContent = '连接中';
      els.connBadge.className = 'badge badge-busy';
    } else if (connected) {
      els.connBadge.textContent = state.device?.name || '已连接';
      els.connBadge.className = 'badge badge-on';
    } else {
      els.connBadge.textContent = '未连接';
      els.connBadge.className = 'badge badge-off';
    }

    const paramsDisabled = !connected || state.locked;
    els.params.querySelectorAll('input').forEach((input) => {
      input.disabled = paramsDisabled;
    });

    els.applyBtn.disabled = paramsDisabled;
    els.saveBtn.disabled = paramsDisabled;
    els.defaultBtn.disabled = paramsDisabled;
    els.readBtn.disabled = !connected;
    els.getBtn.disabled = !connected;
    els.streamOnBtn.disabled = !connected || state.streaming;
    els.streamOffBtn.disabled = !connected || !state.streaming;
    els.rateSelect.disabled = !connected;
    els.rawCmd.disabled = !connected;
    els.rawSendBtn.disabled = !connected;

    if (!connected) {
      els.lockHint.textContent = '连接后可修改';
    } else if (state.locked) {
      els.lockHint.textContent = '已发车，参数已锁定';
    } else {
      els.lockHint.textContent = '连接后可修改';
    }

    setChip(
      els.lockChip,
      !connected ? 'LOCK --' : state.locked ? 'LOCK 已锁' : 'LOCK 可设',
      !connected ? '' : state.locked ? 'danger' : 'ready',
    );

    setChip(
      els.streamChip,
      !connected ? 'STREAM --' : state.streaming ? 'STREAM 开' : 'STREAM 关',
      !connected ? '' : state.streaming ? 'run' : '',
    );

    if (!connected) {
      setChip(els.stateChip, 'ST --');
      els.dutyVal.textContent = '--';
      els.tgtVal.textContent = '--';
      els.ccrVal.textContent = '--';
    }
  }

  function setLocked(locked) {
    const next = Boolean(locked) && state.connected;
    if (state.locked === next) return;
    state.locked = next;
    updateControls();
  }

  /* ------------------------------------------------------------------ *
   * 蓝牙
   * ------------------------------------------------------------------ */

  async function getService(server) {
    try {
      return await server.getPrimaryService(BLE.service);
    } catch (err) {
      // 某些浏览器/固件只接受 16-bit UUID
      return server.getPrimaryService(0xffe0);
    }
  }

  async function getCharacteristic(service, uuid) {
    try {
      return await service.getCharacteristic(uuid);
    } catch (err) {
      const short = parseInt(uuid.slice(4, 8), 16);
      return service.getCharacteristic(short);
    }
  }

  async function connect() {
    if (state.connected || state.connecting) return;

    if (!navigator.bluetooth) {
      showUnsupported();
      toast('当前浏览器不支持 Web Bluetooth', true);
      return;
    }

    state.connecting = true;
    updateControls();

    try {
      const options = els.allDevices.checked
        ? {
            acceptAllDevices: true,
            optionalServices: [BLE.service],
          }
        : {
            filters: [
              { namePrefix: 'BT24' },
              { namePrefix: 'DX-BT24' },
              { namePrefix: 'DX' },
            ],
            optionalServices: [BLE.service],
          };

      const device = await navigator.bluetooth.requestDevice(options);
      state.device = device;
      device.addEventListener('gattserverdisconnected', onDisconnected);

      const server = await device.gatt.connect();
      const service = await getService(server);
      const rxChar = await getCharacteristic(service, BLE.char);

      if (!rxChar.properties.notify && !rxChar.properties.indicate) {
        throw new Error('FFE1 不支持 Notify，请确认模块固件/特征 UUID');
      }

      let txChar = rxChar;
      if (!rxChar.properties.write && !rxChar.properties.writeWithoutResponse) {
        txChar = await getCharacteristic(service, BLE.writeChar);
      }

      await rxChar.startNotifications();
      rxChar.addEventListener('characteristicvaluechanged', onNotify);

      state.server = server;
      state.service = service;
      state.rxChar = rxChar;
      state.txChar = txChar;
      state.connected = true;
      state.connecting = false;
      state.rxBuffer = '';
      state.history = [];
      state.lastStatus = null;
      state.locked = false;

      els.chartEmpty.classList.remove('hidden');
      els.sampleInfo.textContent = '0 个采样';
      updateControls();
      drawChart();

      log('SYS', `已连接 ${device.name || 'BLE 设备'}`);
      toast('蓝牙已连接');

      // 先停掉上一次可能仍在跑的流，再建立本次会话
      await sleep(120);
      await send('STREAM 0');
      await send('RATE 200');
      await send('STREAM 1');
      await send('GET');
    } catch (err) {
      state.connecting = false;
      state.connected = false;
      state.server = null;
      state.service = null;
      state.rxChar = null;
      state.txChar = null;
      state.device = null;
      updateControls();
      log('ERR', formatError(err));
      toast(formatError(err), true);
    }
  }

  function disconnect() {
    if (state.device?.gatt?.connected) {
      state.device.gatt.disconnect();
    } else {
      onDisconnected();
    }
  }

  function onDisconnected() {
    const wasConnected = state.connected;

    state.connected = false;
    state.connecting = false;
    state.locked = false;
    state.streaming = false;
    state.server = null;
    state.service = null;
    state.rxChar = null;
    state.txChar = null;
    state.device = null;
    state.rxBuffer = '';
    state.txChain = Promise.resolve();

    updateControls();
    setChip(els.stateChip, 'ST --');

    if (wasConnected) {
      log('SYS', '蓝牙已断开');
      toast('蓝牙已断开');
    }
  }

  async function send(line) {
    const text = String(line ?? '').trim();
    if (!text) return;

    if (!state.connected || !state.txChar) {
      toast('尚未连接蓝牙', true);
      return;
    }

    const data = encoder.encode(`${text}\n`);

    state.txChain = state.txChain
      .then(async () => {
        try {
          if (state.txChar.properties.writeWithoutResponse) {
            await state.txChar.writeValueWithoutResponse(data);
          } else {
            await state.txChar.writeValue(data);
          }
        } catch (err) {
          // 某些手机只允许带响应写；再试一次
          if (state.txChar.properties.write) {
            await state.txChar.writeValue(data);
          } else {
            throw err;
          }
        }

        log('TX', text);
        await sleep(35);
      })
      .catch((err) => {
        // 保持链继续，避免一次失败后所有命令都卡死
        log('ERR', `发送失败: ${err.message || err}`);
      });

    return state.txChain;
  }

  /* ------------------------------------------------------------------ *
   * 接收与协议解析
   * ------------------------------------------------------------------ */

  function onNotify(event) {
    const value = event.target.value;
    if (!value) return;

    state.rxBuffer += decoder.decode(value);

    if (state.rxBuffer.length > 8192) {
      state.rxBuffer = state.rxBuffer.slice(-4096);
    }

    let match;
    while ((match = state.rxBuffer.match(/\r?\n/))) {
      const index = match.index ?? 0;
      const line = state.rxBuffer.slice(0, index).trim();
      state.rxBuffer = state.rxBuffer.slice(index + match[0].length);

      if (line) {
        handleLine(line);
      }
    }
  }

  function handleLine(line) {
    if (line.startsWith('$CAR,')) {
      log('RX', line);
      parseStatus(line);
      return;
    }

    if (line.startsWith('OK')) {
      log('RX', line);

      if (line.includes('STREAM=1')) {
        state.streaming = true;
        updateControls();
      } else if (line.includes('STREAM=0')) {
        state.streaming = false;
        updateControls();
      }

      const rate = line.match(/RATE=(\d+)/);
      if (rate) {
        state.rate = Number(rate[1]);
        els.rateSelect.value = String(state.rate);
      }
      return;
    }

    if (line.startsWith('ERR')) {
      log('ERR', line);
      if (line.includes('LOCKED')) setLocked(true);
      toast(line, true);
      return;
    }

    log('RX', line);
  }

  function parseStatus(line) {
    const body = line.slice(5);
    const status = {};

    for (const part of body.split(',')) {
      const eq = part.indexOf('=');
      if (eq <= 0) continue;

      const key = part.slice(0, eq).trim();
      const value = Number(part.slice(eq + 1));
      if (Number.isFinite(value)) {
        status[key] = value;
      }
    }

    if (!Number.isFinite(status.DUTY)) return;
    applyStatus(status);
  }

  function applyStatus(status) {
    state.lastStatus = status;

    els.dutyVal.textContent = fmt(status.DUTY);
    els.tgtVal.textContent = fmt(status.TGT);
    els.ccrVal.textContent = fmt(status.CCR);
    els.lastUpdate.textContent = nowText();

    const st = ST_MAP[status.ST] || ['未知', 'warn'];
    setChip(els.stateChip, `ST ${st[0]}`, st[1]);

    const locked = status.LOCK === 1;
    if (state.locked !== locked) {
      setLocked(locked);
    }

    els.sumArm.textContent = fmt(status.ARM);
    els.sumArmMs.textContent = fmt(status.ARMMS);
    els.sumBrk.textContent = fmt(status.BRK);
    els.sumBrkMs.textContent = fmt(status.BRKMS);
    els.sumSms.textContent = fmt(status.SMS);
    els.sumSlew.textContent = fmt(status.SLEW);

    setParamValues(status);
    addPoint(status);
  }

  function addPoint(status) {
    const now = performance.now();
    const last = state.history[state.history.length - 1];

    // 同一时刻 GET 和 STREAM 可能各来一行，避免重复点
    if (last && now - last.t < 25) return;

    state.history.push({
      t: now,
      duty: status.DUTY,
      tgt: status.TGT,
    });

    trimHistory();
    els.sampleInfo.textContent = `${state.history.length} 个采样`;
    els.chartEmpty.classList.add('hidden');
    drawChart();
  }

  function trimHistory() {
    const cutoff = performance.now() - CHART_WINDOW_MS;
    while (state.history.length && state.history[0].t < cutoff) {
      state.history.shift();
    }
    if (state.history.length > 600) {
      state.history.splice(0, state.history.length - 600);
    }
  }

  /* ------------------------------------------------------------------ *
   * 图表
   * ------------------------------------------------------------------ */

  function resizeChart() {
    const rect = els.chart.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));

    if (
      els.chart.width !== Math.floor(w * dpr) ||
      els.chart.height !== Math.floor(h * dpr)
    ) {
      els.chart.width = Math.floor(w * dpr);
      els.chart.height = Math.floor(h * dpr);
    }

    chartSize = { w, h, dpr };
    chartCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawChart();
  }

  function drawChart() {
    const { w, h } = chartSize;
    if (!w || !h) return;

    const ctx = chartCtx;
    ctx.clearRect(0, 0, w, h);

    const pad = { l: 44, r: 14, t: 14, b: 25 };
    const plotW = Math.max(1, w - pad.l - pad.r);
    const plotH = Math.max(1, h - pad.t - pad.b);

    ctx.font = '10px ui-monospace, "Cascadia Code", Consolas, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    for (let i = 0; i <= 5; i += 1) {
      const value = 1000 - i * 200;
      const y = pad.t + (plotH * i) / 5;

      ctx.strokeStyle = 'rgba(148, 163, 184, 0.10)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(pad.l, y);
      ctx.lineTo(pad.l + plotW, y);
      ctx.stroke();

      ctx.fillStyle = '#6f86a8';
      ctx.fillText(String(value), pad.l - 8, y);
    }

    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    for (let i = 0; i <= 6; i += 1) {
      const x = pad.l + (plotW * i) / 6;
      const sec = -60 + i * 10;

      ctx.strokeStyle = 'rgba(148, 163, 184, 0.06)';
      ctx.beginPath();
      ctx.moveTo(x, pad.t);
      ctx.lineTo(x, pad.t + plotH);
      ctx.stroke();

      ctx.fillStyle = '#6f86a8';
      ctx.fillText(sec === 0 ? 'now' : `${sec}s`, x, pad.t + plotH + 8);
    }

    if (!state.history.length) return;

    const now = performance.now();

    const point = (item, key) => {
      const age = clamp(now - item.t, 0, CHART_WINDOW_MS);
      const x = pad.l + plotW * (1 - age / CHART_WINDOW_MS);
      const y = pad.t + plotH * (1 - clamp(item[key], 0, 1000) / 1000);
      return { x, y };
    };

    const drawSeries = (key, color) => {
      const points = state.history;
      if (!points.length) return;

      ctx.save();
      ctx.beginPath();

      for (let i = 0; i < points.length; i += 1) {
        const p = point(points[i], key);
        if (i === 0) {
          ctx.moveTo(p.x, p.y);
        } else {
          ctx.lineTo(p.x, p.y);
        }
      }

      ctx.strokeStyle = color;
      ctx.lineWidth = 2.2;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.shadowColor = color;
      ctx.shadowBlur = 8;
      ctx.stroke();
      ctx.shadowBlur = 0;

      const last = point(points[points.length - 1], key);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(last.x, last.y, 3.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    };

    drawSeries('tgt', '#ffb45e');
    drawSeries('duty', '#35d0ff');
  }

  /* ------------------------------------------------------------------ *
   * 操作
   * ------------------------------------------------------------------ */

  async function applyAll() {
    if (!state.connected) return;
    if (state.locked) {
      toast('已发车，参数已锁定', true);
      return;
    }

    const values = readParams();
    els.applyBtn.disabled = true;

    for (const def of PARAM_DEFS) {
      await send(`SET ${def.key} ${values[def.key]}`);
    }

    await send('GET');
    updateControls();
    toast('参数已发送');
  }

  async function saveToCar() {
    if (!state.connected || state.locked) return;
    await send('SAVE');
    toast('保存命令已发送');
  }

  async function restoreDefault() {
    if (!state.connected || state.locked) return;
    await send('DEFAULT');
    await send('GET');
  }

  async function startStream() {
    if (!state.connected) return;
    const rate = Number(els.rateSelect.value) || 200;
    state.rate = rate;
    await send(`RATE ${rate}`);
    await send('STREAM 1');
    state.streaming = true;
    updateControls();
  }

  async function stopStream() {
    if (!state.connected) return;
    await send('STREAM 0');
    state.streaming = false;
    updateControls();
  }

  /* ------------------------------------------------------------------ *
   * 初始化
   * ------------------------------------------------------------------ */

  function showUnsupported() {
    els.unsupported.classList.remove('hidden');
  }

  function bindEvents() {
    els.connectBtn.addEventListener('click', connect);
    els.disconnectBtn.addEventListener('click', disconnect);

    els.applyBtn.addEventListener('click', applyAll);
    els.saveBtn.addEventListener('click', saveToCar);
    els.readBtn.addEventListener('click', () => send('GET'));
    els.defaultBtn.addEventListener('click', restoreDefault);

    els.streamOnBtn.addEventListener('click', startStream);
    els.streamOffBtn.addEventListener('click', stopStream);
    els.getBtn.addEventListener('click', () => send('GET'));

    els.rateSelect.addEventListener('change', () => {
      const rate = Number(els.rateSelect.value) || 200;
      state.rate = rate;
      if (state.connected) {
        void send(`RATE ${rate}`);
      }
    });

    els.rawSendBtn.addEventListener('click', () => {
      const line = els.rawCmd.value.trim();
      if (!line) return;
      void send(line);
    });

    els.rawCmd.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        els.rawSendBtn.click();
      }
    });

    els.clearLogBtn.addEventListener('click', () => {
      els.log.replaceChildren();
    });

    window.addEventListener('resize', resizeChart);

    if ('ResizeObserver' in window) {
      new ResizeObserver(resizeChart).observe(els.chart.parentElement);
    }

    window.addEventListener('beforeunload', () => {
      if (state.device?.gatt?.connected) {
        state.device.gatt.disconnect();
      }
    });
  }

  function init() {
    buildParams();
    bindEvents();
    updateControls();

    if (!navigator.bluetooth) {
      showUnsupported();
      els.connectBtn.disabled = true;
      log('SYS', '当前环境不支持 Web Bluetooth');
    } else if (!window.isSecureContext) {
      showUnsupported();
      log('SYS', '当前页面不是安全上下文，Web Bluetooth 不可用');
    } else {
      log('SYS', '页面就绪，点击“连接蓝牙”');
    }

    requestAnimationFrame(resizeChart);
  }

  init();
})();
