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
      // CLI: read a JSON array of RoomInput dicts on stdin, print a JSON array of
      // projected UsableResults on stdout. Used only by the parity test.
      const fs = require("fs");
      const rooms = JSON.parse(fs.readFileSync(0, "utf8"));
      const out = rooms.map((r) => api.buildUsable(r));
      process.stdout.write(JSON.stringify(out));
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
  function usableAreaSqft(room) {
    if (room.usable_polygon_ft && room.usable_polygon_ft.length >= 3)
      return polygonArea(room.usable_polygon_ft);
    if (room.polygon_ft && room.polygon_ft.length >= 3) return polygonArea(room.polygon_ft);
    if (room.width_ft && room.depth_ft && room.width_ft > 0 && room.depth_ft > 0)
      return room.width_ft * room.depth_ft;
    return null;
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
  };
});
