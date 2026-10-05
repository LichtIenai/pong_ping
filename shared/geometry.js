// Pure geometry helpers shared by server, PvE and client-side placement previews.

/**
 * Build a regular polygon centered on the origin.
 * Returns { n, r, verts, sides } where each side carries:
 *   p0,p1   endpoints (p1 follows p0 in clockwise screen order)
 *   t       unit tangent (p0 -> p1)
 *   n       unit outward normal
 *   cx,cy   midpoint
 *   len     side length
 */
export function polygon(n, r) {
  const verts = [];
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    verts.push({ x: r * Math.cos(a), y: r * Math.sin(a) });
  }
  const sides = [];
  for (let i = 0; i < n; i++) {
    const p0 = verts[i];
    const p1 = verts[(i + 1) % n];
    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;
    const len = Math.hypot(dx, dy) || 1;
    const tx = dx / len;
    const ty = dy / len;
    const cx = (p0.x + p1.x) / 2;
    const cy = (p0.y + p1.y) / 2;
    const m = Math.hypot(cx, cy) || 1;
    sides.push({
      i, p0, p1, len,
      tx, ty,
      cx, cy,
      nx: cx / m,
      ny: cy / m,
    });
  }
  return { n, r, verts, sides };
}

/** Signed distance from a point to a side plane. Negative = inside. */
export function sideSD(side, x, y) {
  return (x - side.p0.x) * side.nx + (y - side.p0.y) * side.ny;
}

/** Position along the side, measured from p0 along the tangent. */
export function sideU(side, x, y) {
  return (x - side.p0.x) * side.tx + (y - side.p0.y) * side.ty;
}

/** Closest point on segment a-b to p, plus the distance. */
export function segClosest(ax, ay, bx, by, px, py) {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const x = ax + t * dx;
  const y = ay + t * dy;
  return { x, y, t, dist: Math.hypot(px - x, py - y) };
}

/** Distance from a point to a segment. */
export function pointSegDist(px, py, ax, ay, bx, by) {
  return segClosest(ax, ay, bx, by, px, py).dist;
}

function segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
  const d1 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d2 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  const d3 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const d4 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
         ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** Minimum distance between two segments (0 when they intersect). */
export function segSegDist(ax, ay, bx, by, cx, cy, dx, dy) {
  if (segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy)) return 0;
  return Math.min(
    pointSegDist(ax, ay, cx, cy, dx, dy),
    pointSegDist(bx, by, cx, cy, dx, dy),
    pointSegDist(cx, cy, ax, ay, bx, by),
    pointSegDist(dx, dy, ax, ay, bx, by),
  );
}

/** True when the point is at least `margin` away from every wall. */
export function insideMargin(poly, x, y, margin) {
  for (const s of poly.sides) {
    if (sideSD(s, x, y) > -margin) return false;
  }
  return true;
}
