/**
 * Browser half of the Voice plugin:
 * - a 🎤 control before the composer's submit action that records, transcribes
 *   through the dictation provider, and inserts the text into the composer;
 * - a 🔊 action on finalized assistant messages that speaks the text through
 *   the read-aloud provider;
 * - one "Voice" settings section managing the provider registry: add, edit,
 *   and remove profiles (MiMo / Fish Audio / OpenAI-compatible) and pick
 *   independent providers for dictation and read-aloud.
 * @module @huakunshen/dsh-plugin-voice/client
 */

window.__ModuleLoader__.load({
  id: '@huakunshen/dsh-plugin-voice/client',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const tipStyle = function (text) {
      return {
        fontSize: 11, maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis',
        whiteSpace: 'nowrap', opacity: 0.85,
        color: String(text).startsWith('\u26a0') ? '#e5534b' : 'inherit',
      }
    }

    const inputStyle = {
      background: 'var(--dsh-color-bg, rgba(127,127,127,0.15))',
      border: '1px solid rgba(127,127,127,0.35)',
      borderRadius: 6,
      padding: '4px 8px',
      fontSize: 13,
      color: 'inherit',
      width: 260,
    }
    const rowStyle = { display: 'flex', alignItems: 'center', gap: 10, margin: '10px 0' }
    const labelStyle = { width: 110, fontSize: 13, opacity: 0.8, flexShrink: 0 }
    const hintStyle = { fontSize: 12, opacity: 0.55, margin: '2px 0 0 120px' }
    const cardStyle = {
      border: '1px solid rgba(127,127,127,0.25)',
      borderRadius: 8,
      padding: '8px 12px',
      margin: '12px 0',
      maxWidth: 620,
    }
    const smallBtn = {
      background: 'rgba(127,127,127,0.2)',
      border: '1px solid rgba(127,127,127,0.35)',
      borderRadius: 6,
      padding: '3px 10px',
      fontSize: 12,
      cursor: 'pointer',
      color: 'inherit',
    }

    async function api(path, body) {
      const response = await fetch(`/__dsh-voice${path}`, body === undefined
        ? undefined
        : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const text = await response.text()
      try {
        return JSON.parse(text)
      } catch {
        throw new Error(`Voice 服务响应异常 (HTTP ${response.status}): ${text.slice(0, 120)}`)
      }
    }

    // ---------------------------------------------------------------- icons

    function MicIcon() {
      return h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none' },
        h('rect', { x: 5.75, y: 1.5, width: 4.5, height: 8, rx: 2.25, fill: 'currentColor' }),
        h('path', {
          d: 'M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2.5',
          stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', fill: 'none',
        }))
    }

    function StopSquareIcon() {
      return h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none' },
        h('rect', { x: 3.5, y: 3.5, width: 9, height: 9, rx: 1.5, fill: 'currentColor' }))
    }

    function SpeakerIcon() {
      return h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none' },
        h('path', { d: 'M2.2 5.9 H4.9 L8.4 2.9 V13.1 L4.9 10.1 H2.2 Z', fill: 'currentColor' }),
        h('path', { d: 'M10.6 5.6 a3.1 3.1 0 0 1 0 4.8', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', fill: 'none' }),
        h('path', { d: 'M12.4 3.9 a5.6 5.6 0 0 1 0 8.2', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', fill: 'none' }))
    }

    function CloseIcon() {
      return h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none' },
        h('path', { d: 'M4.2 4.2 L11.8 11.8 M11.8 4.2 L4.2 11.8', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }))
    }

    // ------------------------------------------------------------- audio utils

    /** Decode any browser-recorded blob, downmix to mono 16 kHz, and encode 16-bit PCM WAV. */
    async function blobToWavBase64(blob) {
      const decoded = await new AudioContext().decodeAudioData(await blob.arrayBuffer())
      const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16000) || 1, 16000)
      const source = offline.createBufferSource()
      source.buffer = decoded
      source.connect(offline.destination)
      source.start()
      const rendered = await offline.startRendering()
      const samples = rendered.getChannelData(0)
      const bytes = new ArrayBuffer(44 + samples.length * 2)
      const view = new DataView(bytes)
      const writeString = (offset, value) => {
        for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i))
      }
      writeString(0, 'RIFF')
      view.setUint32(4, 36 + samples.length * 2, true)
      writeString(8, 'WAVEfmt ')
      view.setUint32(16, 16, true)
      view.setUint16(20, 1, true)
      view.setUint16(22, 1, true)
      view.setUint32(24, 16000, true)
      view.setUint32(28, 32000, true)
      view.setUint16(32, 2, true)
      view.setUint16(34, 16, true)
      writeString(36, 'data')
      view.setUint32(40, samples.length * 2, true)
      for (let i = 0; i < samples.length; i++) {
        const clamped = Math.max(-1, Math.min(1, samples[i]))
        view.setInt16(44 + i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
      }
      let binary = ''
      const chunk = 0x8000
      const raw = new Uint8Array(bytes)
      for (let i = 0; i < raw.length; i += chunk) {
        binary += String.fromCharCode.apply(null, raw.subarray(i, i + chunk))
      }
      return btoa(binary)
    }

    /** Insert recognized text into the composer's Lexical contenteditable. */
    function insertIntoComposer(text) {
      const editors = Array.from(document.querySelectorAll('[data-lexical-editor="true"]'))
        .filter((el) => el.isContentEditable && el.offsetParent !== null)
      const target = editors[editors.length - 1]
      if (target === undefined) return false
      target.focus()
      const selection = window.getSelection()
      if (selection !== null) {
        const range = document.createRange()
        range.selectNodeContents(target)
        range.collapse(false)
        selection.removeAllRanges()
        selection.addRange(range)
      }
      return document.execCommand('insertText', false, text)
    }

    // ------------------------------------------------------------ mic button

    /** Live microphone level history: SVG geometry per frame, no React state churn. */
    function Waveform(props) {
      const svgRef = React.useRef(null)
      const meter = props.meter
      React.useEffect(function () {
        const bars = Array.from(svgRef.current.querySelectorAll('line')).reverse().map(function (element) {
          return { element: element, level: 0 }
        })
        let frame
        let previous = -Infinity
        const draw = function (now) {
          if (now - previous >= 50) {
            previous = now
            let next = meter !== null && typeof meter.amplitude === 'function' ? meter.amplitude() : 0
            for (const bar of bars) {
              const carried = bar.level
              bar.level = next
              next = carried
              const height = 1 + Math.min(1, bar.level * 5) * 17
              bar.element.setAttribute('y1', String(20 - height))
              bar.element.setAttribute('y2', String(20 + height))
            }
          }
          frame = requestAnimationFrame(draw)
        }
        frame = requestAnimationFrame(draw)
        return function () { cancelAnimationFrame(frame) }
      }, [meter])
      return h('svg', {
        ref: svgRef,
        viewBox: '0 0 640 40',
        preserveAspectRatio: 'none',
        role: 'img',
        'aria-label': props.label,
        style: props.compact
          ? { width: 168, height: 30, color: 'inherit', opacity: 0.85 }
          : { flex: 1, minWidth: 0, height: 30, color: 'inherit', opacity: 0.85 },
      }, Array.from({ length: 80 }, function (_, index) {
        return h('line', {
          key: index,
          x1: index * 8 + 4, x2: index * 8 + 4, y1: 19, y2: 21,
          stroke: 'currentColor', strokeWidth: 3, strokeLinecap: 'round',
          opacity: 0.25 + index / 120,
        })
      }))
    }

    /** Measure live RMS of a capture stream; `close` releases the audio context. */
    function createMeter(stream) {
      try {
        const context = new AudioContext()
        const analyser = context.createAnalyser()
        analyser.fftSize = 1024
        const samples = new Float32Array(analyser.fftSize)
        context.createMediaStreamSource(stream).connect(analyser)
        return {
          amplitude: function () {
            analyser.getFloatTimeDomainData(samples)
            let sum = 0
            for (const sample of samples) sum += sample * sample
            return Math.sqrt(sum / samples.length)
          },
          close: function () { void context.close().catch(function () {}) },
        }
      } catch (error) {
        return { amplitude: function () { return 0 }, close: function () {} }
      }
    }

    /**
     * Composer dictation: a compact mic that expands into the capture row while
     * a recording is live (cancel, live level waveform, stop-and-transcribe),
     * then returns to the compact control once the text lands in the draft.
     */
    function MicButton(props) {
      const phaseState = React.useState('idle')
      const phase = phaseState[0]
      const setPhase = phaseState[1]
      const messageState = React.useState('')
      const message = messageState[0]
      const setMessage = messageState[1]
      const recorderRef = React.useRef(null)
      const chunksRef = React.useRef([])
      const streamRef = React.useRef(null)
      const meterRef = React.useRef(null)
      // Only the expandable activity seat hands us onActiveChange.
      const expandable = typeof props.onActiveChange === 'function'
      const expanded = phase !== 'idle'

      // Let the composer owner expand its tool row while this control is active.
      React.useLayoutEffect(function () {
        if (typeof props.onActiveChange !== 'function') return undefined
        props.onActiveChange(expanded)
        return function () { props.onActiveChange(false) }
      }, [expanded])

      const release = function () {
        const meter = meterRef.current
        meterRef.current = null
        if (meter !== null) meter.close()
        const stream = streamRef.current
        streamRef.current = null
        if (stream !== null) stream.getTracks().forEach(function (track) { track.stop() })
      }

      /** Prefer the composer's own insertion API; fall back to the DOM editor. */
      const insert = function (text) {
        const actions = props.inputActions
        if (actions !== undefined && typeof actions.insertText === 'function') {
          if (actions.insertText(text, actions.captureInsertion())) return true
        }
        return insertIntoComposer(text)
      }

      const finish = async function () {
        const recorder = recorderRef.current
        recorderRef.current = null
        if (recorder === null) return
        setPhase('transcribing')
        const blob = await new Promise(function (resolve) {
          recorder.onstop = function () {
            release()
            resolve(new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' }))
          }
          recorder.stop()
        })
        try {
          const wavBase64 = await blobToWavBase64(blob)
          const reply = await api('/asr', { wavBase64 })
          if (reply.error) {
            setMessage(`\u26a0 ${reply.error}`)
            setPhase('feedback')
          } else if (reply.text && insert(reply.text)) {
            setPhase('idle')
          } else {
            await navigator.clipboard.writeText(reply.text || '').catch(function () {})
            setMessage('未找到输入框，文字已复制到剪贴板')
            setPhase('feedback')
          }
        } catch (error) {
          setMessage(`\u26a0 识别失败：${String(error).slice(0, 160)}`)
          setPhase('feedback')
        }
      }

      const cancel = function () {
        const recorder = recorderRef.current
        recorderRef.current = null
        if (recorder !== null && recorder.state === 'recording') recorder.stop()
        chunksRef.current = []
        release()
        setMessage('')
        setPhase('idle')
      }

      const start = async function () {
        try {
          setMessage('')
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true },
            video: false,
          })
          streamRef.current = stream
          meterRef.current = createMeter(stream)
          chunksRef.current = []
          const recorder = new MediaRecorder(stream)
          recorder.ondataavailable = function (event) {
            if (event.data.size > 0) chunksRef.current.push(event.data)
          }
          recorder.start()
          recorderRef.current = recorder
          setPhase('recording')
        } catch (error) {
          release()
          setMessage(`\u26a0 无法访问麦克风：${String(error).slice(0, 120)}`)
          setPhase('feedback')
        }
      }

      const round = {
        width: 32, height: 32, borderRadius: '50%', border: 'none',
        background: 'rgba(127,127,127,0.18)', color: 'inherit', cursor: 'pointer',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        padding: 0, flexShrink: 0,
      }

      if (!expanded) {
        return h('button', {
          title: '语音输入',
          'aria-label': '语音输入',
          onClick: start,
          style: Object.assign({}, round, { background: 'none', opacity: 0.7 }),
        }, h(MicIcon, null))
      }

      const compact = !expandable
      return h('div', {
        'data-voice-activity': phase,
        style: {
          display: 'flex', alignItems: 'center', gap: 10, minWidth: 0,
          flex: compact ? 'none' : 1,
        },
      }, [
        h('button', {
          key: 'cancel', type: 'button', title: '取消录音', 'aria-label': '取消录音',
          onClick: cancel, style: round,
        }, h(CloseIcon, null)),
        phase === 'recording'
          ? h(Waveform, { key: 'wave', meter: meterRef.current, label: '正在录音', compact: compact })
          : h('span', {
            key: 'status', role: 'status', title: message,
            style: {
              flex: 1, minWidth: 0, fontSize: 12, opacity: 0.8,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              color: String(message).startsWith('\u26a0') ? '#e5534b' : 'inherit',
            },
          }, phase === 'transcribing' ? '识别中…' : message),
        phase === 'recording'
          ? h('button', {
            key: 'stop', type: 'button', title: '停止并识别', 'aria-label': '停止并识别',
            onClick: finish, style: round,
          }, h(StopSquareIcon, null))
          : null,
        phase === 'feedback'
          ? h('button', {
            key: 'retry', type: 'button', title: '重新录音', 'aria-label': '重新录音',
            onClick: start, style: round,
          }, h(MicIcon, null))
          : null,
      ])
    }

    // -------------------------------------------------------- read-aloud button

    function SpeakerButton(props) {
      const state = React.useState('idle')
      const status = state[0]
      const setStatus = state[1]
      const srcState = React.useState('')
      const src = srcState[0]
      const setSrc = srcState[1]
      const errState = React.useState('')
      const error = errState[0]

      const stop = function () {
        setSrc('')
        setStatus('idle')
      }
      const onClick = function () {
        if (status === 'playing') {
          stop()
          return
        }
        errState[1]('')
        setSrc(`/__dsh-voice/tts?sessionId=${encodeURIComponent(props.sessionId)}`
          + `&messageId=${encodeURIComponent(props.messageId)}&t=${Date.now()}`)
        setStatus('playing')
      }
      const onError = function () {
        fetch(src).then(function (response) {
          return response.text()
        }).then(function (text) {
          let message
          try { message = JSON.parse(text).error } catch { message = text.slice(0, 200) }
          errState[1](message || '播放失败')
          setSrc('')
          setStatus('error')
        }, function () {
          errState[1]('播放失败')
          setSrc('')
          setStatus('error')
        })
      }

      const label = status === 'error' ? '⚠' : status === 'playing' ? h(StopSquareIcon, null) : h(SpeakerIcon, null)
      return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
        h('button', {
          title: status === 'error' ? error : '朗读回复',
          onClick: onClick,
          style: {
            background: 'none', border: 'none', cursor: 'pointer',
            opacity: status === 'error' ? 1 : 0.7,
            padding: '2px', display: 'inline-flex', alignItems: 'center',
            color: status === 'error' ? '#e5534b' : 'inherit',
          },
        }, label),
        status === 'error' && error
          ? h('span', { title: error, style: tipStyle('\u26a0 ' + error) }, `\u26a0 ${error}`)
          : null,
        status === 'playing' && src
          ? h('audio', { src: src, autoPlay: true, onEnded: stop, onError: onError, style: { display: 'none' } })
          : null)
    }

    // ---------------------------------------------------------------- settings

    const KIND_LABELS = { mimo: 'Xiaomi MiMo', fish: 'Fish Audio', openai: 'OpenAI 兼容 (/audio/*)' }

    function ProviderCard(props) {
      const id = props.id
      const p = props.profile
      const patch = props.patch
      const remove = props.remove
      const saveKey = props.saveKey
      const keyDraft = React.useState('')
      const saved = React.useState('')
      const savedTimer = React.useRef(null)
      const flash = function () {
        saved[1]('✓ 已保存')
        clearTimeout(savedTimer.current)
        savedTimer.current = setTimeout(function () { saved[1]('') }, 2500)
      }

      const stt = p.capabilities?.stt
      const tts = p.capabilities?.tts
      return h('div', { style: cardStyle },
        h('div', { style: Object.assign({ gap: 8 }, rowStyle) },
          h('input', {
            value: id,
            title: 'provider 名称',
            onChange: function () {}, // ids are immutable; rename = add + delete
            style: Object.assign({ width: 120, fontWeight: 600, background: 'transparent', border: 'none', color: 'inherit' }, inputStyle),
          }),
          h('select', { value: p.kind, onChange: function (e) { patch(id, { kind: e.target.value }) }, style: Object.assign({ width: 170 }, inputStyle) },
            Object.entries(KIND_LABELS).map(function (entry) {
              return h('option', { value: entry[0] }, entry[1])
            })),
          h('span', { style: { fontSize: 11, opacity: 0.6 } },
            `${stt ? '识别 ✓' : '识别 ✗'} · ${tts ? '朗读 ✓' : '朗读 ✗'}`),
          h('button', { onClick: function () { remove(id) }, style: smallBtn, title: '删除这个 provider' }, '删除')),

        p.needsBaseUrl !== false && p.kind !== 'fish'
          ? h('div', { style: rowStyle },
              h('span', { style: labelStyle }, 'Base URL'),
              h('input', { value: p.baseUrl ?? '', onChange: function (e) { patch(id, { baseUrl: e.target.value }) }, style: inputStyle }))
          : null,

        h('div', { style: rowStyle },
          h('span', { style: labelStyle }, 'API Key'),
          h('input', {
            type: 'password',
            value: keyDraft[0],
            placeholder: p.keyConfigured ? `已配置（${p.keySource === 'env' ? '环境变量' : p.keySource === 'file' ? '本地存储' : p.keySource ?? '未知来源'}），输入可覆盖` : `凭证名: ${p.keyRef}`,
            onChange: function (e) { keyDraft[1](e.target.value) },
            style: inputStyle,
          }),
          h('button', {
            onClick: function () {
              const value = keyDraft[0].trim()
              if (!value) return
              void api('/key', { profile: id, value }).then(function () {
                keyDraft[1]('')
                flash()
                return props.reload()
              })
            },
            style: smallBtn,
          }, '保存'),
          h('span', { style: { fontSize: 12, opacity: 0.7 } }, saved[0])),

      stt
        ? h('div', null,
            h('div', { style: rowStyle },
              h('span', { style: labelStyle }, '识别模型'),
              h('input', { value: p.asrModel ?? '', onChange: function (e) { patch(id, { asrModel: e.target.value }) }, style: inputStyle })),
            h('div', { style: rowStyle },
              h('span', { style: labelStyle }, '识别语言'),
              h('select', { value: p.asrLanguage ?? 'auto', onChange: function (e) { patch(id, { asrLanguage: e.target.value }) }, style: inputStyle },
                h('option', { value: 'auto' }, '自动检测'),
                h('option', { value: 'zh' }, '中文'),
                h('option', { value: 'en' }, '英文'))))
        : null,

      tts
        ? h('div', null,
            h('div', { style: rowStyle },
              h('span', { style: labelStyle }, 'TTS 模型'),
              h('input', { value: p.ttsModel ?? '', onChange: function (e) { patch(id, { ttsModel: e.target.value }) }, style: inputStyle })),
            h('div', { style: rowStyle },
              h('span', { style: labelStyle }, p.kind === 'fish' ? 'reference_id' : '音色'),
              h('input', {
                value: p.ttsVoice ?? '',
                placeholder: p.kind === 'fish' ? '留空 = 默认音色' : 'mimo_default / 冰糖 / Mia / alloy …',
                onChange: function (e) { patch(id, { ttsVoice: e.target.value }) },
                style: inputStyle,
              })),
            p.kind === 'fish'
              ? h('div', { style: rowStyle },
                  h('span', { style: labelStyle }, '语速'),
                  h('input', {
                    type: 'number', min: 0.5, max: 2, step: 0.05,
                    value: String(p.speed ?? 1),
                    onChange: function (e) {
                      const v = parseFloat(e.target.value)
                      if (!isNaN(v) && v >= 0.5 && v <= 2) patch(id, { speed: v })
                    },
                    style: Object.assign({ width: 90 }, inputStyle),
                  }))
              : null)
        : null)
    }

    function VoiceSection() {
      const cfgState = React.useState(null)
      const cfg = cfgState[0]
      const setCfg = cfgState[1]
      const loadError = React.useState('')
      const saved = React.useState('')
      const savedTimer = React.useRef(null)
      const newId = React.useState('')

      const reload = React.useCallback(function () {
        return api('/config').then(function (nextConfig) {
          setCfg(nextConfig)
          return nextConfig
        })
      }, [])

      React.useEffect(function () {
        void reload().then(function (nextConfig) {
          if (!nextConfig || typeof nextConfig.providers !== 'object' || nextConfig.providers === null) {
            loadError[1]('Voice host 应答无法识别——dsh host 可能还没重启到 voice 0.2（当前应答：'
              + (JSON.stringify(nextConfig ?? null) ?? '空').slice(0, 120) + '）')
            return
          }
          setCfg(nextConfig)
        }, function (error) { loadError[1](String(error)) })
      }, [reload])

      const flashSaved = function () {
        saved[1]('✓ 已保存')
        clearTimeout(savedTimer.current)
        savedTimer.current = setTimeout(function () { saved[1]('') }, 2000)
      }

      const persist = function (next) {
        setCfg(next)
        return api('/config', { providers: next.providers, dictation: next.dictation, readAloud: next.readAloud }).then(flashSaved)
      }

      const patchProvider = function (id, patchValue) {
        if (!cfg) return
        const providers = Object.assign({}, cfg.providers)
        providers[id] = Object.assign({ kind: providers[id].kind }, providers[id], patchValue)
        void persist(Object.assign({}, cfg, { providers }))
      }
      const removeProvider = function (id) {
        if (!cfg || Object.keys(cfg.providers).length <= 1) return
        const providers = Object.assign({}, cfg.providers)
        delete providers[id]
        const next = Object.assign({}, cfg, { providers })
        if (next.dictation === id) next.dictation = Object.keys(providers)[0]
        if (next.readAloud === id) next.readAloud = Object.keys(providers)[0]
        void persist(next)
      }
      const addProvider = function () {
        if (!cfg || typeof cfg.providers !== 'object' || cfg.providers === null) {
          loadError[1]('配置尚未加载完成，无法添加 provider。')
          return
        }
        const existing = cfg.providers
        let id = newId[0].trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-') || `provider-${Object.keys(existing).length + 1}`
        if (existing[id] !== undefined) id = `${id}-${Object.keys(existing).length + 1}`
        const providers = Object.assign({}, existing)
        providers[id] = { kind: 'openai', baseUrl: 'https://api.openai.com/v1', keyRef: `VOICE_${id.toUpperCase().replace(/-/g, '_')}_API_KEY`, asrModel: '', asrLanguage: 'auto', ttsModel: '', ttsVoice: '' }
        newId[1]('')
        void persist(Object.assign({}, cfg, {
          providers,
          dictation: cfg.dictation in providers ? cfg.dictation : id,
          readAloud: cfg.readAloud in providers ? cfg.readAloud : id,
        }))
      }

      if (loadError[0]) {
        return h('div', { style: { padding: 12, color: '#e5534b', fontSize: 13, maxWidth: 560 } },
          'Voice 加载失败：', loadError[0])
      }
      if (!cfg) return null

      const providerEntries = Object.entries(cfg.providers ?? {})
      const sttChoices = providerEntries.filter(function (entry) { return entry[1].capabilities?.stt })
      const ttsChoices = providerEntries.filter(function (entry) { return entry[1].capabilities?.tts })

      return h('div', { style: { padding: '8px 4px', maxWidth: 660 } },
        h('h3', { style: { margin: '4px 0 12px', fontSize: 15 } }, 'Voice（语音输入 + 朗读）'),

        h('div', { style: rowStyle },
          h('span', { style: labelStyle }, '语音输入用'),
          h('select', { value: cfg.dictation, onChange: function (e) { void persist(Object.assign({}, cfg, { dictation: e.target.value })) }, style: inputStyle },
            sttChoices.map(function (entry) { return h('option', { value: entry[0] }, entry[0]) }))),
        h('div', { style: rowStyle },
          h('span', { style: labelStyle }, '朗读用'),
          h('select', { value: cfg.readAloud, onChange: function (e) { void persist(Object.assign({}, cfg, { readAloud: e.target.value })) }, style: inputStyle },
            ttsChoices.map(function (entry) { return h('option', { value: entry[0] }, entry[0]) }))),
        h('div', { style: hintStyle }, '两处可以选完全不同的 provider。'),
        h('div', { style: { fontSize: 12, opacity: 0.7, margin: '0 0 4px 120px' } }, saved[0]),

        providerEntries.map(function (entry) {
          return h(ProviderCard, {
            key: entry[0],
            id: entry[0],
            profile: entry[1],
            patch: patchProvider,
            remove: removeProvider,
            saveKey: api,
            reload: reload,
          })
        }),

        h('div', { style: rowStyle },
          h('span', { style: labelStyle }, '新增 provider'),
          h('input', {
            value: newId[0],
            placeholder: '名称（如 minimax、groq）',
            onChange: function (e) { newId[1](e.target.value) },
            style: Object.assign({ width: 160 }, inputStyle),
          }),
          h('button', { onClick: addProvider, style: smallBtn }, '添加')),
        h('div', { style: hintStyle }, '配置持久化在 ~/.dsh/voice.json；key 存 dsh 凭证库，环境变量同名优先。'),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = ctx.get('slots')
        // conversation.input.activity is single-occupant: the official Voice input
        // bundle holds it whenever it is installed, so fall back to the toolbar list.
        slots.inject('conversation.input.activity', () => {
          try {
            return slots.register({ name: 'conversation.input.activity' }, MicButton)
          } catch (error) {
            console.warn('voice: activity seat unavailable, using the toolbar seat', error)
            return slots.register(
              { name: 'conversation.input.right', id: 'voice-mic', order: 20 },
              MicButton,
            )
          }
        })
        slots.inject('conversation.chat.assistant-actions', () => slots.register(
          { name: 'conversation.chat.assistant-actions', id: 'voice-read-aloud', order: 90 },
          SpeakerButton,
        ))
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'voice', order: 120, label: 'Voice' },
          VoiceSection,
        ))
      },
    }
  },
})
