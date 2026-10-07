/**
 * @fileoverview Remix PromptDJ - Professional DJ Console
 * Real-time continuous music steering with text prompts, audio visualizer,
 * curated sound banks, session vault (save/load), latency & performance tuning,
 * and multi-theme DJ decks.
 * @license Apache-2.0
 */

import {css, CSSResultGroup, html, LitElement, svg, PropertyValues} from 'lit';
import {customElement, property, query, state} from 'lit/decorators.js';
import {classMap} from 'lit/directives/class-map.js';
import {styleMap} from 'lit/directives/style-map.js';

import {
  GoogleGenAI,
  Scale,
  MusicGenerationMode,
  type LiveMusicGenerationConfig,
  type LiveMusicServerMessage,
  type LiveMusicSession,
} from '@google/genai';
import {decode, decodeAudioData} from './utils';

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  apiVersion: 'v1alpha',
});
const MODEL_NAME = 'lyria-realtime-exp';

export interface Prompt {
  readonly promptId: string;
  readonly color: string;
  text: string;
  weight: number;
  muted?: boolean;
}

export type PlaybackState = 'stopped' | 'playing' | 'loading' | 'paused';
export type DjTheme = 'theme-club' | 'theme-cyberpunk' | 'theme-synthwave' | 'theme-vintage' | 'theme-slate';

export interface SoundBank {
  id: string;
  name: string;
  description: string;
  bpm: number;
  scale: NonNullable<LiveMusicGenerationConfig['scale']>;
  guidance: number;
  temperature: number;
  prompts: Array<{text: string; weight: number}>;
}

export interface SavedSession {
  id: string;
  name: string;
  timestamp: number;
  theme: DjTheme;
  bufferTime: number;
  prompts: Prompt[];
  config: LiveMusicGenerationConfig;
}

export interface PerformanceStats {
  bufferTime: number;
  currentBufferRemaining: number;
  underruns: number;
  chunksReceived: number;
  sampleRate: number;
  audioState: string;
}

export interface DspConfig {
  filterVal: number; // -1.0 (LPF) to 0 (flat/neutral) to +1.0 (HPF)
  saturationDrive: number; // 0.0 to 1.0
  delaySubdivision: '1/16' | '1/8' | '1/8d' | '1/4' | '1/2';
  delayFeedback: number; // 0.0 to 0.85
  delayMix: number; // 0.0 to 1.0
  reverbDecay: number; // 0.5 to 5.0
  reverbMix: number; // 0.0 to 1.0
  reverbBypass: boolean;
}

export interface SceneSnapshot {
  id: 'A' | 'B' | 'C' | 'D';
  label: string;
  prompts: Array<{text: string; weight: number; muted: boolean; color: string}>;
  bpm?: number;
  scale?: Scale;
  dsp: DspConfig;
}

export function createTapeSaturationCurve(amount: number): Float32Array {
  const samples = 2048;
  const curve = new Float32Array(samples);
  const k = amount * 10;
  for (let i = 0; i < samples; i++) {
    const x = (i * 2) / samples - 1;
    if (k === 0) {
      curve[i] = x;
    } else {
      const asym = 0.06 * (x * x);
      const shaped = ((1 + k) * (x + asym)) / (1 + k * Math.abs(x + asym));
      curve[i] = Math.tanh(shaped);
    }
  }
  return curve;
}

export function createReverbImpulse(audioCtx: AudioContext, durationSeconds = 2.4, decay = 2.2): AudioBuffer {
  const sampleRate = audioCtx.sampleRate;
  const length = Math.max(1, Math.floor(sampleRate * Math.max(0.5, durationSeconds)));
  const impulse = audioCtx.createBuffer(2, length, sampleRate);
  const left = impulse.getChannelData(0);
  const right = impulse.getChannelData(1);

  for (let i = 0; i < length; i++) {
    const t = i / length;
    const envelope = Math.pow(1 - t, decay);
    left[i] = (Math.random() * 2 - 1) * envelope;
    right[i] = (Math.random() * 2 - 1) * envelope;
  }
  return impulse;
}

function throttle<T extends (...args: unknown[]) => void>(func: T, delay: number): T {
  let lastCall = 0;
  let timeoutId: number | null = null;
  let lastArgs: unknown[] | null = null;

  return ((...args: unknown[]) => {
    const now = Date.now();
    lastArgs = args;
    const remaining = delay - (now - lastCall);

    if (remaining <= 0) {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      lastCall = now;
      func(...args);
    } else if (timeoutId === null) {
      timeoutId = window.setTimeout(() => {
        lastCall = Date.now();
        timeoutId = null;
        if (lastArgs) {
          func(...lastArgs);
        }
      }, remaining);
    }
  }) as T;
}

const PROMPT_SUGGESTIONS = [
  'Minimal Techno',
  'Punchy Kick',
  'Lush Strings',
  'Acid Synth Bass',
  '80s Analog Synth',
  'Bossa Nova',
  'Chiptune Lead',
  'Dubstep Wobble',
  'Funky Slap Bass',
  'Neo Soul Rhodes',
  'Post Punk Guitars',
  'Shoegaze Drone',
  'Dark Industrial Percussion',
  'Deep House Chords',
  'Afrobeat Horns',
  'Trap 808 Sub Bass',
  'Cyberpunk Arpeggiator',
  'Glitchy Hi-Hats',
  'Ethereal Pad',
  'Acoustic Percussion',
];

const COLORS = [
  '#00f0ff',
  '#ff0077',
  '#ffe600',
  '#00ff88',
  '#a855f7',
  '#ff6b00',
  '#3b82f6',
  '#f43f5e',
];

function getUnusedRandomColor(usedColors: string[]): string {
  const available = COLORS.filter((c) => !usedColors.includes(c));
  if (available.length === 0) {
    return COLORS[Math.floor(Math.random() * COLORS.length)];
  }
  return available[Math.floor(Math.random() * available.length)];
}

export const SOUND_BANKS: SoundBank[] = [
  {
    id: 'club-techno',
    name: 'Club Techno & Cyber',
    description: '130 BPM, bombos contundentes y sintetizadores ácidos de pista oscura',
    bpm: 130,
    scale: Scale.C_MAJOR_A_MINOR,
    guidance: 4.5,
    temperature: 1.1,
    prompts: [
      {text: 'Minimal Techno', weight: 1.1},
      {text: 'Punchy Kick', weight: 1.3},
      {text: 'Acid Synth Bass', weight: 0.9},
      {text: 'Dark Industrial Percussion', weight: 0.7},
    ],
  },
  {
    id: 'synthwave-80s',
    name: 'Retro Synthwave 80s',
    description: '116 BPM, sintetizadores analógicos, baterías con gated reverb y bajos neón',
    bpm: 116,
    scale: Scale.D_MAJOR_B_MINOR,
    guidance: 4.2,
    temperature: 1.0,
    prompts: [
      {text: '80s Analog Synth', weight: 1.2},
      {text: 'Gated Reverb Drums', weight: 1.0},
      {text: 'Cyberpunk Arpeggiator', weight: 0.8},
      {text: 'Lush Pad', weight: 0.7},
    ],
  },
  {
    id: 'lofi-chill',
    name: 'Lo-Fi Chill & Soul',
    description: '84 BPM, texturas de vinilo, acordes cálidos de Rhodes y ritmos relajados',
    bpm: 84,
    scale: Scale.F_MAJOR_D_MINOR,
    guidance: 3.5,
    temperature: 1.2,
    prompts: [
      {text: 'Neo Soul Rhodes', weight: 1.1},
      {text: 'Acoustic Percussion', weight: 0.8},
      {text: 'Funky Slap Bass', weight: 0.7},
      {text: 'Ethereal Pad', weight: 0.6},
    ],
  },
  {
    id: 'future-bass',
    name: 'Future Bass & EDM',
    description: '140 BPM, acordes de super-saw intensos, drops con sub-bajos y arpegios',
    bpm: 140,
    scale: Scale.G_MAJOR_E_MINOR,
    guidance: 4.8,
    temperature: 1.1,
    prompts: [
      {text: 'Dubstep Wobble', weight: 1.0},
      {text: 'Trap 808 Sub Bass', weight: 1.3},
      {text: 'Chiptune Lead', weight: 0.7},
    ],
  },
  {
    id: 'ambient-cinematic',
    name: 'Cinematic Ambient',
    description: '72 BPM, paisajes sonoros espaciales, cuerdas etéreas y atmósferas inmersivas',
    bpm: 72,
    scale: Scale.A_MAJOR_G_FLAT_MINOR,
    guidance: 3.0,
    temperature: 1.3,
    prompts: [
      {text: 'Lush Strings', weight: 1.2},
      {text: 'Shoegaze Drone', weight: 0.9},
      {text: 'Ethereal Pad', weight: 1.0},
      {text: 'Deep Space Drone', weight: 0.6},
    ],
  },
  {
    id: 'latin-groove',
    name: 'Bossa & Afro Groove',
    description: '102 BPM, guitarras brasileñas, percusión afrocubana y ritmo orgánico',
    bpm: 102,
    scale: Scale.C_MAJOR_A_MINOR,
    guidance: 3.9,
    temperature: 1.0,
    prompts: [
      {text: 'Bossa Nova', weight: 1.1},
      {text: 'Afrobeat Horns', weight: 0.9},
      {text: 'Funky Slap Bass', weight: 0.8},
      {text: 'Glitchy Hi-Hats', weight: 0.5},
    ],
  },
];

export const DEFAULT_SCENES: SceneSnapshot[] = [
  {
    id: 'A',
    label: 'Intro / Warm',
    bpm: 124,
    scale: Scale.C_MAJOR_A_MINOR,
    prompts: [
      {text: 'Minimal Techno', weight: 0.9, muted: false, color: '#00f0ff'},
      {text: 'Lush Pad', weight: 1.1, muted: false, color: '#ff0077'},
      {text: 'Punchy Kick', weight: 0.5, muted: false, color: '#00ff88'},
    ],
    dsp: {
      filterVal: 0,
      saturationDrive: 0.15,
      delaySubdivision: '1/8d',
      delayFeedback: 0.3,
      delayMix: 0.2,
      reverbDecay: 2.2,
      reverbMix: 0.25,
      reverbBypass: false,
    },
  },
  {
    id: 'B',
    label: 'Peak Drop',
    bpm: 130,
    scale: Scale.C_MAJOR_A_MINOR,
    prompts: [
      {text: 'Punchy Kick', weight: 1.4, muted: false, color: '#00ff88'},
      {text: 'Acid Synth Bass', weight: 1.2, muted: false, color: '#ffe600'},
      {text: 'Minimal Techno', weight: 1.0, muted: false, color: '#00f0ff'},
    ],
    dsp: {
      filterVal: 0,
      saturationDrive: 0.45,
      delaySubdivision: '1/16',
      delayFeedback: 0.2,
      delayMix: 0.1,
      reverbDecay: 1.2,
      reverbMix: 0.15,
      reverbBypass: false,
    },
  },
  {
    id: 'C',
    label: 'Acid Energy',
    bpm: 132,
    scale: Scale.D_MAJOR_B_MINOR,
    prompts: [
      {text: 'Acid Synth Bass', weight: 1.5, muted: false, color: '#ffe600'},
      {text: 'Cyberpunk Arpeggiator', weight: 1.1, muted: false, color: '#ff3898'},
      {text: 'Punchy Kick', weight: 0.8, muted: false, color: '#00ff88'},
    ],
    dsp: {
      filterVal: 0.25,
      saturationDrive: 0.6,
      delaySubdivision: '1/8',
      delayFeedback: 0.55,
      delayMix: 0.35,
      reverbDecay: 2.8,
      reverbMix: 0.3,
      reverbBypass: false,
    },
  },
  {
    id: 'D',
    label: 'Ambient Break',
    bpm: 110,
    scale: Scale.F_MAJOR_D_MINOR,
    prompts: [
      {text: 'Ethereal Pad', weight: 1.3, muted: false, color: '#00f5d4'},
      {text: 'Neo Soul Rhodes', weight: 1.0, muted: false, color: '#ff9d00'},
      {text: 'Punchy Kick', weight: 0.0, muted: true, color: '#00ff88'},
    ],
    dsp: {
      filterVal: -0.2,
      saturationDrive: 0.05,
      delaySubdivision: '1/4',
      delayFeedback: 0.45,
      delayMix: 0.4,
      reverbDecay: 4.5,
      reverbMix: 0.5,
      reverbBypass: false,
    },
  },
];

/* -------------------------------------------------------------------------
   COMPONENT: dj-visualizer (Real-time Web Audio FFT Spectrum & Oscilloscope)
-------------------------------------------------------------------------- */
@customElement('dj-visualizer')
export class DjVisualizer extends LitElement {
  static override styles = css`
    :host {
      display: block;
      width: 100%;
      height: 100%;
      position: relative;
    }
    canvas {
      width: 100%;
      height: 100%;
      display: block;
      border-radius: 6px;
      background: rgba(0, 0, 0, 0.45);
    }
    .hud {
      position: absolute;
      top: 6px;
      left: 10px;
      display: flex;
      gap: 12px;
      font-size: 10px;
      font-family: var(--dj-font-mono);
      color: var(--dj-text-muted);
      letter-spacing: 0.5px;
      pointer-events: none;
    }
    .hud-val {
      color: var(--dj-accent);
      font-weight: 700;
    }
    .peak-indicator {
      position: absolute;
      top: 6px;
      right: 10px;
      display: flex;
      align-items: center;
      gap: 5px;
      font-size: 10px;
      font-family: var(--dj-font-mono);
    }
    .led {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #333;
      transition: background 0.08s ease;
    }
    .led.green {
      background: #00ff88;
      box-shadow: 0 0 6px #00ff88;
    }
    .led.yellow {
      background: #ffbb00;
      box-shadow: 0 0 6px #ffbb00;
    }
    .led.red {
      background: #ff3344;
      box-shadow: 0 0 6px #ff3344;
    }
  `;

