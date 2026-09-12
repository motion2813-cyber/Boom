// Shared audio-safety utilities.
//
// This file exists to solve one very specific, very common WebRTC problem:
// acoustic feedback ("howling") between a laptop's speakers and its built-in
// microphone. Browser echo cancellation (AEC) usually handles this, but AEC
// is a best-effort adaptive filter — on laptop speaker+mic setups (no
// headphones), a loud enough sound, a sudden position change, or a network
// hiccup right after speech ends can let a small residual echo through.
// Because that residual then gets sent back out over the speakers, picked up
// again, and re-sent, it compounds every round trip: a quiet whistle becomes
// a piercing tone in 2-4 seconds. This is exactly what showed up in the
// diagnostic recording — a single frequency (~1.4kHz) whose level climbed on
// every successive block until it clipped.
//
// The only ways to reliably stop that once it starts are: (1) never let the
// gain of a repeating signal compound in the first place (a limiter), and
// (2) actively detect the "climbing, narrow-band tone" signature and break
// the loop the same way toggling your system volume does — by cutting the
// signal for a moment so it has nothing left to feed on.

let sharedAudioContext: AudioContext | null = null;

export function getSharedAudioContext(): AudioContext | null {
  try {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtx) return null;
    if (!sharedAudioContext || sharedAudioContext.state === 'closed') {
      sharedAudioContext = new AudioCtx();
    }
    return sharedAudioContext;
  } catch {
    return null;
  }
}

// Resume the shared context on the first user gesture (autoplay policy).
if (typeof window !== 'undefined') {
  const resumeCtx = () => {
    if (sharedAudioContext && sharedAudioContext.state === 'suspended') {
      sharedAudioContext.resume().catch(() => {});
    }
  };
  window.addEventListener('click', resumeCtx);
  window.addEventListener('keydown', resumeCtx);
  window.addEventListener('touchstart', resumeCtx);
  window.addEventListener('pointerdown', resumeCtx);
}

export interface ProcessedMicHandle {
  /** The processed, safety-limited audio track. Send this over the wire instead of the raw mic track. */
  track: MediaStreamTrack;
  /** Tears down every node this created. Does NOT stop the raw input track — caller owns that. */
  dispose: () => void;
}

/**
 * Wraps a raw microphone track in: highpass filter -> limiter -> howl guard.
 * Returns null if Web Audio isn't available, so callers should fall back to
 * sending the raw track untouched in that case.
 */
