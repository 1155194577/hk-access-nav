/**
 * Synthetic locations for demo mode.
 *
 * The brief for this build is explicitly: "just give a random gps lat lon".
 * That is a demonstration affordance, not a fallback — a random coordinate is
 * NOT the user's position and must never be presented as one. So every value
 * produced here is tagged, and the screens label it as simulated.
 *
 * Bounds cover the Hong Kong urban core (Hong Kong Island through Kowloon),
 * because a random point in the New Territories' country parks would route
 * nowhere useful.
 */

export const HK_BOUNDS = {
  minLat: 22.245,
  maxLat: 22.345,
  minLng: 114.13,
  maxLng: 114.24,
};

const METERS_PER_DEGREE_LAT = 111320;

export function isInsideHongKong({ latitude, longitude }) {
  return (
    latitude >= HK_BOUNDS.minLat &&
    latitude <= HK_BOUNDS.maxLat &&
    longitude >= HK_BOUNDS.minLng &&
    longitude <= HK_BOUNDS.maxLng
  );
}

/** A uniformly random point in the covered area. */
export function randomHongKongPoint() {
  const latitude =
    HK_BOUNDS.minLat + Math.random() * (HK_BOUNDS.maxLat - HK_BOUNDS.minLat);
  const longitude =
    HK_BOUNDS.minLng + Math.random() * (HK_BOUNDS.maxLng - HK_BOUNDS.minLng);

  return {
    latitude,
    longitude,
    /** Large on purpose: this is not a measurement. */
    accuracy: 999,
    simulated: true,
  };
}

/**
 * A point at a given distance and bearing from an origin.
 *
 * Flat-earth approximation, which is accurate to well under a metre over the few
 * hundred metres this is used for.
 */
export function offsetPoint(origin, distanceMeters, bearingDeg) {
  const rad = (bearingDeg * Math.PI) / 180;
  const dLat = (distanceMeters * Math.cos(rad)) / METERS_PER_DEGREE_LAT;
  const metersPerDegreeLng =
    METERS_PER_DEGREE_LAT * Math.cos((origin.latitude * Math.PI) / 180);
  const dLng = (distanceMeters * Math.sin(rad)) / metersPerDegreeLng;

  return {
    latitude: Math.max(HK_BOUNDS.minLat, Math.min(HK_BOUNDS.maxLat, origin.latitude + dLat)),
    longitude: Math.max(HK_BOUNDS.minLng, Math.min(HK_BOUNDS.maxLng, origin.longitude + dLng)),
    accuracy: 999,
    simulated: true,
  };
}

/** A random point a short walk away — used for the simulated "home". */
export function randomNearbyPoint(origin, minMeters = 400, maxMeters = 900) {
  const distance = minMeters + Math.random() * (maxMeters - minMeters);
  const bearing = Math.random() * 360;
  return offsetPoint(origin, distance, bearing);
}

/**
 * Resolve the origin to use for a trip.
 *
 * Uses the real fix when there is a usable one, and a simulated point otherwise.
 * `simulated` is propagated so the UI can say so out loud.
 */
export function originFor(realLocation, isUsable) {
  if (isUsable && realLocation) {
    return { ...realLocation, simulated: false };
  }
  return randomHongKongPoint();
}

// ------------------------------------------------------- bundled districts

/**
 * Districts shipped inside the app, with named landmarks to route between.
 *
 * This exists because on-device routing can only connect points within one
 * bundled district: there is no cross-district graph, and a fix in a district
 * with no data has no network to route on. So a demo that picks a random
 * territory-wide coordinate almost never produces a route — which reads as the
 * app being broken when it is really just out of coverage.
 *
 * Coordinates are the real MTR station / landmark positions, matching the place
 * table in data/places.js.
 */