  @property({attribute: false}) analyser: AnalyserNode | null = null;
  @property({type: String}) isPlaying: PlaybackState = 'stopped';
  @property({type: String}) visualizerMode: 'high' | 'eco' | 'off' = 'high';

  @query('canvas') private canvas!: HTMLCanvasElement;
  private animFrameId: number | null = null;
  @state() private peakLevel = 0;

  override firstUpdated() {
    this.startRenderLoop();
  }

  override updated(changed: PropertyValues) {
    if (changed.has('analyser') || changed.has('isPlaying') || changed.has('visualizerMode')) {
      if (this.visualizerMode === 'off') {
        if (this.animFrameId) {
          cancelAnimationFrame(this.animFrameId);
          this.animFrameId = null;
        }
        this.clearCanvas();
      } else if (!this.animFrameId) {
        this.startRenderLoop();
      }
    }
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
  }

  private clearCanvas() {
    if (!this.canvas) return;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private startRenderLoop() {
    const render = () => {
      this.draw();
      this.animFrameId = requestAnimationFrame(render);
    };
    this.animFrameId = requestAnimationFrame(render);
  }

  private draw() {
    if (!this.canvas) return;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;

    const width = this.canvas.width;
    const height = this.canvas.height;

    // Auto-adjust resolution to CSS dimensions
    const rect = this.canvas.getBoundingClientRect();
    if (this.canvas.width !== Math.floor(rect.width * window.devicePixelRatio) ||
        this.canvas.height !== Math.floor(rect.height * window.devicePixelRatio)) {
      this.canvas.width = Math.max(10, Math.floor(rect.width * window.devicePixelRatio));
      this.canvas.height = Math.max(10, Math.floor(rect.height * window.devicePixelRatio));
    }

    ctx.clearRect(0, 0, width, height);

    // Subtle grid background
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
    ctx.lineWidth = 1;
    for (let x = 0; x < width; x += 30) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
    for (let y = 0; y < height; y += 20) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    if (!this.analyser || this.isPlaying !== 'playing') {
      // Idle oscilloscope line
      ctx.strokeStyle = 'rgba(0, 240, 255, 0.25)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      const midY = height / 2;
      ctx.moveTo(0, midY);
      const time = Date.now() * 0.002;
      for (let x = 0; x < width; x += 4) {
        const idleWave = Math.sin(x * 0.03 + time) * 3;
        ctx.lineTo(x, midY + idleWave);
      }
      ctx.stroke();
      this.peakLevel = 0;
      return;
    }

    const bufferLength = this.analyser.frequencyBinCount;
    const freqData = new Uint8Array(bufferLength);
    this.analyser.getByteFrequencyData(freqData);

    const timeData = new Uint8Array(bufferLength);
    this.analyser.getByteTimeDomainData(timeData);

    // Calculate peak level
    let sum = 0;
    for (let i = 0; i < bufferLength; i++) {
      const v = (timeData[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / bufferLength);
    this.peakLevel = Math.min(1, rms * 4.5);

    // Spectrum bars
    const numBars = this.visualizerMode === 'eco' ? 32 : 56;
    const barWidth = width / numBars;
    const step = Math.floor(bufferLength / numBars);

    for (let i = 0; i < numBars; i++) {
      let val = 0;
      for (let j = 0; j < step; j++) {
        val += freqData[i * step + j] || 0;
      }
      val = val / step;
      const barHeight = (val / 255) * (height * 0.82);

      const x = i * barWidth;
      const y = height - barHeight;

      // Color gradient per bar
      const ratio = i / numBars;
      const r = Math.floor(0 + ratio * 255);
      const g = Math.floor(240 - ratio * 100);
      const b = Math.floor(255 - ratio * 150);

      const grad = ctx.createLinearGradient(0, height, 0, y);
      grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0.2)`);
      grad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0.85)`);

      ctx.fillStyle = grad;
      ctx.fillRect(x + 1, y, barWidth - 2, barHeight);

      // Bar peak cap
      ctx.fillStyle = `rgba(255, 255, 255, 0.9)`;
      ctx.fillRect(x + 1, Math.max(0, y - 2), barWidth - 2, 2);
    }

    // Oscilloscope waveform line over the spectrum
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    const sliceWidth = width / bufferLength;
    let x = 0;
    for (let i = 0; i < bufferLength; i += 2) {
      const v = timeData[i] / 128.0;
      const y = (v * height) / 2;
      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
      x += sliceWidth * 2;
    }
    ctx.stroke();
  }

  override render() {
    const isHot = this.peakLevel > 0.85;
    const isMedium = this.peakLevel > 0.5;
    const isNorm = this.peakLevel > 0.05;

    return html`
      <div class="hud">
        <span>FFT SPECTRUM // 48kHz</span>
        <span>PEAK: <span class="hud-val">${Math.round(this.peakLevel * 100)}%</span></span>
        <span>DSP: <span class="hud-val">${this.isPlaying.toUpperCase()}</span></span>
      </div>
      <div class="peak-indicator">
        <span class="led ${isNorm ? 'green' : ''}"></span>
        <span class="led ${isMedium ? 'yellow' : ''}"></span>
        <span class="led ${isHot ? 'red' : ''}"></span>
      </div>
      <canvas></canvas>
    `;
  }
}

/* -------------------------------------------------------------------------
   COMPONENT: weight-slider (DJ Channel Volume / Prompt Weight Fader)
-------------------------------------------------------------------------- */
@customElement('weight-slider')
class WeightSlider extends LitElement {
  static override styles = css`
    :host {
      cursor: ns-resize;
      position: relative;
      height: 100%;
      width: 100%;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      box-sizing: border-box;
      padding: 4px;
    }
    .fader-track-wrap {
      width: 100%;
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      position: relative;
      padding: 0 4px;
    }
    .meter-scale {
      position: absolute;
      left: 6px;
      height: 80%;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      font-size: 8px;
      font-family: var(--dj-font-mono);
      color: rgba(255, 255, 255, 0.3);
      pointer-events: none;
      user-select: none;
    }
    .track-outer {
      position: relative;
      width: 12px;
      height: 84%;
      background: #090b10;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 6px;
      box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.8);
      display: flex;
      align-items: flex-end;
      overflow: hidden;
    }
    .track-fill {
      width: 100%;
      border-radius: 4px;
      transition: height 0.05s ease-out;
      box-shadow: 0 0 10px currentColor;
    }
    .fader-thumb {
      position: absolute;
      left: 50%;
      transform: translate(-50%, 50%);
      width: 38px;
      height: 18px;
      background: linear-gradient(180deg, #3a4454 0%, #1c222c 50%, #11151b 100%);
      border: 1px solid rgba(255, 255, 255, 0.35);
      border-radius: 3px;
      box-shadow: 0 3px 6px rgba(0, 0, 0, 0.7), inset 0 1px 0 rgba(255, 255, 255, 0.4);
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: grab;
      z-index: 5;
    }
    .fader-thumb:active {
      cursor: grabbing;
      border-color: var(--dj-accent);
    }
    .thumb-indicator {
      width: 80%;
      height: 2px;
      background: var(--dj-accent);
      box-shadow: 0 0 4px var(--dj-accent);
      border-radius: 1px;
    }
    .fader-readout {
      margin-top: 4px;
      font-family: var(--dj-font-mono);
      font-size: 11px;
      font-weight: 700;
      color: #fff;
      background: rgba(0, 0, 0, 0.5);
      padding: 2px 6px;
      border-radius: 4px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      user-select: none;
      min-width: 42px;
      text-align: center;
    }
  `;

  @property({type: Number}) value = 0;
  @property({type: String}) color = '#00f0ff';

  @query('.track-outer') private trackEl!: HTMLDivElement;

  private isDragging = false;
  private trackRect: DOMRect | null = null;

  constructor() {
    super();
    this.handlePointerDown = this.handlePointerDown.bind(this);
    this.handlePointerMove = this.handlePointerMove.bind(this);
    this.handlePointerUp = this.handlePointerUp.bind(this);
  }

  private handlePointerDown(e: PointerEvent) {
    e.preventDefault();
    this.isDragging = true;
    this.trackRect = this.trackEl.getBoundingClientRect();
    document.body.classList.add('dragging');
    window.addEventListener('pointermove', this.handlePointerMove);
    window.addEventListener('pointerup', this.handlePointerUp);
    this.updateFromY(e.clientY);
  }

  private handlePointerMove(e: PointerEvent) {
    if (!this.isDragging) return;
    this.updateFromY(e.clientY);
  }

  private handlePointerUp() {
    this.isDragging = false;
    document.body.classList.remove('dragging');
    window.removeEventListener('pointermove', this.handlePointerMove);
    this.trackRect = null;
  }

  private handleWheel(e: WheelEvent) {
    e.preventDefault();
    const delta = -e.deltaY * 0.002;
    this.value = Math.max(0, Math.min(2, this.value + delta));
    this.dispatchEvent(new CustomEvent<number>('input', {detail: this.value}));
  }

  private updateFromY(clientY: number) {
    if (!this.trackRect) return;
    const height = this.trackRect.height;
    const relativeY = clientY - this.trackRect.top;
    const normalized = 1 - Math.max(0, Math.min(height, relativeY)) / height;
    this.value = Math.max(0, Math.min(2, normalized * 2));
    this.dispatchEvent(new CustomEvent<number>('input', {detail: this.value}));
  }

  override render() {
    const percent = (this.value / 2) * 100;
    const fillStyle = styleMap({
      height: `${percent}%`,
      backgroundColor: this.color,
      color: this.color,
    });
    const thumbStyle = styleMap({
      bottom: `${percent}%`,
    });

    return html`
      <div
        class="fader-track-wrap"
        @pointerdown=${this.handlePointerDown}
        @wheel=${this.handleWheel}>
        <div class="meter-scale">
          <span>+6</span>
          <span>+3</span>
          <span>0dB</span>
          <span>-6</span>
          <span>-∞</span>
        </div>
        <div class="track-outer">
          <div class="track-fill" style=${fillStyle}></div>
          <div class="fader-thumb" style=${thumbStyle}>
            <div class="thumb-indicator" style="background: ${this.color}; box-shadow: 0 0 5px ${this.color};"></div>
          </div>
        </div>
      </div>
      <div class="fader-readout" style="color: ${this.value > 0 ? this.color : '#666'}">
        ${this.value.toFixed(2)}
      </div>
    `;
  }
}

/* -------------------------------------------------------------------------
   COMPONENT: prompt-controller (DJ Channel Strip)
-------------------------------------------------------------------------- */
@customElement('prompt-controller')
class PromptController extends LitElement {
  static override styles = css`
    :host {
      display: block;
      height: 100%;
      min-width: 135px;
      max-width: 175px;
      flex: 1;
    }
    .channel-strip {
      position: relative;
      height: 100%;
      width: 100%;
      display: flex;
      flex-direction: column;
      background: var(--dj-surface);
      border: 1px solid var(--dj-border);
      border-radius: 8px;
      box-sizing: border-box;
      padding: 8px;
      gap: 6px;
      transition: border-color 0.2s, box-shadow 0.2s;
    }
    .channel-strip.active {
      border-color: rgba(255, 255, 255, 0.25);
      box-shadow: 0 4px 15px rgba(0, 0, 0, 0.4);
    }
    .channel-strip.muted {
      opacity: 0.65;
      filter: grayscale(40%);
    }
    .strip-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      padding-bottom: 6px;
    }
    .channel-tag {
      font-family: var(--dj-font-mono);
      font-size: 11px;
      font-weight: 700;
      padding: 2px 6px;
      border-radius: 3px;
      background: rgba(255, 255, 255, 0.08);
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .channel-led {
      width: 6px;
      height: 6px;
      border-radius: 50%;
    }
    .remove-btn {
      background: transparent;
      border: none;
      color: var(--dj-text-muted);
      cursor: pointer;
      font-size: 14px;
      padding: 2px 5px;
      border-radius: 3px;
      transition: background 0.15s, color 0.15s;
    }
    .remove-btn:hover {
      background: rgba(255, 50, 50, 0.2);
      color: #ff4455;
    }
    .prompt-box {
      background: rgba(0, 0, 0, 0.35);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 5px;
      padding: 6px 8px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .prompt-input {
      font-family: var(--dj-font-display);
      font-size: 13px;
      font-weight: 600;
      color: #fff;
      background: transparent;
      border: none;
      outline: none;
      text-align: center;
      word-break: break-word;
      min-height: 32px;
      max-height: 48px;
      overflow-y: auto;
      line-height: 1.2;
    }
    .prompt-input:focus {
      border-bottom: 1px solid var(--dj-accent);
    }
    .quick-weights {
      display: flex;
      justify-content: space-between;
      gap: 2px;
    }
    .quick-btn {
      flex: 1;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.08);
      color: var(--dj-text-muted);
      font-family: var(--dj-font-mono);
      font-size: 9px;
      padding: 3px 0;
      border-radius: 3px;
      cursor: pointer;
      transition: background 0.12s, color 0.12s;
    }
    .quick-btn:hover {
      background: rgba(255, 255, 255, 0.15);
      color: #fff;
    }
    .fader-area {
      flex: 1;
      min-height: 100px;
      position: relative;
    }
    .strip-footer {
      display: flex;
      gap: 4px;
      border-top: 1px solid rgba(255, 255, 255, 0.08);
      padding-top: 6px;
    }
    .toggle-btn {
      flex: 1;
      font-family: var(--dj-font-mono);
      font-size: 10px;
      font-weight: 700;
      padding: 4px 0;
      border-radius: 4px;
      border: 1px solid rgba(255, 255, 255, 0.12);
      background: rgba(255, 255, 255, 0.05);
      color: var(--dj-text-muted);
      cursor: pointer;
      text-align: center;
      transition: all 0.12s ease;
    }
    .toggle-btn.mute-active {
      background: rgba(255, 50, 68, 0.25);
      color: #ff3344;
      border-color: #ff3344;
    }
    .toggle-btn.solo-active {
      background: rgba(255, 230, 0, 0.25);
      color: #ffe600;
      border-color: #ffe600;
    }
    :host([filtered='true']) .prompt-box {
      border-color: #ff3344;
      background: rgba(255, 50, 68, 0.15);
    }
  `;

