import { useState, useEffect, useRef, useCallback } from 'react';
import { createProcessedMicTrack, type ProcessedMicHandle } from '../utils/audioSafety';

export interface MediaDeviceInfoList {
  audioInputs: MediaDeviceInfo[];
  videoInputs: MediaDeviceInfo[];
  audioOutputs: MediaDeviceInfo[];
}

export interface PermissionError {
  type: 'denied' | 'not_found' | 'in_use' | 'unknown';
  message: string;
}

export function useMediaStream(initialAudio = true, initialVideo = true) {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [audioEnabled, setAudioEnabled] = useState<boolean>(initialAudio);
  const [videoEnabled, setVideoEnabled] = useState<boolean>(initialVideo);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<PermissionError | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfoList>({
    audioInputs: [],
    videoInputs: [],
    audioOutputs: [],
  });
  const [selectedAudioId, setSelectedAudioId] = useState<string>('');
  const [selectedVideoId, setSelectedVideoId] = useState<string>('');

  const streamRef = useRef<MediaStream | null>(null);
  const audioEnabledRef = useRef<boolean>(initialAudio);
  const videoEnabledRef = useRef<boolean>(initialVideo);
  // The raw, unprocessed mic track straight from getUserMedia. Kept around
  // only so it can be stopped when we tear down/replace the stream — the
  // processed track (in streamRef/`stream`) is what actually gets toggled,
  // metered, and sent over WebRTC.
  const rawAudioTrackRef = useRef<MediaStreamTrack | null>(null);
  const processedMicRef = useRef<ProcessedMicHandle | null>(null);

  const teardownAudioChain = useCallback(() => {
    if (processedMicRef.current) {
      processedMicRef.current.dispose();
      processedMicRef.current = null;
    }
    if (rawAudioTrackRef.current) {
      rawAudioTrackRef.current.stop();
      rawAudioTrackRef.current = null;
    }
  }, []);

  audioEnabledRef.current = audioEnabled;
  videoEnabledRef.current = videoEnabled;

  // Enumerate all available audio and video devices
  const updateDevices = useCallback(async () => {
    try {
      if (!navigator.mediaDevices?.enumerateDevices) return;
      const deviceList = await navigator.mediaDevices.enumerateDevices();
      setDevices({
        audioInputs: deviceList.filter((d) => d.kind === 'audioinput'),
        videoInputs: deviceList.filter((d) => d.kind === 'videoinput'),
        audioOutputs: deviceList.filter((d) => d.kind === 'audiooutput'),
      });
    } catch (err) {
      console.warn('Failed to enumerate devices', err);
    }
  }, []);

  // Request media stream from browser
  const initMedia = useCallback(
    async (audioDeviceId?: string, videoDeviceId?: string) => {
      setIsLoading(true);
      setError(null);

      // Stop any existing tracks from a previous call (device switch, retry, etc).
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }
      teardownAudioChain();

      const constraints: MediaStreamConstraints = {
        audio: {
          ...(audioDeviceId ? { deviceId: { exact: audioDeviceId } } : {}),
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          // `ideal` rather than `exact`: an exact channelCount can push some
          // browser/device combinations off their normal fully-processed
          // capture path (and can hard-fail getUserMedia entirely on
          // hardware that doesn't offer exactly 1 channel), which is one of
          // the ways residual echo/feedback can sneak past AEC in the first
          // place.
          channelCount: { ideal: 1 },
          sampleRate: { ideal: 48000 },
          sampleSize: { ideal: 16 },
        },
        video: videoDeviceId
          ? { deviceId: { exact: videoDeviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
          : { width: { ideal: 1280 }, height: { ideal: 720 } },
      };

      try {
        const userStream = await navigator.mediaDevices.getUserMedia(constraints);

        // Route the raw mic track through the highpass filter + limiter +
        // howl-guard chain (see utils/audioSafety.ts) before it ever reaches
        // a meter, a local preview, or a peer connection. This is what
        // actually stops a feedback loop from building into the loud
        // high-pitched tone instead of just relying on AEC to fully cancel
        // it every time.
        const rawAudioTrack = userStream.getAudioTracks()[0] || null;
        let finalStream = userStream;

        if (rawAudioTrack) {
          const processed = createProcessedMicTrack(rawAudioTrack);
          if (processed) {
            processedMicRef.current = processed;
            rawAudioTrackRef.current = rawAudioTrack;
            // Keep the raw track itself always "live" internally — the
            // exposed processed track is what gets muted/unmuted, and it
            // keeps producing correct (silent) output either way.
            rawAudioTrack.enabled = true;
            finalStream = new MediaStream([processed.track, ...userStream.getVideoTracks()]);
          }
          // If Web Audio isn't available at all, finalStream just stays as
          // the raw userStream — same behavior as before this fix.
        }

        streamRef.current = finalStream;
        setStream(finalStream);

        // Apply current audio/video toggle states
        const audioTracks = finalStream.getAudioTracks();
        if (audioTracks.length > 0) {
          audioTracks[0].enabled = audioEnabledRef.current;
        }

        const videoTracks = finalStream.getVideoTracks();
        if (videoTracks.length > 0) {
          videoTracks[0].enabled = videoEnabledRef.current;
        }

        await updateDevices();
      } catch (err: any) {
        console.error('getUserMedia error:', err);
        let errType: PermissionError['type'] = 'unknown';
        let errMsg = "Boom can't access your camera or microphone. Please check your browser permissions.";

        if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
          errType = 'denied';
          errMsg = 'Camera or microphone permission was denied. Please allow access in Chrome address bar (lock icon) and refresh.';
        } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
          errType = 'not_found';
          errMsg = 'No camera or microphone found on your device.';
        } else if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
          errType = 'in_use';
          errMsg = 'Your camera or microphone is currently in use by another application.';
        }

        setError({ type: errType, message: errMsg });

        // Fallback: create empty dummy stream so UI does not crash
        try {
          const emptyStream = new MediaStream();
          streamRef.current = emptyStream;
          setStream(emptyStream);
        } catch {}
      } finally {
        setIsLoading(false);
      }
    },
    [updateDevices, teardownAudioChain]
  );

  useEffect(() => {
    initMedia();

    // Listen for device plug/unplug changes
    navigator.mediaDevices?.addEventListener('devicechange', updateDevices);

    return () => {
      navigator.mediaDevices?.removeEventListener('devicechange', updateDevices);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }
      teardownAudioChain();
    };
  }, [initMedia, updateDevices, teardownAudioChain]);

  // Toggle Microphone
  const toggleAudio = useCallback(() => {
    if (!streamRef.current) return;
    const audioTrack = streamRef.current.getAudioTracks()[0];
    if (audioTrack) {
      const newState = !audioTrack.enabled;
      audioTrack.enabled = newState;
      setAudioEnabled(newState);
    } else {
      setAudioEnabled((prev) => !prev);
    }
  }, []);

  // Set audio enabled explicitly (e.g. muted by host)
  const setAudioState = useCallback((enabled: boolean) => {
    if (!streamRef.current) return;
    const audioTrack = streamRef.current.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = enabled;
    }
    setAudioEnabled(enabled);
  }, []);

  // Camera control deliberately stops the video track when the camera is
  // disabled. Setting track.enabled=false only stops frames; browsers may
  // keep the physical camera capture active (and therefore keep its LED on).
  // Stopping the track releases the camera device. Re-enabling acquires a new
  // video track and replaces it in the local MediaStream.
  const setVideoState = useCallback(async (enabled: boolean) => {
    const currentStream = streamRef.current;

    if (!enabled) {
      const videoTracks = currentStream?.getVideoTracks() || [];
      videoTracks.forEach((track) => {
        track.enabled = false;
        track.stop();
      });

      if (currentStream) {
        const audioTracks = currentStream.getAudioTracks();
        const nextStream = new MediaStream(audioTracks);
        streamRef.current = nextStream;
        setStream(nextStream);
      }

      videoEnabledRef.current = false;
      setVideoEnabled(false);
      await updateDevices();
      return;
    }

    // Already has a live video track.
    const existing = currentStream?.getVideoTracks().find((track) => track.readyState === 'live');
    if (existing) {
      existing.enabled = true;
      videoEnabledRef.current = true;
      setVideoEnabled(true);
      return;
    }

    try {
      const videoConstraints: MediaTrackConstraints = selectedVideoId
        ? { deviceId: { exact: selectedVideoId }, width: { ideal: 1280 }, height: { ideal: 720 } }
        : { width: { ideal: 1280 }, height: { ideal: 720 } };

      const cameraStream = await navigator.mediaDevices.getUserMedia({ audio: false, video: videoConstraints });
      const newVideoTrack = cameraStream.getVideoTracks()[0];
      if (!newVideoTrack) throw new Error('No video track was returned by the camera.');

      const audioTracks = streamRef.current?.getAudioTracks() || [];
      const nextStream = new MediaStream([...audioTracks, newVideoTrack]);
      streamRef.current = nextStream;
      setStream(nextStream);
      videoEnabledRef.current = true;
      setVideoEnabled(true);
      setError(null);
      await updateDevices();
    } catch (err: any) {
      console.error('Failed to re-enable camera:', err);
      setVideoEnabled(false);
      videoEnabledRef.current = false;
      setError({
        type: err?.name === 'NotAllowedError' ? 'denied' : 'unknown',
        message: err?.name === 'NotAllowedError'
          ? 'Camera permission was denied. Please allow camera access and try again.'
          : 'Boom could not turn your camera back on. Please check that the camera is available.',
      });
    }
  }, [selectedVideoId, updateDevices]);

  const toggleVideo = useCallback(() => {
    void setVideoState(!videoEnabledRef.current);
  }, [setVideoState]);

  // Switch Audio Input Device
  const switchAudioDevice = useCallback(
    async (deviceId: string) => {
      setSelectedAudioId(deviceId);
      await initMedia(deviceId, selectedVideoId || undefined);
    },
    [initMedia, selectedVideoId]
  );

  // Switch Video Input Device
  const switchVideoDevice = useCallback(
    async (deviceId: string) => {
      setSelectedVideoId(deviceId);
      await initMedia(selectedAudioId || undefined, deviceId);
    },
    [initMedia, selectedAudioId]
  );

  return {
    stream,
    audioEnabled,
    videoEnabled,
    isLoading,
    error,
    devices,
    selectedAudioId,
    selectedVideoId,
    toggleAudio,
    setAudioState,
    toggleVideo,
    setVideoState,
    switchAudioDevice,
    switchVideoDevice,
    retryPermissions: () => initMedia(selectedAudioId || undefined, selectedVideoId || undefined),
  };
}
