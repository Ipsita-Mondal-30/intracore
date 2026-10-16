import { AppError } from "@/lib/errors";

/**
 * Seams for future geolocation / routing integrations (e.g. a maps or fleet API).
 * Nothing calls out today: the defaults throw NOT_CONFIGURED.
 */

export type GeoPoint = { latitude: number; longitude: number };

export interface LocationProvider {
  /** Address → coordinates. */
  geocode(address: string): Promise<GeoPoint & { formattedAddress?: string }>;
  /** Last known position of a technician/vehicle. */
  currentLocation(subject: { type: "technician" | "vehicle"; id: string }): Promise<(GeoPoint & { at: Date }) | null>;
}

export interface RouteProvider {
  /** Ordered stops with travel estimates, starting at `origin`. */
  planRoute(origin: GeoPoint, stops: (GeoPoint & { id: string })[]): Promise<{ order: string[]; distanceMeters: number; durationSeconds: number }>;
}

const notConfigured = (what: string) => () => Promise.reject(new AppError("NOT_CONFIGURED", `${what} provider is not configured`, 501));

export const NotConfiguredLocationProvider: LocationProvider = {
  geocode: notConfigured("Location"),
  currentLocation: notConfigured("Location"),
};

export const NotConfiguredRouteProvider: RouteProvider = {
  planRoute: notConfigured("Route"),
};

export const locationProvider: LocationProvider = NotConfiguredLocationProvider;
export const routeProvider: RouteProvider = NotConfiguredRouteProvider;