  @property({type: String, reflect: true}) promptId = '';
  @property({type: String}) text = '';
  @property({type: Number}) weight = 0;
  @property({type: String}) color = '#00f0ff';
  @property({type: Number}) channelIndex = 1;
  @property({type: Boolean}) muted = false;
  @property({type: Boolean}) soloed = false;

  @query('weight-slider') private slider!: WeightSlider;
  @query('.prompt-input') private textSpan!: HTMLElement;

  private handleWeightInput(e: CustomEvent<number>) {
    this.weight = e.detail;
    this.dispatchChange();
  }

  private handleTextBlur() {
    const raw = this.textSpan?.textContent?.trim();
    if (raw && raw !== this.text) {
      this.text = raw;
      this.dispatchChange();
    } else if (!raw) {
      if (this.textSpan) this.textSpan.textContent = this.text;
    }
  }

  private handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      this.handleTextBlur();
      this.textSpan.blur();
    }
  }

  private adjustWeight(delta: number) {
    this.weight = Math.max(0, Math.min(2, Math.round((this.weight + delta) * 100) / 100));
    this.dispatchChange();
  }

  private setDirectWeight(val: number) {
    this.weight = val;
    this.dispatchChange();
  }

  private toggleMute() {
    this.muted = !this.muted;
    this.dispatchEvent(new CustomEvent('channel-mute-toggle', {
      detail: {promptId: this.promptId, muted: this.muted},
      bubbles: true,
      composed: true,
    }));
  }

  private toggleSolo() {
    this.dispatchEvent(new CustomEvent('channel-solo-toggle', {
      detail: {promptId: this.promptId},
      bubbles: true,
      composed: true,
    }));
  }

  private dispatchChange() {
    this.dispatchEvent(new CustomEvent<Prompt>('prompt-changed', {
      detail: {
        promptId: this.promptId,
        text: this.text,
        weight: this.weight,
        color: this.color,
        muted: this.muted,
      },
      bubbles: true,
      composed: true,
    }));
  }

  private removePrompt() {
    this.dispatchEvent(new CustomEvent<string>('prompt-removed', {
      detail: this.promptId,
      bubbles: true,
      composed: true,
    }));
  }

  override render() {
    const isActive = this.weight > 0 && !this.muted;
    const stripClasses = classMap({
      'channel-strip': true,
      'active': isActive,
      'muted': this.muted,
    });

    return html`
      <div class=${stripClasses}>
        <div class="strip-header">
          <div class="channel-tag" style="color: ${this.color}">
            <span class="channel-led" style="background: ${this.color}; box-shadow: 0 0 6px ${this.color}"></span>
            CH ${this.channelIndex}
          </div>
          <button class="remove-btn" @click=${this.removePrompt} title="Eliminar canal">✕</button>
        </div>

        <div class="prompt-box">
          <div
            class="prompt-input"
            contenteditable="plaintext-only"
            spellcheck="false"
            @blur=${this.handleTextBlur}
            @keydown=${this.handleKeyDown}
          >${this.text}</div>
          <div class="quick-weights">
            <button class="quick-btn" @click=${() => this.setDirectWeight(0)}>0</button>
            <button class="quick-btn" @click=${() => this.adjustWeight(-0.25)}>-0.25</button>
            <button class="quick-btn" @click=${() => this.adjustWeight(0.25)}>+0.25</button>
            <button class="quick-btn" @click=${() => this.setDirectWeight(1.0)}>1.0</button>
            <button class="quick-btn" @click=${() => this.setDirectWeight(2.0)}>MAX</button>
          </div>
        </div>

        <div class="fader-area">
          <weight-slider
            .value=${this.weight}
            .color=${this.color}
            @input=${this.handleWeightInput}></weight-slider>
        </div>

        <div class="strip-footer">
          <button
            class="toggle-btn ${this.muted ? 'mute-active' : ''}"
            @click=${this.toggleMute}>
            MUTE
          </button>
          <button
            class="toggle-btn ${this.soloed ? 'solo-active' : ''}"
            @click=${this.toggleSolo}>
            SOLO
          </button>
        </div>
      </div>
    `;
  }
}

/* -------------------------------------------------------------------------
   COMPONENT: session-vault-modal (Custom Presets, Sound Banks & Import/Export)
-------------------------------------------------------------------------- */
@customElement('session-vault-modal')
class SessionVaultModal extends LitElement {
  static override styles = css`
    :host {
      display: block;
      position: fixed;
      inset: 0;
      z-index: 1000;
      background: rgba(0, 0, 0, 0.75);
      backdrop-filter: blur(6px);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 16px;
    }
    .modal-card {
      width: 100%;
      max-width: 720px;
      max-height: 85vh;
      background: var(--dj-surface);
      border: 1px solid var(--dj-border-highlight);
      border-radius: 12px;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.8), var(--dj-glow);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .modal-header {
      padding: 16px 20px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid var(--dj-border);
      background: var(--dj-surface-elevated);
    }
    .modal-title {
      font-family: var(--dj-font-display);
      font-size: 20px;
      font-weight: 700;
      color: #fff;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .close-btn {
      background: transparent;
      border: 1px solid var(--dj-border);
      color: var(--dj-text-muted);
      border-radius: 6px;
      width: 32px;
      height: 32px;
      font-size: 16px;
      cursor: pointer;
    }
    .close-btn:hover {
      background: rgba(255, 255, 255, 0.1);
      color: #fff;
    }
    .modal-tabs {
      display: flex;
      background: rgba(0, 0, 0, 0.3);
      border-bottom: 1px solid var(--dj-border);
    }
    .tab-btn {
      flex: 1;
      padding: 12px;
      background: transparent;
      border: none;
      border-bottom: 2px solid transparent;
      color: var(--dj-text-muted);
      font-family: var(--dj-font-mono);
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
      transition: all 0.15s;
    }
    .tab-btn.active {
      color: var(--dj-accent);
      border-bottom-color: var(--dj-accent);
      background: rgba(255, 255, 255, 0.04);
    }
    .modal-body {
      padding: 20px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .grid-banks {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 12px;
    }
    .bank-card {
      background: var(--dj-surface-elevated);
      border: 1px solid var(--dj-border);
      border-radius: 8px;
      padding: 14px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      cursor: pointer;
      transition: transform 0.12s, border-color 0.12s;
    }
    .bank-card:hover {
      transform: translateY(-2px);
      border-color: var(--dj-accent);
    }
    .bank-title {
      font-weight: 700;
      font-size: 15px;
      color: #fff;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .bank-bpm {
      font-family: var(--dj-font-mono);
      font-size: 11px;
      color: var(--dj-accent);
      background: rgba(0, 240, 255, 0.1);
      padding: 2px 6px;
      border-radius: 4px;
    }
    .bank-desc {
      font-size: 12px;
      color: var(--dj-text-muted);
      line-height: 1.4;
    }
    .bank-tags {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }
    .bank-tag {
      font-size: 10px;
      font-family: var(--dj-font-mono);
      padding: 2px 6px;
      border-radius: 3px;
      background: rgba(255, 255, 255, 0.06);
      color: #ccc;
    }
    .save-input-row {
      display: flex;
      gap: 10px;
    }
    .save-input {
      flex: 1;
      background: var(--dj-surface-elevated);
      border: 1px solid var(--dj-border);
      border-radius: 6px;
      padding: 10px 14px;
      font-family: inherit;
      color: #fff;
      font-size: 14px;
      outline: none;
    }
    .save-input:focus {
      border-color: var(--dj-accent);
    }
    .primary-btn {
      background: var(--dj-accent);
      color: #000;
      font-family: var(--dj-font-mono);
      font-weight: 700;
      font-size: 12px;
      padding: 10px 18px;
      border-radius: 6px;
      border: none;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .primary-btn:hover {
      filter: brightness(1.15);
    }
    .saved-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .saved-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: var(--dj-surface-elevated);
      border: 1px solid var(--dj-border);
      border-radius: 8px;
      padding: 12px 16px;
    }
    .saved-info {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .saved-name {
      font-weight: 700;
      font-size: 14px;
      color: #fff;
    }
    .saved-meta {
      font-family: var(--dj-font-mono);
      font-size: 11px;
      color: var(--dj-text-muted);
    }
    .saved-actions {
      display: flex;
      gap: 8px;
    }
    .load-btn {
      background: rgba(0, 240, 255, 0.15);
      border: 1px solid var(--dj-accent);
      color: var(--dj-accent);
      font-family: var(--dj-font-mono);
      font-size: 11px;
      font-weight: 700;
      padding: 6px 12px;
      border-radius: 4px;
      cursor: pointer;
    }
    .load-btn:hover {
      background: var(--dj-accent);
      color: #000;
    }
    .delete-btn {
      background: transparent;
      border: 1px solid rgba(255, 50, 68, 0.3);
      color: #ff3344;
      font-family: var(--dj-font-mono);
      font-size: 11px;
      padding: 6px 10px;
      border-radius: 4px;
      cursor: pointer;
    }
    .delete-btn:hover {
      background: rgba(255, 50, 68, 0.2);
    }
    .empty-msg {
      text-align: center;
      padding: 30px;
      color: var(--dj-text-muted);
      font-size: 13px;
    }
    .io-row {
      display: flex;
      justify-content: space-between;
      padding-top: 12px;
      border-top: 1px solid var(--dj-border);
    }
    .secondary-btn {
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid var(--dj-border);
      color: #eee;
      font-family: var(--dj-font-mono);
      font-size: 11px;
      padding: 8px 14px;
      border-radius: 6px;
      cursor: pointer;
    }
    .secondary-btn:hover {
      background: rgba(255, 255, 255, 0.15);
    }
  `;

  @property({attribute: false}) savedSessions: SavedSession[] = [];
  @state() private activeTab: 'banks' | 'saved' = 'banks';
  @state() private newSessionName = '';

  @query('#import-file') private fileInput!: HTMLInputElement;

  private handleSave() {
    const name = this.newSessionName.trim() || `DJ Set ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}`;
    this.dispatchEvent(new CustomEvent<string>('save-session', {
      detail: name,
      bubbles: true,
      composed: true,
    }));
    this.newSessionName = '';
  }

  private handleLoadBank(bank: SoundBank) {
    this.dispatchEvent(new CustomEvent<SoundBank>('load-bank', {
      detail: bank,
      bubbles: true,
      composed: true,
    }));
    this.close();
  }

  private handleLoadSession(session: SavedSession) {
    this.dispatchEvent(new CustomEvent<SavedSession>('load-session', {
      detail: session,
      bubbles: true,
      composed: true,
    }));
    this.close();
  }

  private handleDeleteSession(id: string) {
    this.dispatchEvent(new CustomEvent<string>('delete-session', {
      detail: id,
      bubbles: true,
      composed: true,
    }));
  }

