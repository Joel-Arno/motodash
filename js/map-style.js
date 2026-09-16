// Eigenes, reduziertes Kartendesign: Straßen, Orte, Hausnummern, Wasser.
// Keine Läden/POIs. Daten: OpenStreetMap über OpenFreeMap (OpenMapTiles-Schema).

const SOURCE = 'omt';
const FONT_REGULAR = ['Noto Sans Regular'];
const FONT_BOLD = ['Noto Sans Bold'];
const FONT_ITALIC = ['Noto Sans Italic'];

const PALETTES = {
  night: {
    background: '#0d1014',
    wood: '#0f1913',
    park: '#101d17',
    residential: '#13161b',
    building: '#1b1f26',
    buildingOutline: '#242a33',
    water: '#0a2434',
    waterway: '#0f3a52',
    boundary: '#4b5563',
    rail: '#363c46',
    casing: '#0d1014',
    motorway: '#e8903f',
    trunk: '#d9ad4e',
    primary: '#d2cbb0',
    secondary: '#a7b0bc',
    tertiary: '#88919e',
    minor: '#4e5662',
    path: '#434a54',
    label: '#e8ebef',
    labelMuted: '#8d96a3',
    labelHalo: '#0d1014',
    place: '#ffffff',
    placeHalo: '#000000',
    waterLabel: '#5b9cc2',
    ref: '#ffd24d',
    refHalo: '#0d1014',
    route: '#4f9dff',
    routeCasing: '#0a2a55',
    routeAlt: '#5f6a7a',
    routeAltCasing: '#1b2129',
    routeDone: '#56606d',
    routeStart: '#3ddc84',
  },
  day: {
    background: '#f1f0ea',
    wood: '#d5e4cb',
    park: '#d2e8c6',
    residential: '#e7e5de',
    building: '#dbd7ce',
    buildingOutline: '#c9c4b9',
    water: '#a6cae6',
    waterway: '#8bbadf',
    boundary: '#9aa1ad',
    rail: '#b5b5b5',
    casing: '#a4a9b0',
    motorway: '#f39a3d',
    trunk: '#f6c552',
    primary: '#ffffff',
    secondary: '#ffffff',
    tertiary: '#ffffff',
    minor: '#ffffff',
    path: '#b3ab9e',
    label: '#1d2126',
    labelMuted: '#5f6773',
    labelHalo: '#ffffff',
    place: '#111418',
    placeHalo: '#ffffff',
    waterLabel: '#3b72a1',
    ref: '#1d2126',
    refHalo: '#f6c552',
    route: '#1a73e8',
    routeCasing: '#0b4aa8',
    routeAlt: '#9aa5b3',
    routeAltCasing: '#6f7a88',
    routeDone: '#a3abb5',
    routeStart: '#12a150',
  },
};

// Von unwichtig nach wichtig – spätere Einträge werden obendrauf gezeichnet.
const ROADS = [
  { id: 'path', classes: ['path', 'track'], minzoom: 14, width: [[14, 0.8], [18, 2.5]], dash: [2, 1.5] },
  { id: 'minor', classes: ['minor', 'service'], minzoom: 12, width: [[12, 0.6], [14, 2], [16, 5], [18, 14]] },
  { id: 'tertiary', classes: ['tertiary'], minzoom: 10, width: [[10, 0.6], [13, 2], [15, 5], [18, 18]] },
  { id: 'secondary', classes: ['secondary'], minzoom: 8, width: [[8, 0.5], [12, 2], [14, 5], [18, 20]] },
  { id: 'primary', classes: ['primary'], minzoom: 7, width: [[7, 0.6], [10, 1.8], [14, 6], [18, 24]] },
  { id: 'trunk', classes: ['trunk'], minzoom: 5, width: [[5, 0.6], [10, 2.2], [14, 6.5], [18, 26]] },
  { id: 'motorway', classes: ['motorway'], minzoom: 4, width: [[4, 0.6], [10, 2.5], [14, 7], [18, 28]] },
];

const byZoom = (stops) => ['interpolate', ['exponential', 1.5], ['zoom'], ...stops.flat()];
const isLine = ['match', ['geometry-type'], ['LineString', 'MultiLineString'], true, false];
const isPoint = ['match', ['geometry-type'], ['Point', 'MultiPoint'], true, false];
const classIn = (classes) => ['match', ['get', 'class'], classes, true, false];
const germanName = ['coalesce', ['get', 'name:de'], ['get', 'name']];
const tunnelOpacity = ['match', ['get', 'brunnel'], 'tunnel', 0.45, 1];

