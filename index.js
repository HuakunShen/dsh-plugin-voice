/**
 * Host half of the Voice plugin. Serves same-origin `/__dsh-voice` routes the
 * browser half fetches. Configuration is a user-managed provider registry
 * persisted to `~/.dsh/voice.json`: each profile names a wire dialect
 * (`mimo` | `fish` | `openai`), its endpoint, model, and credential reference.
 * Read-aloud TTS and composer dictation STT each select any profile whose
 * dialect supports the capability.
 * @module dsh-plugin-voice
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const inject = ['credentials', 'webServer']

const CONFIG_PATH = join(
  process.env.DSH_HOME?.replace(/^~/, process.env.HOME ?? '') ?? join(process.env.HOME ?? '.', '.dsh'),
  'voice.json',
)
const MAX_TTS_CHARS = 8000
const MAX_ASR_BYTES = 25 * 1024 * 1024

/** Wire dialects and the capabilities each can serve. */
export const KINDS = {
  mimo: { stt: true, tts: true, needsBaseUrl: true },
  fish: { stt: false, tts: true, needsBaseUrl: false },
  openai: { stt: true, tts: true, needsBaseUrl: true },
}

function seededConfig() {
  return {
    providers: {
      mimo: {
        kind: 'mimo',
        baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
        keyRef: 'MIMO_API_KEY',
        asrModel: 'mimo-v2.5-asr',
        asrLanguage: 'auto',
        ttsModel: 'mimo-v2.5-tts',
        ttsVoice: 'mimo_default',
      },
      fish: {
        kind: 'fish',
        keyRef: 'FISH_API_KEY',
        ttsModel: 's2.1-pro-free',
        ttsVoice: '',
        speed: 1,
      },
      openai: {
        kind: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        keyRef: 'OPENAI_API_KEY',
        asrModel: 'gpt-4o-mini-transcribe',
        asrLanguage: 'auto',
        ttsModel: 'gpt-4o-mini-tts',
        ttsVoice: 'alloy',
      },
    },
    dictation: 'mimo',
    readAloud: 'mimo',
  }
}

/** In-memory config; every mutation persists through saveConfig(). */
let config = seededConfig()

function loadConfig() {
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
    if (parsed && typeof parsed === 'object' && parsed.providers && typeof parsed.providers === 'object') {
      config = { ...seededConfig(), ...parsed }
    }
  } catch {
    // Absent or unreadable file: keep the seeded registry; the first save writes it.
  }
}

function saveConfig() {
  try {
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n')
  } catch {
    // Persisted config is an optimization; the runtime registry stays usable.
  }
}

function sanitizeProfileId(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 32)
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

function json(res, status, value) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(value))
}

async function resolveKey(credentials, ref) {
  try {
    return await credentials.resolve(ref)
  } catch {
    return undefined
  }
}

/** Normalize a MiMo/OpenAI-style base URL and join one path. */
function endpoint(baseUrl, path) {
  return `${String(baseUrl ?? '').trim().replace(/\/+$/, '')}${path}`
}

/**
 * One chat-completions call carrying either an input_audio part (MiMo ASR) or
 * an audio output request (MiMo TTS). Answer fields: audio (base64) or text.
 */
async function mimoChat(profile, key, body, timeoutMs) {
  const response = await fetch(endpoint(profile.baseUrl, '/chat/completions'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await response.text()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = { raw: text.slice(0, 300) }
  }
  if (!response.ok) {
    return { error: `请求失败（HTTP ${response.status}）。${JSON.stringify(parsed).slice(0, 200)}` }
  }
  return { parsed }
}

async function synthesizeMimo(profile, key, text) {
  const audio = { format: 'mp3' }
  if (profile.ttsVoice) audio.voice = profile.ttsVoice
  const reply = await mimoChat(profile, key, {
    model: profile.ttsModel || 'mimo-v2.5-tts',
    messages: [{ role: 'assistant', content: text }],
    audio,
  }, 300_000)
  if (reply.error !== undefined) return { error: `MiMo TTS ${reply.error}` }
  const data = reply.parsed?.choices?.[0]?.message?.audio?.data
  if (typeof data !== 'string' || !data) return { error: 'MiMo TTS 响应中没有音频数据。' }
  return { buffer: Buffer.from(data, 'base64') }
}

async function synthesizeFish(profile, key, text) {
  const body = { text, format: 'mp3', chunk_length: 100 }
  if (profile.ttsVoice) body.reference_id = profile.ttsVoice
  if (profile.speed && profile.speed !== 1) body.prosody = { speed: profile.speed }
  const response = await fetch('https://api.fish.audio/v1/tts', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      model: profile.ttsModel || 's2.1-pro-free',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300_000),
  })
  if (!response.ok || response.body === null) {
    const detail = (await response.text().catch(() => '')).slice(0, 200)
    return { error: `Fish Audio TTS 请求失败（HTTP ${response.status}）。${detail}` }
  }
  return { stream: response.body }
}

