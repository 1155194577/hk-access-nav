/**
 * Nearest MTR stations to a position.
 *
 * Why this is the right primitive for a blind pedestrian: when someone is unsure
 * where they are, "the nearest station" is a far better target than an arbitrary
 * destination. It is a place staff can help, it is well known, and it is
 * reachable. So the app's job is to name the closest ones, in walking terms.
 *
 * Distances are straight-line (great-circle), NOT walking distance. Presenting a
 * crow-flies distance as a walk is misleading — a station 300 m away across the
 * harbour is not 300 m of walking — so callers get `straightLineMeters` and are
 * expected to route to get the real figure before promising anything.
 */

import STATIONS from '@/data/mtr-stations';

const EARTH_R = 6371008.8;

const toRad = (deg) => (deg * Math.PI) / 180;

export function distanceMeters(a, b) {
  const p1 = toRad(a.latitude);
  const p2 = toRad(b.latitude);
  const dp = p2 - p1;
  const dl = toRad(b.longitude - a.longitude);
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function bearingDegrees(a, b) {
  const p1 = toRad(a.latitude);
  const p2 = toRad(b.latitude);
  const dl = toRad(b.longitude - a.longitude);
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360;
}

/** Clock-face direction relative to where the user is facing. */
export function clockDirection(bearing, heading) {
  if (bearing == null || heading == null) return null;
  const delta = ((bearing - heading + 540) % 360) - 180;
  if (Math.abs(delta) <= 15) return "12 o'clock";
  if (Math.abs(delta) >= 165) return "6 o'clock";
  const hours = Math.round((delta / 30 + 12) % 12) || 12;
  return `${hours} o'clock`;
}

/** Spoken distance. Rounds to what a person can act on. */
export function formatDistance(meters, language = 'en') {
  if (!Number.isFinite(meters)) return language === 'yue' ? '未知距離' : 'an unknown distance';
  const yue = language === 'yue' || language === 'tc';
  if (meters < 1000) {
    const rounded = meters < 100 ? Math.round(meters / 10) * 10 : Math.round(meters / 50) * 50;
    const value = Math.max(10, rounded);
    return yue ? `${value}米` : `${value} metres`;
  }
  const km = (meters / 1000).toFixed(1);
  return yue ? `${km}公里` : `${km} kilometres`;
}

/**
 * The closest stations to a point.
 *
 * @param {{latitude:number, longitude:number}} location
 * @param {{limit?: number, maxMeters?: number}} options
 */
export function nearestStations(location, options = {}) {
  const { limit = 5, maxMeters = 3000 } = options;
  if (!location) return [];

  const heading = Number.isFinite(location.heading) ? location.heading : null;

  const withDistance = STATIONS.map((station) => {
    const straightLineMeters = distanceMeters(location, station);
    const bearing = bearingDegrees(location, station);
    return {
      id: station.id,
      name: station.en,
      nameTc: station.tc,
      latitude: station.latitude,
      longitude: station.longitude,
      straightLineMeters,
      bearing,
      clock: clockDirection(bearing, heading),
      // Rough walking estimate only; the router gives the real figure.
      approximateWalkMeters: Math.round(straightLineMeters * 1.3),
    };
  })
    .filter((station) => station.straightLineMeters <= maxMeters)
    .sort((a, b) => a.straightLineMeters - b.straightLineMeters);

  return withDistance.slice(0, limit);
}

/** Name a station for speech, preferring the user's language. */
export function stationName(station, language = 'en') {
  if (!station) return '';
  return language === 'yue' || language === 'tc' ? station.nameTc : station.name;
}

/**
 * One spoken line listing the nearest stations.
 *
 * Named individually rather than read as a count, because the whole point is that
 * the user picks one — "three stations nearby" is not actionable.
 */
export function describeNearest(stations, language = 'en') {
  if (!stations || stations.length === 0) {
    return language === 'yue' || language === 'tc'
      ? '附近三公里內冇地鐵站。'
      : 'No MTR station within three kilometres.';
  }

  const yue = language === 'yue' || language === 'tc';
  const parts = stations.slice(0, 3).map((station, index) => {
    const name = stationName(station, language);
    const distance = formatDistance(station.straightLineMeters, language);
    const direction = station.clock
      ? yue
        ? `，喺你${station.clock === "12 o'clock" ? '前面' : station.clock}`
        : `, ${station.clock}`
      : '';
    if (index === 0) {
      return yue ? `最近係${name}，大約${distance}${direction}` : `${name}, about ${distance}${direction}`;
    }
    return yue ? `${name}${distance}` : `${name} ${distance}`;
  });

  return (yue ? '附近地鐵站：' : 'Nearby MTR stations: ') + parts.join(yue ? '；' : '; ') + '。';
}