export const BUNDLED_DISTRICTS = [
  {
    id: 'central',
    label: 'Central & Admiralty',
    labelTc: '中環 · 金鐘',
    // Kept inside the graph box 22.2790..22.2860, 114.1560..114.1660
    bbox: [22.2795, 114.1565, 22.2855, 114.1655],
    landmarks: [
      { name: 'Central', nameTc: '中環', latitude: 22.2819, longitude: 114.158 },
      { name: 'Admiralty', nameTc: '金鐘', latitude: 22.2793, longitude: 114.1654 },
      { name: 'Hong Kong Station', nameTc: '香港站', latitude: 22.2848, longitude: 114.158 },
      { name: 'Statue Square', nameTc: '皇后像廣場', latitude: 22.2821, longitude: 114.1602 },
    ],
  },
  {
    id: 'tst',
    label: 'Tsim Sha Tsui',
    labelTc: '尖沙咀',
    // 22.2960..22.3040, 114.1680..114.1760
    bbox: [22.2965, 114.1685, 22.3035, 114.1755],
    landmarks: [
      { name: 'Tsim Sha Tsui', nameTc: '尖沙咀', latitude: 22.2976, longitude: 114.1722 },
      { name: 'East Tsim Sha Tsui', nameTc: '尖東', latitude: 22.2955, longitude: 114.1745 },
      { name: 'Kowloon Park', nameTc: '九龍公園', latitude: 22.3006, longitude: 114.1706 },
    ],
  },
  {
    id: 'cheungShaWan',
    label: 'Cheung Sha Wan',
    labelTc: '長沙灣',
    // 22.3310..22.3430, 114.1500..114.1680
    bbox: [22.3315, 114.1505, 22.3425, 114.1675],
    landmarks: [
      { name: 'Cheung Sha Wan', nameTc: '長沙灣', latitude: 22.3355, longitude: 114.1568 },
      { name: 'Lai Chi Kok', nameTc: '荔枝角', latitude: 22.3372, longitude: 114.1503 },
      { name: 'Sham Shui Po', nameTc: '深水埗', latitude: 22.3307, longitude: 114.1622 },
      { name: 'Cheung Sha Wan Plaza', nameTc: '長沙灣廣場', latitude: 22.3369, longitude: 114.1547 },
    ],
  },
];

export function districtById(id) {
  return BUNDLED_DISTRICTS.find((district) => district.id === id) || null;
}

/** Which bundled district covers this point, if any. */
export function districtFor(point, margin = 0.01) {
  if (!point) return null;
  return (
    BUNDLED_DISTRICTS.find(
      (district) =>
        point.latitude >= district.bbox[0] - margin &&
        point.latitude <= district.bbox[2] + margin &&
        point.longitude >= district.bbox[1] - margin &&
        point.longitude <= district.bbox[3] + margin
    ) || null
  );
}

/**
 * A random point inside one bundled district's box, so it is always somewhere
 * the app can route from.
 */
export function randomPointInDistrict(districtId) {
  const district = districtById(districtId) || pickRandom(BUNDLED_DISTRICTS);
  const [minLat, minLon, maxLat, maxLon] = district.bbox;
  return {
    latitude: minLat + Math.random() * (maxLat - minLat),
    longitude: minLon + Math.random() * (maxLon - minLon),
    accuracy: 999,
    simulated: true,
    districtId: district.id,
  };
}

function pickRandom(list) {
  return list[Math.floor(Math.random() * list.length)];
}

/**
 * A routable demo trip: an origin and a named destination in the SAME bundled
 * district, so the on-device router can always connect them.
 *
 * Returns null when nothing is bundled, so callers can fall back rather than
 * receiving a pair that cannot route.
 */
export function randomVisitTrip(preferredDistrictId) {
  if (BUNDLED_DISTRICTS.length === 0) return null;

  const district =
    (preferredDistrictId && districtById(preferredDistrictId)) ||
    pickRandom(BUNDLED_DISTRICTS);

  const destination = pickRandom(district.landmarks);
  const origin = {
    latitude: district.bbox[0] + Math.random() * (district.bbox[2] - district.bbox[0]),
    longitude: district.bbox[1] + Math.random() * (district.bbox[3] - district.bbox[1]),
    accuracy: 999,
    simulated: true,
    districtId: district.id,
  };

  return {
    origin,
    destination: {
      latitude: destination.latitude,
      longitude: destination.longitude,
      accuracy: null,
      simulated: true,
      districtId: district.id,
    },
    spokenName: destination.nameTc,
    destinationName: destination.name,
    destinationNameTc: destination.nameTc,
    district: district.label,
    districtTc: district.labelTc,
    districtId: district.id,
  };
}
