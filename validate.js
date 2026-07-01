/*
 * validate.js — browser-side port of arcade_optimizer.usables.core / .models.
 *
 * This is the SAME pressure-test logic the Python pipeline runs at the back of the
 * funnel (src/arcade_optimizer/usables/core.py), moved to the FRONT — so a person
 * with a tape measure sees the flags WHILE they are still in the room.
 *
 * ── SYNC CONTRACT ───────────────────────────────────────────────────────────────
 * This file MUST stay behaviour-identical to core.py / models.py. The contract that
 * matters (inconsistency CODES + severities, the confidence GRADE, usable_sqft, and
 * game_count) is locked by tests/test_measure_js_parity.py, which runs the same
 * fixtures through BOTH implementations and asserts they agree. If you change a rule
 * here or there, run `uv run pytest tests/test_measure_js_parity.py` — it will fail
 * on drift. Human message wording is allowed to differ slightly; codes/grades are not.
 *
 * Loads as a plain <script src> (no ES-module / file:// CORS issues), exposing
 * `window.BetsonMeasure`; also `module.exports` for Node, with a stdin JSON CLI used
 * by the parity test.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
    if (require.main === module) {
      if (process.argv[2] === "obb") {
        // OBB geometry subcommand (doc 17, Phase C — purely additive / dormant). Reads a
        // JSON array of {op,...} cases on stdin, dispatches each to the new OBB helpers, and
        // prints a JSON array to stdout. Exercised ONLY by tests/test_obb_geometry_js.py.
        // stdin drains once, so this branch reads its OWN payload; the no-arg branch below is
        // the EXISTING buildUsable behaviour, byte-for-byte unchanged (parity lock).
        const fs = require("fs");
        const cases = JSON.parse(fs.readFileSync(0, "utf8"));
        const out = cases.map((c) => api.obbDispatch(c));
        process.stdout.write(JSON.stringify(out));
      } else {
        // CLI: read a JSON array of RoomInput dicts on stdin, print a JSON array of
        // projected UsableResults on stdout. Used only by the parity test.
        const fs = require("fs");
        const rooms = JSON.parse(fs.readFileSync(0, "utf8"));
        const out = rooms.map((r) => api.buildUsable(r));
        process.stdout.write(JSON.stringify(out));
      }
    }
  } else {
    root.BetsonMeasure = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // ── Betson constants (from the 2026-06-22 kickoff) ──────────────────────────────
  const SQ_FT_PER_GAME = 70; // usable sq ft ÷ 70 = game count
  const DEFAULT_DOOR_WIDTH_IN = 36; // assumed door width when none given (caveat)

  // Plausibility bounds — deliberately generous: catch GROSS errors (unit mix-ups,
  // typos, a swapped measurement), not borderline-but-real rooms. Each only flags.
  const MIN_ROOM_DIM_FT = 4.0;
  const MAX_ROOM_DIM_FT = 400.0;
  const MIN_USABLE_SQFT = SQ_FT_PER_GAME; // below one game's footprint
  const MAX_USABLE_SQFT = 100000.0;
  const MAX_ASPECT_RATIO = 6.0;
  const POLYGON_AREA_TOLERANCE = 0.1;
  const MIN_DOOR_WIDTH_IN = 18.0;
  const MAX_DOOR_WIDTH_IN = 144.0;
  const MIN_CEILING_FT = 7.0;
  const MAX_CEILING_FT = 40.0;
  // Phase A (browser-only game placement): uniform clearance ring around each placed
  // game footprint, matching the Python decoder's ew/eh per-side expansion. Purely
  // additive — NOT read by usableAreaSqft/validate/buildUsable/gradeConfidence.
  const CLEARANCE_FT = 2.5;

  // The customer-facing measuring guide (Mike approved a website FAQ).
  const HOW_TO_MEASURE_URL = "https://www.betson.com/how-to-measure-your-room";

  // ── number formatting helpers that mirror Python f-string specs ─────────────────
  function g(x) {
    // Python "%g": up to 6 sig-figs, trailing zeros stripped.
    if (x === null || x === undefined || Number.isNaN(Number(x))) return String(x);
    let s = Number(x).toPrecision(6);
    if (s.indexOf("e") === -1 && s.indexOf(".") !== -1) {
      s = s.replace(/0+$/, "").replace(/\.$/, "");
    }
    return s;
  }
  function comma0(x) {
    // Python ":,.0f"
    return Math.round(Number(x)).toLocaleString("en-US");
  }
  function f1(x) {
    return Number(x).toFixed(1);
  }
  function pct0(x) {
    return Math.round(Number(x) * 100) + "%";
  }

  // ── geometry ────────────────────────────────────────────────────────────────────
  function polygonArea(pts) {
    let acc = 0.0;
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const [x1, y1] = pts[i];
      const [x2, y2] = pts[(i + 1) % n];
      acc += x1 * y2 - x2 * y1;
    }
    return Math.abs(acc) / 2.0;
  }
  function bbox(pts) {
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }
  function num(v) {
    // pydantic Optional[float]: treat undefined/null as missing.
    return v === null || v === undefined ? null : v;
  }

  function roomArea(room) {
    if (room.polygon_ft && room.polygon_ft.length >= 3) return polygonArea(room.polygon_ft);
    if (room.width_ft && room.depth_ft && room.width_ft > 0 && room.depth_ft > 0)
      return room.width_ft * room.depth_ft;
    return null;
  }
  function roomBounds(room) {
    if (room.polygon_ft && room.polygon_ft.length >= 3) return bbox(room.polygon_ft);
    if (room.width_ft && room.depth_ft && room.width_ft > 0 && room.depth_ft > 0)
      return [0.0, 0.0, room.width_ft, room.depth_ft];
    return null;
  }
  // Floor footprint (w×d) of interior obstructions standing inside the room — subtracted
  // from usable area. Obstructions outside the room bounds (same test as pillar_outside)
  // don't count. Footprint is the bbox (w_ft × d_ft) the RoomInput carries per pillar.
  function obstructionFootprintSqft(room) {
    const bx = roomBounds(room);
    let total = 0.0;
    (room.pillars || []).forEach((p) => {
      const w = p.w_ft || 0.0;
      const d = p.d_ft || 0.0;
      if (w <= 0 || d <= 0) return;
      if (bx && p.x_ft !== null && p.x_ft !== undefined && p.y_ft !== null && p.y_ft !== undefined) {
        const [x0, y0, x1, y1] = bx;
        if (!(x0 - 0.01 <= p.x_ft && p.x_ft <= x1 + 0.01 && y0 - 0.01 <= p.y_ft && p.y_ft <= y1 + 0.01)) return;
      }
      total += w * d;
    });
    return total;
  }
  function usableAreaSqft(room) {
    let base = null;
    if (room.usable_polygon_ft && room.usable_polygon_ft.length >= 3)
      base = polygonArea(room.usable_polygon_ft);
    else if (room.polygon_ft && room.polygon_ft.length >= 3) base = polygonArea(room.polygon_ft);
    else if (room.width_ft && room.depth_ft && room.width_ft > 0 && room.depth_ft > 0)
      base = room.width_ft * room.depth_ft;
    if (base === null) return null;
    return Math.max(0.0, base - obstructionFootprintSqft(room));
  }
  function gameCount(areaSqft) {
    if (areaSqft === null || areaSqft === undefined || areaSqft <= 0) return null;
    return Math.floor(areaSqft / SQ_FT_PER_GAME);
  }

  // ── normalize a raw room dict the way the pydantic models do ─────────────────────
  function normalizeDoor(d) {
    const door = Object.assign(
      { width_in: DEFAULT_DOOR_WIDTH_IN, location: null, measured_inside: null, assumed: false },
      d || {}
    );
    // Door._assume_unknown_width: explicit null width → assume 36" and flag.
    if (d && Object.prototype.hasOwnProperty.call(d, "width_in") && d.width_in === null) {
      door.width_in = DEFAULT_DOOR_WIDTH_IN;
      door.assumed = true;
    }
    return door;
  }
  function normalizeRoom(raw) {
    const r = raw || {};
    return {
      source_format: r.source_format || "manual",
      shape: r.shape || "unknown",
      width_ft: num(r.width_ft),
      depth_ft: num(r.depth_ft),
      polygon_ft: r.polygon_ft || null,
      usable_polygon_ft: r.usable_polygon_ft || null,
      ceiling_height_ft: num(r.ceiling_height_ft),
      doors: (r.doors || []).map(normalizeDoor),
      windows: r.windows || [],
      pillars: (r.pillars || []).map((p) =>
        Object.assign({ x_ft: null, y_ft: null, w_ft: 0.0, d_ft: 0.0 }, p || {})
      ),
      has_ropes_course: !!r.has_ropes_course,
      raw_dimensions_ft: r.raw_dimensions_ft || [],
      notes: r.notes || [],
      extraction_confidence: num(r.extraction_confidence),
    };
  }

  // ── validate(): FLAG problems, never solve them (Mike's instruction) ─────────────
  function validate(room) {
    const issues = [];
    const warn = (code, field, message, hint) =>
      issues.push({ severity: "warning", field, message, code, hint: hint || null });
    const block = (code, field, message, hint) =>
      issues.push({ severity: "blocking", field, message, code, hint: hint || null });

    const dims = room.raw_dimensions_ft.filter((d) => d > 0);

    // rectangle dimension count ("4 dimensions isn't a rectangle")
    if (room.shape === "rectangular") {
      if (dims.length > 2) {
        warn(
          "rect_dim_count",
          "raw_dimensions_ft",
          `${dims.length} dimensions provided, but a rectangle needs 2.`,
          "If the room isn't a simple rectangle send a sketch/outline; otherwise re-check the measurements."
        );
      }
      if ((room.width_ft === null || room.depth_ft === null) && !room.polygon_ft) {
        block(
          "rect_missing_dim",
          "dimensions",
          "Rectangular room missing width and/or depth — cannot size the usable.",
          "Provide both wall-to-wall width and depth (inside dimensions)."
        );
      }
    }

    // is any area derivable at all?
    const area = usableAreaSqft(room);
    if (area === null) {
      block(
        "no_area",
        "area",
        "No usable area derivable — need width×depth or a polygon outline.",
        "Send at least width×depth, or an outline with 3+ corner points."
      );
    }

    // non-positive dimensions
    for (const [name, val] of [
      ["width_ft", room.width_ft],
      ["depth_ft", room.depth_ft],
      ["ceiling_height_ft", room.ceiling_height_ft],
    ]) {
      if (val !== null && val <= 0) {
        block(
          "nonpositive_dim",
          name,
          `${name} = ${g(val)} is not a positive measurement.`,
          "Dimensions must be positive numbers in feet."
        );
      }
    }

    // implausibly small / large wall lengths
    for (const [name, val] of [
      ["width_ft", room.width_ft],
      ["depth_ft", room.depth_ft],
    ]) {
      if (val !== null && val > 0) {
        if (val < MIN_ROOM_DIM_FT) {
          warn(
            "dim_too_small",
            name,
            `${name} = ${g(val)} ft is unusually small for an arcade wall.`,
            "Confirm the units are FEET (not yards/meters) and not a typo."
          );
        } else if (val > MAX_ROOM_DIM_FT) {
          warn(
            "dim_too_large",
            name,
            `${name} = ${g(val)} ft is unusually large.`,
            "Confirm this isn't inches entered as feet, or a typo."
          );
        }
      }
    }

    // aspect ratio (long/narrow often = a swapped/mis-entered measurement)
    if (room.width_ft && room.depth_ft && room.width_ft > 0 && room.depth_ft > 0) {
      const [lo, hi] = [room.width_ft, room.depth_ft].sort((a, b) => a - b);
      if (lo > 0 && hi / lo > MAX_ASPECT_RATIO) {
        warn(
          "aspect_ratio",
          "dimensions",
          `Room is very long and narrow (${g(hi)}×${g(lo)} ft, ${f1(hi / lo)}:1).`,
          "Long/narrow rooms are valid but often signal a measurement swapped or mis-entered — please verify."
        );
      }
    }

    // usable-area plausibility
    if (area !== null) {
      if (area < MIN_USABLE_SQFT) {
        warn(
          "area_too_small",
          "area",
          `Usable area ${comma0(area)} sq ft is less than one game's footprint (${SQ_FT_PER_GAME} sq ft).`,
          "Double-check the measurements; this space may be too small to lay out."
        );
      } else if (area > MAX_USABLE_SQFT) {
        warn(
          "area_too_large",
          "area",
          `Usable area ${comma0(area)} sq ft is implausibly large.`,
          "Confirm units — this looks like inches treated as feet."
        );
      }
    }

    // width×depth vs outline-area agreement
    if (room.polygon_ft && room.polygon_ft.length >= 3 && room.width_ft && room.depth_ft) {
      const rect = room.width_ft * room.depth_ft;
      const poly = polygonArea(room.polygon_ft);
      if (rect > 0 && Math.abs(rect - poly) / rect > POLYGON_AREA_TOLERANCE) {
        warn(
          "poly_rect_mismatch",
          "polygon_ft",
          `Outline area (${comma0(poly)} sq ft) disagrees with width×depth (${comma0(
            rect
          )} sq ft) by more than ${pct0(POLYGON_AREA_TOLERANCE)}.`,
          "The corner points and the width×depth don't match — one of them is off."
        );
      }
    }

    // the green usable box can't exceed the room
    if (room.usable_polygon_ft && room.usable_polygon_ft.length >= 3) {
      const u = polygonArea(room.usable_polygon_ft);
      const ra = roomArea(room);
      if (ra && u > ra * (1 + POLYGON_AREA_TOLERANCE)) {
        block(
          "usable_exceeds_room",
          "usable_polygon_ft",
          `Usable box (${comma0(u)} sq ft) is larger than the room (${comma0(ra)} sq ft).`,
          "The green usable area cannot exceed the room outline — re-check the box."
        );
      }
    }

    // degenerate polygons
    for (const fld of ["polygon_ft", "usable_polygon_ft"]) {
      const poly = room[fld];
      if (poly !== null && poly !== undefined && poly.length < 3) {
        warn(
          "degenerate_polygon",
          fld,
          `${fld} has fewer than 3 points; it was ignored.`,
          "An outline needs at least 3 corner points."
        );
      }
    }

    // pillars inside the room bounds?
    let bx = null;
    if (room.polygon_ft && room.polygon_ft.length >= 3) bx = bbox(room.polygon_ft);
    else if (room.width_ft && room.depth_ft) bx = [0.0, 0.0, room.width_ft, room.depth_ft];
    if (bx) {
      const [x0, y0, x1, y1] = bx;
      room.pillars.forEach((p, idx) => {
        if (p.x_ft === null || p.y_ft === null) return;
        if (!(x0 - 0.01 <= p.x_ft && p.x_ft <= x1 + 0.01 && y0 - 0.01 <= p.y_ft && p.y_ft <= y1 + 0.01)) {
          warn(
            "pillar_outside",
            "pillars",
            `Pillar #${idx + 1} at (${g(p.x_ft)},${g(p.y_ft)}) ft is outside the room.`,
            "Pillar coordinates should share the room's origin/measurement reference."
          );
        }
      });
    }

    // door plausibility
    const wallCandidates = [room.width_ft, room.depth_ft].filter((d) => d);
    const longestWallFt = wallCandidates.length ? Math.max(...wallCandidates) : null;
    room.doors.forEach((d, idx) => {
      const wFt = d.width_in / 12.0;
      if (longestWallFt && wFt > longestWallFt) {
        warn(
          "door_wider_than_wall",
          "doors",
          `Door #${idx + 1} (${g(d.width_in)}") is wider than the longest wall.`,
          "Door width is the INSIDE clear opening, in inches — re-check."
        );
      } else if (d.width_in < MIN_DOOR_WIDTH_IN || d.width_in > MAX_DOOR_WIDTH_IN) {
        warn(
          "door_width_implausible",
          "doors",
          `Door #${idx + 1} width ${g(d.width_in)}" is outside the usual ${g(MIN_DOOR_WIDTH_IN)}–${g(
            MAX_DOOR_WIDTH_IN
          )}" range.`,
          "Measure the INSIDE clear opening, in inches."
        );
      }
    });

    // ceiling plausibility
    const ch = room.ceiling_height_ft;
    if (ch !== null && ch > 0 && (ch < MIN_CEILING_FT || ch > MAX_CEILING_FT)) {
      warn(
        "ceiling_implausible",
        "ceiling_height_ft",
        `Ceiling height ${g(ch)} ft is unusual.`,
        "Confirm units (feet) — tall games and ropes courses need accurate height."
      );
    }

    return issues;
  }

  // ── standard caveat library (Mike: boilerplate on EVERY usable) ──────────────────
  function buildCaveats(room) {
    const doorAssumed = room.doors.length === 0 || room.doors.some((d) => d.assumed);
    const obstructionSqft = obstructionFootprintSqft(room);
    const rules = [
      [
        doorAssumed,
        `Presumes a ${DEFAULT_DOOR_WIDTH_IN}" door measured at the INSIDE of the frame. How to measure correctly: ${HOW_TO_MEASURE_URL}.`,
      ],
      [
        true,
        `Game count is the Betson rule of thumb: usable sq ft ÷ ${SQ_FT_PER_GAME}. Actual fit depends on game mix, sight lines, and aisle layout.`,
      ],
      [
        room.ceiling_height_ft === null,
        "Ceiling height not provided — fine for the count, but required for tall games, VR rigs, and ropes courses.",
      ],
      [room.has_ropes_course, "Ropes course present — verify the minimum height clearance on the CAD."],
      [
        room.pillars.length === 0,
        "No interior obstructions (pillars, soffits, low beams) were supplied — if any exist, the real usable area will be smaller.",
      ],
      [
        obstructionSqft > 0,
        `Interior obstructions (~${Math.round(obstructionSqft).toLocaleString()} sq ft) have been subtracted from the usable area above.`,
      ],
      [
        true,
        "Egress, ADA aisle widths, and fire-strobe keep-outs are NOT certified here — the local fire marshal/AHJ and a licensed professional sign off on code compliance.",
      ],
      [true, "This usable is a draft estimate for review, not a code-compliance certification."],
    ];
    return rules.filter(([cond]) => cond).map(([, msg]) => msg);
  }

  function confidenceReasons(room, areaSqft, issues) {
    const reasons = [];
    const blocking = issues.filter((i) => i.severity === "blocking");
    const warnings = issues.filter((i) => i.severity === "warning");
    if (areaSqft === null) reasons.push("no usable area could be derived from the input");
    blocking.forEach((i) => reasons.push(`blocking — ${i.message}`));
    if (blocking.length || areaSqft === null) return reasons;
    warnings.forEach((i) => reasons.push(`warning — ${i.message}`));
    if (room.doors.length === 0 || room.doors.some((d) => d.assumed))
      reasons.push("door width was assumed, not measured");
    if (room.extraction_confidence !== null && room.extraction_confidence < 0.6)
      reasons.push(`low extraction confidence (${pct0(room.extraction_confidence)}) from the source file`);
    if (reasons.length === 0) reasons.push("all pertinent facts present and internally consistent");
    return reasons;
  }

  function gradeConfidence(room, areaSqft, issues) {
    if (areaSqft === null || issues.some((i) => i.severity === "blocking")) return "low";
    const hasWarning = issues.some((i) => i.severity === "warning");
    const assumedDoors = room.doors.length === 0 || room.doors.some((d) => d.assumed);
    const lowOcr = room.extraction_confidence !== null && room.extraction_confidence < 0.6;
    if (hasWarning || assumedDoors || lowOcr) return "medium";
    return "high";
  }

  function buildUsable(rawRoom) {
    const room = normalizeRoom(rawRoom);
    const issues = validate(room);
    const area = usableAreaSqft(room);
    const confidence = gradeConfidence(room, area, issues);
    const gc = gameCount(area);
    const readyForThroughput =
      confidence === "high" && gc !== null && !issues.some((i) => i.severity === "blocking");
    return {
      room,
      usable_sqft: area,
      sqft_per_game: SQ_FT_PER_GAME,
      game_count: gc,
      confidence,
      confidence_reasons: confidenceReasons(room, area, issues),
      inconsistencies: issues,
      caveats: buildCaveats(room),
      ready_for_throughput: readyForThroughput,
    };
  }

  // ── Phase A geometry helpers (browser-only placement/clearance; purely additive) ──
  // None of these are called from buildUsable/validate/usableAreaSqft/gradeConfidence,
  // so usable_sqft/game_count/codes/grade stay byte-identical (parity guard).

  // The usable region a placed game must sit inside — mirrors usableAreaSqft precedence
  // (L130-139): usable_polygon_ft (>=3) wins, else polygon_ft (>=3), else the w×d rect.
  function pickUsable(room) {
    if (room.usable_polygon_ft && room.usable_polygon_ft.length >= 3) return room.usable_polygon_ft;
    if (room.polygon_ft && room.polygon_ft.length >= 3) return room.polygon_ft;
    if (room.width_ft && room.depth_ft && room.width_ft > 0 && room.depth_ft > 0)
      return [
        [0.0, 0.0],
        [room.width_ft, 0.0],
        [room.width_ft, room.depth_ft],
        [0.0, room.depth_ft],
      ];
    return null;
  }
  // Classic ray-cast point-in-polygon (NEW: no point-in-polygon existed in this file).
  function pointInPolygon(pt, ring) {
    if (!ring || ring.length < 3) return false;
    const x = pt[0];
    const y = pt[1];
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0];
      const yi = ring[i][1];
      const xj = ring[j][0];
      const yj = ring[j][1];
      const intersect =
        yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
      if (intersect) inside = !inside;
    }
    return inside;
  }
  // AABB overlap on top-left rects {x,y,w,d}, with the established ±0.01 ft tolerance (L124).
  function rectsOverlap(a, b) {
    return (
      a.x < b.x + b.w + 0.01 &&
      b.x < a.x + a.w + 0.01 &&
      a.y < b.y + b.d + 0.01 &&
      b.y < a.y + a.d + 0.01
    );
  }
  // Inflate a top-left rect uniformly by `pad` per side (matches Python ew/eh ring).
  function inflateRect(r, pad) {
    return { x: r.x - pad, y: r.y - pad, w: r.w + 2 * pad, d: r.d + 2 * pad };
  }
  // True iff all 4 corners of a top-left rect fall inside the room's usable region.
  function rectInUsable(room, r) {
    const ring = pickUsable(room);
    if (!ring) return false;
    const corners = [
      [r.x, r.y],
      [r.x + r.w, r.y],
      [r.x + r.w, r.y + r.d],
      [r.x, r.y + r.d],
    ];
    return corners.every((c) => pointInPolygon(c, ring));
  }

  // ── Phase B geometry helpers (advisory ADA / egress overlay; purely additive) ─────
  // Exactly like the Phase A block above: NONE of these are called from buildUsable /
  // validate / usableAreaSqft / gradeConfidence, so usable_sqft / game_count / codes /
  // grade stay byte-identical and tests/test_measure_js_parity.py stays green.

  // Minimum clear distance (ft) between two top-left AABB rects {x,y,w,d}. 0 when they
  // touch or overlap. Used to find sub-36" aisle pinches between placed game footprints.
  function rectGap(a, b) {
    const dx = Math.max(0, a.x - (b.x + b.w), b.x - (a.x + a.w));
    const dy = Math.max(0, a.y - (b.y + b.d), b.y - (a.y + a.d));
    return Math.hypot(dx, dy);
  }

  // Distance from point p=[x,y] to segment a→b (a,b are [x,y]). NEW (no such fn existed).
  function pointToSegmentDist(p, a, b) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    if (l2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
    let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
  }

  // The egress keep-out quad in front of a door: a (widthFt × depthFt) rectangle that
  // begins at the door opening and projects INTO the room. `a`/`b` are the door's wall
  // segment endpoints; `inwardRef` is any point inside the room (e.g. the centroid), used
  // to orient the projection toward the interior. Returns a 4-point [x,y] ring.
  function doorKeepout(doorPos, a, b, inwardRef, widthFt, depthFt) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const L = Math.hypot(dx, dy) || 1;
    const wu = [dx / L, dy / L]; // along-wall unit (tangent)
    let n = [-wu[1], wu[0]]; // wall normal
    if (n[0] * (inwardRef[0] - doorPos[0]) + n[1] * (inwardRef[1] - doorPos[1]) < 0) n = [-n[0], -n[1]];
    const half = widthFt / 2;
    const base0 = [doorPos[0] - wu[0] * half, doorPos[1] - wu[1] * half];
    const base1 = [doorPos[0] + wu[0] * half, doorPos[1] + wu[1] * half];
    const far1 = [base1[0] + n[0] * depthFt, base1[1] + n[1] * depthFt];
    const far0 = [base0[0] + n[0] * depthFt, base0[1] + n[1] * depthFt];
    return [base0, base1, far1, far0];
  }

  // Do segments p1→p2 and p3→p4 properly cross? (internal helper for rectIntersectsPoly)
  function _segCross(p1, p2, p3, p4) {
    const ccw = (A, B, C) => (C[1] - A[1]) * (B[0] - A[0]) > (B[1] - A[1]) * (C[0] - A[0]);
    return ccw(p1, p3, p4) !== ccw(p2, p3, p4) && ccw(p1, p2, p3) !== ccw(p1, p2, p4);
  }

  // Does an axis-aligned top-left rect {x,y,w,d} overlap a simple polygon ring [[x,y],…]?
  // True when any rect corner is in the polygon, any polygon vertex is in the rect, or any
  // edges cross — enough to flag a footprint (or its clearance ring) intruding a keep-out.
  function rectIntersectsPoly(r, ring) {
    if (!ring || ring.length < 3) return false;
    const corners = [
      [r.x, r.y],
      [r.x + r.w, r.y],
      [r.x + r.w, r.y + r.d],
      [r.x, r.y + r.d],
    ];
    for (let i = 0; i < 4; i++) if (pointInPolygon(corners[i], ring)) return true;
    const inRect = (p) => p[0] >= r.x && p[0] <= r.x + r.w && p[1] >= r.y && p[1] <= r.y + r.d;
    for (let k = 0; k < ring.length; k++) if (inRect(ring[k])) return true;
    for (let e = 0; e < 4; e++) {
      const c0 = corners[e];
      const c1 = corners[(e + 1) % 4];
      for (let m = 0; m < ring.length; m++) {
        if (_segCross(c0, c1, ring[m], ring[(m + 1) % ring.length])) return true;
      }
    }
    return false;
  }

  // Phase C (OBB free-rotation; purely additive) ───────────────────────────────────
  // Oriented-bounding-box geometry for the browser placement tool. DORMANT in Phase 1:
  // exactly like the Phase A/B blocks above, NONE of these is called from buildUsable /
  // validate / usableAreaSqft / gradeConfidence / polygonArea / roomArea / gameCount /
  // normalizeRoom / buildCaveats / confidenceReasons, so usable_sqft / game_count / codes /
  // grade stay byte-identical and tests/test_measure_js_parity.py stays green. Built over the
  // existing angle-agnostic primitives (pointInPolygon, _segCross, pointToSegmentDist) and
  // mirroring the rect* helpers + the single ±0.01 ft tolerance convention (rectsOverlap
  // L516-519, pillar bbox L128) so that at θ∈{0,90,180,270} every OBB result reduces to
  // today's AABB result. OBB shape: { cx, cy, w, d, deg } — center, width (local x), depth
  // (local y), degrees CCW. At θ=0 the corner winding equals the rect {x:cx-w/2, y:cy-d/2,
  // w, d} corners used by rectInUsable / rectIntersectsPoly, which makes the reduction exact.

  // Top-left AABB rect for an OBB at θ=0 (the rect an axis-aligned box corresponds to).
  function toRect(obb) {
    return { x: obb.cx - obb.w / 2, y: obb.cy - obb.d / 2, w: obb.w, d: obb.d };
  }
  // The 4 corners of an OBB, CCW from the (−w/2,−d/2) local corner. At θ=0 these equal the
  // rect corners [(x,y),(x+w,y),(x+w,y+d),(x,y+d)] in the SAME order rectInUsable uses.
  function obbCorners(cx, cy, w, h, thetaDeg) {
    const t = ((thetaDeg || 0) * Math.PI) / 180;
    const cos = Math.cos(t);
    const sin = Math.sin(t);
    const hw = w / 2;
    const hh = h / 2;
    const local = [
      [-hw, -hh],
      [hw, -hh],
      [hw, hh],
      [-hw, hh],
    ];
    return local.map(([dx, dy]) => [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos]);
  }
  // The i-th OBB face normal (unit): axis 0 = local +x (cos,sin), axis 1 = local +y (−sin,cos).
  // SAT needs only these two per box (opposite faces share a normal). At θ=0: (1,0) and (0,1).
  function _obbAxis(obb, i) {
    const t = ((obb.deg || 0) * Math.PI) / 180;
    const cos = Math.cos(t);
    const sin = Math.sin(t);
    return i === 0 ? [cos, sin] : [-sin, cos];
  }
  // [min,max] of the projection of `corners` onto unit axis `ax`.
  function _projExtent(corners, ax) {
    let mn = Infinity;
    let mx = -Infinity;
    for (let i = 0; i < corners.length; i++) {
      const d = corners[i][0] * ax[0] + corners[i][1] * ax[1];
      if (d < mn) mn = d;
      if (d > mx) mx = d;
    }
    return [mn, mx];
  }
  // Enclosing axis-aligned top-left rect {x,y,w,d} of an OBB's 4 corners. At θ=0 this equals
  // toRect(obb); with inflateObb it is the broad-phase superset obbAABB(inflateObb(...)).
  function obbAABB(obb) {
    const cs = obbCorners(obb.cx, obb.cy, obb.w, obb.d, obb.deg || 0);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < cs.length; i++) {
      const x = cs[i][0];
      const y = cs[i][1];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    return { x: minX, y: minY, w: maxX - minX, d: maxY - minY };
  }
  // Is point p=[x,y] inside the OBB? Inverse-rotate into the box's local frame and compare to
  // the half-extents with the established ±0.01 ft tolerance (a point within 0.01 ft of a wall
  // reads as inside — flush-to-wall must not self-flag, matching rectsOverlap / the pillar bbox).
  function pointInObb(p, obb) {
    const t = ((obb.deg || 0) * Math.PI) / 180;
    const cos = Math.cos(t);
    const sin = Math.sin(t);
    const dx = p[0] - obb.cx;
    const dy = p[1] - obb.cy;
    const lx = dx * cos + dy * sin; // inverse rotation (rotate by −θ)
    const ly = -dx * sin + dy * cos;
    // Strict `<` so the seam matches the overlap convention exactly: within 0.01 ft of a face
    // is inside (flush-to-wall reads OK), at/ beyond 0.01 ft is outside (gap ≥ 0.01 ⇒ clear).
    return Math.abs(lx) < obb.w / 2 + 0.01 && Math.abs(ly) < obb.d / 2 + 0.01;
  }
  // Strict-interior variant of pointInObb for the Part-3 intrusion test: a point counts only when
  // it is ≥0.01 ft INSIDE every face (inset by the same seam, NOT the outward +0.01 ft tolerance).
  // This is what lets obbInUsable reduce to the legacy AABB accept for a box flush in a CONVEX
  // corner — a room vertex on/just outside the box boundary is not an intrusion — while a
  // reflex/concave vertex poking genuinely inside still trips Part 3 (box-E).
  function pointStrictlyInObb(p, obb) {
    const t = ((obb.deg || 0) * Math.PI) / 180;
    const cos = Math.cos(t);
    const sin = Math.sin(t);
    const dx = p[0] - obb.cx;
    const dy = p[1] - obb.cy;
    const lx = dx * cos + dy * sin; // inverse rotation (rotate by −θ), same as pointInObb
    const ly = -dx * sin + dy * cos;
    return Math.abs(lx) < obb.w / 2 - 0.01 && Math.abs(ly) < obb.d / 2 - 0.01;
  }
  // Proper (transversal) segment crossing for Part 2 of obbInUsable: true ONLY when ab and cd
  // cross through each other's interior. Unlike the shared _segCross it returns FALSE for a
  // collinear-overlap or endpoint touch, so a box edge lying flush ALONG a wall is not a
  // "crossing" (flush-to-wall must reduce to the legacy AABB accept) while a box edge that
  // genuinely passes through a wall still trips (box-E, the slot bridge).
  function _properCross(a, b, c, d) {
    const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
  }
  // 3-PART containment: an OBB is inside the usable polygon iff (1) all 4 corners are in the
  // polygon AND (2) no box edge crosses any wall/ring segment AND (3) no ring vertex sits
  // inside the box. The legacy corner-only rectInUsable (L527-537) silently passes a box that
  // pokes through a concave/angled wall; parts 2-3 are what catch it (box-E in the test).
  function obbInUsable(obb, usablePolygon) {
    const ring = usablePolygon;
    if (!ring || ring.length < 3) return false;
    const corners = obbCorners(obb.cx, obb.cy, obb.w, obb.d, obb.deg || 0);
    // Part 1 — every corner inside the polygon.
    for (let i = 0; i < 4; i++) if (!pointInPolygon(corners[i], ring)) return false;
    // Part 2 — no box edge TRANSVERSALLY crosses a wall segment. Uses _properCross (not the shared
    // _segCross) so a box edge lying flush ALONG a wall is not a crossing — flush-to-wall reduces to
    // the legacy AABB accept — while a genuine poke through an (angled/concave) wall still rejects.
    for (let e = 0; e < 4; e++) {
      const c0 = corners[e];
      const c1 = corners[(e + 1) % 4];
      for (let m = 0; m < ring.length; m++) {
        if (_properCross(c0, c1, ring[m], ring[(m + 1) % ring.length])) return false;
      }
    }
    // Part 3 — no wall vertex STRICTLY inside the box. Uses the inset pointStrictlyInObb (not the
    // outward +0.01 seam of pointInObb): a CONVEX wall vertex flush against the box boundary is not
    // an intrusion (must reduce to the legacy AABB accept), while a reflex/concave vertex poking
    // ≥0.01 ft in still rejects (box-E). [regression: flush-to-convex-corner, adversarial verify]
    for (let k = 0; k < ring.length; k++) if (pointStrictlyInObb(ring[k], obb)) return false;
    return true;
  }
  // SAT overlap of two OBBs over the 4 face normals, in the INTERVAL/OFFSET form of
  // rectsOverlap (L514-521) so that at θ=0 it is byte-identical to rectsOverlap for every
  // placement INCLUDING the ±0.01 ft seam: each axis test collapses to `aMin < bMax + 0.01`.
  function obbOverlap(a, b) {
    const ca = obbCorners(a.cx, a.cy, a.w, a.d, a.deg || 0);
    const cb = obbCorners(b.cx, b.cy, b.w, b.d, b.deg || 0);
    const axes = [_obbAxis(a, 0), _obbAxis(a, 1), _obbAxis(b, 0), _obbAxis(b, 1)];
    for (let i = 0; i < axes.length; i++) {
      const ea = _projExtent(ca, axes[i]);
      const eb = _projExtent(cb, axes[i]);
      // separated on this axis ⇒ no overlap (mirrors rectsOverlap's offset comparison)
      if (!(ea[0] < eb[1] + 0.01 && eb[0] < ea[1] + 0.01)) return false;
    }
    return true;
  }
  // Minimum clear distance (ft) between two OBBs; 0 when they overlap. For disjoint convex
  // quads the min distance is vertex↔edge, so scan every corner of each against the other's
  // edges (the rotated analogue of rectGap).
  function obbGap(a, b) {
    if (obbOverlap(a, b)) return 0;
    const ca = obbCorners(a.cx, a.cy, a.w, a.d, a.deg || 0);
    const cb = obbCorners(b.cx, b.cy, b.w, b.d, b.deg || 0);
    let best = Infinity;
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        const da = pointToSegmentDist(ca[i], cb[j], cb[(j + 1) % 4]);
        if (da < best) best = da;
        const db = pointToSegmentDist(cb[i], ca[j], ca[(j + 1) % 4]);
        if (db < best) best = db;
      }
    }
    return best;
  }
  // Advisory pinch: the two footprints are clear (not overlapping) but their gap is below the
  // required clearance — a sub-aisle pinch. Uses the same ±0.01 ft seam as the overlap test.
  function obbPinch(a, b, minClearFt) {
    const thr = minClearFt === null || minClearFt === undefined ? CLEARANCE_FT : minClearFt;
    if (obbOverlap(a, b)) return false;
    return obbGap(a, b) < thr + 0.01;
  }
  // Inflate an OBB by a clearance ring. Accepts a uniform number (every side) OR a per-side
  // {front,back,left,right} object (front/back grow local +y/−y, right/left grow local +x/−x);
  // asymmetric growth shifts the center accordingly. A number — or missing sides — falls back
  // to uniform, so with no per-side data this is byte-identical to today's flat ring (inflateRect).
  function inflateObb(obb, spec) {
    let front;
    let back;
    let left;
    let right;
    if (spec !== null && typeof spec === "object") {
      const u = spec.uniform === null || spec.uniform === undefined ? 0 : spec.uniform;
      front = spec.front === null || spec.front === undefined ? u : spec.front;
      back = spec.back === null || spec.back === undefined ? u : spec.back;
      left = spec.left === null || spec.left === undefined ? u : spec.left;
      right = spec.right === null || spec.right === undefined ? u : spec.right;
    } else {
      const p = Number(spec) || 0;
      front = back = left = right = p;
    }
    const w2 = obb.w + left + right;
    const d2 = obb.d + front + back;
    const sx = (right - left) / 2; // center shift along local +x
    const sy = (front - back) / 2; // center shift along local +y
    const t = ((obb.deg || 0) * Math.PI) / 180;
    const cos = Math.cos(t);
    const sin = Math.sin(t);
    return {
      cx: obb.cx + sx * cos - sy * sin,
      cy: obb.cy + sx * sin + sy * cos,
      w: w2,
      d: d2,
      deg: obb.deg || 0,
    };
  }
  // OBB vs polygon-ring overlap (the OBB analogue of rectIntersectsPoly L591-610): true when
  // any OBB corner is in the ring, any ring vertex is in the OBB, or any edges cross.
  function obbIntersectsPoly(obb, poly) {
    const ring = poly;
    if (!ring || ring.length < 3) return false;
    const corners = obbCorners(obb.cx, obb.cy, obb.w, obb.d, obb.deg || 0);
    for (let i = 0; i < 4; i++) if (pointInPolygon(corners[i], ring)) return true;
    for (let k = 0; k < ring.length; k++) if (pointInObb(ring[k], obb)) return true;
    for (let e = 0; e < 4; e++) {
      const c0 = corners[e];
      const c1 = corners[(e + 1) % 4];
      for (let m = 0; m < ring.length; m++) {
        if (_segCross(c0, c1, ring[m], ring[(m + 1) % ring.length])) return true;
      }
    }
    return false;
  }
  // Test-only dispatcher for the `obb` argv subcommand (parity-safe — never called by the
  // locked engine). Maps a {op,...} case from tests/test_obb_geometry_js.py to the helper(s)
  // above and returns a JSON-able result. Combined ops bundle the comparisons a single test
  // assertion needs (e.g. obbOverlap vs rectsOverlap, two-phase vs single-phase SAT).
  function obbDispatch(c) {
    switch (c && c.op) {
      case "corners":
        return obbCorners(c.cx, c.cy, c.w, c.d, c.deg || 0);
      case "aabb":
        return obbAABB(c.obb);
      case "pointInObb":
        return pointInObb(c.p, c.obb);
      case "inUsable": {
        const obb = c.obb;
        const ring = c.ring;
        const corners = obbCorners(obb.cx, obb.cy, obb.w, obb.d, obb.deg || 0);
        const cornersIn = corners.every((pt) => pointInPolygon(pt, ring));
        let edgeCross = false;
        for (let e = 0; e < 4 && !edgeCross; e++) {
          const c0 = corners[e];
          const c1 = corners[(e + 1) % 4];
          for (let m = 0; m < ring.length; m++) {
            if (_properCross(c0, c1, ring[m], ring[(m + 1) % ring.length])) {
              edgeCross = true;
              break;
            }
          }
        }
        let vertexIn = false;
        for (let k = 0; k < ring.length; k++) {
          if (pointStrictlyInObb(ring[k], obb)) {
            vertexIn = true;
            break;
          }
        }
        return {
          inUsable: obbInUsable(obb, ring),
          cornersIn: cornersIn,
          noEdgeCross: !edgeCross,
          noVertexInBox: !vertexIn,
          rectInUsable: rectInUsable({ usable_polygon_ft: ring }, toRect(obb)),
        };
      }
      case "overlap":
        return obbOverlap(c.a, c.b);
      case "overlapPair":
        return { obb: obbOverlap(c.a, c.b), rect: rectsOverlap(toRect(c.a), toRect(c.b)) };
      case "twoPhase": {
        const ai = inflateObb(c.a, c.clr);
        const bi = inflateObb(c.b, c.clr);
        return {
          single: obbOverlap(ai, bi),
          broad: rectsOverlap(obbAABB(ai), obbAABB(bi)),
          oldBroad: rectsOverlap(inflateRect(toRect(c.a), c.clr), inflateRect(toRect(c.b), c.clr)),
          singleRaw: obbOverlap(c.a, c.b),
          oldRawBroad: rectsOverlap(toRect(c.a), toRect(c.b)),
        };
      }
      case "gap":
        return obbGap(c.a, c.b);
      case "pinch":
        return obbPinch(c.a, c.b, c.minClear);
      case "inflate":
        return inflateObb(c.obb, c.spec);
      case "inflateAABB": {
        const inf = inflateObb(c.obb, c.clr);
        return {
          infObb: inf,
          obbAabb: obbAABB(inf),
          rectInflate: inflateRect(toRect(c.obb), c.clr),
        };
      }
      case "intersectsPoly":
        return obbIntersectsPoly(c.obb, c.ring);
      default:
        return { error: "unknown op: " + String(c && c.op) };
    }
  }

  return {
    SQ_FT_PER_GAME,
    DEFAULT_DOOR_WIDTH_IN,
    HOW_TO_MEASURE_URL,
    MIN_DOOR_WIDTH_IN,
    MAX_DOOR_WIDTH_IN,
    MIN_CEILING_FT,
    MAX_CEILING_FT,
    polygonArea,
    usableAreaSqft,
    roomArea,
    gameCount,
    normalizeRoom,
    validate,
    buildCaveats,
    confidenceReasons,
    gradeConfidence,
    buildUsable,
    // Phase A (browser-only placement) — additive, never called by the above.
    CLEARANCE_FT,
    pointInPolygon,
    rectInUsable,
    rectsOverlap,
    inflateRect,
    pickUsable,
    // Phase B (advisory ADA / egress overlay) — additive, never called by the above.
    rectGap,
    pointToSegmentDist,
    doorKeepout,
    rectIntersectsPoly,
    // Phase C (OBB free-rotation) — additive, never called by the locked engine above.
    obbCorners,
    obbAABB,
    toRect,
    pointInObb,
    obbInUsable,
    obbOverlap,
    obbGap,
    obbPinch,
    inflateObb,
    obbIntersectsPoly,
    obbDispatch,
  };
});
