import assert from "node:assert/strict";
import { test } from "node:test";
import { arrowLine, makeShape, shapeColor, squareAt, squareCenter, toggleShape } from "../board-shapes.js";

test("modifier keys pick Lichess's brush colors", () => {
  assert.equal(shapeColor({}), "green");
  assert.equal(shapeColor({ shiftKey: true }), "red");
  assert.equal(shapeColor({ ctrlKey: true }), "red");
  assert.equal(shapeColor({ altKey: true }), "blue");
  assert.equal(shapeColor({ metaKey: true }), "blue");
  assert.equal(shapeColor({ shiftKey: true, altKey: true }), "yellow");
});

test("drawing a shape again removes it, and a new color replaces it", () => {
  const arrow = makeShape("e2", "e4", "green");
  const circle = makeShape("d5", "d5", "red");
  assert.deepEqual(circle, { from: "d5", color: "red" });
  let shapes = toggleShape(toggleShape([], arrow), circle);
  assert.equal(shapes.length, 2);
  shapes = toggleShape(shapes, makeShape("e2", "e4", "blue"));
  assert.deepEqual(shapes, [circle, { from: "e2", to: "e4", color: "blue" }]);
  shapes = toggleShape(shapes, makeShape("d5", "d5", "red"));
  assert.deepEqual(shapes, [{ from: "e2", to: "e4", color: "blue" }]);
  // An arrow and a circle on the same starting square are different shapes.
  assert.equal(toggleShape(shapes, makeShape("e2", "e2", "blue")).length, 2);
});

test("squares map to board positions for both orientations", () => {
  assert.deepEqual(squareCenter("a1"), { x: 0.5, y: 7.5 });
  assert.deepEqual(squareCenter("h8"), { x: 7.5, y: 0.5 });
  assert.deepEqual(squareCenter("a1", "b"), { x: 7.5, y: 0.5 });
  assert.equal(squareAt(0.01, 0.99), "a1");
  assert.equal(squareAt(0.99, 0.01), "h8");
  assert.equal(squareAt(0.01, 0.99, "b"), "h8");
  assert.equal(squareAt(0.5, 0.5), "e4");
  assert.equal(squareAt(1, 0.5), null);
  assert.equal(squareAt(-0.1, 0.5), null);
});

test("an arrow's shaft stops short of the target so its head points at the center", () => {
  const line = arrowLine("e2", "e4", "w", 0.5);
  assert.deepEqual(line, { x1: 4.5, y1: 6.5, x2: 4.5, y2: 5 });
  const flipped = arrowLine("e2", "e4", "b", 0.5);
  assert.deepEqual(flipped, { x1: 3.5, y1: 1.5, x2: 3.5, y2: 3 });
});
