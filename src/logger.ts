let verbose = false;

export function setVerbose(v: boolean): void {
  verbose = v;
}

export function log(...args: unknown[]): void {
  if (verbose) {
    console.log(new Date(), ...args);
  }
}
