import { describe, it, expect } from 'vitest';
import { missingLastSgv, withTrend } from './samples.js';
import { transform } from '../src/transform/index.js';

describe('integration test: missingLastSgv', () => {
  const sample = missingLastSgv;
  const transformed = transform(sample);
  const pumpStatuses = transformed.devicestatus;
  const sgvs = transformed.entries;

  it('should set the pump status time based on the "last device data update time"', () => {
    expect(pumpStatuses[0].created_at).toBe(
      new Date(sample.lastMedicalDeviceDataUpdateServerTime).toISOString(),
    );
  });

  it('should have one pump_status and 5 sgv entries', () => {
    expect(pumpStatuses).toHaveLength(1);
    expect(sgvs).toHaveLength(5);
  });

  it('should pull the right sgvs', () => {
    expect(sgvs.map(s => s.sgv)).toEqual([70, 69, 68, 65, 66]);
  });

  it('should correctly deduce that the pump time offset is -0700', () => {
    expect(sgvs.map(s => s.date)).toEqual(
      [1445266500000, 1445266800000, 1445267100000, 1445267400000, 1445267700000],
    );
  });

  it('should not include a trend for any sgv', () => {
    const directions = [...new Set(sgvs.map(s => s.direction))];
    expect(directions).toEqual([undefined]);
  });

  it('should include pump status data, including active insulin', () => {
    const ps = pumpStatuses[0];
    expect(ps.uploader.battery).toBe(29);
    expect(ps.pump?.battery.percent).toBe(75);
    expect(ps.pump?.reservoir).toBe(60);
    expect(ps.pump?.iob.bolusiob).toBe(4.85);
    expect(ps.pump?.iob.timestamp).toBe(
      new Date(sample.lastMedicalDeviceDataUpdateServerTime).toISOString(),
    );
    expect(ps.connect.calibStatus).toBe('LESS_THAN_TWELVE_HRS');
    expect(ps.connect.conduitInRange).toBe(true);
    expect(ps.connect.conduitMedicalDeviceInRange).toBe(true);
    expect(ps.connect.conduitSensorInRange).toBe(true);
    expect(ps.connect.sensorDurationHours).toBe(73);
    expect(ps.connect.sensorState).toBe('NORMAL');
    expect(ps.connect.timeToNextCalibHours).toBe(10);
    expect(ps.device).toBe('connect-paradigm');
  });
});

describe('integration test: withTrend', () => {
  const sample = withTrend;
  const transformed = transform(sample);
  const pumpStatuses = transformed.devicestatus;
  const sgvs = transformed.entries;

  it('should have one pump_status and 6 sgv entries', () => {
    expect(pumpStatuses).toHaveLength(1);
    expect(sgvs).toHaveLength(6);
  });

  it('should pull the right sgvs', () => {
    expect(sgvs.map(s => s.sgv)).toEqual([191, 185, 179, 175, 168, 163]);
  });

  it('should correctly deduce that the pump time offset is -0500', () => {
    expect(sgvs.map(s => s.date)).toEqual(
      [1445365260000, 1445365560000, 1445365860000, 1445366160000, 1445366460000, 1445366760000],
    );
  });

  it('should include a SingleDown direction/trend on the last sgv', () => {
    const withDirection = sgvs.filter(s => s.direction === 'SingleDown');
    const withTrend = sgvs.filter(s => s.trend === 6);
    const withoutDirection = sgvs.filter(s => s.direction === undefined);
    const withoutTrend = sgvs.filter(s => s.trend === undefined);

    expect(withDirection).toHaveLength(1);
    expect(withTrend).toHaveLength(1);
    expect(withoutDirection).toHaveLength(5);
    expect(withoutTrend).toHaveLength(5);

    expect(sgvs[sgvs.length - 1].direction).toBe('SingleDown');
    expect(sgvs[sgvs.length - 1].trend).toBe(6);
  });

  it('should include pump status data, including active insulin', () => {
    const ps = pumpStatuses[0];
    expect(ps.uploader.battery).toBe(86);
    expect(ps.pump?.battery.percent).toBe(50);
    expect(ps.pump?.reservoir).toBe(67);
    expect(ps.pump?.iob.bolusiob).toBe(1.35);
    expect(ps.pump?.iob.timestamp).toBe(
      new Date(sample.lastMedicalDeviceDataUpdateServerTime).toISOString(),
    );
    expect(ps.connect.calibStatus).toBe('LESS_THAN_NINE_HRS');
    expect(ps.connect.conduitInRange).toBe(true);
    expect(ps.connect.conduitMedicalDeviceInRange).toBe(true);
    expect(ps.connect.conduitSensorInRange).toBe(true);
    expect(ps.connect.sensorDurationHours).toBe(137);
    expect(ps.connect.sensorState).toBe('NORMAL');
    expect(ps.connect.timeToNextCalibHours).toBe(6);
    expect(ps.device).toBe('connect-paradigm');
  });
});
