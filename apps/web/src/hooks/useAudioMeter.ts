import { useState, useEffect, useRef } from 'react';

let sharedAudioContext: AudioContext | null = null;

function getSharedAudioContext(): AudioContext | null {
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

// Global user gesture handler to resume AudioContext as soon as user interacts
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

export function useAudioMeter(stream: MediaStream | null, isMuted: boolean = false) {
  const [volume, setVolume] = useState<number>(0); // 0 to 100
  const [isSpeaking, setIsSpeaking] = useState<boolean>(false);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastSpeakingRef = useRef<boolean>(false);
  const lastVolumeUpdateRef = useRef<number>(0);

  const audioTrack = stream?.getAudioTracks()[0] || null;
  const trackId = audioTrack?.id || null;
  const isEnabled = audioTrack && audioTrack.enabled && !isMuted;

  useEffect(() => {
    if (!stream || !audioTrack || !isEnabled) {
      setVolume(0);
      setIsSpeaking(false);
      lastSpeakingRef.current = false;
      return;
    }

    try {
      const audioContext = getSharedAudioContext();
      if (!audioContext) return;

      if (audioContext.state === 'suspended') {
        audioContext.resume().catch(() => {});
      }

      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.3;
      analyserRef.current = analyser;

      // Connect source -> analyser -> silentGain (0) -> destination
      // Connecting to destination is REQUIRED by the Web Audio spec to drive the audio pull-clock
      const silentGain = audioContext.createGain();
      silentGain.gain.value = 0;
      gainRef.current = silentGain;

      const source = audioContext.createMediaStreamSource(stream);
      source.connect(analyser);
      analyser.connect(silentGain);
      silentGain.connect(audioContext.destination);
      sourceRef.current = source;

      const bufferLength = analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);

      const checkVolume = () => {
        if (!analyserRef.current) return;

        if (audioContext.state === 'suspended') {
          audioContext.resume().catch(() => {});
        }

        analyserRef.current.getByteTimeDomainData(dataArray);

        let sumSquares = 0;
        for (let i = 0; i < bufferLength; i++) {
          const norm = (dataArray[i] - 128) / 128;
          sumSquares += norm * norm;
        }

        const rms = Math.sqrt(sumSquares / bufferLength);
        const normalizedVolume = Math.min(100, Math.round(rms * 250));
        const now = Date.now();

        if (now - lastVolumeUpdateRef.current > 80) {
          lastVolumeUpdateRef.current = now;
          setVolume(normalizedVolume);
        }

        const speakingNow = normalizedVolume > 4;
        if (speakingNow !== lastSpeakingRef.current) {
          lastSpeakingRef.current = speakingNow;
          setIsSpeaking(speakingNow);
        }

        rafRef.current = requestAnimationFrame(checkVolume);
      };

      checkVolume();
    } catch (err) {
      console.warn('AudioMeter initialization failed', err);
    }

    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      if (sourceRef.current) {
        try {
          sourceRef.current.disconnect();
        } catch {}
        sourceRef.current = null;
      }
      if (gainRef.current) {
        try {
          gainRef.current.disconnect();
        } catch {}
        gainRef.current = null;
      }
      if (analyserRef.current) {
        try {
          analyserRef.current.disconnect();
        } catch {}
        analyserRef.current = null;
      }
    };
  }, [trackId, isEnabled, stream]);

  return { volume, isSpeaking };
}
