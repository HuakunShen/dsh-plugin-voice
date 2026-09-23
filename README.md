# dsh-plugin-voice

Voice for the [DeepSeek Harness](https://github.com/kernel-machine/deepseek-harness) web UI: read assistant messages aloud and dictate into the composer with one mic click — powered by user-managed speech provider profiles.

在 DeepSeek Harness 网页版里朗读 assistant 回复、一键语音输入 —— 语音 provider 由你自己配置、随意组合。

## Features

- **🎤 Dictation** — a mic control in the composer tool row: click to record, click again to stop, the transcript lands directly in the input (falls back to the clipboard when no editor is found). Audio is converted to 16 kHz mono WAV in the browser before upload.
- **🔊 Read aloud** — a speaker action on every finalized assistant message.
- **🧩 Provider registry** — add any number of provider profiles and mix them freely; dictation and read-aloud can use completely different providers:

  | Kind | STT | TTS | Wire dialect |
  |---|---|---|---|
  | `mimo` (Xiaomi MiMo) | ✓ | ✓ | chat-completions `input_audio` / `message.audio` |
  | `fish` (Fish Audio) | ✗ | ✓ | `POST /v1/tts`, true streaming |
  | `openai` | ✓ | ✓ | `POST /audio/transcriptions` + `POST /audio/speech` (works with OpenAI, Groq, SiliconFlow, MiniMax-compatible gateways, …) |

- **⚙️ One settings section** — Settings → Voice: per-provider base URL / model / voice / language, API keys stored in the DSH credential store (an environment variable with the same name wins, matching DSH semantics), and the whole registry persists to `~/.dsh/voice.json`.
- **No repo changes** — installs as an out-of-tree profile plugin.

## Install

Requires a running DeepSeek Harness (web GUI) deployment.

```sh
git clone https://github.com/HuakunShen/dsh-plugin-voice.git ~/Dev/dsh-plugin-voice
```

Then in any DeepSeek Harness session, ask the agent:

> Install the bundle at ~/Dev/dsh-plugin-voice into my profile

or have it call the plugin manager's `install_bundle` with that directory. Restart DSH once so the new module generation loads — after that it auto-loads on every start.

## Configure

1. Open **Settings → Voice**.
2. The registry ships three seeded profiles: `mimo` (base URL points at the Token Plan host; switch to `https://api.xiaomimimo.com/v1` for the pay-as-you-go platform), `fish`, and `openai`.
3. Paste an API key per provider and save — it goes into the DSH local credential store under the profile's `keyRef` (seeded: `MIMO_API_KEY`, `FISH_API_KEY`, `VOICE_OPENAI_API_KEY`; a same-named environment variable takes precedence).
4. Pick the dictation provider and the read-aloud provider independently.
5. Add more providers (e.g. `groq` with `whisper-large-v3` for STT) from the bottom row; delete is one click, and the selects follow.

## Notes

- MiMo TTS is non-streaming (the model returns base64 audio that plays after synthesis); Fish Audio and OpenAI dialects stream while synthesizing.
- Dictation records via `MediaRecorder` and transcodes to WAV client-side, so any browser-supported recording format works regardless of what the provider accepts.
- Config lives in `~/.dsh/voice.json`; keys live in the DSH credential store (`~/.dsh/.credentials.yaml`). Deleting the JSON re-seeds the default registry.

## License

MIT
