import test from 'node:test';
import assert from 'node:assert/strict';
import {
  polygon, sideSD, sideU, pointSegDist, segSegDist, insideMargin,
} from '../shared/geometry.js';

test('regular polygon: side count, length, outward normals', () => {
  const n = 6;
  const r = 100;
  const p = polygon(n, r);
  assert.equal(p.verts.length, n);
  assert.equal(p.sides.length, n);
  const expectedLen = 2 * r * Math.sin(Math.PI / n);
  for (const s of p.sides) {
    assert.ok(Math.abs(s.len - expectedLen) < 1e-9, 'side length matches');
    assert.ok(Math.abs(Math.hypot(s.nx, s.ny) - 1) < 1e-9, 'unit normal');
    assert.ok(Math.abs(Math.hypot(s.tx, s.ty) - 1) < 1e-9, 'unit tangent');
    assert.ok(sideSD(s, 0, 0) < 0, 'center is inside every side');
    assert.ok(s.nx * s.cx + s.ny * s.cy > 0, 'normal points outward');
  }
});

test('sideU measures along the tangent from p0', () => {
  const p = polygon(4, 100);
  const s = p.sides[0];
  assert.ok(Math.abs(sideU(s, s.p0.x, s.p0.y) - 0) < 1e-9);
  assert.ok(Math.abs(sideU(s, s.p1.x, s.p1.y) - s.len) < 1e-9);
});

test('pointSegDist and segSegDist', () => {
  assert.equal(pointSegDist(0, 0, -10, 0, 10, 0), 0);
  assert.equal(pointSegDist(0, 5, -10, 0, 10, 0), 5);
  assert.equal(pointSegDist(20, 0, -10, 0, 10, 0), 10);
  assert.equal(segSegDist(0, 0, 10, 0, 5, -5, 5, 5), 0, 'crossing segments');
  assert.equal(segSegDist(0, 0, 10, 0, 0, 5, 10, 5), 5, 'parallel segments');
});

test('insideMargin distinguishes safe and wall-hugging points', () => {
  const p = polygon(3, 480);
  assert.ok(insideMargin(p, 0, 0, 60));
  assert.ok(!insideMargin(p, 0, -460, 60), 'near a vertex is outside the margin');
});
