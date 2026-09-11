// WebRTC ICE configuration.
//
// Production deployments should provide a real TURN credential through the
// Boom API endpoint (/api/webrtc/ice-servers). The bundled Open Relay entries
// remain a compatibility fallback so the app can still work without any extra
// setup. Direct peer-to-peer candidates are always allowed and preferred by ICE.
const defaultIceServers: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
  { urls: 'stun:stun4.l.google.com:19302' },
  {
    urls: 'turn:openrelay.metered.ca:80',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
  {
    urls: 'turn:openrelay.metered.ca:443',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
  {
    urls: 'turn:openrelay.metered.ca:443?transport=tcp',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
];

export const rtcConfiguration: RTCConfiguration = {
  iceServers: [...defaultIceServers],
  iceCandidatePoolSize: 8,
  bundlePolicy: 'max-bundle',
  rtcpMuxPolicy: 'require',
};

function getApiBaseUrl(): string {
  return (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');
}

let iceLoadPromise: Promise<void> | null = null;

/**
 * Load production TURN credentials from the Render API before the first peer
 * connection is created. The secret/API key never has to be shipped to the
 * Netlify bundle. If the endpoint is unavailable, Boom keeps its safe fallback
 * ICE configuration rather than preventing a meeting from starting.
 */
export function loadProductionIceServers(): Promise<void> {
  if (iceLoadPromise) return iceLoadPromise;

  iceLoadPromise = (async () => {
    const apiBase = getApiBaseUrl();
    if (!apiBase) return;

    try {
      const response = await fetch(`${apiBase}/api/webrtc/ice-servers`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      });
      if (!response.ok) return;

      const data = await response.json();
      if (!Array.isArray(data?.iceServers) || data.iceServers.length === 0) return;

      const valid = data.iceServers.filter(
        (server: unknown): server is RTCIceServer =>
          !!server && typeof server === 'object' && 'urls' in server
      );
      if (valid.length === 0) return;

      // Keep Google's STUN servers even if the TURN provider returns only relay
      // entries. ICE can then still try a direct connection before relaying.
      const stunFallbacks = defaultIceServers.filter((server) => {
        const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
        return urls.some((url) => typeof url === 'string' && url.startsWith('stun:'));
      });
      rtcConfiguration.iceServers = [...valid, ...stunFallbacks];
      console.info('Boom: loaded production ICE/TURN servers.');
    } catch (error) {
      console.warn('Boom: could not load production TURN credentials; using fallback ICE servers.', error);
    }
  })();

  return iceLoadPromise;
}
