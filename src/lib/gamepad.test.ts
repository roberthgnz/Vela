import { describe, expect, it } from 'vitest';
import { nearest } from './gamepad';

const box = (left: number, top: number, width = 100, height = 40) => ({ left, top, right: left + width, bottom: top + height });

describe('nearest', () => {
  const from = box(200, 200);
  const candidates = [
    { item: 'right', box: box(320, 200) },
    { item: 'right-far', box: box(700, 200) },
    { item: 'right-up', box: box(320, 60) },
    { item: 'down', box: box(200, 260) },
    { item: 'down-far-aligned', box: box(200, 600) },
    { item: 'left', box: box(60, 210) },
    { item: 'up', box: box(190, 120) },
  ];

  it('picks the closest control in each direction', () => {
    expect(nearest(from, candidates, 'right')).toBe('right');
    expect(nearest(from, candidates, 'down')).toBe('down');
    expect(nearest(from, candidates, 'left')).toBe('left');
    expect(nearest(from, candidates, 'up')).toBe('up');
  });

  it('prefers a neighbour slightly off the line to an aligned one far away', () => {
    const near = [
      { item: 'aligned-far', box: box(200, 700) },
      { item: 'offset-near', box: box(260, 260) },
    ];
    expect(nearest(from, near, 'down')).toBe('offset-near');
  });

  it('finds nothing when no control lies that way', () => {
    expect(nearest(from, [{ item: 'x', box: box(60, 210) }], 'right')).toBeUndefined();
  });
});
