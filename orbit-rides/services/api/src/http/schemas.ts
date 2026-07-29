import { z } from 'zod';

export const latLngSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

export const createQuoteBody = z.object({
  origin: latLngSchema,
  originAddress: z.string().max(300).nullish(),
  destination: latLngSchema,
  destinationAddress: z.string().max(300).nullish(),
});

export const requestTripBody = z.object({
  quoteId: z.string().uuid(),
  paymentMethod: z.enum(['cash', 'card', 'wallet']),
});

export const cancelTripBody = z.object({
  reason: z.string().max(300).nullish(),
});

export const completeTripBody = z.object({
  actualDistanceMeters: z.number().int().min(0).max(1_000_000),
  actualDurationSeconds: z.number().int().min(0).max(86_400),
});

export const positionBody = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  bearing: z.number().min(0).max(360).nullish(),
  isOnline: z.boolean(),
});

export const devLoginBody = z.object({
  phone: z.string().regex(/^\+[1-9][0-9]{7,14}$/, 'formato E.164, por ejemplo +59899123456'),
});

export const uuidParam = z.object({ id: z.string().uuid() });

export const ratingBody = z.object({
  stars: z.number().int().min(1).max(5),
  tags: z.array(z.string().max(40)).max(6).optional(),
  comment: z.string().max(1000).nullish(),
});