function roadLayers(p) {
  const casings = ROADS.filter((road) => !road.dash).map((road) => ({
    id: `road-${road.id}-casing`,
    type: 'line',
    source: SOURCE,
    'source-layer': 'transportation',
    minzoom: road.minzoom,
    filter: ['all', isLine, classIn(road.classes)],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': p.casing,
      'line-width': byZoom(road.width.map(([z, w]) => [z, w + (z >= 14 ? 3 : 1.2)])),
      'line-opacity': tunnelOpacity,
    },
  }));

  const fills = ROADS.map((road) => ({
    id: `road-${road.id}`,
    type: 'line',
    source: SOURCE,
    'source-layer': 'transportation',
    minzoom: road.minzoom,
    filter: ['all', isLine, classIn(road.classes)],
    layout: { 'line-cap': road.dash ? 'butt' : 'round', 'line-join': 'round' },
    paint: {
      'line-color': p[road.id],
      'line-width': byZoom(road.width),
      'line-opacity': tunnelOpacity,
      ...(road.dash && { 'line-dasharray': road.dash }),
    },
  }));

  return [...casings, ...fills];
}

/**
 * Gefahrener Teil der Route in Grau: Verlauf entlang der Linie, bis `fraction` grau, danach durchsichtig.
 * Wird während der Fahrt über map.setPaintProperty aktualisiert.
 */
export function routeDoneGradient(theme, fraction) {
  const p = PALETTES[theme] ?? PALETTES.night;
  return ['step', ['line-progress'], p.routeDone, Math.min(1, Math.max(0, fraction)), 'rgba(0, 0, 0, 0)'];
}

/** Grüner Anfang der Route: bis `fraction` (0…1) grün, danach durchsichtig. */
export function routeStartGradient(theme, fraction) {
  const p = PALETTES[theme] ?? PALETTES.night;
  const end = Math.min(0.999, Math.max(0.001, fraction));
  return ['step', ['line-progress'], p.routeStart, end, 'rgba(0, 0, 0, 0)'];
}

