import { z } from "zod";

const categorySchema = z.enum([
  "animal",
  "plant",
  "mineral",
  "landscape",
  "sky",
  "food",
  "artifact",
  "other",
]);

const luckSchema = z.object({
  text: z.string().min(1).max(180),
  basis: z.string().min(1).max(240),
  confidence: z.enum(["low", "medium", "high"]),
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

export const recognizedResultSchema = baseResultSchema.extend({
  unrecognized: z.literal(false),
});

export const unrecognizedResultSchema = z.object({
  unrecognized: z.literal(true),
  observation: z.string().min(1).max(240),
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

export const recognizeResultSchema = z.discriminatedUnion("unrecognized", [
  recognizedResultSchema,
  unrecognizedResultSchema,
]);

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
  lat: z.number().finite().nullable(),
  lng: z.number().finite().nullable(),
  locationSource: z.enum(["gps", "exif", "previous", "default", "manual"]),
  placeSource: z.enum(["voice", "exif", "manual", "previous", "default", "gps"]).optional(),
  date: z.string().min(1),
  dateSource: z.enum(["exif", "fileModified", "imported"]).optional(),
  userNote: z.string(),
  heard: z.string().max(500).optional(),
  ai: z.union([recognizedAiSchema, z.null()]),
  answer: z.string().optional(),
  isSeed: z.boolean(),
  createdAt: z.string().min(1),
});

export const recognizeRequestSchema = z.object({
  image: z.string().min(1),
  userNote: z.string().max(300),
  history: z.union([
    z.array(historyEntrySchema).max(1_000),
    z.string().max(120_000),
  ]),
});

export const avModelSegmentSchema = recognizedResultSchema.extend({
  frameIndex: z.number().int().min(0).max(5),
  heard: z.string().max(500),
  relatedItemName: z.string().max(80).nullable(),
  matchBasis: z.string().max(240).nullable(),
  matchConfidence: z.enum(["low", "medium", "high"]).nullable(),
}).strict();

const avRecognizedResultSchema = z.object({
  recognized: z.literal(true),
  placeHint: z.string().min(1).max(60).nullable(),
  segments: z.array(avModelSegmentSchema).min(1).max(6),
}).strict();

const avEmptyResultSchema = z.object({
  recognized: z.literal(false),
  placeHint: z.null(),
  segments: z.tuple([]),
}).strict();

export const avModelResultSchema = z.discriminatedUnion("recognized", [
  avRecognizedResultSchema,
  avEmptyResultSchema,
]);

const avResponseSegmentSchema = avModelSegmentSchema.extend({
  associationStatus: z.enum(["confirmed", "uncertain", "none"]),
});

export const avResponseSchema = z.discriminatedUnion("recognized", [
  z.object({
    recognized: z.literal(true),
    placeHint: z.string().min(1).max(60).nullable(),
    segments: z.array(avResponseSegmentSchema).min(1).max(6),
  }).strict(),
  avEmptyResultSchema,
]);

const avFrameSchema = z.object({
  dataUrl: z.string().min(1),
  atSec: z.number().finite().min(0).max(60),
}).strict();

export const encounterAvRequestSchema = z.object({
  frames: z.array(avFrameSchema).min(1).max(6),
  audioDataUrl: z.string().min(1).max(2_700_000),
  history: z.array(historyEntrySchema),
  placeFallback: z.string().max(120).nullable().optional(),
}).strict();

export type RecognizeResultInput = z.infer<typeof recognizeResultSchema>;
