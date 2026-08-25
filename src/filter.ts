export function makeRecencyFilter<T>(timeFn: (item: T) => number): (items: T[]) => T[] {
  let lastTime = 0;

  return function (items: T[]): T[] {
    const out: T[] = [];

    for (const item of items) {
      if (timeFn(item) > lastTime) {
        out.push(item);
      }
    }

    for (const item of out) {
      lastTime = Math.max(lastTime, timeFn(item));
    }

    return out;
  };
}
