export function shouldUseSingleTileFallback(loadedTiles: number, expectedTiles: number): boolean {
  return loadedTiles !== expectedTiles;
}
