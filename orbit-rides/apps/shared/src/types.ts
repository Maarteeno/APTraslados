/** Tipos del contrato con el API. Espejan las respuestas de services/api. */

export interface LatLng {
  readonly lat: number;
  readonly lng: number;
}

export type Role = 'rider' | 'driver' | 'admin' | 'support';

export type TripStatus =
  | 'REQUESTED' | 'MATCHING' | 'ACCEPTED' | 'ARRIVED'
  | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELED' | 'NO_DRIVERS';

export type PaymentMethod = 'cash' | 'card' | 'wallet';

export interface Session {
  readonly token: string;
  readonly user: { readonly id: string; readonly role: Role; readonly fullName: string };
}

export interface Me {
  readonly id: string;
  readonly fullName: string;
  readonly role: Role;
  readonly cityId: string | null;
}

export interface FareBreakdown {
  readonly baseCents: number;
  readonly distanceCents: number;
  readonly timeCents: number;
  readonly serviceFeeCents: number;
  readonly minimumAppliedCents: number;
  readonly surgeCents: number;
  readonly totalCents: number;
}

export interface Quote {
  readonly quoteId: string;
  readonly cityId: string;
  readonly currency: string;
  readonly fareCents: number;
  readonly distanceMeters: number;
  readonly durationSeconds: number;
  readonly surgeMultiplier: number;
  readonly expiresAt: string;
  readonly signature: string;
  /** 'osrm' | 'mapbox' = ruta real. 'estimate' = estimación local. */
  readonly routeProvider: string;
  readonly breakdown: FareBreakdown;
}

export interface TripEvent {
  readonly from: TripStatus | null;
  readonly to: TripStatus;
  readonly actor: 'rider' | 'driver' | 'system';
  readonly at: string;
  readonly payload: unknown;
}

export interface Trip {
  readonly id: string;
  readonly status: TripStatus;
  readonly riderId: string;
  readonly driverId: string | null;
  readonly origin: LatLng & { readonly address: string | null };
  readonly destination: LatLng & { readonly address: string | null };
  readonly currency: string;
  readonly fareCents: number | null;
  readonly commissionBps: number | null;
  readonly commissionCents: number | null;
  readonly driverEarningsCents: number | null;
  readonly paymentMethod: PaymentMethod;
  readonly cancellationFeeCents: number;
  readonly canceledBy: 'rider' | 'driver' | 'system' | null;
  readonly timestamps: {
    readonly requestedAt: string;
    readonly acceptedAt: string | null;
    readonly arrivedAt: string | null;
    readonly startedAt: string | null;
    readonly completedAt: string | null;
  };
  readonly events: readonly TripEvent[];
}

export interface ActiveTrip {
  readonly id: string;
  readonly status: TripStatus;
  readonly driverId: string | null;
  readonly origin: LatLng & { readonly address: string | null };
  readonly destination: LatLng & { readonly address: string | null };
  readonly paymentMethod: PaymentMethod;
  readonly requestedAt: string;
}

export interface DriverOffer {
  readonly tripId: string;
  readonly expiresAt: string;
}

export interface Earnings {
  /** Lo que la plataforma le debe al conductor. Siempre >= 0. */
  readonly pendingPayoutCents: number;
  /** Lo que el conductor le debe a la plataforma (viajes en efectivo). Siempre >= 0. */
  readonly owedToPlatformCents: number;
  /** Saldo contable con signo. Para auditoría. */
  readonly balanceCents: number;
  readonly thisWeek: {
    readonly trips: number;
    readonly grossCents: number;
    readonly commissionCents: number;
  };
}

export interface Settlement {
  readonly tripId: string;
  readonly fareCents: number;
  readonly commissionCents: number;
  readonly driverEarningsCents: number;
  readonly currency: string;
  readonly recalculated: boolean;
}

/** Mensajes que llegan por WebSocket. */
export type SocketMessage =
  | { readonly type: 'connected'; readonly at: string; readonly data: { userId: string; role: Role; tripId: string | null } }
  | { readonly type: 'ping'; readonly at: string; readonly data: null }
  | { readonly type: 'trip.matching'; readonly at: string; readonly data: { wave?: number; offersSent?: number } }
  | { readonly type: 'trip.offer'; readonly at: string; readonly data: { tripId: string; wave: number; etaSeconds: number; distanceMeters: number; expiresInSeconds: number; expiresAt: string } }
  | { readonly type: 'trip.accepted'; readonly at: string; readonly data: { tripId: string; driverId: string } }
  | { readonly type: 'trip.arrived'; readonly at: string; readonly data: { tripId: string } }
  | { readonly type: 'trip.in_progress'; readonly at: string; readonly data: { tripId: string } }
  | { readonly type: 'trip.completed'; readonly at: string; readonly data: Settlement }
  | { readonly type: 'trip.canceled'; readonly at: string; readonly data: { tripId: string; by: string; feeCents: number } }
  | { readonly type: 'trip.no_drivers'; readonly at: string; readonly data: { tripId: string } }
  | { readonly type: 'error'; readonly at: string; readonly data: { message: string } };

export type SocketMessageType = SocketMessage['type'];