  private handleExportAll() {
    const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(this.savedSessions, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute('href', dataStr);
    downloadAnchor.setAttribute('download', `promptdj_sessions_${Date.now()}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  }

  private triggerImport() {
    this.fileInput?.click();
  }

  private handleFileChange(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const parsed = JSON.parse(evt.target?.result as string) as SavedSession[];
        if (Array.isArray(parsed)) {
          this.dispatchEvent(new CustomEvent<SavedSession[]>('import-sessions', {
            detail: parsed,
            bubbles: true,
            composed: true,
          }));
        }
      } catch (err) {
        console.error('Failed to parse sessions json', err);
      }
    };
    reader.readAsText(file);
  }

  private close() {
    this.dispatchEvent(new CustomEvent('close-modal', {bubbles: true, composed: true}));
  }

  override render() {
    return html`
      <div class="modal-card" @click=${(e: Event) => e.stopPropagation()}>
        <div class="modal-header">
          <div class="modal-title">
            <span>🎛️ SESSION VAULT & SOUND BANKS</span>
          </div>
          <button class="close-btn" @click=${this.close}>✕</button>
        </div>

        <div class="modal-tabs">
          <button
            class="tab-btn ${this.activeTab === 'banks' ? 'active' : ''}"
            @click=${() => (this.activeTab = 'banks')}>
            BANCOS TEMÁTICOS PRESET (${SOUND_BANKS.length})
          </button>
          <button
            class="tab-btn ${this.activeTab === 'saved' ? 'active' : ''}"
            @click=${() => (this.activeTab = 'saved')}>
            SESIONES GUARDADAS (${this.savedSessions.length})
          </button>
        </div>

        <div class="modal-body">
          ${this.activeTab === 'banks'
            ? html`
                <div class="grid-banks">
                  ${SOUND_BANKS.map(
                    (bank) => html`
                      <div class="bank-card" @click=${() => this.handleLoadBank(bank)}>
                        <div class="bank-title">
                          <span>${bank.name}</span>
                          <span class="bank-bpm">${bank.bpm} BPM</span>
                        </div>
                        <div class="bank-desc">${bank.description}</div>
                        <div class="bank-tags">
                          ${bank.prompts.map(
                            (p) => html`<span class="bank-tag">${p.text} (${p.weight})</span>`,
                          )}
                        </div>
                      </div>
                    `,
                  )}
                </div>
              `
            : html`
                <div class="save-input-row">
                  <input
                    type="text"
                    class="save-input"
                    placeholder="Nombre para la sesión actual..."
                    .value=${this.newSessionName}
                    @input=${(e: Event) =>
                      (this.newSessionName = (e.target as HTMLInputElement).value)}
                    @keydown=${(e: KeyboardEvent) => e.key === 'Enter' && this.handleSave()} />
                  <button class="primary-btn" @click=${this.handleSave}>
                    💾 GUARDAR ACTUAL
                  </button>
                </div>

                <div class="saved-list">
                  ${this.savedSessions.length === 0
                    ? html`<div class="empty-msg">No hay sesiones guardadas todavía. ¡Guarda tu mezcla actual arriba!</div>`
                    : this.savedSessions.map(
                        (sess) => html`
                          <div class="saved-item">
                            <div class="saved-info">
                              <div class="saved-name">${sess.name}</div>
                              <div class="saved-meta">
                                ${new Date(sess.timestamp).toLocaleString()} • ${sess.prompts.length} canales • ${sess.config?.bpm || 'Auto'} BPM
                              </div>
                            </div>
                            <div class="saved-actions">
                              <button class="load-btn" @click=${() => this.handleLoadSession(sess)}>CARGAR</button>
                              <button class="delete-btn" @click=${() => this.handleDeleteSession(sess.id)}>BORRAR</button>
                            </div>
                          </div>
                        `,
                      )}
                </div>

                <div class="io-row">
                  <button class="secondary-btn" @click=${this.handleExportAll}>
                    ⬇ EXPORTAR TODO (JSON)
                  </button>
                  <button class="secondary-btn" @click=${this.triggerImport}>
                    ⬆ IMPORTAR (JSON)
                  </button>
                  <input
                    type="file"
                    id="import-file"
                    style="display: none;"
                    accept=".json"
                    @change=${this.handleFileChange} />
                </div>
              `}
        </div>
      </div>
    `;
  }
}

/* -------------------------------------------------------------------------
   COMPONENT: performance-modal (Audio Latency & Engine Performance Settings)
-------------------------------------------------------------------------- */
@customElement('performance-modal')
class PerformanceModal extends LitElement {
  static override styles = css`
    :host {
      display: block;
      position: fixed;
      inset: 0;
      z-index: 1000;
      background: rgba(0, 0, 0, 0.75);
      backdrop-filter: blur(6px);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 16px;
    }
    .modal-card {
      width: 100%;
      max-width: 580px;
      background: var(--dj-surface);
      border: 1px solid var(--dj-border-highlight);
      border-radius: 12px;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.8), var(--dj-glow);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .modal-header {
      padding: 16px 20px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid var(--dj-border);
      background: var(--dj-surface-elevated);
    }
    .modal-title {
      font-family: var(--dj-font-display);
      font-size: 18px;
      font-weight: 700;
      color: #fff;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .close-btn {
      background: transparent;
      border: 1px solid var(--dj-border);
      color: var(--dj-text-muted);
      border-radius: 6px;
      width: 32px;
      height: 32px;
      font-size: 16px;
      cursor: pointer;
    }
    .modal-body {
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 20px;
    }
    .section-title {
      font-size: 12px;
      font-family: var(--dj-font-mono);
      color: var(--dj-accent);
      letter-spacing: 0.5px;
      margin-bottom: 8px;
      display: flex;
      justify-content: space-between;
    }
    .latency-options {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 8px;
    }
    .latency-btn {
      background: var(--dj-surface-elevated);
      border: 1px solid var(--dj-border);
      border-radius: 8px;
      padding: 10px 6px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
      cursor: pointer;
      transition: all 0.12s;
    }
    .latency-btn:hover {
      border-color: rgba(255, 255, 255, 0.3);
    }
    .latency-btn.active {
      border-color: var(--dj-accent);
      background: rgba(0, 240, 255, 0.1);
      box-shadow: 0 0 10px rgba(0, 240, 255, 0.2);
    }
    .latency-time {
      font-family: var(--dj-font-mono);
      font-size: 15px;
      font-weight: 800;
      color: #fff;
    }
    .latency-label {
      font-size: 10px;
      color: var(--dj-text-muted);
    }
    .stats-panel {
      background: rgba(0, 0, 0, 0.35);
      border: 1px solid var(--dj-border);
      border-radius: 8px;
      padding: 12px 16px;
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 12px;
      font-family: var(--dj-font-mono);
    }
    .stat-box {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .stat-lbl {
      font-size: 10px;
      color: var(--dj-text-muted);
    }
    .stat-val {
      font-size: 15px;
      font-weight: 700;
      color: #fff;
    }
    .stat-val.good {
      color: var(--dj-led-active);
    }
    .stat-val.warn {
      color: #ffaa00;
    }
    .option-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
    }
    .option-info {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .option-name {
      font-size: 14px;
      font-weight: 600;
      color: #fff;
    }
    .option-desc {
      font-size: 12px;
      color: var(--dj-text-muted);
    }
    select {
      background: var(--dj-surface-elevated);
      border: 1px solid var(--dj-border);
      color: #fff;
      padding: 8px 12px;
      border-radius: 6px;
      font-family: var(--dj-font-mono);
      font-size: 12px;
      outline: none;
    }
    select:focus {
      border-color: var(--dj-accent);
    }
  `;

  @property({type: Number}) bufferTime = 2;
  @property({type: String}) visualizerMode: 'high' | 'eco' | 'off' = 'high';
  @property({type: Number}) throttleMs = 200;
  @property({attribute: false}) stats: PerformanceStats = {
    bufferTime: 2,
    currentBufferRemaining: 0,
    underruns: 0,
    chunksReceived: 0,
    sampleRate: 48000,
    audioState: 'running',
  };

  private setBuffer(sec: number) {
    this.dispatchEvent(new CustomEvent<number>('buffer-change', {
      detail: sec,
      bubbles: true,
      composed: true,
    }));
  }

  private handleVisualizerChange(e: Event) {
    const val = (e.target as HTMLSelectElement).value as 'high' | 'eco' | 'off';
    this.dispatchEvent(new CustomEvent<'high' | 'eco' | 'off'>('vis-mode-change', {
      detail: val,
      bubbles: true,
      composed: true,
    }));
  }

  private handleThrottleChange(e: Event) {
    const val = Number((e.target as HTMLSelectElement).value);
    this.dispatchEvent(new CustomEvent<number>('throttle-change', {
      detail: val,
      bubbles: true,
      composed: true,
    }));
  }

  private close() {
    this.dispatchEvent(new CustomEvent('close-modal', {bubbles: true, composed: true}));
  }

  override render() {
    return html`
      <div class="modal-card" @click=${(e: Event) => e.stopPropagation()}>
        <div class="modal-header">
          <div class="modal-title">
            <span>⚡ LATENCIA & RENDIMIENTO DE AUDIO</span>
          </div>
          <button class="close-btn" @click=${this.close}>✕</button>
        </div>

        <div class="modal-body">
          <div>
            <div class="section-title">
              <span>BUFFER DE SEGURIDAD (LATENCIA OBJETIVO)</span>
              <span>ACTUAL: ${this.bufferTime}s</span>
            </div>
            <div class="latency-options">
              <button
                class="latency-btn ${this.bufferTime === 0.6 ? 'active' : ''}"
                @click=${() => this.setBuffer(0.6)}>
                <span class="latency-time">0.6s</span>
                <span class="latency-label">Ultra-Baja</span>
              </button>
              <button
                class="latency-btn ${this.bufferTime === 1.2 ? 'active' : ''}"
                @click=${() => this.setBuffer(1.2)}>
                <span class="latency-time">1.2s</span>
                <span class="latency-label">Rápida</span>
              </button>
              <button
                class="latency-btn ${this.bufferTime === 2.0 ? 'active' : ''}"
                @click=${() => this.setBuffer(2.0)}>
                <span class="latency-time">2.0s</span>
                <span class="latency-label">Balanceada</span>
              </button>
              <button
                class="latency-btn ${this.bufferTime === 3.5 ? 'active' : ''}"
                @click=${() => this.setBuffer(3.5)}>
                <span class="latency-time">3.5s</span>
                <span class="latency-label">Anti-Glitch</span>
              </button>
            </div>
          </div>

          <div>
            <div class="section-title">DIAGNÓSTICO DEL MOTOR DE AUDIO EN VIVO</div>
            <div class="stats-panel">
              <div class="stat-box">
                <span class="stat-lbl">Buffer libre</span>
                <span class="stat-val ${this.stats.currentBufferRemaining > 1 ? 'good' : 'warn'}">
                  ${this.stats.currentBufferRemaining.toFixed(2)}s
                </span>
              </div>
              <div class="stat-box">
                <span class="stat-lbl">Micro-cortes (Underruns)</span>
                <span class="stat-val ${this.stats.underruns === 0 ? 'good' : 'warn'}">
                  ${this.stats.underruns}
                </span>
              </div>
              <div class="stat-box">
                <span class="stat-lbl">Chunks recibidos</span>
                <span class="stat-val">${this.stats.chunksReceived}</span>
              </div>
              <div class="stat-box">
                <span class="stat-lbl">Frecuencia de muestreo</span>
                <span class="stat-val">${this.stats.sampleRate} Hz</span>
              </div>
              <div class="stat-box">
                <span class="stat-lbl">AudioContext</span>
                <span class="stat-val good">${this.stats.audioState.toUpperCase()}</span>
              </div>
              <div class="stat-box">
                <span class="stat-lbl">Streaming API</span>
                <span class="stat-val good">ACTIVO</span>
              </div>
            </div>
          </div>

          <div class="option-row">
            <div class="option-info">
              <span class="option-name">Rendimiento del Visualizador</span>
              <span class="option-desc">Baja la resolución o apaga para ahorrar CPU en dispositivos portátiles</span>
            </div>
            <select .value=${this.visualizerMode} @change=${this.handleVisualizerChange}>
              <option value="high">Alta Definición (60 FPS, 56 Bandas)</option>
              <option value="eco">Modo Eco (30 FPS, 32 Bandas)</option>
              <option value="off">Desactivado (Máximo ahorro)</option>
            </select>
          </div>

          <div class="option-row">
            <div class="option-info">
              <span class="option-name">Velocidad de Respuesta de Faders</span>
              <span class="option-desc">Intervalo de throttling para enviar cambios de faders a la IA</span>
            </div>
            <select .value=${String(this.throttleMs)} @change=${this.handleThrottleChange}>
              <option value="120">Ultrarrápido (120ms)</option>
              <option value="200">Recomendado (200ms)</option>
              <option value="350">Modo Conexión Lenta (350ms)</option>
            </select>
          </div>
        </div>
      </div>
    `;
  }
}

/* -------------------------------------------------------------------------
   COMPONENT: settings-controller (DJ Master FX & Generation Rack)
-------------------------------------------------------------------------- */
@customElement('settings-controller')
class SettingsController extends LitElement {
  static override styles = css`
    :host {
      display: block;
      background: var(--dj-surface);
      border: 1px solid var(--dj-border);
      border-radius: 8px;
      padding: 10px 14px;
      color: #eee;
      box-sizing: border-box;
      font-size: 13px;
    }
    .rack-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 8px;
    }
    .rack-title {
      font-family: var(--dj-font-mono);
      font-size: 11px;
      font-weight: 700;
      color: var(--dj-text-muted);
      letter-spacing: 0.5px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .rack-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
      gap: 12px;
      align-items: center;
    }
    .control-item {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .control-item label {
      display: flex;
      justify-content: space-between;
      font-size: 11px;
      font-family: var(--dj-font-mono);
      color: var(--dj-text-muted);
    }
    .control-item label span {
      color: var(--dj-accent);
      font-weight: 700;
    }
    input[type='range'] {
      width: 100%;
      height: 6px;
      background: #090b10;
      border-radius: 3px;
      outline: none;
      accent-color: var(--dj-accent);
      cursor: pointer;
    }
    select, input[type='number'] {
      background: var(--dj-surface-elevated);
      border: 1px solid var(--dj-border);
      border-radius: 4px;
      color: #fff;
      font-family: var(--dj-font-mono);
      font-size: 11px;
      padding: 4px 6px;
      outline: none;
    }
    select:focus, input[type='number']:focus {
      border-color: var(--dj-accent);
    }
    .checkbox-row {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }
    .cb-badge {
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 11px;
      font-family: var(--dj-font-mono);
      cursor: pointer;
      background: rgba(255, 255, 255, 0.05);
      padding: 3px 8px;
      border-radius: 4px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      user-select: none;
    }
    .cb-badge input {
      accent-color: var(--dj-accent);
      cursor: pointer;
    }
  `;

  private readonly defaultConfig: LiveMusicGenerationConfig = {
    temperature: 1.1,
    topK: 40,
    guidance: 4.0,
    bpm: 120,
    musicGenerationMode: 'QUALITY' as unknown as LiveMusicGenerationConfig['musicGenerationMode'],
  };

  @state() public config: LiveMusicGenerationConfig = this.defaultConfig;

  public resetToDefaults() {
    this.config = {...this.defaultConfig};
    this.dispatchChange();
  }

  public setConfig(newConfig: LiveMusicGenerationConfig) {
    this.config = {...this.config, ...newConfig};
    this.dispatchChange();
  }

  private handleChange(key: keyof LiveMusicGenerationConfig, val: unknown) {
    this.config = {
      ...this.config,
      [key]: val,
    };
    this.dispatchChange();
  }

  private dispatchChange() {
    this.dispatchEvent(new CustomEvent<LiveMusicGenerationConfig>('settings-changed', {
      detail: this.config,
      bubbles: true,
      composed: true,
    }));
  }

  override render() {
    const cfg = this.config;
    const scales: Array<[string, Scale]> = [
      ['Auto', Scale.SCALE_UNSPECIFIED],
      ['C Maj / A Min', Scale.C_MAJOR_A_MINOR],
      ['C# Maj / A# Min', Scale.D_FLAT_MAJOR_B_FLAT_MINOR],
      ['D Maj / B Min', Scale.D_MAJOR_B_MINOR],
      ['D# Maj / C Min', Scale.E_FLAT_MAJOR_C_MINOR],
      ['E Maj / C# Min', Scale.E_MAJOR_D_FLAT_MINOR],
      ['F Maj / D Min', Scale.F_MAJOR_D_MINOR],
      ['F# Maj / D# Min', Scale.G_FLAT_MAJOR_E_FLAT_MINOR],
      ['G Maj / E Min', Scale.G_MAJOR_E_MINOR],
      ['G# Maj / F Min', Scale.A_FLAT_MAJOR_F_MINOR],
      ['A Maj / F# Min', Scale.A_MAJOR_G_FLAT_MINOR],
      ['A# Maj / G Min', Scale.B_FLAT_MAJOR_G_MINOR],
      ['B Maj / G# Min', Scale.B_MAJOR_A_FLAT_MINOR],
    ];

    return html`
      <div class="rack-header">
        <span class="rack-title">🎚️ MASTER DSP & GENERATION PARAMETERS</span>
        <div class="checkbox-row">
          <label class="cb-badge">
            <input
              type="checkbox"
              .checked=${!!cfg.muteBass}
              @change=${(e: Event) => this.handleChange('muteBass', (e.target as HTMLInputElement).checked)} />
            MUTE BASS
          </label>
          <label class="cb-badge">
            <input
              type="checkbox"
              .checked=${!!cfg.muteDrums}
              @change=${(e: Event) => this.handleChange('muteDrums', (e.target as HTMLInputElement).checked)} />
            MUTE DRUMS
          </label>
          <label class="cb-badge">
            <input
              type="checkbox"
              .checked=${!!cfg.onlyBassAndDrums}
              @change=${(e: Event) => this.handleChange('onlyBassAndDrums', (e.target as HTMLInputElement).checked)} />
            SOLO BASS & DRUMS
          </label>
        </div>
      </div>

      <div class="rack-grid">
        <div class="control-item">
          <label>TEMPO (BPM) <span>${cfg.bpm || 'Auto'}</span></label>
          <input
            type="number"
            min="60"
            max="180"
            placeholder="Auto"
            .value=${cfg.bpm ?? ''}
            @change=${(e: Event) => {
              const v = (e.target as HTMLInputElement).value;
              this.handleChange('bpm', v === '' ? undefined : Number(v));
            }} />
        </div>

        <div class="control-item">
          <label>ESCALA MUSICAL</label>
          <select
            .value=${cfg.scale || Scale.SCALE_UNSPECIFIED}
            @change=${(e: Event) => this.handleChange('scale', (e.target as HTMLSelectElement).value as Scale)}>
            ${scales.map(([title, val]) => html`<option value=${val}>${title}</option>`)}
          </select>
        </div>

        <div class="control-item">
          <label>GUIDANCE <span>${(cfg.guidance ?? 4.0).toFixed(1)}</span></label>
          <input
            type="range"
            min="0"
            max="6"
            step="0.1"
            .value=${String(cfg.guidance ?? 4.0)}
            @input=${(e: Event) => this.handleChange('guidance', Number((e.target as HTMLInputElement).value))} />
        </div>

        <div class="control-item">
          <label>TEMPERATURE <span>${(cfg.temperature ?? 1.1).toFixed(1)}</span></label>
          <input
            type="range"
            min="0"
            max="2"
            step="0.1"
            .value=${String(cfg.temperature ?? 1.1)}
            @input=${(e: Event) => this.handleChange('temperature', Number((e.target as HTMLInputElement).value))} />
        </div>

        <div class="control-item">
          <label>MODO GENERACIÓN</label>
          <select
            .value=${cfg.musicGenerationMode || 'QUALITY'}
            @change=${(e: Event) => this.handleChange('musicGenerationMode', (e.target as HTMLSelectElement).value)}>
            <option value="QUALITY">Calidad Sonora (Quality)</option>
            <option value="DIVERSITY">Diversidad (Diversity)</option>
            <option value="VOCALIZATION">Vocalización (Vocalization)</option>
          </select>
        </div>
      </div>
    `;
  }
}

/* -------------------------------------------------------------------------
   COMPONENT: dsp-rack-controller (Low-Latency Hardware FX Rack: A&H, Tape, Delay, Reverb)
-------------------------------------------------------------------------- */
@customElement('dsp-rack-controller')
export class DspRackController extends LitElement {
  static override styles = css`
    :host {
      display: block;
      background: var(--dj-surface-elevated);
      border: 1px solid var(--dj-border);
      border-radius: 8px;
      padding: 12px 16px;
      margin-bottom: 12px;
    }
    .rack-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 12px;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--dj-border);
    }
    .rack-title {
      font-family: var(--dj-font-mono);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.5px;
      color: var(--dj-accent);
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .rack-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
      gap: 12px;
    }
    .fx-unit {
      background: var(--dj-surface);
      border: 1px solid var(--dj-border);
      border-radius: 6px;
      padding: 10px 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .fx-unit-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-family: var(--dj-font-mono);
      font-size: 11px;
      font-weight: 700;
      color: var(--dj-text);
    }
    .fx-badge {
      font-size: 9px;
      padding: 1px 5px;
      border-radius: 3px;
      background: rgba(var(--dj-accent-rgb), 0.15);
      color: var(--dj-accent);
      border: 1px solid rgba(var(--dj-accent-rgb), 0.3);
    }
    .fx-param {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .fx-param-label {
      display: flex;
      justify-content: space-between;
      font-family: var(--dj-font-mono);
      font-size: 10px;
      color: var(--dj-text-muted);
    }
    .fx-param-val {
      color: var(--dj-text);
      font-weight: 700;
    }
    .fx-slider {
      width: 100%;
      height: 4px;
      background: var(--dj-border);
      border-radius: 2px;
      outline: none;
      accent-color: var(--dj-accent);
      cursor: pointer;
    }
    .filter-track-legend {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-family: var(--dj-font-mono);
      font-size: 9px;
      color: var(--dj-text-muted);
      margin-top: 2px;
    }
    .subdiv-selector {
      display: flex;
      gap: 3px;
    }
    .subdiv-btn {
      flex: 1;
      padding: 3px 0;
      background: var(--dj-surface-interactive);
      border: 1px solid var(--dj-border);
      color: var(--dj-text-muted);
      font-family: var(--dj-font-mono);
      font-size: 9px;
      font-weight: 700;
      border-radius: 3px;
      cursor: pointer;
      text-align: center;
      transition: all 0.1s ease;
    }
    .subdiv-btn:hover {
      color: var(--dj-text);
      border-color: var(--dj-border-highlight);
    }
    .subdiv-btn.active {
      background: var(--dj-accent);
      color: #000;
      border-color: var(--dj-accent);
    }
    .reset-btn {
      background: none;
      border: 1px solid var(--dj-border);
      color: var(--dj-text-muted);
      font-family: var(--dj-font-mono);
      font-size: 9px;
      padding: 2px 6px;
      border-radius: 3px;
      cursor: pointer;
    }
    .reset-btn:hover {
      color: var(--dj-text);
      border-color: var(--dj-accent);
    }
    .bypass-btn {
      background: none;
      border: 1px solid var(--dj-border);
      color: var(--dj-text-muted);
      font-family: var(--dj-font-mono);
      font-size: 9px;
      padding: 2px 6px;
      border-radius: 3px;
      cursor: pointer;
    }
    .bypass-btn.bypassed {
      border-color: var(--dj-led-danger);
      color: var(--dj-led-danger);
      background: rgba(255, 51, 68, 0.1);
    }
    .meter-bar {
      height: 4px;
      background: rgba(0, 0, 0, 0.3);
      border-radius: 2px;
      overflow: hidden;
    }
    .meter-fill {
      height: 100%;
      background: linear-gradient(to right, var(--dj-accent), #ff9d00, #ff3344);
      transition: width 0.1s ease;
    }
  `;

  @property({type: Object})
  public dsp: DspConfig = {
    filterVal: 0,
    saturationDrive: 0,
    delaySubdivision: '1/8d',
    delayFeedback: 0.3,
    delayMix: 0,
    reverbDecay: 2.2,
    reverbMix: 0,
    reverbBypass: false,
  };

  @property({type: Number})
  public bpm = 120;

  private updateDsp(patch: Partial<DspConfig>) {
    this.dsp = {...this.dsp, ...patch};
    this.dispatchEvent(new CustomEvent<DspConfig>('dsp-changed', {
      detail: this.dsp,
      bubbles: true,
      composed: true,
    }));
  }

  override render() {
    const d = this.dsp;
    const filterText =
      d.filterVal === 0
        ? 'BYPASS (0)'
        : d.filterVal < 0
        ? `LPF ${(20000 * Math.pow(40 / 20000, Math.abs(d.filterVal))).toFixed(0)} Hz`
        : `HPF ${(20 * Math.pow(15000 / 20, d.filterVal)).toFixed(0)} Hz`;

    const beatSec = 60 / (this.bpm || 120);
    const subdivMultipliers: Record<string, number> = {
      '1/16': 0.25,
      '1/8': 0.5,
      '1/8d': 0.75,
      '1/4': 1.0,
      '1/2': 2.0,
    };
    const delayMs = Math.round(beatSec * (subdivMultipliers[d.delaySubdivision] || 0.75) * 1000);

    return html`
      <div class="rack-header">
        <span class="rack-title">
          ⚡ RACK DSP DE BAJAS LATENCIAS (ALLEN & HEATH FILTER • TAPE • BPM DELAY • REVERB)
        </span>
        <button class="reset-btn" @click=${() => this.updateDsp({
          filterVal: 0,
          saturationDrive: 0,
          delayMix: 0,
          reverbMix: 0,
        })}>
          RESET FX
        </button>
      </div>

      <div class="rack-grid">
        <!-- 1. FILTRO DJ BI-DIRECCIONAL (A&H) -->
        <div class="fx-unit">
          <div class="fx-unit-header">
            <span>🎚️ FILTRO DJ A&H</span>
            <span class="fx-badge">${filterText}</span>
          </div>
          <div class="fx-param">
            <input
              type="range"
              class="fx-slider"
              min="-1"
              max="1"
              step="0.02"
              .value=${String(d.filterVal)}
              @input=${(e: Event) => this.updateDsp({filterVal: Number((e.target as HTMLInputElement).value)})} />
            <div class="filter-track-legend">
              <span>◄ LPF</span>
              <button class="reset-btn" style="padding: 0 4px; font-size: 8px;" @click=${() => this.updateDsp({filterVal: 0})}>0 CTR</button>
              <span>HPF ►</span>
            </div>
          </div>
        </div>

        <!-- 2. SATURADOR DE CINTA ANALÓGICO -->
        <div class="fx-unit">
          <div class="fx-unit-header">
            <span>📻 SATURADOR CINTA</span>
            <span class="fx-badge">${Math.round(d.saturationDrive * 100)}% DRIVE</span>
          </div>
          <div class="fx-param">
            <div class="fx-param-label">
              <span>WARMTH DRIVE</span>
              <span class="fx-param-val">${(d.saturationDrive * 10).toFixed(1)} dB</span>
            </div>
            <input
              type="range"
              class="fx-slider"
              min="0"
              max="1"
              step="0.01"
              .value=${String(d.saturationDrive)}
              @input=${(e: Event) => this.updateDsp({saturationDrive: Number((e.target as HTMLInputElement).value)})} />
            <div class="meter-bar">
              <div class="meter-fill" style="width: ${d.saturationDrive * 100}%"></div>
            </div>
          </div>
        </div>

        <!-- 3. BPM SYNC DELAY -->
        <div class="fx-unit">
          <div class="fx-unit-header">
            <span>⏱️ DELAY BPM-SYNC</span>
            <span class="fx-badge">${delayMs} ms</span>
          </div>
          <div class="subdiv-selector">
            ${(['1/16', '1/8', '1/8d', '1/4', '1/2'] as const).map(
              (sub) => html`
                <button
                  class="subdiv-btn ${d.delaySubdivision === sub ? 'active' : ''}"
                  @click=${() => this.updateDsp({delaySubdivision: sub})}>
                  ${sub}
                </button>
              `,
            )}
          </div>
          <div class="fx-param">
            <div class="fx-param-label">
              <span>FDBK: ${Math.round(d.delayFeedback * 100)}%</span>
              <span>D/W: ${Math.round(d.delayMix * 100)}%</span>
            </div>
            <div style="display: flex; gap: 8px;">
              <input
                type="range"
                class="fx-slider"
                min="0"
                max="0.85"
                step="0.01"
                .value=${String(d.delayFeedback)}
                @input=${(e: Event) => this.updateDsp({delayFeedback: Number((e.target as HTMLInputElement).value)})}
                title="Feedback" />
              <input
                type="range"
                class="fx-slider"
                min="0"
                max="1"
                step="0.01"
                .value=${String(d.delayMix)}
                @input=${(e: Event) => this.updateDsp({delayMix: Number((e.target as HTMLInputElement).value)})}
                title="Dry / Wet Mix" />
            </div>
          </div>
        </div>

        <!-- 4. REVERB ESPACIAL -->
        <div class="fx-unit">
          <div class="fx-unit-header">
            <span>🌌 REVERB CONVOLUTIVO</span>
            <button
              class="bypass-btn ${d.reverbBypass ? 'bypassed' : ''}"
              @click=${() => this.updateDsp({reverbBypass: !d.reverbBypass})}>
              ${d.reverbBypass ? 'BYPASS' : 'ACTIVE'}
            </button>
          </div>
          <div class="fx-param">
            <div class="fx-param-label">
              <span>DECAY: ${d.reverbDecay.toFixed(1)}s</span>
              <span>D/W: ${d.reverbBypass ? '0%' : `${Math.round(d.reverbMix * 100)}%`}</span>
            </div>
            <div style="display: flex; gap: 8px;">
              <input
                type="range"
                class="fx-slider"
                min="0.5"
                max="5.0"
                step="0.1"
                .value=${String(d.reverbDecay)}
                @input=${(e: Event) => this.updateDsp({reverbDecay: Number((e.target as HTMLInputElement).value)})}
                title="Decay Time" />
              <input
                type="range"
                class="fx-slider"
                min="0"
                max="1"
                step="0.01"
                .value=${String(d.reverbMix)}
                @input=${(e: Event) => this.updateDsp({reverbMix: Number((e.target as HTMLInputElement).value)})}
                title="Dry / Wet Mix" />
            </div>
          </div>
        </div>
      </div>
    `;
  }
}

/* -------------------------------------------------------------------------
   COMPONENT: prompt-dj (Main DJ Console Application)
-------------------------------------------------------------------------- */
@customElement('prompt-dj')
export class PromptDj extends LitElement {
  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100vh;
      width: 100vw;
      box-sizing: border-box;
      background-color: var(--dj-bg);
      color: var(--dj-text);
      overflow: hidden;
      font-family: var(--dj-font-display);
    }

    /* Top DJ Status Bar */
    .dj-top-bar {
      height: 52px;
      background: var(--dj-surface);
      border-bottom: 1px solid var(--dj-border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 16px;
      flex-shrink: 0;
      gap: 12px;
    }
    .brand-section {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .brand-logo {
      font-family: var(--dj-font-display);
      font-weight: 700;
      font-size: 18px;
      letter-spacing: 1px;
      color: #fff;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .brand-logo span {
      color: var(--dj-accent);
    }
    .live-badge {
      display: flex;
      align-items: center;
      gap: 6px;
      font-family: var(--dj-font-mono);
      font-size: 10px;
      font-weight: 700;
      padding: 3px 8px;
      border-radius: 4px;
      background: rgba(0, 0, 0, 0.4);
      border: 1px solid var(--dj-border);
    }
    .live-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #555;
    }
    .live-dot.on-air {
      background: var(--dj-led-active);
      box-shadow: 0 0 8px var(--dj-led-active);
      animation: pulse 1.5s infinite;
    }
    .live-dot.buffering {
      background: #ffbb00;
      box-shadow: 0 0 8px #ffbb00;
      animation: blink 0.8s infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }
    @keyframes blink {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.1; }
    }

    .top-controls {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .hud-chip {
      font-family: var(--dj-font-mono);
      font-size: 11px;
      background: var(--dj-surface-elevated);
      border: 1px solid var(--dj-border);
      padding: 4px 10px;
      border-radius: 5px;
      color: var(--dj-text-muted);
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .hud-chip span {
      color: #fff;
      font-weight: 700;
    }
    .action-btn {
      background: var(--dj-surface-elevated);
      border: 1px solid var(--dj-border);
      color: #fff;
      font-family: var(--dj-font-mono);
      font-size: 11px;
      font-weight: 700;
      padding: 6px 12px;
      border-radius: 6px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 6px;
      transition: all 0.12s;
    }
    .action-btn:hover {
      border-color: var(--dj-accent);
      background: rgba(255, 255, 255, 0.08);
    }
    .theme-selector {
      background: var(--dj-surface-elevated);
      border: 1px solid var(--dj-border);
      color: #fff;
      font-family: var(--dj-font-mono);
      font-size: 11px;
      padding: 6px 10px;
      border-radius: 6px;
      outline: none;
      cursor: pointer;
    }

    /* Main Console Workspace */
    .dj-console {
      flex: 1;
      display: flex;
      flex-direction: column;
      padding: 12px;
      gap: 10px;
      overflow: hidden;
      position: relative;
    }

    /* Deck Master Row (Visualizer + Master Controls) */
    .master-row {
      height: 120px;
      display: flex;
      gap: 12px;
      flex-shrink: 0;
    }
    .visualizer-card {
      flex: 1;
      background: var(--dj-surface);
      border: 1px solid var(--dj-border);
      border-radius: 8px;
      padding: 6px;
      position: relative;
    }
    .master-transport-card {
      width: 320px;
      background: var(--dj-surface);
      border: 1px solid var(--dj-border);
      border-radius: 8px;
      padding: 10px 14px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      gap: 8px;
    }
    .transport-buttons {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .big-play-btn {
      flex: 2;
      height: 44px;
      border-radius: 6px;
      border: none;
      font-family: var(--dj-font-mono);
      font-size: 13px;
      font-weight: 800;
      letter-spacing: 0.5px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      transition: all 0.15s;
    }
    .big-play-btn.play {
      background: var(--dj-accent);
      color: #000;
      box-shadow: 0 0 15px rgba(var(--dj-accent-rgb), 0.3);
    }
    .big-play-btn.pause {
      background: #ffbb00;
      color: #000;
    }
    .big-play-btn.loading {
      background: #555;
      color: #fff;
    }
    .small-transport-btn {
      flex: 1;
      height: 44px;
      background: var(--dj-surface-elevated);
      border: 1px solid var(--dj-border);
      color: #eee;
      border-radius: 6px;
      font-family: var(--dj-font-mono);
      font-size: 11px;
      font-weight: 700;
      cursor: pointer;
      transition: background 0.12s;
    }
    .small-transport-btn:hover {
      background: rgba(255, 255, 255, 0.12);
    }
    .master-vol-row {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .master-vol-lbl {
      font-family: var(--dj-font-mono);
      font-size: 10px;
      color: var(--dj-text-muted);
      min-width: 70px;
    }
    .master-slider {
      flex: 1;
      height: 6px;
      background: #090b10;
      accent-color: var(--dj-accent);
      cursor: pointer;
    }

    /* Channels Mixer Deck */
    .mixer-deck-container {
      flex: 1;
      display: flex;
      gap: 10px;
      overflow-x: auto;
      overflow-y: hidden;
      padding-bottom: 4px;
      scrollbar-width: thin;
    }
    .add-channel-card {
      width: 110px;
      flex-shrink: 0;
      background: rgba(255, 255, 255, 0.02);
      border: 2px dashed var(--dj-border);
      border-radius: 8px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 8px;
      color: var(--dj-text-muted);
      cursor: pointer;
      transition: all 0.15s;
    }
    .add-channel-card:hover {
      border-color: var(--dj-accent);
      color: var(--dj-accent);
      background: rgba(0, 240, 255, 0.04);
    }
    .add-icon {
      width: 36px;
      height: 36px;
      border-radius: 50%;
      background: var(--dj-surface-elevated);
      border: 1px solid var(--dj-border);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 20px;
      font-weight: 700;
    }
    .add-lbl {
      font-family: var(--dj-font-mono);
      font-size: 11px;
      font-weight: 700;
    }

    /* Bottom Rack */
    .bottom-rack {
      flex-shrink: 0;
    }

    /* Toast notification */
    .dj-toast {
      position: fixed;
      bottom: 24px;
      left: 50%;
      transform: translateX(-50%);
      background: #111;
      border: 1px solid var(--dj-accent);
      color: #fff;
      padding: 10px 18px;
      border-radius: 6px;
      box-shadow: 0 10px 25px rgba(0, 0, 0, 0.8), 0 0 10px rgba(var(--dj-accent-rgb), 0.3);
      font-family: var(--dj-font-mono);
      font-size: 12px;
      display: flex;
      align-items: center;
      gap: 12px;
      z-index: 2000;
      pointer-events: none;
    }
  `;

  @property({type: Object, attribute: false})
  private prompts: Map<string, Prompt> = new Map();

  @state() private playbackState: PlaybackState = 'stopped';
  @state() private currentTheme: DjTheme = 'theme-club';
  @state() private bufferTime = 2.0;
  @state() private throttleMs = 200;
  @state() private visualizerMode: 'high' | 'eco' | 'off' = 'high';
  @state() private masterVolume = 1.0;
  @state() private showSessionVault = false;
  @state() private showPerformanceModal = false;
  @state() private toastMessage: string | null = null;
  @state() private savedSessions: SavedSession[] = [];
  @state() private soloPromptId: string | null = null;

  @state() private perfStats: PerformanceStats = {
    bufferTime: 2.0,
    currentBufferRemaining: 0,
    underruns: 0,
    chunksReceived: 0,
    sampleRate: 48000,
    audioState: 'running',
  };

  @state() private dspConfig: DspConfig = DEFAULT_SCENES[0].dsp;
  @state() private scenes: SceneSnapshot[] = DEFAULT_SCENES;
  @state() private activeSceneId: string | null = 'A';
  @state() private isRecordingScene = false;
  @state() private isMatrixExpanded = false;

  private tapeSaturatorNode!: WaveShaperNode;
  private djLowpassFilter!: BiquadFilterNode;
  private djHighpassFilter!: BiquadFilterNode;
  private fxSplitterGain!: GainNode;
  private dryGain!: GainNode;
  private delayNode!: DelayNode;
  private delayFilterNode!: BiquadFilterNode;
  private delayFeedbackGain!: GainNode;
  private delayWetGain!: GainNode;
  private convolverNode!: ConvolverNode;
  private reverbWetGain!: GainNode;
  private dspOutputGain!: GainNode;

  private nextPromptId = 0;
  private session: LiveMusicSession | null = null;
  private readonly sampleRate = 48000;
  private audioContext = new (window.AudioContext || (window as unknown as {webkitAudioContext: typeof AudioContext}).webkitAudioContext)({
    sampleRate: this.sampleRate,
  });
  private analyserNode: AnalyserNode = this.audioContext.createAnalyser();
  private masterGainNode: GainNode = this.audioContext.createGain();
  private nextStartTime = 0;
  private connectionError = true;
  private perfTimer: number | null = null;
  private toastTimer: number | null = null;

  @query('settings-controller') private settingsCtrl!: SettingsController;

  constructor() {
    super();
    // Initialize Web Audio DSP Chain
    this.tapeSaturatorNode = this.audioContext.createWaveShaper();
    this.tapeSaturatorNode.oversample = '4x';
    this.tapeSaturatorNode.curve = createTapeSaturationCurve(this.dspConfig.saturationDrive);

    this.djLowpassFilter = this.audioContext.createBiquadFilter();
    this.djLowpassFilter.type = 'lowpass';
    this.djLowpassFilter.frequency.value = 20000;
    this.djLowpassFilter.Q.value = 1.5;

    this.djHighpassFilter = this.audioContext.createBiquadFilter();
    this.djHighpassFilter.type = 'highpass';
    this.djHighpassFilter.frequency.value = 20;
    this.djHighpassFilter.Q.value = 1.5;

    this.fxSplitterGain = this.audioContext.createGain();
    this.dryGain = this.audioContext.createGain();
    this.dryGain.gain.value = 1.0;

    this.delayNode = this.audioContext.createDelay(5.0);
    this.delayNode.delayTime.value = 0.375;

    this.delayFilterNode = this.audioContext.createBiquadFilter();
    this.delayFilterNode.type = 'lowpass';
    this.delayFilterNode.frequency.value = 3200;

    this.delayFeedbackGain = this.audioContext.createGain();
    this.delayFeedbackGain.gain.value = this.dspConfig.delayFeedback;

    this.delayWetGain = this.audioContext.createGain();
    this.delayWetGain.gain.value = this.dspConfig.delayMix;

    this.convolverNode = this.audioContext.createConvolver();
    this.convolverNode.buffer = createReverbImpulse(this.audioContext, this.dspConfig.reverbDecay);

    this.reverbWetGain = this.audioContext.createGain();
    this.reverbWetGain.gain.value = this.dspConfig.reverbMix;

    this.dspOutputGain = this.audioContext.createGain();

    // Signal Flow:
    // tapeSaturator -> djLowpass -> djHighpass -> fxSplitter
    this.tapeSaturatorNode.connect(this.djLowpassFilter);
    this.djLowpassFilter.connect(this.djHighpassFilter);
    this.djHighpassFilter.connect(this.fxSplitterGain);

    // Dry path:
    this.fxSplitterGain.connect(this.dryGain);
    this.dryGain.connect(this.dspOutputGain);

    // Delay path with feedback loop:
    this.fxSplitterGain.connect(this.delayNode);
    this.delayNode.connect(this.delayFilterNode);
    this.delayFilterNode.connect(this.delayFeedbackGain);
    this.delayFeedbackGain.connect(this.delayNode);
    this.delayFilterNode.connect(this.delayWetGain);
    this.delayWetGain.connect(this.dspOutputGain);

    // Reverb path:
    this.fxSplitterGain.connect(this.convolverNode);
    this.convolverNode.connect(this.reverbWetGain);
    this.reverbWetGain.connect(this.dspOutputGain);

    // Master bus & Visualizer:
    this.dspOutputGain.connect(this.masterGainNode);
    this.masterGainNode.connect(this.analyserNode);
    this.analyserNode.connect(this.audioContext.destination);

    this.analyserNode.fftSize = 256;
    this.analyserNode.smoothingTimeConstant = 0.8;

    // Load stored scenes if available
    const rawScenes = localStorage.getItem('dj_scene_snapshots');
    if (rawScenes) {
      try {
        this.scenes = JSON.parse(rawScenes);
      } catch (err) {
        console.error('Failed to load scenes', err);
      }
    }

    // Load stored theme
    const savedTheme = localStorage.getItem('dj_theme') as DjTheme;
    if (savedTheme) {
      this.currentTheme = savedTheme;
    }
    document.body.className = this.currentTheme;

    // Load stored sessions
    const rawSessions = localStorage.getItem('dj_saved_sessions');
    if (rawSessions) {
      try {
        this.savedSessions = JSON.parse(rawSessions);
      } catch (err) {
        console.error('Failed to load saved sessions', err);
      }
    }

    // Load initial prompts or create default DJ preset
    this.prompts = this.loadInitialPrompts();
    this.nextPromptId = this.prompts.size;
  }

  override connectedCallback() {
    super.connectedCallback();
    this.perfTimer = window.setInterval(() => {
      this.updatePerfStats();
    }, 400);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    if (this.perfTimer) clearInterval(this.perfTimer);
  }

  override async firstUpdated() {
    await this.connectToSession();
    this.sendSessionPrompts();
  }

  private updatePerfStats() {
    const remaining = Math.max(0, this.nextStartTime - this.audioContext.currentTime);
    this.perfStats = {
      ...this.perfStats,
      bufferTime: this.bufferTime,
      currentBufferRemaining: remaining,
      audioState: this.audioContext.state,
    };
  }

  private async connectToSession() {
    try {
      this.session = await ai.live.music.connect({
        model: MODEL_NAME,
        callbacks: {
          onmessage: async (e: LiveMusicServerMessage) => {
            if (e.setupComplete) {
              this.connectionError = false;
              this.showToast('Conectado con éxito a Live Music API');
            }
            if (e.filteredPrompt) {
              this.showToast(`Filtro activado: ${e.filteredPrompt.filteredReason || 'Aviso de seguridad'}`);
            }
            if (e.serverContent?.audioChunks !== undefined) {
              if (this.playbackState === 'paused' || this.playbackState === 'stopped') {
                return;
              }
              this.perfStats.chunksReceived++;

              const audioBuffer = await decodeAudioData(
                decode(e.serverContent.audioChunks[0].data),
                this.audioContext,
                this.sampleRate,
                2,
              );

              const source = this.audioContext.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(this.tapeSaturatorNode);

              if (this.nextStartTime === 0) {
                this.nextStartTime = this.audioContext.currentTime + this.bufferTime;
                setTimeout(() => {
                  this.playbackState = 'playing';
                }, this.bufferTime * 1000);
              }

              if (this.nextStartTime < this.audioContext.currentTime) {
                this.perfStats.underruns++;
                this.playbackState = 'loading';
                this.nextStartTime = 0;
                return;
              }

              source.start(this.nextStartTime);
              this.nextStartTime += audioBuffer.duration;
            }
          },
          onerror: (err: ErrorEvent) => {
            console.error('Session error:', err);
            this.connectionError = true;
            this.stopAudio();
            this.showToast('Error de conexión con la IA musical.');
          },
          onclose: () => {
            this.connectionError = true;
            this.stopAudio();
          },
        },
      });
    } catch (err) {
      console.error('Connection failed', err);
      this.connectionError = true;
      this.showToast('Error al conectar con la API de Gemini Music.');
    }
  }

  private sendSessionPrompts = throttle(async () => {
    if (!this.session) return;

    const weightedPrompts = Array.from(this.prompts.values())
      .filter((p) => {
        if (this.soloPromptId && p.promptId !== this.soloPromptId) return false;
        if (p.muted) return false;
        return p.weight > 0;
      })
      .map((p) => ({
        text: p.text,
        weight: p.weight,
      }));

    try {
      await this.session.setWeightedPrompts({weightedPrompts});
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.showToast(msg);
      this.pauseAudio();
    }
  }, 200);

  private handlePromptChanged(e: CustomEvent<Prompt>) {
    const detail = e.detail;
    const existing = this.prompts.get(detail.promptId);
    if (!existing) return;

    this.prompts.set(detail.promptId, {...existing, ...detail});
    this.prompts = new Map(this.prompts);
    this.sendSessionPrompts();
    this.savePromptsToStorage();
    this.requestUpdate();
  }

  private handleChannelMuteToggle(e: CustomEvent<{promptId: string; muted: boolean}>) {
    const {promptId, muted} = e.detail;
    const p = this.prompts.get(promptId);
    if (p) {
      p.muted = muted;
      this.prompts = new Map(this.prompts);
      this.sendSessionPrompts();
      this.savePromptsToStorage();
    }
  }

  private handleChannelSoloToggle(e: CustomEvent<{promptId: string}>) {
    const {promptId} = e.detail;
    if (this.soloPromptId === promptId) {
      this.soloPromptId = null;
    } else {
      this.soloPromptId = promptId;
    }
    this.prompts = new Map(this.prompts);
    this.sendSessionPrompts();
  }

  private handlePromptRemoved(e: CustomEvent<string>) {
    const promptId = e.detail;
    if (this.prompts.has(promptId)) {
      this.prompts.delete(promptId);
      if (this.soloPromptId === promptId) this.soloPromptId = null;
      this.prompts = new Map(this.prompts);
      this.sendSessionPrompts();
      this.savePromptsToStorage();
    }
  }

  private addChannel(initialText?: string, initialWeight = 1.0) {
    const id = `prompt-${this.nextPromptId++}`;
    const usedColors = Array.from(this.prompts.values()).map((p) => p.color);
    const color = getUnusedRandomColor(usedColors);
    const text = initialText || PROMPT_SUGGESTIONS[Math.floor(Math.random() * PROMPT_SUGGESTIONS.length)];

    this.prompts.set(id, {
      promptId: id,
      text,
      weight: initialWeight,
      color,
      muted: false,
    });

    this.prompts = new Map(this.prompts);
    this.sendSessionPrompts();
    this.savePromptsToStorage();
  }

  private async handlePlayPause() {
    if (this.playbackState === 'playing') {
      this.pauseAudio();
    } else if (this.playbackState === 'paused' || this.playbackState === 'stopped') {
      if (this.connectionError || !this.session) {
        await this.connectToSession();
        this.sendSessionPrompts();
      }
      this.loadAudio();
    } else if (this.playbackState === 'loading') {
      this.stopAudio();
    }
  }

  private loadAudio() {
    this.audioContext.resume();
    this.session?.play();
    this.playbackState = 'loading';
    this.masterGainNode.gain.setValueAtTime(this.masterVolume, this.audioContext.currentTime);
  }

  private pauseAudio() {
    this.session?.pause();
    this.playbackState = 'paused';
    this.nextStartTime = 0;
  }

  private stopAudio() {
    this.session?.stop();
    this.playbackState = 'stopped';
    this.nextStartTime = 0;
  }

  private handleReset() {
    this.pauseAudio();
    this.session?.resetContext();
    this.settingsCtrl?.resetToDefaults();
    this.session?.setMusicGenerationConfig({musicGenerationConfig: {}});
    this.showToast('Contexto de música reiniciado.');
    setTimeout(() => this.loadAudio(), 100);
  }

  private handleMasterVolumeChange(e: Event) {
    const val = Number((e.target as HTMLInputElement).value);
    this.masterVolume = val;
    this.masterGainNode.gain.setValueAtTime(val, this.audioContext.currentTime);
  }

  private handleThemeChange(e: Event) {
    const theme = (e.target as HTMLSelectElement).value as DjTheme;
    this.currentTheme = theme;
    document.body.className = theme;
    localStorage.setItem('dj_theme', theme);
  }

  private handleBufferChange(e: CustomEvent<number>) {
    this.bufferTime = e.detail;
    this.showToast(`Latencia de buffer configurada a ${this.bufferTime}s`);
  }

  private handleVisModeChange(e: CustomEvent<'high' | 'eco' | 'off'>) {
    this.visualizerMode = e.detail;
  }

  private handleThrottleChange(e: CustomEvent<number>) {
    this.throttleMs = e.detail;
    this.sendSessionPrompts = throttle(this.sendSessionPrompts, this.throttleMs);
  }

  private handleLoadBank(e: CustomEvent<SoundBank>) {
    const bank = e.detail;
    const newPrompts = new Map<string, Prompt>();
    const usedColors: string[] = [];

    bank.prompts.forEach((bp, idx) => {
      const color = getUnusedRandomColor(usedColors);
      usedColors.push(color);
      const id = `prompt-${idx}`;
      newPrompts.set(id, {
        promptId: id,
        text: bp.text,
        weight: bp.weight,
        color,
        muted: false,
      });
    });

    this.prompts = newPrompts;
    this.nextPromptId = bank.prompts.length;
    this.soloPromptId = null;

    if (this.settingsCtrl) {
      this.settingsCtrl.setConfig({
        bpm: bank.bpm,
        scale: bank.scale,
        guidance: bank.guidance,
        temperature: bank.temperature,
      });
    }

    this.sendSessionPrompts();
    this.savePromptsToStorage();
    this.showToast(`Banco cargado: ${bank.name}`);
  }

  private handleSaveSession(e: CustomEvent<string>) {
    const name = e.detail;
    const session: SavedSession = {
      id: `session-${Date.now()}`,
      name,
      timestamp: Date.now(),
      theme: this.currentTheme,
      bufferTime: this.bufferTime,
      prompts: Array.from(this.prompts.values()),
      config: this.settingsCtrl ? this.settingsCtrl.config : {},
    };

    this.savedSessions = [session, ...this.savedSessions];
    localStorage.setItem('dj_saved_sessions', JSON.stringify(this.savedSessions));
    this.showToast(`Sesión "${name}" guardada con éxito.`);
  }

  private handleLoadSession(e: CustomEvent<SavedSession>) {
    const sess = e.detail;
    const newMap = new Map<string, Prompt>();
    sess.prompts.forEach((p) => newMap.set(p.promptId, p));
    this.prompts = newMap;
    this.nextPromptId = this.prompts.size + 1;
    this.soloPromptId = null;

    if (sess.theme) {
      this.currentTheme = sess.theme;
      document.body.className = sess.theme;
    }
    if (sess.bufferTime) {
      this.bufferTime = sess.bufferTime;
    }
    if (sess.config && this.settingsCtrl) {
      this.settingsCtrl.setConfig(sess.config);
    }

    this.sendSessionPrompts();
    this.savePromptsToStorage();
    this.showToast(`Sesión "${sess.name}" cargada.`);
  }

  private handleDeleteSession(e: CustomEvent<string>) {
    const id = e.detail;
    this.savedSessions = this.savedSessions.filter((s) => s.id !== id);
    localStorage.setItem('dj_saved_sessions', JSON.stringify(this.savedSessions));
    this.showToast('Sesión eliminada');
  }

  private handleImportSessions(e: CustomEvent<SavedSession[]>) {
    const incoming = e.detail;
    this.savedSessions = [...incoming, ...this.savedSessions];
    localStorage.setItem('dj_saved_sessions', JSON.stringify(this.savedSessions));
    this.showToast(`${incoming.length} sesiones importadas correctamente.`);
  }

  private handleSettingsChanged(e: CustomEvent<LiveMusicGenerationConfig>) {
    this.session?.setMusicGenerationConfig({
      musicGenerationConfig: e.detail,
    });
  }

  private handleDspChanged(e: CustomEvent<DspConfig>) {
    this.dspConfig = e.detail;
    this.applyDsp(this.dspConfig);
  }

  private applyDsp(dsp: DspConfig) {
    const now = this.audioContext.currentTime;

    // 1. Tape Saturation
    this.tapeSaturatorNode.curve = createTapeSaturationCurve(dsp.saturationDrive);

    // 2. A&H DJ Bi-directional Filter
    if (dsp.filterVal === 0) {
      this.djLowpassFilter.frequency.setTargetAtTime(20000, now, 0.02);
      this.djHighpassFilter.frequency.setTargetAtTime(20, now, 0.02);
    } else if (dsp.filterVal < 0) {
      const lpfFreq = 20000 * Math.pow(40 / 20000, Math.abs(dsp.filterVal));
      this.djLowpassFilter.frequency.setTargetAtTime(lpfFreq, now, 0.02);
      this.djLowpassFilter.Q.setTargetAtTime(1.2 + Math.abs(dsp.filterVal) * 2.2, now, 0.02);
      this.djHighpassFilter.frequency.setTargetAtTime(20, now, 0.02);
    } else {
      const hpfFreq = 20 * Math.pow(15000 / 20, dsp.filterVal);
      this.djHighpassFilter.frequency.setTargetAtTime(hpfFreq, now, 0.02);
      this.djHighpassFilter.Q.setTargetAtTime(1.2 + dsp.filterVal * 2.2, now, 0.02);
      this.djLowpassFilter.frequency.setTargetAtTime(20000, now, 0.02);
    }

    // 3. BPM Sync Delay
    const bpm = this.settingsCtrl?.config?.bpm || 120;
    const beatSec = 60 / bpm;
    const subdivMultipliers: Record<string, number> = {
      '1/16': 0.25,
      '1/8': 0.5,
      '1/8d': 0.75,
      '1/4': 1.0,
      '1/2': 2.0,
    };
    const delaySec = beatSec * (subdivMultipliers[dsp.delaySubdivision] || 0.75);
    this.delayNode.delayTime.setTargetAtTime(Math.min(4.5, delaySec), now, 0.04);
    this.delayFeedbackGain.gain.setTargetAtTime(dsp.delayFeedback, now, 0.02);
    this.delayWetGain.gain.setTargetAtTime(dsp.delayMix, now, 0.02);

    // 4. Space Reverb
    this.reverbWetGain.gain.setTargetAtTime(dsp.reverbBypass ? 0 : dsp.reverbMix, now, 0.02);
    this.convolverNode.buffer = createReverbImpulse(this.audioContext, dsp.reverbDecay);
  }

  private handleSceneSelect(scene: SceneSnapshot) {
    this.activeSceneId = scene.id;

    // 1. Restore prompts
    const newPrompts = new Map<string, Prompt>();
    const usedColors: string[] = [];
    scene.prompts.forEach((sp, idx) => {
      const color = sp.color || getUnusedRandomColor(usedColors);
      usedColors.push(color);
      const id = `prompt-${idx}`;
      newPrompts.set(id, {
        promptId: id,
        text: sp.text,
        weight: sp.weight,
        color,
        muted: !!sp.muted,
      });
    });
    this.prompts = newPrompts;
    this.nextPromptId = scene.prompts.length;
    this.soloPromptId = null;

    // 2. Restore DSP
    this.dspConfig = {...scene.dsp};
    this.applyDsp(this.dspConfig);

    // 3. Restore BPM & Scale
    if (this.settingsCtrl) {
      this.settingsCtrl.setConfig({
        bpm: scene.bpm,
        scale: scene.scale,
      });
    }

    this.sendSessionPrompts();
    this.savePromptsToStorage();
    this.showToast(`Escena [${scene.id}] activada: ${scene.label}`);
    this.requestUpdate();
  }

  private handleSaveSceneSnapshot(sceneId: 'A' | 'B' | 'C' | 'D') {
    const idx = this.scenes.findIndex((s) => s.id === sceneId);
    if (idx === -1) return;

    const currentPrompts = Array.from(this.prompts.values()).map((p) => ({
      text: p.text,
      weight: p.weight,
      muted: !!p.muted,
      color: p.color,
    }));

    const currentBpm = this.settingsCtrl?.config?.bpm;
    const currentScale = this.settingsCtrl?.config?.scale;

    this.scenes[idx] = {
      ...this.scenes[idx],
      prompts: currentPrompts,
      bpm: currentBpm,
      scale: currentScale,
      dsp: {...this.dspConfig},
    };
    this.scenes = [...this.scenes];
    localStorage.setItem('dj_scene_snapshots', JSON.stringify(this.scenes));
    this.activeSceneId = sceneId;
    this.isRecordingScene = false;
    this.showToast(`Escena [${sceneId}] guardada con la mezcla actual`);
    this.requestUpdate();
  }

  private showToast(msg: string) {
    this.toastMessage = msg;
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      this.toastMessage = null;
    }, 3200);
  }

  private loadInitialPrompts(): Map<string, Prompt> {
    const raw = localStorage.getItem('dj_prompts');
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Prompt[];
        return new Map(parsed.map((p) => [p.promptId, p]));
      } catch (err) {
        console.error('Failed to parse stored prompts', err);
      }
    }

    // Default Bank: Club Techno
    const defaultBank = SOUND_BANKS[0];
    const map = new Map<string, Prompt>();
    const usedColors: string[] = [];
    defaultBank.prompts.forEach((bp, i) => {
      const color = getUnusedRandomColor(usedColors);
      usedColors.push(color);
      map.set(`prompt-${i}`, {
        promptId: `prompt-${i}`,
        text: bp.text,
        weight: bp.weight,
        color,
        muted: false,
      });
    });
    return map;
  }