/** OpenAI /audio/speech: binary audio body streamed straight through. */
async function synthesizeOpenai(profile, key, text) {
  const response = await fetch(endpoint(profile.baseUrl, '/audio/speech'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: profile.ttsModel || 'gpt-4o-mini-tts', voice: profile.ttsVoice || 'alloy', input: text, response_format: 'mp3' }),
    signal: AbortSignal.timeout(300_000),
  })
  if (!response.ok || response.body === null) {
    const detail = (await response.text().catch(() => '')).slice(0, 200)
    return { error: `TTS 请求失败（HTTP ${response.status}）。${detail}` }
  }
  return { stream: response.body }
}

async function synthesize(profile, key, text) {
  if (profile.kind === 'mimo') return synthesizeMimo(profile, key, text)
  if (profile.kind === 'fish') return synthesizeFish(profile, key, text)
  return synthesizeOpenai(profile, key, text)
}

async function transcribeMimo(profile, key, wavBase64) {
  const body = {
    model: profile.asrModel || 'mimo-v2.5-asr',
    messages: [{
      role: 'user',
      content: [{ type: 'input_audio', input_audio: { data: `data:audio/wav;base64,${wavBase64}` } }],
    }],
  }
  if (profile.asrLanguage && profile.asrLanguage !== 'auto') body.asr_options = { language: profile.asrLanguage }
  const reply = await mimoChat(profile, key, body, 120_000)
  if (reply.error !== undefined) return { error: `语音识别 ${reply.error}` }
  const content = reply.parsed?.choices?.[0]?.message?.content
  if (typeof content !== 'string') return { error: '语音识别响应中没有文字。' }
  return { text: content }
}

async function transcribeOpenai(profile, key, wavBase64) {
  const bytes = Buffer.from(wavBase64, 'base64')
  const form = new FormData()
  form.append('file', new Blob([bytes], { type: 'audio/wav' }), 'audio.wav')
  form.append('model', profile.asrModel || 'gpt-4o-mini-transcribe')
  if (profile.asrLanguage && profile.asrLanguage !== 'auto') form.append('language', profile.asrLanguage)
  const response = await fetch(endpoint(profile.baseUrl, '/audio/transcriptions'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
    signal: AbortSignal.timeout(120_000),
  })
  const text = await response.text()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = { raw: text.slice(0, 300) }
  }
  if (!response.ok) return { error: `语音识别请求失败（HTTP ${response.status}）。${JSON.stringify(parsed).slice(0, 200)}` }
  if (typeof parsed.text !== 'string') return { error: '语音识别响应中没有文字。' }
  return { text: parsed.text }
}

async function transcribe(profile, key, wavBase64) {
  if (profile.kind === 'mimo') return transcribeMimo(profile, key, wavBase64)
  return transcribeOpenai(profile, key, wavBase64)
}

