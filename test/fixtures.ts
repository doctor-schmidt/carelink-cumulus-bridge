import type { CareLinkData, CareLinkSG } from '../src/types/carelink.js';

export function makeSG(sg: number, time?: string): CareLinkSG {
  return {
    sg,
    datetime: time || 'Oct 20, 2015 11:09:00',
    version: 1,
    timeChange: false,
    kind: 'SG',
  };
}

export function makeSGs(count: number): CareLinkSG[] {
  return Array.from({ length: count }, (_, i) => makeSG(70 + i));
}

export function data(overrides?: Partial<CareLinkData>): CareLinkData {
  const sgs = makeSGs(288);
  const base: CareLinkData = {
    sgs,
    lastSG: sgs[sgs.length - 1],
    conduitSerialNumber: '0',
    conduitMedicalDeviceInRange: true,
    calibStatus: 'LESS_THAN_TWELVE_HRS',
    medicalDeviceFamily: 'PARADIGM',
    currentServerTime: 1445091119507,
    sMedicalDeviceTime: 'Oct 17, 2015 09:09:14',
    conduitInRange: true,
    reservoirAmount: 52,
    sensorState: 'NORMAL',
    medicalDeviceBatteryLevelPercent: 100,
    lastMedicalDeviceDataUpdateServerTime: 1445091101422,
    activeInsulin: {
      datetime: 'Oct 17, 2015 09:09:14',
      version: 1,
      amount: 1.275,
      kind: 'Insulin',
    },
    conduitBatteryLevel: 100,
    conduitBatteryStatus: 'FULL',
    conduitSensorInRange: true,
    timeToNextCalibHours: 11,
    sensorDurationHours: 91,
    bgunits: 'MGDL',
    bgUnits: 'MGDL',
    lastSGTrend: 'UP_DOUBLE',
  };
  return { ...base, ...overrides };
}