// Gewählte Route kräftig, Alternativen grau darunter. Liegt über den Straßen, unter den Beschriftungen.
function routeLayers(p, theme, doneFraction) {
  const selected = ['==', ['get', 'selected'], true];
  const alternative = ['!=', ['get', 'selected'], true];
  const line = (id, filter, color, width) => ({
    id,
    type: 'line',
    source: 'route',
    filter,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': color, 'line-width': byZoom(width) },
  });
  return [
    line('route-alt-casing', alternative, p.routeAltCasing, [[5, 4], [14, 11], [18, 26]]),
    line('route-alt', alternative, p.routeAlt, [[5, 2.5], [14, 7], [18, 18]]),
    line('route-casing', selected, p.routeCasing, [[5, 5], [14, 13], [18, 30]]),
    line('route-line', selected, p.route, [[5, 3.5], [14, 9], [18, 22]]),
    {
      id: 'route-done',
      type: 'line',
      source: 'route',
      filter: selected,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-gradient': routeDoneGradient(theme, doneFraction), 'line-width': byZoom([[5, 3.5], [14, 9], [18, 22]]) },
    },
    // Erstes Stück der Route grün – bei Rundtouren sieht man so, welcher der beiden Striche der Hinweg ist.
    {
      id: 'route-start',
      type: 'line',
      source: 'route',
      filter: selected,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-gradient': routeStartGradient(theme, 0), 'line-width': byZoom([[5, 3.5], [14, 9], [18, 22]]) },
    },
    // Pfeile in Fahrtrichtung auf der gewählten Route.
    {
      id: 'route-arrows',
      type: 'symbol',
      source: 'route',
      filter: selected,
      minzoom: 11,
      layout: {
        'symbol-placement': 'line',
        'symbol-spacing': 130,
        'icon-image': 'route-arrow',
        'icon-size': byZoom([[11, 0.6], [14, 0.8], [18, 1]]),
        'icon-rotation-alignment': 'map',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
    },
    // Unsichtbare, breite Linie, damit man Alternativen mit dem Finger leicht antippen kann.
    {
      id: 'route-hit',
      type: 'line',
      source: 'route',
      paint: { 'line-color': '#000000', 'line-opacity': 0, 'line-width': 36 },
    },
  ];
}

function placeLayer(id, classes, minzoom, sizes, p, { bold = false, muted = false } = {}) {
  return {
    id,
    type: 'symbol',
    source: SOURCE,
    'source-layer': 'place',
    minzoom,
    filter: classIn(classes),
    layout: {
      'text-field': germanName,
      'text-font': bold ? FONT_BOLD : FONT_REGULAR,
      'text-size': ['interpolate', ['linear'], ['zoom'], ...sizes.flat()],
      'text-max-width': 8,
      'symbol-sort-key': ['get', 'rank'],
    },
    paint: {
      'text-color': muted ? p.labelMuted : p.place,
      'text-halo-color': muted ? p.labelHalo : p.placeHalo,
      'text-halo-width': 1.6,
    },
  };
}

const EMPTY_COLLECTION = { type: 'FeatureCollection', features: [] };

/**
 * @param route aktuelle Routen als GeoJSON – bleibt so auch beim Wechsel Tag/Nacht erhalten
 * @param doneFraction Anteil der schon gefahrenen Route (0–1)
 */
export function buildStyle(theme, { route = EMPTY_COLLECTION, doneFraction = 0 } = {}) {
  const p = PALETTES[theme] ?? PALETTES.night;

  return {
    version: 8,
    name: `MotoDash ${theme}`,
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: {
      [SOURCE]: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' },
      route: { type: 'geojson', data: route, lineMetrics: true },
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': p.background } },
      {
        id: 'wood',
        type: 'fill',
        source: SOURCE,
        'source-layer': 'landcover',
        filter: classIn(['wood']),
        paint: { 'fill-color': p.wood },
      },
      {
        id: 'park',
        type: 'fill',
        source: SOURCE,
        'source-layer': 'park',
        paint: { 'fill-color': p.park },
      },
      {
        id: 'residential',
        type: 'fill',
        source: SOURCE,
        'source-layer': 'landuse',
        filter: classIn(['residential', 'suburb', 'neighbourhood']),
        paint: { 'fill-color': p.residential },
      },
      {
        id: 'water',
        type: 'fill',
        source: SOURCE,
        'source-layer': 'water',
        paint: { 'fill-color': p.water },
      },
      {
        id: 'waterway',
        type: 'line',
        source: SOURCE,
        'source-layer': 'waterway',
        minzoom: 10,
        paint: { 'line-color': p.waterway, 'line-width': byZoom([[10, 0.5], [14, 1.5], [18, 5]]) },
      },
      {
        id: 'building',
        type: 'fill',
        source: SOURCE,
        'source-layer': 'building',
        minzoom: 14,
        paint: {
          'fill-color': p.building,
          'fill-outline-color': p.buildingOutline,
          'fill-opacity': ['interpolate', ['linear'], ['zoom'], 14, 0, 15, 1],
        },
      },
      {
        id: 'boundary',
        type: 'line',
        source: SOURCE,
        'source-layer': 'boundary',
        filter: ['all', ['<=', ['get', 'admin_level'], 4], ['!=', ['get', 'maritime'], 1]],
        paint: { 'line-color': p.boundary, 'line-width': 1, 'line-dasharray': [3, 2] },
      },
      {
        id: 'rail',
        type: 'line',
        source: SOURCE,
        'source-layer': 'transportation',
        minzoom: 11,
        filter: ['all', isLine, classIn(['rail', 'transit'])],
        paint: { 'line-color': p.rail, 'line-width': byZoom([[11, 0.6], [18, 2.5]]) },
      },

      ...roadLayers(p),
      ...routeLayers(p, theme, doneFraction),

      {
        id: 'water-name',
        type: 'symbol',
        source: SOURCE,
        'source-layer': 'water_name',
        minzoom: 11,
        filter: isPoint,
        layout: { 'text-field': germanName, 'text-font': FONT_ITALIC, 'text-size': 12, 'text-max-width': 6 },
        paint: { 'text-color': p.waterLabel, 'text-halo-color': p.labelHalo, 'text-halo-width': 1 },
      },
      {
        id: 'housenumber',
        type: 'symbol',
        source: SOURCE,
        'source-layer': 'housenumber',
        minzoom: 17,
        layout: { 'text-field': ['get', 'housenumber'], 'text-font': FONT_REGULAR, 'text-size': 11, 'text-padding': 2 },
        paint: { 'text-color': p.labelMuted, 'text-halo-color': p.labelHalo, 'text-halo-width': 1 },
      },
      {
        id: 'road-name',
        type: 'symbol',
        source: SOURCE,
        'source-layer': 'transportation_name',
        minzoom: 13,
        filter: classIn(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor', 'service']),
        layout: {
          'symbol-placement': 'line',
          'text-field': ['get', 'name'],
          'text-font': FONT_REGULAR,
          'text-size': ['interpolate', ['linear'], ['zoom'], 13, 11, 18, 16],
          'text-max-angle': 30,
          'text-padding': 4,
          'symbol-spacing': 300,
        },
        paint: { 'text-color': p.label, 'text-halo-color': p.labelHalo, 'text-halo-width': 2 },
      },
      {
        id: 'road-ref',
        type: 'symbol',
        source: SOURCE,
        'source-layer': 'transportation_name',
        minzoom: 8,
        filter: ['all', ['has', 'ref'], classIn(['motorway', 'trunk', 'primary'])],
        layout: {
          'symbol-placement': 'line',
          'text-field': ['get', 'ref'],
          'text-font': FONT_BOLD,
          'text-size': 12,
          'text-rotation-alignment': 'viewport',
          'symbol-spacing': 500,
        },
        paint: { 'text-color': p.ref, 'text-halo-color': p.refHalo, 'text-halo-width': 2.5 },
      },

      placeLayer('place-minor', ['suburb', 'quarter', 'neighbourhood', 'hamlet'], 12, [[12, 11], [16, 14]], p, { muted: true }),
      placeLayer('place-village', ['village'], 10, [[10, 11], [15, 16]], p),
      placeLayer('place-town', ['town'], 7, [[7, 11], [14, 19]], p, { bold: true }),
      placeLayer('place-city', ['city'], 4, [[4, 12], [12, 24]], p, { bold: true }),
    ],
  };
}
