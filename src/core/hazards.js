/**
 * Hazard detection from a camera frame.
 *
 * ## Why this is written the way it is
 *
 * The live HK Nav server's /api/vlm endpoint returns a PLAIN DESCRIPTION STRING
 * ("A glass revolving door is 3 steps ahead, flanked by metal handrails."), and
 * we verified it answers identically for a 1x1 pixel image, so it is not
 * actually looking at the frame. We therefore cannot rely on it for structured
 * hazards.
 *
 * So hazards are derived on-device from the description text using an explicit
 * keyword table that maps to the closed hazard-code set this app understands.
 * That has two advantages over trusting a model's prose:
 *
 *   1. It still works when the server returns something unexpected.
 *   2. The mapping is auditable: a wrong "no steps" is far worse than
 *      "I cannot tell", so anything ambiguous maps to a *low* confidence and is
 *      spoken as uncertain rather than as safe.
 *
 * A SiliconFlow VLM call is offered as an alternative source, but it is only
 * attempted when explicitly enabled, because it costs money per frame and the
 * server path is free.
 */

import { HAZARD } from './config.js';

/**
 * Ordered longest-phrase-first so "wet floor" wins over "floor".
 * Each entry: regex, hazard code, spoken phrase (yue / en).
 */
const HAZARD_HINTS = [
  { re: /construction|barricade|scaffold|hoarding|棚架|工程|圍板/i, code: 'obstacle-ahead', yue: '前方有工程障礙物', en: 'construction obstruction ahead' },
  { re: /stairs|staircase|steps|樓梯|梯級|階梯/i, code: 'stairs-ahead', yue: '前方有樓梯', en: 'stairs ahead' },
  { re: /escalator|自動扶梯|電扶梯/i, code: 'escalator-ahead', yue: '前方有自動扶梯', en: 'escalator ahead' },
  { re: /kerb|curb|step\s*down|石壆|落級/i, code: 'step-down-ahead', yue: '前方有落級', en: 'step down ahead' },
  { re: /step\s*up|上級/i, code: 'step-up-ahead', yue: '前方有上級', en: 'step up ahead' },
  { re: /manhole|open\s*drain|坑渠|沙井/i, code: 'open-manhole', yue: '前方有打開嘅渠蓋', en: 'open manhole ahead' },
  { re: /wet floor|slippery|spill|濕滑|地滑|積水/i, code: 'wet-floor', yue: '地面濕滑', en: 'wet floor' },
  { re: /low\s*clearance|overhead|low\s*beam|低矮|橫樑/i, code: 'low-clearance', yue: '前方有低矮障礙物', en: 'low clearance ahead' },
  { re: /platform edge|edge of platform|月台邊/i, code: 'edge-of-platform', yue: '接近月台邊緣', en: 'platform edge' },
  { re: /car|vehicle|van|truck|bus|taxi|motorcycle|單車|車|貨車|巴士|的士/i, code: 'moving-vehicle', yue: '有車輛', en: 'vehicle' },
  { re: /obstacle|barrier|pole|bollard|bin|obstruct|障礙|欄|柱|垃圾桶/i, code: 'obstacle-ahead', yue: '前方有障礙物', en: 'obstacle ahead' },
  { re: /door|gate|revolving|門|閘/i, code: 'obstacle-ahead', yue: '前方有門', en: 'door ahead' },
  { re: /crowd|people|congested|人群|人多/i, code: 'obstacle-ahead', yue: '前方人多', en: 'crowd ahead' },
];

/** Phrases that mean the frame was not usable. We must not claim it is safe.
 *
 * The Cantonese entries are load-bearing, not decoration. The models answer in
 * Cantonese, and an earlier version of this list only carried 睇唔清/唔清楚 — so
 * "我無法判斷前方是否有障礙物" ("I cannot judge whether anything is in the way")
 * still matched the 障礙 keyword table and was spoken as a HIGH-confidence
 * "obstacle ahead". A refusal must always outrank a keyword.
 */
const UNCERTAIN_HINTS =
  /cannot tell|can't tell|unclear|too dark|blurry|not sure|unsure|unable to (?:tell|determine|identify)|cannot be determined|睇唔清|睇唔到|睇唔清楚|唔清楚|唔確定|太暗|模糊|無法判斷|無法確定|無法辨識|無法看清|不能確定|未能判斷|判斷唔到/i;

