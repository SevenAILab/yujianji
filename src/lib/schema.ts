import { z } from "zod";

const categorySchema = z.enum(["animal", "plant", "mineral", "landscape", "sky", "food", "artifact", "other"]);

const luckSchema = z.object({
  text: z.string().min(1).max(180),
  basis: z.string().min(1).max(240),
  confidence: z.enum(["low", "medium", "high"]),
});

const healthSnapshotSchema = z.object({
  timestamp: z.string().min(1),
  heartRate: z.number().finite().optional(),
  bloodOxygen: z.number().finite().optional(),
  altitude: z.number().finite().optional(),
  steps: z.number().finite().optional(),
  source: z.enum(["manual", "bluetooth-heart-rate", "health-provider"]),
  sampleId: z.string().optional(),
  originId: z.string().optional(),
  originName: z.string().optional(),
  provider: z.enum(["health-connect", "healthkit"]).optional(),
  endTimestamp: z.string().optional(),
});

const trackPointSchema = z.object({
  timestamp: z.string().min(1),
  lat: z.number().finite(),
  lng: z.number().finite(),
  altitude: z.number().finite().optional(),
  heading: z.number().finite().optional(),
  speed: z.number().finite().optional(),
});

const nutritionEntrySchema = z.object({
  id: z.string().min(1),
  timestamp: z.string().min(1),
  meal: z.string().min(1).max(80),
  calories: z.number().finite().nonnegative().optional(),
  waterMl: z.number().finite().nonnegative().optional(),
});

const baseResultSchema = z.object({
  name: z.string().min(1).max(80),
  nameEn: z.string().max(100).nullable().optional(),
  category: categorySchema,
  cognition: z.string().min(1).max(320),
  fun: z.string().min(1).max(240),
  luck: luckSchema,
  question: z.string().min(1).max(180),
  verdict: z.enum(["first", "reunion"]),
  relatedItemId: z.string().nullable(),
  memorySentence: z.string().min(1).max(80),
});

export const recognizedAiSchema = z.object({
  cognition: z.string().min(1).max(320),
  fun: z.string().min(1).max(240),
  luck: luckSchema,
  question: z.string().min(1).max(180),
  verdict: z.enum(["first", "reunion"]),
  relatedItemId: z.string().nullable(),
  memorySentence: z.string().min(1).max(80),
});

export const recognizedResultSchema = baseResultSchema.extend({ unrecognized: z.literal(false) });
export const unrecognizedResultSchema = z.object({
  unrecognized: z.literal(true),
  name: z.null(),
  nameEn: z.null(),
  category: z.null(),
  cognition: z.null(),
  fun: z.null(),
  luck: z.null(),
  question: z.null(),
  verdict: z.null(),
  relatedItemId: z.null(),
  memorySentence: z.null(),
});
export const recognizeResultSchema = z.discriminatedUnion("unrecognized", [recognizedResultSchema, unrecognizedResultSchema]);

export const historyEntrySchema = z.object({
  id: z.string().min(1).max(120),
  name: z.string().min(1).max(80),
  category: categorySchema,
  place: z.string().max(120),
  date: z.string().max(40),
  userNote: z.string().max(120),
});

export const itemSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  nameEn: z.string().optional(),
  category: categorySchema,
  photo: z.string().min(1),
  place: z.string().min(1),
  country: z.string().min(2),
  lat: z.number().finite(),
  lng: z.number().finite(),
  locationSource: z.enum(["gps", "previous", "default", "manual"]),
  date: z.string().min(1),
  userNote: z.string(),
  ai: z.union([recognizedAiSchema, z.null()]),
  answer: z.string().optional(),
  isSeed: z.boolean(),
  createdAt: z.string().min(1),
  mediaType: z.enum(["photo", "panorama"]).optional(),
  tripId: z.string().optional(),
  healthSnapshot: healthSnapshotSchema.optional(),
  trackPoint: trackPointSchema.optional(),
});

export const tripSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(120),
  status: z.enum(["active", "paused", "completed"]),
  startedAt: z.string().min(1),
  endedAt: z.string().optional(),
  trackPoints: trackPointSchema.array(),
  healthSnapshots: healthSnapshotSchema.array(),
  nutrition: nutritionEntrySchema.array(),
  panorama: z.string().optional(),
  distanceMeters: z.number().finite().nonnegative(),
  elevationGainMeters: z.number().finite().nonnegative(),
  riskLevel: z.enum(["low", "medium", "high"]),
  createdAt: z.string().min(1),
});

export const recognizeRequestSchema = z.object({
  image: z.string().min(1),
  userNote: z.string().max(300),
  history: z.union([z.array(historyEntrySchema).max(200), z.string().max(120_000)]),
});

export type RecognizeResultInput = z.infer<typeof recognizeResultSchema>;