export function createProcessedMicTrack(rawTrack: MediaStreamTrack): ProcessedMicHandle | null {
  const ctx = getSharedAudioContext();
  if (!ctx) return null;

  try {
    const source = ctx.createMediaStreamSource(new MediaStream([rawTrack]));

    // Feedback loops on laptop speaker/mic setups tend to lock onto
    // low-mid frequencies. Trimming sub-120Hz content removes a chunk of the
    // energy a loop needs to sustain itself, with negligible impact on voice
    // intelligibility (fundamental frequency of speech sits well above this
    // for the vast majority of speakers).
    const highpass = ctx.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = 120;
    highpass.Q.value = 0.7;

    // Fast, aggressive limiter. This is the primary defense: even if a
    // residual echo starts to repeat, a 20:1 ratio with a ~1ms attack clamps
    // it within a couple of audio blocks instead of letting it ramp up over
    // seconds like the runaway tone in the diagnostic recording did.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -32;
    limiter.knee.value = 4;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.08;

    // Brick-wall ceiling. The compressor above is a *ratio*-based limiter —
    // it reduces gain proportionally but can still let a loud spike through
    // at high level. This waveshaper caps the sample value outright, so no
    // matter how fast a loop compounds, the maximum possible output level
    // is fixed. This matters most for real acoustic feedback between two
    // separate physical devices (speaker of one bleeding into the mic of
    // the other) — that loop can build faster over a real network than the
    // compressor's release time alone can track.
    const ceiling = ctx.createWaveShaper();
    const ceilingCurve = new Float32Array(4);
    ceilingCurve[0] = -0.7;
    ceilingCurve[1] = -0.7;
    ceilingCurve[2] = 0.7;
    ceilingCurve[3] = 0.7;
    ceiling.curve = ceilingCurve;
    ceiling.oversample = '4x';

    // "Circuit breaker" gain. The howl detector below yanks this down for a
    // few hundred ms whenever it sees the exact signature of a feedback
    // loop, then eases it back in — automating the mute/unmute-your-volume
    // trick instead of requiring you to do it by hand.
    const breaker = ctx.createGain();
    breaker.gain.value = 1;

    const destination = ctx.createMediaStreamDestination();

    source.connect(highpass);
    highpass.connect(limiter);
    limiter.connect(ceiling);
    ceiling.connect(breaker);
    breaker.connect(destination);

    // --- Howl detector ---
    // ScriptProcessorNode is deprecated in favor of AudioWorklet, but it
    // needs no separate module file to load/bundle and is still supported
    // everywhere, so it's the pragmatic choice for a self-contained fix.
    const processor = ctx.createScriptProcessor(512, 1, 1);
    const analysisSink = ctx.createGain();
    analysisSink.gain.value = 0; // never actually audible; required only to drive the graph's pull-clock
    breaker.connect(processor);
    processor.connect(analysisSink);
    analysisSink.connect(ctx.destination);

    const HISTORY_LENGTH = 8; // ~0.08-0.1s of history — reacts within a fraction of a second
    const rmsHistory: number[] = [];
    let duckedUntil = 0;

    processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      let sumSquares = 0;
      for (let i = 0; i < input.length; i++) sumSquares += input[i] * input[i];
      const rms = Math.sqrt(sumSquares / input.length);

      rmsHistory.push(rms);
      if (rmsHistory.length > HISTORY_LENGTH) rmsHistory.shift();

      const now = ctx.currentTime;
      if (now < duckedUntil) return;
      if (rmsHistory.length < HISTORY_LENGTH) return;

      // Feedback signature: level climbs almost every single block in a row
      // (normal speech rises and falls constantly; a howl doesn't) AND has
      // reached a level above the normal room/mic noise floor.
      let climbingBlocks = 0;
      for (let i = 1; i < rmsHistory.length; i++) {
        if (rmsHistory[i] >= rmsHistory[i - 1] * 0.98) climbingBlocks++;
      }
      const isClimbing = climbingBlocks >= HISTORY_LENGTH - 1;
      const isLoud = rms > 0.025;

      if (isClimbing && isLoud) {
        const t = ctx.currentTime;
        breaker.gain.cancelScheduledValues(t);
        breaker.gain.setValueAtTime(breaker.gain.value, t);
        breaker.gain.linearRampToValueAtTime(0.01, t + 0.02);
        breaker.gain.setValueAtTime(0.01, t + 0.8);
        breaker.gain.linearRampToValueAtTime(1, t + 1.2);
        duckedUntil = t + 1.2;
        rmsHistory.length = 0;
      }
    };

    const outputTrack = destination.stream.getAudioTracks()[0];

    return {
      track: outputTrack,
      dispose: () => {
        try { processor.onaudioprocess = null; } catch {}
        try { source.disconnect(); } catch {}
        try { highpass.disconnect(); } catch {}
        try { limiter.disconnect(); } catch {}
        try { ceiling.disconnect(); } catch {}
        try { breaker.disconnect(); } catch {}
        try { processor.disconnect(); } catch {}
        try { analysisSink.disconnect(); } catch {}
        try { outputTrack.stop(); } catch {}
      },
    };
  } catch (err) {
    console.warn('Failed to build processed mic chain; falling back to raw track', err);
    return null;
  }
}

export interface PlaybackLimiterHandle {
  dispose: () => void;
}

/**
 * Receive-side safety net. Routes an <audio> element's output through a
 * limiter before it reaches the speakers, so a remote peer who hasn't picked
 * up this fix yet (older tab, different device) still can't blast your ears.
 * Must be called exactly once per HTMLMediaElement (Web Audio spec
 * restriction), after the element exists.
 */
export function attachPlaybackLimiter(mediaElement: HTMLMediaElement): PlaybackLimiterHandle | null {
  const ctx = getSharedAudioContext();
  if (!ctx) return null;

  try {
    const mediaSource = ctx.createMediaElementSource(mediaElement);
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -20;
    limiter.knee.value = 4;
    limiter.ratio.value = 16;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.12;

    const ceiling = ctx.createWaveShaper();
    const ceilingCurve = new Float32Array(4);
    ceilingCurve[0] = -0.8;
    ceilingCurve[1] = -0.8;
    ceilingCurve[2] = 0.8;
    ceilingCurve[3] = 0.8;
    ceiling.curve = ceilingCurve;
    ceiling.oversample = '4x';

    mediaSource.connect(limiter);
    limiter.connect(ceiling);
    ceiling.connect(ctx.destination);

    return {
      dispose: () => {
        try { mediaSource.disconnect(); } catch {}
        try { limiter.disconnect(); } catch {}
        try { ceiling.disconnect(); } catch {}
      },
    };
  } catch (err) {
    console.warn('Failed to attach playback limiter', err);
    return null;
  }
}
