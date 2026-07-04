// Maps deep links. Google's dir API accepts either "lat,lng" or a plain
// address string as the destination, and it hands off to Apple Maps on iOS —
// so an owner only ever NEEDS to type the address; coordinates are an
// optional precision upgrade (pin exactness for big complexes).
export function mapsDirectionsUrl(loc: {
  latitude?: number | null;
  longitude?: number | null;
  address?: string | null;
}): string | null {
  if (loc.latitude != null && loc.longitude != null) {
    return `https://www.google.com/maps/dir/?api=1&destination=${loc.latitude},${loc.longitude}`;
  }
  if (loc.address?.trim()) {
    return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(loc.address.trim())}`;
  }
  return null;
}