/**
 * Absence markers, tested immediately BEFORE a hazard noun.
 *
 * The models phrase "all clear" positively — the 8B model's answer for the demo
 * frame opens with "前方地面平坦，無明顯障礙物或凹凸", and a bare keyword match
 * read 障礙 as "obstacle ahead" with HIGH confidence. A statement of absence is
 * the one case where the keyword must lose.
 *
 * Two deliberate limits:
 *
 *   - The window is short (≤4 filler characters, ≤2 words), so "無遮擋，前方有
 *     障礙物" and "there are no bollards but there is a barrier" still report the
 *     hazard in the other clause.
 *   - Only existence-negations count. 唔 / "do not" are NOT markers, because
 *     "唔好行近樓梯" ("do not go near the stairs") is a warning ABOUT a real
 *     staircase, and dropping it would hide a fall risk.
 */
const ABSENCE_BEFORE =
  /(?:無|冇|沒有|未有|未見|不見|無發現|冇發現|不存在|無任何)[^，。,.;；!！?？]{0,4}$/;
const ABSENCE_BEFORE_EN =
  /(?:\bno\b|\bnot\b|\bwithout\b|\bnone\b|\bclear of\b|\bfree of\b)(?:\s+[\w-]+){0,2}\s+$/i;

/** Did the text state that this thing is *not* there? */
function statesAbsence(text, index) {
  const before = text.slice(Math.max(0, index - 24), index);
  return ABSENCE_BEFORE.test(before) || ABSENCE_BEFORE_EN.test(before);
}

const DISTANCE_HINT = /(\d+(?:\.\d+)?)\s*(?:m\b|meter|metre|米)/i;

/**
 * @param {string} description free text from a vision model or the server
 * @returns {{
 *   hazards: {code: string, label: string, phrase: string}[],
 *   confidence: 'high'|'low'|'none',
 *   uncertain: boolean,
 *   distanceMeters: number|null
 * }}
 */
export function hazardsFromText(description, language = 'yue') {
  const text = String(description ?? '');
  const yue = language === 'yue';

  if (!text.trim()) {
    return { hazards: [], confidence: 'none', uncertain: true, distanceMeters: null };
  }

  const uncertain = UNCERTAIN_HINTS.test(text);
  const distanceMatch = text.match(DISTANCE_HINT);
  const distanceMeters = distanceMatch ? Number(distanceMatch[1]) : null;

  const hazards = [];
  for (const hint of HAZARD_HINTS) {
    const match = hint.re.exec(text);
    if (!match) continue;
    // "無明顯障礙物" is not an obstacle. Absence always beats the keyword.
    if (statesAbsence(text, match.index)) continue;
    // Collapse repeats of the same code (e.g. "car" and "obstacle" both firing).
    if (hazards.some((h) => h.code === hint.code)) continue;
    hazards.push({
      code: hint.code,
      label: yue ? hint.yue : hint.en,
      phrase: yue ? hint.yue : hint.en,
    });
  }

  // A hazard word and an "I cannot tell" in the same sentence means we are not
  // confident it is really there.
  let confidence = 'none';
  if (hazards.length > 0) confidence = uncertain ? 'low' : 'high';
  else if (uncertain) confidence = 'none';

  return { hazards, confidence, uncertain, distanceMeters };
}

/** Is this hazard close enough to be worth interrupting the user for? */
export function isUrgent(hazard, distanceMeters) {
  if (!hazard) return false;
  if (distanceMeters == null) return true; // unknown proximity: warn, do not assume safe
  return distanceMeters <= HAZARD.warnDistanceMeters;
}

/**
 * Build the spoken warning. Deliberately short: it interrupts whatever else the
 * app was saying, and a long sentence delays the corrective instruction.
 */
export function hazardSentence(hazards, distanceMeters, language = 'yue', corrective = null) {
  if (!hazards || hazards.length === 0) return '';
  const yue = language === 'yue';
  const labels = hazards.map((h) => h.label).join(yue ? '、' : ', ');
  const distance =
    distanceMeters != null
      ? yue
        ? `前方${Math.round(distanceMeters)}米`
        : `${Math.round(distanceMeters)} metres ahead`
      : yue
        ? '前方'
        : 'ahead';

  const parts = [yue ? `警告！${distance}有${labels}。` : `Warning! ${labels} ${distance}.`];
  if (corrective) parts.push(corrective);
  return parts.join('');
}
