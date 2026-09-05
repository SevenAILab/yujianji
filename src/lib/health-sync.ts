"use client";

import { db } from "./db";
import { sampleKey, toHealthSnapshot, type NativeHealthSample } from "./native-bridge";
import { riskLevelForHealth } from "./trip";

export async function saveHealthSamples(samples: NativeHealthSample[]): Promise<number> {
  return db.transaction("rw", db.healthSamples, db.trips, async () => {
    const existing = await db.healthSamples.bulkGet(samples.map(sampleKey));
    await db.healthSamples.bulkPut(samples.map((sample) => ({ ...sample, key: sampleKey(sample) })));
    const trips = await db.trips.where("status").equals("active").toArray();
    for (const trip of trips) {
      const keys = new Set(trip.healthSnapshots.map((snapshot) => snapshot.sampleId));
      const additions = samples.filter((sample) => Date.parse(sample.timestamp) >= Date.parse(trip.startedAt) && !keys.has(sampleKey(sample)));
      const healthSnapshots = [...trip.healthSnapshots, ...additions.map(toHealthSnapshot)]
        .sort((first, second) => Date.parse(first.timestamp) - Date.parse(second.timestamp));
      await db.trips.update(trip.id, { healthSnapshots, riskLevel: riskLevelForHealth(healthSnapshots) });
    }
    return existing.filter((sample) => !sample).length;
  });
}
