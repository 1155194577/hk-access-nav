/**
 * Geodesy. Pure functions, no platform APIs, so they are trivially testable.
 */

const EARTH_RADIUS_M = 6371008.8;

const toRad = (deg) => (deg * Math.PI) / 180;
const toDeg = (rad) => (rad * 180) / Math.PI;

/** Great-circle distance in metres. */
export function distanceMeters(a, b) {
  if (!a || !b) return 0;
  const phi1 = toRad(a.latitude);
  const phi2 = toRad(b.latitude);
  const dPhi = phi2 - phi1;
  const dLambda = toRad(b.longitude - a.longitude);

  const h =
    Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing from a to b, 0-360 clockwise from north. */
export function bearingDegrees(a, b) {
  if (!a || !b) return 0;
  const phi1 = toRad(a.latitude);
  const phi2 = toRad(b.latitude);
  const dLambda = toRad(b.longitude - a.longitude);

  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);

  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Turn a bearing into clock-face language, which is what blind users navigate by. */
export function clockDirection(bearing, heading) {
  if (bearing == null || heading == null) return null;
  const delta = ((bearing - heading + 540) % 360) - 180;

  if (Math.abs(delta) <= 15) return '12 o\'clock';
  if (Math.abs(delta) >= 165) return '6 o\'clock';

  const hours = Math.round((delta / 30 + 12) % 12) || 12;
  return `${hours} o'clock`;
}

export function bearingToCompass(bearing) {
  if (bearing == null) return '';
  const points = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
  return points[Math.round(bearing / 45) % 8];
}

/** Spoken distance. Rounds to what a person can actually act on. */
export function formatDistance(meters, language = 'yue') {
  if (!Number.isFinite(meters)) return language === 'yue' ? '未知距離' : 'an unknown distance';
  const yue = language === 'yue';

  if (meters < 10) {
    const rounded = Math.max(1, Math.round(meters));
    return yue ? `${rounded}米` : `${rounded} metres`;
  }
  if (meters < 1000) {
    const rounded = Math.round(meters / 5) * 5;
    return yue ? `${rounded}米` : `${rounded} metres`;
  }
  const km = (meters / 1000).toFixed(1);
  return yue ? `${km}公里` : `${km} kilometres`;
}

/** Walking time at a calm pace. 1.2 m/s is the usual planning figure. */
export function walkingSeconds(meters, metersPerSecond = 1.2) {
  return meters / metersPerSecond;
}

/** How big a turn is, in words. */
export function classifyTurn(fromBearing, toBearing) {
  if (fromBearing == null || toBearing == null) return 'straight';
  const delta = Math.abs(((toBearing - fromBearing + 540) % 360) - 180);

  if (delta < 20) return 'straight';
  if (delta < 45) return 'slight';
  if (delta < 120) return 'turn';
  if (delta <= 160) return 'sharp';
  return 'uturn';
}
