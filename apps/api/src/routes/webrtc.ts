import { Router } from 'express';
import { config } from '../config.js';

export const webrtcRouter = Router();

let cachedIceServers: unknown[] | null = null;
let cachedAt = 0;
const CACHE_MS = 5 * 60 * 1000;

webrtcRouter.get('/ice-servers', async (_req, res) => {
  const now = Date.now();

  if (cachedIceServers && now - cachedAt < CACHE_MS) {
    res.json({ iceServers: cachedIceServers });
    return;
  }

  const credentialsUrl = config.meteredTurnCredentialsUrl;
  if (!credentialsUrl) {
    res.json({ iceServers: [] });
    return;
  }

  try {
    const response = await fetch(credentialsUrl, {
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      console.warn(`TURN credential provider returned HTTP ${response.status}`);
      res.json({ iceServers: [] });
      return;
    }

    const data = await response.json();
    const iceServers = Array.isArray(data) ? data : data?.iceServers;

    if (!Array.isArray(iceServers) || iceServers.length === 0) {
      res.json({ iceServers: [] });
      return;
    }

    cachedIceServers = iceServers;
    cachedAt = now;
    res.json({ iceServers });
  } catch (error) {
    console.error('Failed to fetch production TURN credentials:', error);
    res.json({ iceServers: [] });
  }
});
