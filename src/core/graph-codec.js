/**
 * Decode the packed graph format.
 *
 * The verbose format stored nodes as full-precision floats and edges as 17-key
 * objects, which cost 5.13 MB for three districts. This decodes the packed form
 * back to the same structure at ~17% of the size, so roughly six times as many
 * districts fit in the same bundle.
 *
 * PACKED FORM (see the data pipeline's pack_graph.py for the encoder):
 *   n    flat integer array of coordinate deltas, in 1e-6 degrees (0.11 m).
 *        [dLon0, dLat0, dLon1, dLat1, ...] — cumulative sum rebuilds the nodes.
 *   e    one array per edge: [dU, dV, packed, ...optional]
 *          dU, dV  node-index deltas, cumulative
 *          packed  (subtype << 16) | (metres_decimetres << 8) | bitmask
 *                  bits: 0 stairs, 1 escalator, 2 lift, 3 ramp, 4 crossing,
 *                        5 indoor, 6 barrier, 7 tactile
 *          optional, in order: gradient*10000, street, streetTc.
 *          Street indices of -1 and empty tails are trimmed by the encoder, so
 *          absent fields must be tolerated.
 *   st   interned English street names, indexed by the edge's field
 *   stc  interned Traditional Chinese names
 *
 * Subtype is a CSDI FeatureType (max 33), or 255 meaning "confirmed step-free"
 * (WheelchairAccess = True). It rides in the HIGH byte because FeatureType up to
 * 33 would collide with the flags if it shared the low byte. That signal is worth
 * the slot: it is true for only 0.9% of the network, while `not accessible` is
 * the 99.1% default and so is not stored at all.
 *
 * Lossiness: coordinates to 0.11 m and edge length to 0.05 m. Both are far below
 * the survey precision and the ~10 m GPS error, so no routing decision changes.
 */

const MICRO = 1e6;

/** Marks a subtype that means "confirmed step-free" rather than a FeatureType. */
const SUBTYPE_STEP_FREE = 255;

/** Unpack a graph module payload into the shape the router consumes. */
export function decodeGraph(packed) {
  if (!packed || packed.v !== 2) {
    throw new Error('Unsupported graph format; rebuild with build_js_graphs.py');
  }

  // ------------------------------------------------------------- nodes
  const raw = packed.n;
  const count = raw.length / 2;
  const nodes = new Array(count);

  let lon = 0;
  let lat = 0;
  for (let i = 0; i < count; i += 1) {
    lon += raw[i * 2];
    lat += raw[i * 2 + 1];
    nodes[i] = [lon / MICRO, lat / MICRO];
  }

  // ------------------------------------------------------------- edges
  const streets = packed.st || [];
  const streetsTc = packed.stc || [];
  const rows = packed.e;
  const edges = new Array(rows.length);

  let u = 0;
  let v = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    u += row[0];
    v += row[1];

    const packedValue = row[2];
    const bitmask = packedValue & 0xff;
    // 16 bits for length: with 8 it overflowed past 25.5 m and spilled into the
    // subtype. Decimetres, so 0.1 m resolution up to 6,553.5 m.
    const metres = ((packedValue >> 8) & 0xffff) / 10;
    const subtype = (packedValue >>> 24) & 0xff;

    const featureType = subtype === SUBTYPE_STEP_FREE ? 0 : subtype;
    const confirmedStepFree = subtype === SUBTYPE_STEP_FREE ? 1 : 0;

    let cursor = 3;

    let gradient = 0;
    if (cursor < row.length) {
      const g = row[cursor];
      cursor += 1;
      if (g > 0) gradient = g / 10000;
    }

    let nameEn = '';
    if (cursor < row.length) {
      const s = row[cursor];
      cursor += 1;
      if (s >= 0 && s < streets.length) nameEn = streets[s];
    }

    let nameTc = '';
    if (cursor < row.length) {
      const s = row[cursor];
      cursor += 1;
      if (s >= 0 && s < streetsTc.length) nameTc = streetsTc[s];
    }

    edges[i] = {
      u,
      v,
      m: metres,
      t: (bitmask >> 7) & 1,
      s: bitmask & 1,
      e: (bitmask >> 1) & 1,
      l: (bitmask >> 2) & 1,
      r: (bitmask >> 3) & 1,
      x: (bitmask >> 4) & 1,
      i: (bitmask >> 5) & 1,
      b: (bitmask >> 6) & 1,
      a: confirmedStepFree,
      // Not stored: `w` is true for 99.1% of edges, so it is the default rather
      // than information. Nothing in the router reads it.
      w: 1,
      g: gradient,
      ft: featureType,
      en: nameEn,
      tc: nameTc,
    };
  }

  return {
    name: packed.name,
    bbox: packed.bbox,
    nodes,
    edges,
  };
}

export default decodeGraph;