export function apply(ctx) {
  const credentials = ctx.get('credentials')
  const webServer = ctx.get('webServer')
  if (credentials === undefined || webServer === undefined) return
  loadConfig()

  const dispose = webServer.register({
    kind: 'prefix',
    path: '/__dsh-voice',
    async handler(req, res) {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const path = url.pathname

      if (req.method === 'GET' && path === '/__dsh-voice/config') {
        if (Object.keys(config.providers).length === 0) {
          config = seededConfig()
          saveConfig()
        }
        const providers = {}
        for (const [id, profile] of Object.entries(config.providers)) {
          const resolved = await resolveKey(credentials, profile.keyRef)
          providers[id] = {
            ...profile,
            keyConfigured: resolved !== undefined,
            keySource: resolved?.source,
            capabilities: KINDS[profile.kind] ?? { stt: false, tts: false },
          }
        }
        return json(res, 200, {
          providers,
          dictation: config.dictation,
          readAloud: config.readAloud,
          kinds: KINDS,
        })
      }

      if (req.method === 'POST' && path === '/__dsh-voice/config') {
        const body = await readBody(req)
        if (body === undefined) return json(res, 400, { error: 'invalid body' })
        const next = { providers: {}, dictation: config.dictation, readAloud: config.readAloud }
        for (const [id, raw] of Object.entries(body.providers ?? {})) {
          const profileId = sanitizeProfileId(id)
          if (!profileId || typeof raw !== 'object') continue
          const kind = KINDS[raw.kind] !== undefined ? raw.kind : 'openai'
          const profile = {
            kind,
            keyRef: typeof raw.keyRef === 'string' && raw.keyRef.trim() ? raw.keyRef.trim() : `VOICE_${profileId.toUpperCase().replace(/-/g, '_')}_API_KEY`,
          }
          if (KINDS[kind].needsBaseUrl && typeof raw.baseUrl === 'string' && /^https?:\/\//.test(raw.baseUrl)) profile.baseUrl = raw.baseUrl.trim()
          if (typeof raw.asrModel === 'string' && raw.asrModel.trim()) profile.asrModel = raw.asrModel.trim()
          if (raw.asrLanguage === 'auto' || raw.asrLanguage === 'zh' || raw.asrLanguage === 'en') profile.asrLanguage = raw.asrLanguage
          if (typeof raw.ttsModel === 'string' && raw.ttsModel.trim()) profile.ttsModel = raw.ttsModel.trim()
          if (typeof raw.ttsVoice === 'string') profile.ttsVoice = raw.ttsVoice.trim()
          if (typeof raw.speed === 'number' && raw.speed >= 0.5 && raw.speed <= 2) profile.speed = raw.speed
          next.providers[profileId] = profile
        }
        if (Object.keys(next.providers).length === 0) return json(res, 400, { error: '至少保留一个 provider。' })
        if (typeof body.dictation === 'string' && next.providers[body.dictation]?.kind !== undefined) next.dictation = body.dictation
        if (typeof body.readAloud === 'string' && next.providers[body.readAloud]?.kind !== undefined) next.readAloud = body.readAloud
        if (next.providers[next.dictation] === undefined) next.dictation = Object.keys(next.providers)[0]
        if (next.providers[next.readAloud] === undefined) next.readAloud = Object.keys(next.providers)[0]
        config = next
        saveConfig()
        return json(res, 200, { ok: true })
      }

      if (req.method === 'POST' && path === '/__dsh-voice/key') {
        const body = await readBody(req)
        const value = typeof body?.value === 'string' ? body.value.trim() : ''
        const profileId = sanitizeProfileId(body?.profile ?? '')
        const profile = config.providers[profileId]
        if (profile === undefined) return json(res, 404, { error: '未知 provider。' })
        if (!value) return json(res, 400, { ok: false, error: 'empty' })
        await credentials.set(profile.keyRef, value)
        return json(res, 200, { ok: true })
      }

      if (req.method === 'POST' && path === '/__dsh-voice/asr') {
        const body = await readBody(req)
        const audio = typeof body?.wavBase64 === 'string' ? body.wavBase64 : ''
        if (!audio) return json(res, 400, { error: '缺少音频数据。' })
        if (audio.length > (MAX_ASR_BYTES / 3) * 4) return json(res, 413, { error: '录音太长。' })
        const profile = config.providers[config.dictation]
        if (profile === undefined || !KINDS[profile.kind].stt) {
          return json(res, 409, { error: `语音输入的 provider「${config.dictation}」不支持识别。` })
        }
        const resolved = await resolveKey(credentials, profile.keyRef)
        if (resolved === undefined) {
          ctx.logger.warn(`voice: 识别请求缺少 key（${profile.keyRef}）`)
          return json(res, 409, { error: `未配置 key：Settings → Voice 里给「${config.dictation}」填 API key。` })
        }
        let result
        try {
          result = await transcribe(profile, resolved.value, audio)
        } catch (error) {
          ctx.logger.error(`voice: 识别请求异常 — ${String(error?.stack ?? error)}`)
          return json(res, 502, { error: `识别请求异常：${String(error?.message ?? error).slice(0, 160)}` })
        }
        if (result.error !== undefined) {
          ctx.logger.warn(`voice: 识别失败（provider=${config.dictation}）— ${result.error}`)
          return json(res, 502, { error: result.error })
        }
        ctx.logger.info(`voice: 识别完成（${result.text.length} 字，provider=${config.dictation}）`)
        return json(res, 200, { text: result.text })
      }

      if (req.method === 'GET' && path === '/__dsh-voice/tts') {
        const text = url.searchParams.get('text') ?? ''
        if (!text.trim()) return json(res, 400, { error: '缺少文本。' })
        const limited = text.length > MAX_TTS_CHARS ? text.slice(0, MAX_TTS_CHARS) : text
        const profile = config.providers[config.readAloud]
        if (profile === undefined || !KINDS[profile.kind].tts) {
          return json(res, 409, { error: `朗读的 provider「${config.readAloud}」不支持合成。` })
        }
        const resolved = await resolveKey(credentials, profile.keyRef)
        if (resolved === undefined) {
          ctx.logger.warn(`voice: 朗读请求缺少 key（${profile.keyRef}）`)
          return json(res, 409, { error: `未配置 key：Settings → Voice 里给「${config.readAloud}」填 API key。` })
        }
        let result
        try {
          result = await synthesize(profile, resolved.value, limited)
        } catch (error) {
          ctx.logger.error(`voice: 合成请求异常 — ${String(error?.stack ?? error)}`)
          return json(res, 502, { error: `合成请求异常：${String(error?.message ?? error).slice(0, 160)}` })
        }
        if (result.error !== undefined) {
          ctx.logger.warn(`voice: 合成失败（provider=${config.readAloud}）— ${result.error}`)
          return json(res, 502, { error: result.error })
        }
        res.statusCode = 200
        res.setHeader('Content-Type', 'audio/mpeg')
        res.setHeader('Cache-Control', 'no-store')
        if (result.buffer !== undefined) {
          res.end(result.buffer)
          return
        }
        const reader = result.stream.getReader()
        try {
          for (;;) {
            const next = await reader.read()
            if (next.done || res.destroyed) break
            if (!res.write(Buffer.from(next.value))) {
              await new Promise((resolve) => res.once('drain', resolve))
            }
          }
          res.end()
        } catch {
          res.destroy()
        }
        return
      }

      json(res, 404, { error: 'not found' })
    },
  })
  ctx.effect(() => dispose)
}
