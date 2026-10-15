/**
 * A tiny Place Name -> coordinate table.
 *
 * Why this exists: the app resolves "I want to go to the Happy Cha chaan teng"
 * to a coordinate. Real geocoding needs a service, and the brief does not provide
 * one. Rather than inventing a coordinate for an unknown place — which could send
 * someone walking into a harbour — resolution is restricted to this audited list,
 * and anything not found is spoken back as "I do not know where that is".
 *
 * Coordinates are approximate station/landmark positions taken from public MTR
 * station locations. They are good enough to route between, and the UI must not
 * claim metre-level precision for them.
 */

export const PLACES = [
  { id: 'central', name: 'Central', yue: '中環', aliases: ['central', '中環', '中环'], latitude: 22.2819, longitude: 114.158 },
  { id: 'admiralty', name: 'Admiralty', yue: '金鐘', aliases: ['admiralty', '金鐘', '金钟'], latitude: 22.2793, longitude: 114.1654 },
  { id: 'wanchai', name: 'Wan Chai', yue: '灣仔', aliases: ['wan chai', 'wanchai', '灣仔', '湾仔'], latitude: 22.2775, longitude: 114.173 },
  { id: 'causeway-bay', name: 'Causeway Bay', yue: '銅鑼灣', aliases: ['causeway bay', 'cwb', '銅鑼灣', '铜锣湾'], latitude: 22.2802, longitude: 114.185 },
  { id: 'tst', name: 'Tsim Sha Tsui', yue: '尖沙咀', aliases: ['tsim sha tsui', 'tst', '尖沙咀'], latitude: 22.2976, longitude: 114.1722 },
  { id: 'mong-kok', name: 'Mong Kok', yue: '旺角', aliases: ['mong kok', 'mongkok', '旺角'], latitude: 22.3193, longitude: 114.1694 },
  { id: 'sham-shui-po', name: 'Sham Shui Po', yue: '深水埗', aliases: ['sham shui po', 'ssp', '深水埗'], latitude: 22.3307, longitude: 114.1622 },
  { id: 'cheung-sha-wan', name: 'Cheung Sha Wan', yue: '長沙灣', aliases: ['cheung sha wan', 'csw', '長沙灣', '长沙湾'], latitude: 22.3355, longitude: 114.1568 },
  { id: 'kowloon-tong', name: 'Kowloon Tong', yue: '九龍塘', aliases: ['kowloon tong', '九龍塘', '九龙塘'], latitude: 22.3373, longitude: 114.1761 },
  { id: 'hung-hom', name: 'Hung Hom', yue: '紅磡', aliases: ['hung hom', '紅磡', '红磡'], latitude: 22.3029, longitude: 114.1825 },
  { id: 'hkust', name: 'HKUST', yue: '科技大學', aliases: ['hkust', 'ust', '科技大學', '科技大学'], latitude: 22.3375, longitude: 114.2632 },
  { id: 'hku', name: 'HKU', yue: '香港大學', aliases: ['hku', 'university of hong kong', '香港大學', '香港大学'], latitude: 22.2839, longitude: 114.1354 },
  { id: 'cuhk', name: 'CUHK', yue: '中文大學', aliases: ['cuhk', 'chinese university', '中文大學', '中文大学'], latitude: 22.4196, longitude: 114.2069 },
  { id: 'polyu', name: 'PolyU', yue: '理工大學', aliases: ['polyu', 'polytechnic', '理工大學', '理工大学'], latitude: 22.3049, longitude: 114.1792 },
  { id: 'hkcec', name: 'Hong Kong Convention Centre', yue: '會展', aliases: ['convention', 'hkcec', '會展', '会展'], latitude: 22.2833, longitude: 114.1733 },
  { id: 'star-ferry', name: 'Star Ferry', yue: '天星碼頭', aliases: ['star ferry', '天星', '碼頭', '码头'], latitude: 22.2938, longitude: 114.1681 },
  { id: 'victoria-park', name: 'Victoria Park', yue: '維多利亞公園', aliases: ['victoria park', '維園', '维园', '維多利亞公園'], latitude: 22.2824, longitude: 114.1895 },
  { id: 'kowloon-park', name: 'Kowloon Park', yue: '九龍公園', aliases: ['kowloon park', '九龍公園', '九龙公园'], latitude: 22.3006, longitude: 114.1706 },
  { id: 'airport-express', name: 'Airport Express Kowloon', yue: '機場快綫九龍站', aliases: ['airport express', '機場快綫', '机场快线'], latitude: 22.3049, longitude: 114.1654 },
];

/** Fallback when we have no fix at all: Central, the densest transit hub. */
export const DEFAULT_ORIGIN = { latitude: 22.2819, longitude: 114.158, accuracy: 999 };

function normalise(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\s,，。.!?？、]/g, '');
}

/**
 * Find the place a user named.
 *
 * Longest alias wins, so "kowloon tong" beats "kowloon park" when the utterance
 * is ambiguous, and a bare "kowloon" does not falsely match either.
 */
export function findPlace(utterance) {
  const haystack = normalise(utterance);
  if (!haystack) return null;

  let best = null;
  let bestLength = 0;

  for (const place of PLACES) {
    for (const alias of place.aliases) {
      const needle = normalise(alias);
      if (needle.length === 0) continue;
      if (haystack.includes(needle) && needle.length > bestLength) {
        best = place;
        bestLength = needle.length;
      }
    }
  }

  return best;
}

/** Nearest known place to a coordinate — used for the "your vicinity" banner. */
export function nearestPlace(location) {
  if (!location) return null;

  let best = null;
  let bestDistance = Infinity;

  for (const place of PLACES) {
    const dLat = place.latitude - location.latitude;
    const dLng = place.longitude - location.longitude;
    const approx = dLat * dLat + dLng * dLng;
    if (approx < bestDistance) {
      bestDistance = approx;
      best = place;
    }
  }

  return best;
}

export function formatPlaceName(place, language = 'yue') {
  if (!place) return '';
  return language === 'yue' ? place.yue : place.name;
}