  private savePromptsToStorage() {
    localStorage.setItem('dj_prompts', JSON.stringify(Array.from(this.prompts.values())));
  }

  override render() {
    const isLive = this.playbackState === 'playing';
    const isBuffering = this.playbackState === 'loading';

    const activePrompts = Array.from(this.prompts.values()).filter(
      (p) => !p.muted && p.weight > 0 && (!this.soloPromptId || p.promptId === this.soloPromptId),
    );
    const totalWeight = activePrompts.reduce((sum, p) => sum + p.weight, 0);

    return html`
      <!-- Top DJ Status Bar -->
      <header class="dj-top-bar">
        <div class="brand-section">
          <div class="brand-logo">
            <span>PROMPT DJ</span> // CONSOLE
          </div>
          <div class="live-badge">
            <span class="live-dot ${isLive ? 'on-air' : isBuffering ? 'buffering' : ''}"></span>
            ${isLive ? 'ON AIR' : isBuffering ? 'BUFFERING' : 'STANDBY'}
          </div>
          <div class="hud-chip">
            BPM: <span>${this.settingsCtrl?.config?.bpm || 'Auto'}</span>
          </div>
          <div class="hud-chip">
            KEY: <span>${(this.settingsCtrl?.config?.scale || 'Auto').replace(/_/g, ' ')}</span>
          </div>
        </div>

        <div class="top-controls">
          <button class="action-btn" @click=${() => (this.showSessionVault = true)}>
            🎛️ BANCOS & SESIONES
          </button>
          <button class="action-btn" @click=${() => (this.showPerformanceModal = true)}>
            ⚡ LATENCIA (${this.bufferTime}s)
          </button>
          <select class="theme-selector" .value=${this.currentTheme} @change=${this.handleThemeChange}>
            <option value="theme-club">🎧 Club Dark</option>
            <option value="theme-cyberpunk">⚡ Cyberpunk Neon</option>
            <option value="theme-synthwave">🌌 80s Synthwave</option>
            <option value="theme-vintage">🎚️ Vintage Analog</option>
            <option value="theme-slate">🔬 Clean Slate</option>
          </select>
        </div>
      </header>

      <!-- Main Console Workspace -->
      <main class="dj-console">
        <!-- Deck Master Row -->
        <section class="master-row">
          <div class="visualizer-card">
            <dj-visualizer
              .analyser=${this.analyserNode}
              .isPlaying=${this.playbackState}
              .visualizerMode=${this.visualizerMode}></dj-visualizer>
          </div>

          <div class="master-transport-card">
            <div class="transport-buttons">
              <button
                class="big-play-btn ${this.playbackState === 'playing' ? 'pause' : this.playbackState === 'loading' ? 'loading' : 'play'}"
                @click=${this.handlePlayPause}>
                ${this.playbackState === 'playing' ? '⏸ PAUSE STREAM' : this.playbackState === 'loading' ? '⏳ BUFFERING...' : '▶ LIVE MASTER'}
              </button>
              <button class="small-transport-btn" @click=${this.stopAudio} title="Detener audio">
                ⏹ STOP
              </button>
              <button class="small-transport-btn" @click=${this.handleReset} title="Reiniciar contexto de IA">
                🔄 RESET
              </button>
            </div>

            <div class="master-vol-row">
              <span class="master-vol-lbl">MASTER VOL: ${Math.round(this.masterVolume * 100)}%</span>
              <input
                type="range"
                class="master-slider"
                min="0"
                max="1"
                step="0.01"
                .value=${String(this.masterVolume)}
                @input=${this.handleMasterVolumeChange} />
            </div>
          </div>
        </section>

        <!-- Compact Toolbar: Matrix Dropdown Toggle + Scene Snapshots -->
        <section class="matrix-scenes-strip">
          <!-- Left: Collapsible Matrix Dropdown Trigger -->
          <div class="matrix-toggle-cluster">
            <button
              class="matrix-toggle-btn ${this.isMatrixExpanded ? 'active' : ''}"
              @click=${() => (this.isMatrixExpanded = !this.isMatrixExpanded)}
              title="Haz clic para desplegar/ocultar los porcentajes y pesos de steering">
              <span class="matrix-toggle-icon">🎛️</span>
              <span class="matrix-toggle-label">MATRIZ DE STEERING</span>
              <span class="matrix-toggle-arrow">${this.isMatrixExpanded ? '▲' : '▼'}</span>

              <!-- Mini Proportional Track always visible in header -->
              <div class="matrix-mini-track" title="Distribución proporcional de canales activos">
                ${totalWeight === 0
                  ? html`<div style="width: 100%; background: #263147;"></div>`
                  : activePrompts.map((p) => {
                      const pct = Math.round((p.weight / totalWeight) * 100);
                      return html`
                        <div
                          class="matrix-bar-segment"
                          style="width: ${pct}%; background: ${p.color};"></div>
                      `;
                    })}
              </div>

              <span class="matrix-toggle-summary">
                ${activePrompts.length} activos • ${totalWeight.toFixed(1)} peso
              </span>
            </button>
          </div>

          <!-- Right: Instant Scene Snapshots (Compact Strip) -->
          <div class="scene-snapshots-strip">
            <span class="scenes-label">ESCENAS:</span>
            <div class="scene-btn-group">
              ${this.scenes.map(
                (scene) => html`
                  <button
                    class="scene-btn ${this.activeSceneId === scene.id ? 'active' : ''}"
                    @click=${() => {
                      if (this.isRecordingScene) {
                        this.handleSaveSceneSnapshot(scene.id);
                      } else {
                        this.handleSceneSelect(scene);
                      }
                    }}
                    title="1-Clic para cargar escena ${scene.id} (${scene.label})">
                    <span class="scene-letter">${scene.id}</span>
                    <span class="scene-desc">${scene.label}</span>
                  </button>
                `,
              )}
              <button
                class="scene-rec-btn ${this.isRecordingScene ? 'recording' : ''}"
                @click=${() => (this.isRecordingScene = !this.isRecordingScene)}
                title="Activar modo grabación para guardar la mezcla actual en una escena">
                ${this.isRecordingScene ? '🔴 ELIGE SLOT' : '💾 REC'}
              </button>
            </div>
          </div>
        </section>

        <!-- Collapsible Matrix Details Drawer (Only rendered when expanded) -->
        ${this.isMatrixExpanded
          ? html`
              <div class="matrix-dropdown-panel">
                <div class="matrix-header">
                  <div class="matrix-header-title">
                    <span>🎛️ PONDERACIÓN & INFLUENCIA EN EL MODELO IA</span>
                    <span class="matrix-sub-badge">
                      ${activePrompts.length} ACTIVOS • PESO TOTAL: ${totalWeight.toFixed(2)}
                    </span>
                  </div>
                  <button
                    class="matrix-close-btn"
                    @click=${() => (this.isMatrixExpanded = false)}
                    title="Cerrar panel desplegable">
                    ✕ CERRAR
                  </button>
                </div>

                <!-- Multi-colored Segmented Dynamic Bar -->
                <div class="matrix-bar-track">
                  ${totalWeight === 0
                    ? html`<div style="width: 100%; background: #263147;"></div>`
                    : activePrompts.map((p) => {
                        const pct = Math.round((p.weight / totalWeight) * 100);
                        return html`
                          <div
                            class="matrix-bar-segment"
                            style="width: ${pct}%; background: ${p.color};"
                            title="${p.text}: ${pct}% (${p.weight})"></div>
                        `;
                      })}
                </div>

                <!-- Percentage Tags Pills -->
                <div class="matrix-tags-pills">
                  ${activePrompts.length === 0
                    ? html`<span style="font-size: 10px; color: var(--dj-text-muted);">Sin canales activos (sube los faders de canal)</span>`
                    : activePrompts.map((p) => {
                        const pct = Math.round((p.weight / totalWeight) * 100);
                        return html`
                          <div class="matrix-pill">
                            <span class="matrix-pill-dot" style="background: ${p.color}"></span>
                            <span class="matrix-pill-pct">${pct}%</span>
                            <span>${p.text}</span>
                          </div>
                        `;
                      })}
                </div>
              </div>
            `
          : ''}

        <!-- Channels Mixer Deck -->
        <section class="mixer-deck-container">
          ${Array.from(this.prompts.values()).map(
            (p, idx) => html`
              <prompt-controller
                .promptId=${p.promptId}
                .text=${p.text}
                .weight=${p.weight}
                .color=${p.color}
                .channelIndex=${idx + 1}
                .muted=${!!p.muted}
                .soloed=${this.soloPromptId === p.promptId}
                @prompt-changed=${this.handlePromptChanged}
                @channel-mute-toggle=${this.handleChannelMuteToggle}
                @channel-solo-toggle=${this.handleChannelSoloToggle}
                @prompt-removed=${this.handlePromptRemoved}>
              </prompt-controller>
            `,
          )}

          <div class="add-channel-card" @click=${() => this.addChannel()}>
            <div class="add-icon">+</div>
            <div class="add-lbl">NUEVO CANAL</div>
          </div>
        </section>

        <!-- Bottom DSP Rack & Master Settings -->
        <section class="bottom-rack">
          <dsp-rack-controller
            .dsp=${this.dspConfig}
            .bpm=${this.settingsCtrl?.config?.bpm || 120}
            @dsp-changed=${this.handleDspChanged}></dsp-rack-controller>
          <settings-controller @settings-changed=${this.handleSettingsChanged}></settings-controller>
        </section>
      </main>

      <!-- Modals -->
      ${this.showSessionVault
        ? html`
            <session-vault-modal
              .savedSessions=${this.savedSessions}
              @close-modal=${() => (this.showSessionVault = false)}
              @load-bank=${this.handleLoadBank}
              @save-session=${this.handleSaveSession}
              @load-session=${this.handleLoadSession}
              @delete-session=${this.handleDeleteSession}
              @import-sessions=${this.handleImportSessions}></session-vault-modal>
          `
        : ''}

      ${this.showPerformanceModal
        ? html`
            <performance-modal
              .bufferTime=${this.bufferTime}
              .visualizerMode=${this.visualizerMode}
              .throttleMs=${this.throttleMs}
              .stats=${this.perfStats}
              @close-modal=${() => (this.showPerformanceModal = false)}
              @buffer-change=${this.handleBufferChange}
              @vis-mode-change=${this.handleVisModeChange}
              @throttle-change=${this.handleThrottleChange}></performance-modal>
          `
        : ''}

      <!-- Toast Feedback -->
      ${this.toastMessage
        ? html`<div class="dj-toast">📢 ${this.toastMessage}</div>`
        : ''}
    `;
  }
}

function main() {
  const container = document.body;
  const dj = new PromptDj();
  container.appendChild(dj);
}

main();

declare global {
  interface HTMLElementTagNameMap {
    'prompt-dj': PromptDj;
    'prompt-controller': PromptController;
    'weight-slider': WeightSlider;
    'dj-visualizer': DjVisualizer;
    'dsp-rack-controller': DspRackController;
    'settings-controller': SettingsController;
    'session-vault-modal': SessionVaultModal;
    'performance-modal': PerformanceModal;
  }
}
