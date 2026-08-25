export const CARELINK_TREND_TO_NIGHTSCOUT_TREND: Record<string, { trend: number; direction: string }> = {
  NONE: { trend: 0, direction: 'NONE' },
  UP_TRIPLE: { trend: 1, direction: 'TripleUp' },
  UP_DOUBLE: { trend: 1, direction: 'DoubleUp' },
  UP: { trend: 2, direction: 'SingleUp' },
  DOWN: { trend: 6, direction: 'SingleDown' },
  DOWN_DOUBLE: { trend: 7, direction: 'DoubleDown' },
  DOWN_TRIPLE: { trend: 7, direction: 'TripleDown' },
};
